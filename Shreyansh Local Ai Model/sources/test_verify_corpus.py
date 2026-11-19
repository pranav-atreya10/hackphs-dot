import csv
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image

import common
import verify_corpus as verify


class CorpusTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name).resolve()
        self.root = self.repo / "data"

    def bundle(self):
        a = "BTR (1).jpg"
        b = "DTR (11).jpg"
        test = "B (44).jpg"
        self.lineage = {"fit_image": [a] * 3, "fit_group": ["seq-a"] * 3,
                        "holdout_image": [b] * 3, "holdout_group": ["seq-b"] * 3}
        self.write(verify.FROZEN, {"tiers": {"dataset": {"visual": {"items": [{"path": f"test/{test}"}]}}}})
        self.write(verify.MENDELEY, {"holdout_images": [b], "dropped_near_test": ["DTR (85).jpg"]})
        self.write(verify.SVAN, {"clips": [{"clip": c, "part": p, "youtube": y} for c, p, y in (
            ("V_BIRD_001", "train", False), ("V_BIRD_002", "select", False), ("V_AIRPLANE_003", "test", True)
        )]})
        credits = []
        for src, part, stem, suffixes, versions in verify._parts():
            path = self.root / stem
            path.parent.mkdir(parents=True, exist_ok=True)
            np.save(f"{path}_X.npy", np.zeros((3, versions, 64, 64, 3), dtype=np.uint8))
            y = np.arange(3, dtype=np.int64)
            if src == "mendeley":
                np.save(f"{path}_y.npy", y)
            elif src == "svanstrom":
                name = "V_BIRD_001" if part == "train" else "V_BIRD_002"
                np.savez(f"{path}_meta.npz", y=y, clip=[0, 0, 0], clip_names=[name], youtube=[False])
            else:
                group = next(f"{src}-{i}" for i in range(1000) if common.split_part(f"{src}-{i}") == part)
                np.savez(f"{path}_meta.npz", y=y, group=[group] * 3)
                self.write((self.root / f"{stem}_info.json").relative_to(self.repo),
                           {"source": src, "part": part, "crops": 3, "bird": 1, "drone": 1, "other": 1, "groups": 1})
                if src == "openimages":
                    credits.append([group, part, "Synthetic Fixture", "https://example.test/credits",
                                    "https://creativecommons.org/licenses/by/2.0/"])
        np.savez(self.root / verify.LINEAGE, **self.lineage)
        credit_path = self.repo / verify.CREDITS
        credit_path.parent.mkdir(parents=True, exist_ok=True)
        with credit_path.open("w", encoding="utf-8", newline="") as out:
            writer = csv.writer(out)
            writer.writerow(("ImageID", "Part", "Author", "OriginalLandingURL", "License"))
            writer.writerows(credits)
        self.anchors = {name: hashlib.sha256((self.repo / name).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
                        for name in verify.ANCHORS}
        p = patch.multiple(verify, REPO=self.repo, ANCHORS=self.anchors)
        p.start()
        self.addCleanup(p.stop)

    def write(self, name, obj):
        p = self.repo / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj), encoding="utf-8")

    def evidence(self):
        inv = verify._inspect(self.root, inventory_only=True)
        return {
            "schema_version": 1,
            "files": inv["files"],
            "sources": {name: {
                "revision": "synthetic",
                "input_bytes": 1,
                "upstream_manifest_sha256": "a" * 64,
                "train_select_rights_confirmed": True,
                "attribution": "Synthetic fixture",
                "rights_review": "Fixture, no third-party material",
                "archive_digests": verify.ARCHIVE_PINS.get(name, {}).copy(),
            } for name in verify.SOURCES},
            "duplicate_audit": {
                "max_hamming": 6,
                "svan_test_phash_sha256": "b" * 64,
                "fbd_sv_excluded": True,
                "review": "Synthetic fixture, not real clearance",
                "checks": {scope: {"items_checked": 1, "exact_matches": 0, "unresolved_phash_matches": 0,
                                   "overlapping_groups": 0} for scope in verify.AUDIT_SCOPES},
            },
        }

    def write_evidence(self, evidence):
        self.write((self.root / verify.EVIDENCE).relative_to(self.repo), evidence)

    def test_missing_artifacts_are_explicit(self):
        with self.assertRaises(verify.CorpusError) as err:
            verify.verify_corpus(self.root)
        self.assertIn("shreyansh_crops_v2/fit_X.npy", str(err.exception))
        self.assertIn("shreyansh_crops_v4/synth_cranfield_select_meta.npz", str(err.exception))
        self.assertIn(verify.LINEAGE, str(err.exception))
        self.assertIn(verify.EVIDENCE, str(err.exception))

    def test_matching_inventory_passes_without_opening_test_files(self):
        self.bundle()
        self.write_evidence(self.evidence())
        fbd = self.root / verify.V4 / "fbdsv2024_testonly_test_X.npy"
        fbd.write_bytes(b"not an array; must not be opened")
        with patch.object(np, "load", wraps=np.load) as load, patch.object(Path, "open", autospec=True,
                                                                          side_effect=Path.open) as op:
            result = verify.verify_corpus(self.root)
        opened = [str(c.args[0]) for c in [*load.call_args_list, *op.call_args_list]]
        self.assertFalse(any("testonly" in path for path in opened))
        self.assertEqual(result["status"], "verified_train_select")
        self.assertEqual(set(result["splits"]), set(verify.SOURCES))
        self.assertEqual(len(result["files"]), 57)

    def test_rejects_test_only_and_unapproved_train_select_spill(self):
        v4 = self.root / verify.V4
        v4.mkdir(parents=True)
        for name in ("FBD-SV-2024_train_X.npy", "extra_source_select_meta.npz"):
            (v4 / name).write_bytes(b"must not be opened")
        with self.assertRaisesRegex(verify.CorpusError, "not opened:.*FBD-SV-2024.*extra_source"):
            verify.verify_corpus(self.root)
        with self.assertRaisesRegex(ValueError, "test-only"):
            common.CropWriter("FBD-SV-2024", "select")

    def test_rejects_group_overlap_and_svan_test_clip(self):
        self.bundle()
        overlapping = {**self.lineage, "holdout_group": self.lineage["fit_group"]}
        np.savez(self.root / verify.LINEAGE, **overlapping)
        with self.assertRaisesRegex(verify.CorpusError, "group overlap"):
            verify._inspect(self.root, inventory_only=True)
        np.savez(self.root / verify.LINEAGE, **self.lineage)
        np.savez(self.root / verify.V3 / "svan_select_meta.npz", y=np.arange(3, dtype=np.int64),
                 clip=[0, 0, 0], clip_names=["V_AIRPLANE_003"], youtube=[False])
        with self.assertRaisesRegex(verify.CorpusError, "unknown, test, or YouTube clip"):
            verify._inspect(self.root, inventory_only=True)

    def test_rejects_dropped_mendeley_image(self):
        self.bundle()
        invalid = {**self.lineage, "fit_image": ["DTR (85).jpg"] * 3}
        np.savez(self.root / verify.LINEAGE, **invalid)
        with self.assertRaisesRegex(verify.CorpusError, "invalid, dropped, or frozen image"):
            verify._inspect(self.root, inventory_only=True)

    def test_rejects_uncredited_crop_group(self):
        self.bundle()
        group = next(f"uncredited{i}" for i in range(1000) if common.split_part(f"uncredited{i}") == "train")
        np.savez(self.root / verify.V4 / "openimages_train_meta.npz", y=np.arange(3, dtype=np.int64), group=[group] * 3)
        with self.assertRaisesRegex(verify.CorpusError, "missing per-image credit/licence"):
            verify._inspect(self.root, inventory_only=True)

    def test_rejects_changed_bytes_even_with_valid_array_header(self):
        self.bundle()
        self.write_evidence(self.evidence())
        with (self.root / verify.V2 / "fit_X.npy").open("r+b") as f:
            f.seek(-1, 2)
            f.write(b"x")
        with self.assertRaisesRegex(verify.CorpusError, "SHA-256 mismatch.*fit_X.npy"):
            verify.verify_corpus(self.root)

    def test_rejects_failed_rights_and_duplicate_reviews(self):
        self.bundle()
        evidence = self.evidence()
        evidence["sources"]["aod4"]["train_select_rights_confirmed"] = False
        self.write_evidence(evidence)
        with self.assertRaisesRegex(verify.CorpusError, "aod4: missing.*rights"):
            verify.verify_corpus(self.root)
        evidence["sources"]["aod4"]["train_select_rights_confirmed"] = True
        evidence["duplicate_audit"]["checks"]["cross_source"]["unresolved_phash_matches"] = 1
        self.write_evidence(evidence)
        with self.assertRaisesRegex(verify.CorpusError, "unresolved duplicates: cross_source"):
            verify.verify_corpus(self.root)

    def test_rejects_partial_archive_digest(self):
        self.bundle()
        evidence = self.evidence()
        evidence["sources"]["synth_athkot"]["archive_digests"]["dataset-yolo.zip"] = "sha256:7c13162528f61f04"
        self.write_evidence(evidence)
        with self.assertRaisesRegex(verify.CorpusError, "mismatched published digest for dataset-yolo.zip"):
            verify.verify_corpus(self.root)

    def test_leak_check_refuses_missing_cache_or_changed_reference(self):
        with patch.multiple(common, REPO=self.repo, OUT=self.root, _REF=None):
            with self.assertRaisesRegex(FileNotFoundError, "Svanstrom test pHash cache"):
                common.leak_check([])
            ref = Path("data") / "mendeley" / "Dataset" / "test" / "images" / "fake.png"
            self.write("benchmarks/test_sets.json", {"tiers": {"dataset": {"visual": {
                "items": [{"path": ref.as_posix(), "sha256": "0" * 64}]}}}})
            p = self.repo / ref
            p.parent.mkdir(parents=True)
            Image.new("RGB", (4, 4)).save(p)
            np.save(self.root / "svan_test_phash.npy", np.array([3], dtype=np.uint64))
            with patch.dict(sys.modules, {"imagehash": SimpleNamespace(phash=lambda _: "0")}):
                with self.assertRaisesRegex(ValueError, "Frozen Mendeley image changed"):
                    common.leak_check([])
                self.write("benchmarks/test_sets.json", {"tiers": {"dataset": {"visual": {
                    "items": [{"path": ref.as_posix(), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}]}}}})
                self.assertEqual(common.leak_check([Image.new("RGB", (4, 4))]), [0])
                self.assertEqual(common._REF.tolist(), [0, 3])


if __name__ == "__main__":
    unittest.main()
