"""Read-only v5 train/SELECT preflight for the fd85c001 corpus recipe."""

import argparse
import csv
import hashlib
import io
import json
import re
import sys
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile

import numpy as np

if __package__:
    from .common import is_test_only, split_part
else:
    from common import is_test_only, split_part

REPO = Path(__file__).resolve().parents[2]
MODEL = "Shreyansh Local Ai Model"
V2, V3, V4 = ("shreyansh_crops_v2", "shreyansh_crops_v3", "shreyansh_crops_v4")
V4_SOURCES = ("aod4", "dcskycam", "dut_anti_uav", "iberbirds", "klim_skagen",
              "openimages", "synth_athkot", "synth_cranfield")
SOURCES = ("mendeley", "svanstrom", *V4_SOURCES)
LINEAGE = f"{V2}/row_lineage.npz"
EVIDENCE = "v5_corpus_evidence.json"
CLASSES = ("bird", "drone", "other")
FROZEN = "benchmarks/test_sets.json"
MENDELEY = f"{MODEL}/split.json"
SVAN = f"{MODEL}/svanstrom_split.json"
CREDITS = f"{MODEL}/sources/openimages_attribution.csv"
ANCHORS = {
    FROZEN: "af8a62cfb5d22887ec9a268c3e2a287aa23aa22d51a21b2901cacbc46258211e",
    MENDELEY: "232b691b8c9f47e9b6f2b297b86873a5419aa4b24ff10f5e074b9e024b836548",
    SVAN: "63bcd3025e37661467daf642d693d966e19db36768a1fd05b5f314fb3eb51125",
    CREDITS: "63b0fcb38cdfceeebc933078930f6974eacd9aee475b106ddae26e2beb0bc4d4",
}
ARCHIVE_PINS = {
    "mendeley": {"Dataset.zip": "sha256:5bf5b257071176713664659db6e7e31ebc4c331d94e0c3f369461c1e7ecac51c"},
    "svanstrom": {"Drone-detection-dataset-v1.0.0.zip": "md5:5d9b891a87857b3d9ee8872e8a1f0f0f"},
    "aod4": {"AOD 4.zip": "sha256:fac56b9c0494312bcd4c63dfefcbcd8ed07ab55d4b00584131c0b55273d24518"},
    "dut_anti_uav": {
        "train.zip": "sha256:14f927290556df60e23cedfa80dffc10dc21e4a3b6843e150cfc49644376eece",
        "val.zip": "sha256:238be0ceb3e7c5be6711ee3247e49df2750d52f91f54f5366c68bebac112ebf8",
        "test.zip": "sha256:a671989a01cff98c684aeb084e59b86f4152c50499d86152eb970a9fc7fb1cbe",
    },
    "iberbirds": {"IBERBIRDS_dataset.zip": "md5:379d49674e798d9e115268ed08652c77"},
    "klim_skagen": {
        "models-Klim.zip": "sha256:da270905c3a2ca4bfeb6cae331aaa2819dbdf57eeae9c65f76253d7c1ac9aa27",
        "Test-Skagen.zip": "sha256:0a7a57f1004db44017eda13ae426241040fccdfbbc74d046c92e1cd203a0ac1a",
    },
    "synth_athkot": {"dataset-yolo.zip": "sha256:7c13162528f61f04c500bf13e9e8080e981612fe24f4c8381b1f632917ef2505"},
    "synth_cranfield": {
        "multi_drone_no_birds_40m_small.zip": "sha256:297671d67e6b06c089b2e598f70ac2f156100997207b944d7c91e8d00140e82c",
    },
}
AUDIT_SCOPES = ("train_vs_select", "cross_source", "train_select_vs_mendeley_and_svanstrom_tests")


class CorpusError(ValueError):
    """Missing, invalid, or unaudited corpus; do not train."""


def _require(ok, message):
    if not ok:
        raise CorpusError(message)


def _parts():
    for source in SOURCES:
        for part in ("train", "select"):
            if source == "mendeley":
                stem = f"{V2}/{'fit' if part == 'train' else 'holdout'}"
                yield source, part, stem, ("X.npy", "y.npy"), 3 if part == "train" else 2
            elif source == "svanstrom":
                yield source, part, f"{V3}/svan_{part}", ("X.npy", "meta.npz"), 3 if part == "train" else 1
            else:
                yield source, part, f"{V4}/{source}_{part}", ("X.npy", "meta.npz", "info.json"), 3 if part == "train" else 1


def _input_paths(root, inventory_only):
    files = {f"{stem}_{suffix}" for _, _, stem, suffixes, _ in _parts() for suffix in suffixes} | {LINEAGE}
    paths = {rel: root / rel for rel in sorted(files | (set() if inventory_only else {EVIDENCE}))}
    for rel, p in paths.items():
        _require(p.resolve() == p, f"Linked corpus artifact is not allowed: {rel}")
    v4 = root / V4
    if v4.is_dir() and v4.resolve() == v4:
        unexpected = sorted(p.name for p in v4.iterdir()
                            if re.search(r"_(train|select)_(x\.npy|meta\.npz|info\.json)$", p.name, re.I)
                            and f"{V4}/{p.name}" not in files)
        _require(not unexpected, f"Unexpected v4 train/SELECT artifact(s), not opened: {', '.join(unexpected)}")
    missing = [rel for rel, p in paths.items() if not p.is_file()]
    _require(not missing, f"Missing required corpus artifacts under {root}:\n  " + "\n  ".join(missing))
    return paths


def _anchors():
    texts = {}
    for rel, digest in ANCHORS.items():
        data = (REPO / rel).read_bytes().replace(b"\r\n", b"\n")
        _require(hashlib.sha256(data).hexdigest() == digest, f"Changed baseline metadata: {rel}")
        texts[rel] = data.decode("utf-8")
    return texts


def _strings(array, label, rows=None):
    _require(array.ndim == 1 and array.dtype.kind == "U"
             and (rows is None or len(array) == rows)
             and all(v and v == v.strip() for v in array), f"Invalid {label}")
    return array.tolist()


def _mendeley_groups(lineage, part, rows, split, frozen_names):
    prefix = "fit" if part == "train" else "holdout"
    images = _strings(lineage[f"{prefix}_image"], f"Mendeley {prefix} image lineage", rows)
    groups = _strings(lineage[f"{prefix}_group"], f"Mendeley {prefix} group lineage", rows)
    seen = set(images)
    holdout = set(split["holdout_images"])
    _require(not seen & (frozen_names | set(split["dropped_near_test"]))
             and all(re.fullmatch(r"[BD]TR \(\d+\)\.jpg", name) for name in seen),
             f"Mendeley {part}: invalid, dropped, or frozen image in row lineage")
    _require(seen <= holdout if part == "select" else not seen & holdout,
             f"Mendeley {part}: row lineage disagrees with pinned split.json")
    _require(len(set(zip(images, groups))) == len(seen), f"Mendeley {part}: images assigned multiple groups")
    return set(groups)


def _svan_groups(meta, part, rows, svan):
    names = _strings(meta["clip_names"], "Svanstrom clip names")
    clip, youtube = meta["clip"], meta["youtube"]
    _require(clip.shape == (rows,) and clip.dtype.kind in "iu" and clip.min() >= 0 and clip.max() < len(names),
             f"Svanstrom {part}: invalid clip indices")
    _require(youtube.shape == (len(names),) and youtube.dtype.kind == "b" and not youtube.any()
             and len(set(names)) == len(names)
             and all(svan.get(name) == (part, False) for name in names),
             f"Svanstrom {part}: unknown, test, or YouTube clip in metadata")
    return {names[i] for i in np.unique(clip)}


def _v4_groups(meta, source, part, rows, credits):
    groups = set(_strings(meta["group"], f"{source} {part} group IDs", rows))
    _require(all(not is_test_only(g) and split_part(g) == part for g in groups),
             f"{source} {part}: test-only group or group assigned to a different split")
    if source == "aod4":
        _require(not any(g.casefold().startswith(("aod4:misc:yt-", "aod4:misc:v_")) for g in groups),
                 f"{source} {part}: excluded YouTube/Svanstrom material in group IDs")
    if source == "openimages":
        _require(all((g, part) in credits for g in groups), f"Open Images {part}: missing per-image credit/licence")
    return groups


def _inventory(paths):
    texts = _anchors()
    split = json.loads(texts[MENDELEY])
    frozen = json.loads(texts[FROZEN])["tiers"]["dataset"]["visual"]["items"]
    frozen_names = {PurePosixPath(row["path"]).name for row in frozen}
    svan = {row["clip"]: (row["part"], row["youtube"]) for row in json.loads(texts[SVAN])["clips"]}
    credits = {(row["ImageID"], row["Part"]) for row in csv.DictReader(io.StringIO(texts[CREDITS]))
               if row["Author"] and row["OriginalLandingURL"]
               and row["License"] == "https://creativecommons.org/licenses/by/2.0/"}
    splits, train_groups = {}, {}
    with np.load(paths[LINEAGE], allow_pickle=False) as lineage:
        for source, part, stem, suffixes, versions in _parts():
            x_path = paths[f"{stem}_X.npy"]
            x = np.load(x_path, mmap_mode="r", allow_pickle=False)
            _require(isinstance(x, np.memmap) and x.dtype == np.uint8 and x.ndim == 5
                     and x.shape[1:] == (versions, 64, 64, 3) and len(x) > 0
                     and x.offset + x.nbytes == x_path.stat().st_size, f"Invalid uint8 crop array: {x_path.name}")
            rows = len(x)
            del x
            if source == "mendeley":
                y = np.load(paths[f"{stem}_y.npy"], allow_pickle=False)
                groups = _mendeley_groups(lineage, part, rows, split, frozen_names)
            else:
                with np.load(paths[f"{stem}_meta.npz"], allow_pickle=False) as meta:
                    y = meta["y"]
                    groups = (_svan_groups(meta, part, rows, svan) if source == "svanstrom"
                              else _v4_groups(meta, source, part, rows, credits))
            _require(isinstance(y, np.ndarray) and y.shape == (rows,) and y.dtype == np.int64
                     and y.min() >= 0 and y.max() < len(CLASSES), f"Invalid int64 labels: {stem}")
            counts = {name: int((y == i).sum()) for i, name in enumerate(CLASSES)}
            stats = {"crops": rows, "groups": len(groups), **counts}
            if "info.json" in suffixes:
                info_path = paths[f"{stem}_info.json"]
                info = json.loads(info_path.read_text(encoding="utf-8"))
                expected = {"source": source, "part": part, **stats}
                _require(all(info.get(k) == v for k, v in expected.items()), f"Inconsistent summary: {info_path.name}")
            if part == "train":
                train_groups[source] = groups
            else:
                _require(not train_groups[source] & groups, f"{source}: group overlap between train and SELECT")
            splits.setdefault(source, {})[part] = stats
    _require(all(sum(s["train"][name] for s in splits.values()) for name in CLASSES),
             "Training corpus must contain all three classes")
    return splits


def _sha256(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _evidence(data, files):
    evidence = json.loads(data)
    _require(type(evidence["schema_version"]) is int and evidence["schema_version"] == 1, "Unsupported evidence schema")
    locked_files = evidence["files"]
    _require(locked_files.keys() == files.keys(), "Evidence must name exactly the required train/SELECT artifacts")
    changed = [rel for rel, digest in files.items() if locked_files[rel] != digest]
    _require(not changed, "Corpus SHA-256 mismatch: " + ", ".join(changed))

    sources = evidence["sources"]
    _require(sources.keys() == set(SOURCES), "Evidence is missing a source or includes an unapproved source")
    for source, record in sources.items():
        _require(_sha256(record["upstream_manifest_sha256"])
                 and type(record["input_bytes"]) is int and record["input_bytes"] > 0
                 and record["train_select_rights_confirmed"] is True
                 and all(isinstance(record[k], str) and record[k].strip()
                         for k in ("revision", "attribution", "rights_review")),
                 f"{source}: missing upstream file lock, byte count, revision, or rights/attribution review")
        for archive, pin in ARCHIVE_PINS.get(source, {}).items():
            _require(record["archive_digests"].get(archive) == pin,
                     f"{source}: missing or mismatched published digest for {archive}")

    audit = evidence["duplicate_audit"]
    _require(audit["max_hamming"] == 6 and _sha256(audit["svan_test_phash_sha256"])
             and audit["fbd_sv_excluded"] is True
             and isinstance(audit["review"], str) and audit["review"].strip(),
             "Missing SHA-256/pHash audit review, Svanstrom reference digest, or FBD-SV exclusion")
    checks = audit["checks"]
    _require(checks.keys() == set(AUDIT_SCOPES), "Duplicate audit must cover all three non-FBD scopes")
    for scope, check in checks.items():
        _require(type(check["items_checked"]) is int and check["items_checked"] > 0
                 and all(type(check[k]) is int and check[k] == 0
                         for k in ("exact_matches", "unresolved_phash_matches")),
                 f"Missing checks or unresolved duplicates: {scope}")
        if scope != AUDIT_SCOPES[-1]:
            _require(type(check["overlapping_groups"]) is int and check["overlapping_groups"] == 0,
                     f"Unresolved source/group overlap: {scope}")
    return evidence


def _inspect(data_root, inventory_only=False):
    try:
        paths = _input_paths(Path(data_root).resolve(), inventory_only)
        splits = _inventory(paths)
        files = {}
        for rel, path in paths.items():
            if rel != EVIDENCE:
                with path.open("rb") as f:
                    files[rel] = hashlib.file_digest(f, "sha256").hexdigest()
        result = {"schema_version": 1, "status": "inventory_only", "files": files, "anchors": ANCHORS, "splits": splits}
        if not inventory_only:
            data = paths[EVIDENCE].read_bytes()
            result.update(status="verified_train_select", evidence_sha256=hashlib.sha256(data).hexdigest(),
                          evidence=_evidence(data, files))
        return result
    except CorpusError:
        raise
    except (OSError, KeyError, ValueError, TypeError, AttributeError, EOFError, BadZipFile) as exc:
        raise CorpusError(f"Invalid corpus artifact or evidence: {exc}") from exc


def verify_corpus(data_root: Path) -> dict:
    """Check a previously audited bundle. Does not read test bytes or run a benchmark."""
    return _inspect(data_root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=REPO / "data")
    parser.add_argument("--inventory-only", action="store_true", help="Emit file locks for audit; not training clearance")
    args = parser.parse_args()
    try:
        print(json.dumps(_inspect(args.data_root, args.inventory_only), indent=2, sort_keys=True))
    except CorpusError as exc:
        print(f"Corpus preflight BLOCKED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
