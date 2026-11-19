import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from small_bird_preflight import check_intake


class SmallBirdPreflightTest(unittest.TestCase):
    def setUp(self):
        self.metadata = {
            "used_source_groups": ["fit-session", "tune-session"],
            "frames": [{
                "geometry": "native",
                "source_group": "test-session-a",
                "frame_id": "frame-0",
                "frame_size": [1920, 1080],
                "bird_boxes_xyxy": [[0, 0, 6.99, 2], [0, 20, 2, 27], [1918, 1065, 1920, 1080]],
            }],
        }
        self.frame = self.metadata["frames"][0]

    def test_native_boundaries_and_group_counts(self):
        self.metadata["frames"].extend([
            dict(self.frame, frame_id="frame-1", bird_boxes_xyxy=[[0, 0, 15.01, 2]]),
            dict(self.frame, source_group="test-session-b", bird_boxes_xyxy=[[10, 10, 19, 12]]),
            dict(self.frame, source_group="test-session-c", bird_boxes_xyxy=[]),
        ])
        self.assertEqual(check_intake(self.metadata), {
            "native_frames": 4,
            "source_groups": 3,
            "bird_boxes_by_native_size_px": {
                "<7": {"bird_boxes": 1, "source_groups": 1},
                "7-15": {"bird_boxes": 3, "source_groups": 2},
                ">15": {"bird_boxes": 1, "source_groups": 1},
            },
        })

    def test_rejects_source_overlap_even_when_frame_id_differs(self):
        for group in self.metadata["used_source_groups"]:
            with self.subTest(group=group):
                self.frame.update(source_group=group, frame_id="a-different-frame")
                with self.assertRaisesRegex(ValueError, "source-group overlap"):
                    check_intake(self.metadata)

    def test_rejects_duplicate_frames_within_one_session(self):
        self.metadata["frames"].append(self.frame.copy())
        with self.assertRaisesRegex(ValueError, "duplicates a frame"):
            check_intake(self.metadata)

    def test_rejects_proxies_and_missing_provenance(self):
        for geometry in ("resized", "cropped", "synthetic", None):
            with self.subTest(geometry=geometry):
                self.frame["geometry"] = geometry
                with self.assertRaisesRegex(ValueError, "native geometry"):
                    check_intake(self.metadata)
        self.frame["geometry"] = "native"
        self.frame["source_group"] = ""
        with self.assertRaisesRegex(ValueError, "source_group.*canonical ID"):
            check_intake(self.metadata)
        self.frame["source_group"] = "test-session-a"
        self.metadata["used_source_groups"] = []
        with self.assertRaisesRegex(ValueError, "used_source_groups"):
            check_intake(self.metadata)

    def test_rejects_boxes_outside_declared_frame_or_without_positive_area(self):
        for box in ([1918, 1065, 1921, 1080], [1, 1, 1, 2], [0, 0, float("nan"), 2]):
            with self.subTest(box=box):
                self.frame["bird_boxes_xyxy"] = [box]
                with self.assertRaisesRegex(ValueError, "within the native frame"):
                    check_intake(self.metadata)

    def test_cli_prints_only_coverage_and_fails_closed_on_overlap(self):
        script = Path(__file__).with_name("small_bird_preflight.py")
        with tempfile.TemporaryDirectory() as folder:
            metadata = Path(folder) / "intake.json"
            metadata.write_text(json.dumps(self.metadata), encoding="utf-8")
            cmd = [sys.executable, "-B", str(script), str(metadata)]
            good = subprocess.run(cmd, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(good.stdout), check_intake(self.metadata))

            self.frame["source_group"] = "tune-session"
            metadata.write_text(json.dumps(self.metadata), encoding="utf-8")
            bad = subprocess.run(cmd, capture_output=True, text=True, check=False)
            self.assertEqual(bad.returncode, 2)
            self.assertEqual(bad.stdout, "")
            self.assertIn("source-group overlap", bad.stderr)
