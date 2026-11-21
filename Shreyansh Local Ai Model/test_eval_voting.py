import gc
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from eval_voting import (
    ARCHIVES, FBD, LEGACY, TRACK, archive_cohorts, grouped_rate, run_report, sha256_file, windows,
)


def fbd_metadata():
    return {
        "y": np.array([0, 0, 0, 0, 0, 2, 2]),
        "group": np.array(["train/bird_12"] * 4 + ["val/bird_12"] + ["val/bird_3"] * 2),
    }


class VoteWindowTests(unittest.TestCase):
    def test_explicit_tracks_sort_frames_without_crossing_clips_or_tracks(self):
        y = np.zeros(9, dtype=int)
        clips = np.array(["A", "A", "B", "A", "A", "A", "B", "A", "A"])
        tracks = np.array([1, 2, 1, 1, 2, 1, 1, 1, 1])
        frames = np.array([40, 20, 10, 10, 10, 20, 20, 30, 50])
        keep = np.ones(9, dtype=bool)
        keep[8] = False
        # Track ID 1 is reused in another clip; several tracks occur at frame 10.
        np.testing.assert_array_equal(
            windows(y, clips, keep, 2, tracks=tracks, frames=frames), [[3, 5], [7, 0], [4, 1], [2, 6]]
        )

    def test_legacy_is_storage_order_separately_for_each_clip_and_class(self):
        meta = {"y": np.array([0, 2, 0, 2, 0, 0, 0]),
                "group": np.array(["A", "A", "A", "A", "B", "A", "A"]),
                "frame_index": np.array([40, 40, 40, 10, 20, 20, 10])}
        crops = np.zeros((len(meta["y"]), 1, 64, 64, 3), dtype=np.uint8)
        (row,) = archive_cohorts(crops, meta, ARCHIVES[0][1], 2)
        self.assertEqual(row.window_unit, LEGACY)
        self.assertTrue(row.has_frame_indices)
        np.testing.assert_array_equal(row.windows, [[0, 2], [5, 6], [1, 3]])

    def test_track_metadata_does_not_fall_back_on_invalid_order_or_identity(self):
        crops = np.zeros((7, 1, 64, 64, 3), dtype=np.uint8)
        base = fbd_metadata()
        base["track_id"] = np.array([4, 4, 5, 5, 4, 4, 4])
        valid = np.array([20, 10, 20, 10, 10, 20, 10])
        (row,) = archive_cohorts(crops, {**base, "frame_index": valid}, ARCHIVES[0][1], 2)
        self.assertEqual(row.window_unit, TRACK)
        np.testing.assert_array_equal(row.windows, [[1, 0], [3, 2], [6, 5]])
        for overrides, error in (
            ({}, "track_id requires frame_index"),
            ({"frame_index": np.array([10, 10, 20, 10, 10, 20, 10])}, "repeated frame_index"),
            ({"frame_index": valid, "y": np.array([0, 2, 0, 0, 0, 2, 2])}, "mixed classes"),
            ({"frame_index": valid.astype(float)}, "frame_index.*expected length and type"),
        ):
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                archive_cohorts(crops, {**base, **overrides}, ARCHIVES[0][1], 2)

    def test_available_identity_vectors_are_checked_before_voting(self):
        crops = np.zeros((7, 1, 64, 64, 3), dtype=np.uint8)
        for overrides, error in (
            ({"sample_id": np.array([0, 1, 2, 3, 3, 5, 6])}, "sample_id.*duplicate"),
            ({"sample_id": np.arange(6)}, "sample_id.*expected length"),
            ({"group": np.array(["A"] * 6 + [" "])}, "group.*invalid"),
            ({"group": np.zeros(7, dtype=float)}, "group.*type"),
        ):
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                archive_cohorts(crops, {**fbd_metadata(), **overrides}, ARCHIVES[0][1], 2)

    def test_grouped_interval_resamples_whole_clips_not_crops_or_tracks(self):
        hits = np.array([True] * 30 + [False] * 10)
        eligible = np.ones(40, dtype=bool)
        clips = np.array(["first"] * 30 + ["second"] * 10)
        actual = grouped_rate(hits, eligible, clips)
        self.assertEqual(actual, {"value": 0.75, "ci95": [0.0, 1.0], "n": 40, "groups": 2})
        self.assertEqual(actual, grouped_rate(hits[::-1], eligible, clips[::-1]))


class VoteReportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.tmp = Path(directory.name)
        self.data = self.tmp / "data"
        self.out = self.tmp / "new_vote_run"
        self.fbd_pins = self.tmp / "fbd_pins.json"
        self.svan_pins = self.tmp / "svan_pins.json"
        self.sha = {}
        meta = fbd_metadata()
        meta["sample_id"] = np.arange(len(meta["y"]))
        self.fbd_meta = self.write_archive(ARCHIVES[0], meta)
        self.write_archive(ARCHIVES[1], {
            "y": np.array([1, 1, 2, 2]),
            "clip": np.array([0, 0, 1, 1]), "clip_names": np.array(["train/bird_12", "yt"]),
            "youtube": np.array([False, True]),
        })
        self.write_archive(ARCHIVES[2], {
            "y": np.array([0] * 6),
            "clip": np.array([0] * 6), "clip_names": np.array(["train/bird_12"]),
            "youtube": np.array([False]), "size": np.array([7, 10, 13, 7, 10, 13]),
        })
        self.predictor = Mock(checkpoint_sha256="b" * 64)
        self.loader = Mock(return_value=self.predictor)
        self.predictor.predict_proba.side_effect = [
            np.array([[.4, .5, .1], [.8, .1, .1], [.8, .1, .1], [.7, .1, .2],
                      [.9, .05, .05], [.4, .1, .5], [.1, .1, .8]], dtype=np.float32),
            np.full((4, 3), 1 / 3, dtype=np.float32),
            np.full((6, 3), 1 / 3, dtype=np.float32),
        ]
        # The mocked predictor holds mmap arguments on Windows; release them before temp cleanup.
        self.addCleanup(self.clear_predictor_calls)

    def clear_predictor_calls(self):
        self.predictor.reset_mock()
        gc.collect()

    def write_archive(self, archive, meta):
        folder, stem = archive
        dest = self.data / folder
        dest.mkdir(parents=True, exist_ok=True)
        x, m = dest / f"{stem}_X.npy", dest / f"{stem}_meta.npz"
        np.save(x, np.zeros((len(meta["y"]), 1, 64, 64, 3), dtype=np.uint8))
        np.savez(m, **meta)
        self.sha.update({file.name: sha256_file(file) for file in (x, m)})
        if archive == ARCHIVES[0]:
            pins = {"crops_sha256": self.sha[x.name], "metadata_sha256": self.sha[m.name]}
            self.fbd_pins.write_text(json.dumps(pins), encoding="utf-8")
        else:
            pins = {name: digest for name, digest in self.sha.items() if name.startswith("svan_")}
            self.svan_pins.write_text(json.dumps(pins), encoding="utf-8")
        return m

    def run_synthetic(self, n=2):
        return run_report(Path("checkpoint.pt"), "skynetlite", self.out, n, self.fbd_pins, self.svan_pins,
                          data=self.data, predictor_loader=self.loader)

    def test_report_headlines_fbd_and_keeps_each_denominator_and_group_separate(self):
        text = self.run_synthetic()
        report_path = self.out / "voting_2.json"
        original = report_path.read_bytes()
        report = json.loads(original)
        self.assertEqual(next(iter(report["sources"])), FBD)
        self.assertEqual(report["headline_source"], FBD)
        self.assertEqual(report["checkpoint_sha256"], "b" * 64)
        self.assertEqual(report["frozen_inputs_sha256"], self.sha)
        row = report["sources"][FBD]
        self.assertEqual(row["window_unit"], LEGACY)
        self.assertEqual(row["crops_outside_complete_windows"], 1)
        bird = row["metrics"]["bird_recall"]
        self.assertEqual(bird["all_crops"]["n"], 5)
        self.assertEqual(bird["all_crops"]["groups"], 2)
        self.assertEqual(bird["all_crops"]["value"], .8)
        self.assertEqual(bird["first_crop_per_window"], {"value": .5, "ci95": [.5, .5], "n": 2, "groups": 1})
        self.assertEqual(bird["vote_per_window"], {"value": 1, "ci95": [1, 1], "n": 2, "groups": 1})
        # A single contributing clip cannot show between-clip variation.
        self.assertEqual(bird["vote_vs_first_ci_overlap"], "not significant")
        self.assertIsNone(row["metrics"]["drone_recall"]["vote_per_window"])
        self.assertEqual(row["metrics"]["false_alarm"]["vote_vs_first_ci_overlap"], "not significant")
        self.assertEqual(report["sources"]["Svanstrom (real size)"]["metrics"]["drone_recall"]
                         ["vote_per_window"]["n"], 1)
        self.assertIn(f"**Headline: {FBD}.**", text)
        self.assertIn("n=2, clips=1", text)
        self.assertIn("same complete windows", text)
        self.loader.assert_called_once_with(Path("checkpoint.pt"), arch="skynetlite")
        self.assertEqual(self.predictor.predict_proba.call_count, 3)
        self.assertTrue(all(call.kwargs == {"batch_size": 512}
                            for call in self.predictor.predict_proba.call_args_list))
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.run_synthetic()
        self.assertEqual(report_path.read_bytes(), original)
        self.loader.assert_called_once()

    def test_missing_headline_metadata_stops_before_model_or_output(self):
        self.fbd_meta.rename(self.fbd_meta.with_suffix(".missing"))
        with self.assertRaisesRegex(ValueError, "missing frozen headline FBD-SV"):
            self.run_synthetic()
        self.loader.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_missing_headline_window_denominator_stops_before_model_or_output(self):
        with self.assertRaisesRegex(ValueError, "requires complete bird and background windows"):
            self.run_synthetic(n=3)
        self.loader.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_changed_frozen_input_stops_before_model_or_output(self):
        with self.fbd_meta.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum mismatch: fbdsv2024_testonly_test_meta"):
            self.run_synthetic()
        self.loader.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_present_but_unpinned_headline_metadata_stops_before_model_or_output(self):
        self.fbd_pins.write_text(json.dumps({"crops_sha256": self.sha["fbdsv2024_testonly_test_X.npy"]}),
                                 encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "missing or invalid approved SHA-256 for fbdsv2024_testonly_test_meta"):
            self.run_synthetic()
        self.loader.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_normal_run_requires_protocol_manifest_before_scoring(self):
        manifest_path = self.tmp / "benchmarks" / "test_sets.json"
        manifest_path.parent.mkdir()
        manifest_path.write_text('{"tiers": {}}', encoding="utf-8")
        verifier = Mock(side_effect=ValueError("test-set verification failed"))
        with (patch("eval_voting.ROOT", self.tmp), patch("eval_voting.DATA", self.data),
              patch.dict("sys.modules", {"bench.manifest": Mock(verify=verifier)})):
            with self.assertRaisesRegex(ValueError, "test-set verification failed"):
                self.run_synthetic()
        verifier.assert_called_once_with({"tiers": {}}, include_holdout=False)
        self.loader.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_refuses_predictions_with_wrong_number_of_samples(self):
        self.predictor.predict_proba.side_effect = None
        self.predictor.predict_proba.return_value = np.ones((1, 3))
        with self.assertRaisesRegex(ValueError, "predictor must return aligned"):
            self.run_synthetic()
        self.loader.assert_called_once()
        self.assertFalse(self.out.exists())

    def test_uses_shared_adapter_for_mobilenet(self):
        adapter = SimpleNamespace(ARCHITECTURES=("mobilenet_v3_large",), load_predictor=self.loader)
        checkpoint = Path("mobilenet.pt")
        with patch.dict("sys.modules", {"eval_inference": adapter}):
            run_report(checkpoint, "mobilenet_v3_large", self.out, 2, self.fbd_pins, self.svan_pins,
                       data=self.data)
        self.loader.assert_called_once_with(checkpoint, arch="mobilenet_v3_large")
        self.assertEqual(self.predictor.predict_proba.call_count, 3)


if __name__ == "__main__":
    unittest.main()
