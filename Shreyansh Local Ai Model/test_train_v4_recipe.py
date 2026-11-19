import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from train_v4 import load_sources

BASELINE = "klim_skagen:3,svanstrom:3,openimages:1"
DRONE_X2 = BASELINE + ",dut_anti_uav:2,synth_cranfield:2"
TRAINER = Path(__file__).with_name("train_v4.py").resolve()


class WeightRecipeTest(unittest.TestCase):
    def setUp(self):
        data = tempfile.TemporaryDirectory()
        self.addCleanup(data.cleanup)
        self.data = Path(data.name)
        v2, v3, v4 = (self.data / f"shreyansh_crops_v{v}" for v in (2, 3, 4))
        for directory in (v2, v3, v4):
            directory.mkdir()
        np.save(v2 / "fit_y.npy", np.zeros(30001, dtype=np.int64))
        np.save(v2 / "holdout_y.npy", [0, 1, 2])
        samples = {
            v3 / "svan": [0, 1, 2, 0, 1, 2],
            v4 / "dut_anti_uav": [1, 1, 2, 2],
            v4 / "klim_skagen": [0, 0, 2],
            v4 / "openimages": [0, 2],
            v4 / "synth_athkot": [0, 1, 2],
            v4 / "synth_cranfield": [1, 1, 2],
        }
        for prefix, y in samples.items():
            np.savez(prefix.with_name(prefix.name + "_train_meta.npz"), y=y, group=["train"] * len(y))
            np.savez(prefix.with_name(prefix.name + "_select_meta.npz"), y=y[:2], group=["select"] * 2)
        for name in ("dut_anti_uav_test_meta.npz", "fbdsv2024_testonly_train_meta.npz"):
            (v4 / name).write_bytes(b"must not be read")

    def preview(self, recipe):
        return subprocess.run(
            [sys.executable, "-B", str(TRAINER), "--dry-run", "--data-dir", str(self.data),
             "--seed", "44", "--batch", "8", "--epochs", "4", "--lr", "0.001", "--weights", recipe],
            text=True, capture_output=True, check=False,
        )

    def test_paired_recipes_use_the_same_splits(self):
        baseline, candidate = [self.preview(recipe) for recipe in (BASELINE, DRONE_X2)]
        for run in (baseline, candidate):
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertNotIn("testonly", run.stdout)
            self.assertIn("seed=44 batch=8 epochs=4 lr=0.001", run.stdout)
        baseline_changes = {
            "dut_anti_uav 4 (x1)": "dut_anti_uav 4 (x2)",
            "synth_cranfield 3 (x1)": "synth_cranfield 3 (x2)",
            "dut_anti_uav: bird=0 drone=2 other=2 | draws/epoch=4":
                "dut_anti_uav: bird=0 drone=2 other=2 | draws/epoch=8",
            "synth_cranfield: bird=0 drone=2 other=1 | draws/epoch=3":
                "synth_cranfield: bird=0 drone=2 other=1 | draws/epoch=6",
            "per epoch 30039": "per epoch 30046",
            "steps/epoch=3755": "steps/epoch=3756",
        }
        expected = baseline.stdout
        for before, after in baseline_changes.items():
            self.assertIn(before, expected)
            expected = expected.replace(before, after)
        self.assertEqual(candidate.stdout, expected)

    def test_rejects_invalid_or_unavailable_overrides(self):
        for recipe, error in (
            ("dut_anti_uav:0", "positive_integer"),
            ("dut_anti_uav:1,dut_anti_uav:2", "repeats"),
            ("fbdsv2024_testonly:2", "unavailable training source"),
        ):
            with self.subTest(recipe=recipe):
                run = self.preview(recipe)
                self.assertEqual(run.returncode, 2)
                self.assertIn(error, run.stderr)
                self.assertEqual(run.stdout, "")

    def test_digest_detects_a_select_group_change_with_the_same_labels(self):
        baseline = self.preview(BASELINE)
        meta = self.data / "shreyansh_crops_v4" / "dut_anti_uav_select_meta.npz"
        np.savez(meta, y=[1, 1], group=["different", "different"])
        changed = self.preview(BASELINE)

        def non_digest_output(run):
            self.assertEqual(run.returncode, 0, run.stderr)
            return [line for line in run.stdout.splitlines() if not line.startswith("train/select metadata SHA-256:")]

        self.assertEqual(non_digest_output(baseline), non_digest_output(changed))
        self.assertNotEqual(baseline.stdout, changed.stdout)

    def test_crop_loader_still_serves_training_callers(self):
        for labels in (self.data / "shreyansh_crops_v2").glob("*_y.npy"):
            np.save(labels.with_name(labels.name.replace("_y.npy", "_X.npy")), np.zeros_like(np.load(labels)))
        v3 = self.data / "shreyansh_crops_v3"
        v4 = self.data / "shreyansh_crops_v4"
        for prefix in (v3 / "svan", v4 / "dut_anti_uav"):
            for part in ("train", "select"):
                name = f"{prefix.name}_{part}"
                with np.load(prefix.with_name(name + "_meta.npz")) as meta:
                    np.save(prefix.with_name(name + "_X.npy"), np.zeros_like(meta["y"]))
        with patch("train_v4.DATA", self.data):
            train, select = load_sources()
        self.assertEqual([(n, w) for n, _, _, w in train],
                         [("mendeley", 1), ("svanstrom", 2), ("dut_anti_uav", 1)])
        self.assertEqual([n for n, _, _ in select], ["mendeley", "svanstrom", "dut_anti_uav"])
        self.assertTrue(all(isinstance(row[1], np.memmap) for row in train + select))

    def test_requires_select_metadata_for_the_paired_preflight(self):
        np.savez(self.data / "shreyansh_crops_v4" / "dut_anti_uav_select_meta.npz",
                 y=np.empty(0, dtype=np.int64))
        run = self.preview(DRONE_X2)
        self.assertEqual(run.returncode, 2)
        self.assertIn("missing or empty select metadata for: dut_anti_uav", run.stderr)


if __name__ == "__main__":
    unittest.main()
