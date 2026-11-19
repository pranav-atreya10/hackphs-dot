import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from site_release_gate import check, read_pinned


class SiteReleaseGateTest(unittest.TestCase):
    def setUp(self):
        self.ident = dict(site="synthetic fixture", release_sha256="a" * 64,
                          installation_sha256="b" * 64, plan_sha256="c" * 64)
        common = {k: v for k, v in self.ident.items() if k != "plan_sha256"}
        self.plan = dict(schema=1, **common, strata={"night": {
            "drone_recall": dict(limit=0.8, min_sessions=4, min_exposure=30),
            "false_alarms_per_hour": dict(limit=0.2, min_sessions=4, min_exposure=20),
        }})
        self.evidence = dict(schema=1, **self.ident, dataset_kind="independent_airport_field",
                             leakage_check="passed", bootstrap_resamples=1000,
                             evidence_bundle_sha256="d" * 64, strata={"night": {
                                 "drone_recall": dict(sessions=4, exposure=40, count=36, value=.9, lo=.8, hi=.96),
                                 "false_alarms_per_hour": dict(sessions=5, exposure=20, count=0, value=0, lo=0, hi=.2),
                             }})

    def check(self):
        check(self.plan, self.evidence, **self.ident)

    def test_exact_bounds_pass(self):
        self.check()

    def test_wrong_dataset_or_incomplete_strata_fail(self):
        self.evidence["dataset_kind"] = "synthetic"
        with self.assertRaisesRegex(ValueError, "independent airport"):
            self.check()
        self.evidence["dataset_kind"] = "independent_airport_field"
        self.evidence["strata"] = {}
        with self.assertRaisesRegex(ValueError, "strata mismatch"):
            self.check()

    def test_confidence_and_exposure_rule(self):
        metric = self.evidence["strata"]["night"]["false_alarms_per_hour"]
        for updates, expected in (({"hi": 0.21}, "bound misses"), ({"hi": 0}, "nonzero upper"),
                                  ({"exposure": 19}, "insufficient exposure"), ({"sessions": 3}, "independent sessions")):
            with self.subTest(updates=updates):
                original = metric.copy()
                metric.update(updates)
                with self.assertRaisesRegex(ValueError, expected):
                    self.check()
                metric.update(original)

    def test_modified_pinned_input_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            plan_file = Path(folder) / "plan.json"
            original = json.dumps(self.plan).encode()
            plan_file.write_bytes(original)
            sha256 = hashlib.sha256(original).hexdigest()
            self.assertEqual(read_pinned(plan_file, sha256), self.plan)
            plan_file.write_bytes(original + b"\n")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                read_pinned(plan_file, sha256)
