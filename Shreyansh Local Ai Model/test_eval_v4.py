import contextlib
import hashlib
import importlib.util
import io
import json
import pickle
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

import eval_v4
from eval_inference import ARCHITECTURES, CropPredictor, load_predictor


class InferenceTests(unittest.TestCase):
    def test_explicit_dispatch_and_weights_only_load(self):
        state = {"weight": object()}
        torch = Mock()
        torch.is_tensor.return_value = True
        model = Mock()
        model.to.return_value.eval.return_value = model
        sky = SimpleNamespace(SkyNetLite=Mock(return_value=model))
        train = SimpleNamespace(norm=Mock(), to_tensor=Mock())
        mobile = SimpleNamespace(build=Mock(return_value=model), norm=Mock(), prep=Mock())
        modules = {"torch": torch, "model": sky, "train": train, "train_v5_mobilenet": mobile}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, modules):
            path = Path(tmp) / "fixture.pt"
            path.write_bytes(b"synthetic mocked checkpoint")
            for arch in ARCHITECTURES:
                with self.subTest(arch=arch):
                    torch.load.return_value = state if arch == "skynetlite" else {"model": state, "arch": arch}
                    predictor = load_predictor(path, arch=arch)
                    args, kwargs = torch.load.call_args
                    self.assertEqual(args[0].getvalue(), path.read_bytes())
                    self.assertEqual(kwargs, {"map_location": "cpu", "weights_only": True})
                    model.load_state_dict.assert_called_with(state, strict=True)
                    self.assertEqual(predictor.checkpoint_sha256, hashlib.sha256(path.read_bytes()).hexdigest())
                    rgb = object()
                    predictor._preprocess(rgb)
                    if arch == "skynetlite":
                        sky.SkyNetLite.assert_called_once_with()
                        train.to_tensor.assert_called_once_with(rgb)
                        train.norm.assert_called_once_with(train.to_tensor.return_value)
                    else:
                        mobile.build.assert_called_with(arch, pretrained=False)
                        mobile.prep.assert_called_with(rgb, "cpu")
                        mobile.norm.assert_called_with(mobile.prep.return_value)
            model.load_state_dict.side_effect = RuntimeError("size mismatch")
            with self.assertRaisesRegex(ValueError, "weights do not match mobilenet_v3_small"):
                load_predictor(path, arch="mobilenet_v3_small")

    def test_rejects_unidentifiable_mismatched_and_unsafe_checkpoints(self):
        torch = Mock()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {"torch": torch}):
            path = Path(tmp) / "fixture.pt"
            path.touch()
            for payload, arch, error in (
                ({"model": {"w": object()}, "arch": "mobilenet_v3_large"}, "skynetlite", "does not match"),
                ({"model": {"w": object()}}, "mobilenet_v3_small", "requires the 'arch' tag"),
                ({"model": None}, "skynetlite", "must be a nonempty state dict"),
            ):
                with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                    torch.load.return_value = payload
                    load_predictor(path, arch=arch)
            torch.load.reset_mock(side_effect=True)
            torch.load.side_effect = pickle.UnpicklingError("not a supported weights-only fixture")
            with self.assertRaisesRegex(ValueError, "could not read a weights-only checkpoint"):
                load_predictor(path, arch="skynetlite")
            self.assertEqual(torch.load.call_count, 1)

    def test_batch_and_probability_contract_without_torch(self):
        class FakeLogits(np.ndarray):
            def softmax(self, dim):
                exp = np.exp(self)
                return exp / exp.sum(axis=dim, keepdims=True)

            def numpy(self):
                return np.asarray(self)

        X = np.zeros((3, 2, 64, 64, 3), dtype=np.uint8)
        X[:, 0, 0, 0, 0] = [2, 0, 1]
        X[:, 1, 0, 0, 0] = [1, 2, 0]
        X.setflags(write=False)

        def forward(rgb):
            self.assertTrue(rgb.flags.c_contiguous and rgb.flags.writeable)
            return (np.eye(3, dtype=np.float32)[rgb[:, 0, 0, 0]] * np.log(2)).view(FakeLogits)

        model = Mock(side_effect=forward)
        predictor = CropPredictor(model, lambda rgb: rgb, "fake")
        runtime = SimpleNamespace(inference_mode=contextlib.nullcontext, isfinite=np.isfinite)
        with patch.dict(sys.modules, {"torch": runtime}):
            p = predictor.predict_proba(X, batch_size=2)
            self.assertEqual(p.dtype, np.float32)
            np.testing.assert_array_equal(p, [[0.25, 0.25, 0.5], [0.5, 0.25, 0.25], [0.25, 0.5, 0.25]])
            self.assertEqual([len(c.args[0]) for c in model.call_args_list], [2, 1])

    def _assert_parity(self, arch, model, preprocess, state):
        import torch

        X = np.random.default_rng(42).integers(0, 256, (3, 2, 64, 64, 3), dtype=np.uint8)
        with tempfile.TemporaryDirectory() as tmp, torch.inference_mode():
            path = Path(tmp) / "random_weights.pt"
            torch.save(state, path)
            predictor = load_predictor(path, arch=arch)
            X.setflags(write=False)
            logits = model.eval()(preprocess(X[:, 0].copy()))
            pred = predictor.predict_proba(X, batch_size=2)
            self.assertEqual(pred.shape, (3, 3))
            np.testing.assert_allclose(pred, logits.softmax(1).numpy(), rtol=1e-5, atol=1e-7)
            np.testing.assert_array_equal(predictor.predict(X, batch_size=1), logits.argmax(1).numpy())
            self.assertEqual(predictor.predict_proba(X[:0]).shape, (0, 3))

    @unittest.skipUnless(importlib.util.find_spec("torch"), "PyTorch is not installed")
    def test_skynetlite_fp32_parity_and_incompatible_head(self):
        import torch

        from model import SkyNetLite
        from train import norm, to_tensor

        torch.manual_seed(42)
        model = SkyNetLite()
        self._assert_parity("skynetlite", model, lambda rgb: norm(to_tensor(rgb)), {"model": model.state_dict()})
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "wrong_head.pt"
            torch.save(SkyNetLite(n_classes=2).state_dict(), path)
            with self.assertRaisesRegex(ValueError, "weights do not match skynetlite"):
                load_predictor(path, arch="skynetlite")

    @unittest.skipUnless(importlib.util.find_spec("torch") and importlib.util.find_spec("torchvision"),
                         "PyTorch and Torchvision are required")
    def test_mobilenet_fp32_parity(self):
        import torch

        from train_v5_mobilenet import build, norm, prep

        torch.manual_seed(42)
        for arch in ARCHITECTURES[1:]:
            with self.subTest(arch=arch):
                model = build(arch, pretrained=False)
                self._assert_parity(arch, model, lambda rgb: norm(prep(rgb, "cpu")),
                                    {"model": model.state_dict(), "arch": arch})


class CropReportTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.data = self.root / "data"
        self.v4 = self.data / "shreyansh_crops_v4"
        self.v4.mkdir(parents=True)

    def _v4_split(self, source, y, p, groups):
        X = np.zeros((len(y), 1, 64, 64, 3), dtype=np.uint8)
        X[:, 0, 0, 0, 0] = p
        crops = self.v4 / f"{source}_test_X.npy"
        meta = self.v4 / f"{source}_test_meta.npz"
        np.save(crops, X)
        np.savez(meta, y=np.array(y), size=np.full(len(y), 10), group=np.array(groups))
        return crops, meta

    @staticmethod
    def _predict(X):
        return X[:, 0, 0, 0, 0].copy()

    def test_test_only_rows_distinguish_zero_absent_class_and_missing_split(self):
        self._v4_split("aod4", [0] * 10 + [2], [0] * 8 + [2] * 3, ["a"] * 8 + ["b", "b", "c"])
        # If the suite picks up a selection file or arbitrary newly discovered source, this is unreadable.
        (self.v4 / "aod4_select_X.npy").touch()
        (self.v4 / "new_source_test_X.npy").touch()
        (self.v4 / "new_source_test_meta.npz").touch()
        rows = eval_v4.score_suite(SimpleNamespace(predict=self._predict), self.data)
        self.assertEqual(next(iter(rows)), eval_v4.FBD)
        self.assertEqual(rows[eval_v4.FBD]["status"], "missing_split")
        self.assertEqual(rows["aod4"]["bird_recall"], {"value": 0.8, "ci95": [0.0, 1.0], "n": 10, "clips": 2})
        self.assertIsNone(rows["aod4"]["drone_recall"])
        self.assertEqual(rows["aod4"]["false_alarm"], {"value": 0.0, "ci95": [0.0, 0.0], "n": 1, "clips": 1})
        report = eval_v4._report(rows, {"architecture": "skynetlite", "checkpoint_sha256": "fixture"})
        self.assertIn("no examples", report)
        self.assertIn("missing split", report)
        self.assertIn("groups=2", report)

    def test_unpinned_fbd_is_not_read_and_wrong_pins_are_refused(self):
        crops, meta = self._v4_split(eval_v4.FBD, [0], [0], ["clip"])
        predictor = Mock(predict=Mock(side_effect=self._predict))
        with patch.object(eval_v4.np, "load") as load:
            rows = eval_v4.score_suite(predictor, self.data)
            self.assertEqual(rows[eval_v4.FBD]["status"], "unpinned_split")
            load.assert_not_called()
        predictor.predict.assert_not_called()
        pins_file = self.root / "fixture_pins.json"
        pins_file.write_text(json.dumps({"crops_sha256": eval_v4.sha256_file(crops),
                                        "metadata_sha256": eval_v4.sha256_file(meta)}), encoding="utf-8")
        pins = eval_v4.read_fbd_pins(pins_file)
        wrong_pins = {**pins, "metadata_sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "differs from reviewed FBD-SV SHA-256 pin"):
            eval_v4.score_suite(predictor, self.data, fbd_pins=wrong_pins)
        predictor.predict.assert_not_called()
        rows = eval_v4.score_suite(SimpleNamespace(predict=self._predict), self.data, fbd_pins=pins)
        self.assertEqual(rows[eval_v4.FBD]["bird_recall"]["value"], 1.0)

    def test_unknown_label_is_refused_not_counted_as_other(self):
        self._v4_split("aod4", [3], [0], ["clip"])
        predictor = Mock()
        with self.assertRaisesRegex(ValueError, "unknown class code"):
            eval_v4.score_suite(predictor, self.data)
        predictor.predict.assert_not_called()

    def test_manifest_verification_excludes_field_holdout(self):
        import bench

        visual = {"items": [{"path": "image.jpg", "label_path": "label.txt"}]}
        tune = [{"path": "tune.mp4"}]
        manifest_path = self.root / "test_sets.json"
        manifest_path.write_text(json.dumps({"tiers": {"dataset": {"visual": visual}, "field": {
            "visual": {"splits": {"tune": tune, "holdout": [{"path": "protected.mp4"}]}}
        }}}), encoding="utf-8")
        verify_mendeley = Mock(return_value=(2, 2))
        verify_other = Mock(return_value=1)
        with (
            patch.object(bench, "manifest", SimpleNamespace(verify=verify_other), create=True),
            patch.dict(sys.modules, {"evaluate": SimpleNamespace(verify=verify_mendeley)}),
            patch.object(eval_v4, "BENCHMARKS", self.root),
        ):
            record = eval_v4._verify_benchmark_inputs()
        verify_mendeley.assert_called_once_with(visual, visual["items"])
        verify_other.assert_called_once_with(
            {"tiers": {"dataset": {}, "field": {"visual": {"splits": {"tune": tune}}}}},
            include_holdout=False,
        )
        self.assertEqual(record["n_test_files_verified"], 3)
        self.assertEqual(record["manifest_sha256"], eval_v4.sha256_file(manifest_path))

    def test_main_records_one_preselected_checkpoint_and_preserves_reports(self):
        self._v4_split("aod4", [0], [0], ["clip"])
        out = self.root / "output"
        argv = ["--checkpoint", "selected.pt", "--out", str(out)]
        predictor = SimpleNamespace(predict=self._predict, checkpoint_sha256="fixture")
        with (
            patch.object(eval_v4, "DATA", self.data),
            patch.object(eval_v4, "_verify_benchmark_inputs", return_value={"field_holdout": False}) as verify,
            patch.object(eval_v4, "load_predictor", return_value=predictor) as load,
            patch.object(eval_v4, "git_info", return_value={"commit": "abc", "dirty": False}),
            patch.object(eval_v4, "hardware_info", return_value={}),
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            eval_v4.main(argv)
            report_path = out / "all_tests.json"
            existing = report_path.read_bytes()
            with self.assertRaises(SystemExit):
                eval_v4.main(argv)
            self.assertEqual(report_path.read_bytes(), existing)
            verify.assert_called_once_with()
            load.assert_called_once_with(Path("selected.pt"), arch="skynetlite")
        record = json.loads((out / "all_tests_run.json").read_text(encoding="utf-8"))
        self.assertEqual(record["checkpoint_sha256"], "fixture")
        self.assertEqual(record["fbd_sv"]["leakage_audit"], "not_performed")


if __name__ == "__main__":
    unittest.main()
