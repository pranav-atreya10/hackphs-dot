"""Offline tests for the v5 ONNX validation gate."""

import subprocess
import sys
import tempfile
import unittest
from importlib.util import find_spec
from pathlib import Path
from types import SimpleNamespace

from validate_v5_onnx import (
    check_binding, check_graph, check_logits, missing_modules, read_artifact, synthetic_crops, validate,
)

MISSING = missing_modules()
HERE = Path(__file__).resolve().parent


class OnnxGateTests(unittest.TestCase):
    def test_artifact_byte_limit_includes_exact_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model.onnx"
            with path.open("wb") as file:
                file.truncate(20_000_000)
            self.assertEqual(len(read_artifact(path)), path.stat().st_size)
            with path.open("ab") as file:
                file.write(b"\0")
            with self.assertRaisesRegex(ValueError, "exceeds 20 MB"):
                read_artifact(path)

    def test_binding_rejects_fixed_batch_wrong_layout_and_type(self):
        name = "crop96_normalised"
        for kind, shape in (("tensor(float)", [1, 3, 96, 96]), ("tensor(float)", ["n", 96, 96, 3]),
                            ("tensor(uint8)", ["n", 3, 96, 96])):
            with self.subTest(kind=kind, shape=shape), self.assertRaisesRegex(ValueError, "dynamic batch"):
                check_binding([SimpleNamespace(name=name, type=kind, shape=shape)], name, (3, 96, 96))
        check_binding([SimpleNamespace(name=name, type="tensor(float)", shape=["n", 3, 96, 96])], name, (3, 96, 96))

    @unittest.skipUnless(find_spec("numpy"), "NumPy is unavailable")
    def test_logits_reject_wrong_columns_and_nonfinite_values(self):
        import numpy as np

        logits = np.array([[0.5, -0.75, 1.0]], dtype=np.float32)
        self.assertAlmostEqual(check_logits(logits + 1e-6, logits, (1, 3)), 1e-6, places=7)
        with self.assertRaisesRegex(AssertionError, "Logits differ"):
            check_logits(logits[:, [1, 0, 2]], logits, (1, 3))
        with self.assertRaisesRegex(ValueError, "finite"):
            check_logits(np.array([[np.nan, -0.75, 1.0]], dtype=np.float32), logits, (1, 3))

    @unittest.skipUnless(find_spec("onnx"), "ONNX graph check unavailable: missing onnx")
    def test_graph_rejects_external_tensor_in_node_attribute(self):
        from onnx import TensorProto, helper

        tensor = TensorProto(name="payload", data_type=TensorProto.FLOAT, dims=[1], data_location=TensorProto.EXTERNAL)
        tensor.external_data.add(key="location", value="weights.bin")
        node = helper.make_node("Constant", [], ["out"], value=tensor)
        graph = helper.make_graph([node], "external", [], [helper.make_tensor_value_info("out", TensorProto.FLOAT, [1])])
        with self.assertRaisesRegex(ValueError, "uses external data"):
            check_graph(helper.make_model(graph).SerializeToString())

    @unittest.skipIf(MISSING, f"v5 MobileNet export/parity unavailable: missing {', '.join(MISSING)}")
    def test_trainer_exports_match_pytorch(self):
        import torch

        from train_v5_mobilenet import build, norm, prep

        with tempfile.TemporaryDirectory() as tmp:
            for arch in ("mobilenet_v3_large", "mobilenet_v3_small"):
                with self.subTest(arch=arch):
                    torch.manual_seed(45)
                    model = build(arch, pretrained=False).train()
                    # Measure synthetic BatchNorm statistics so the random network's logits are not nearly constant.
                    for layer in model.modules():
                        if isinstance(layer, torch.nn.BatchNorm2d):
                            layer.momentum = 1.0
                    with torch.no_grad():
                        model(norm(prep(synthetic_crops(), "cpu")))
                    checkpoint = Path(tmp) / f"{arch}.pt"
                    torch.save({"arch": arch, "model": model.state_dict()}, checkpoint)
                    subprocess.run([sys.executable, "-B", str(HERE / "train_v5_mobilenet.py"),
                                    "--export", str(checkpoint), "--arch", arch], check=True)
                    onnx_path = checkpoint.with_suffix(".onnx")
                    exported_arch, size, _, batch_errors = validate(checkpoint, onnx_path)
                    self.assertEqual((exported_arch, size), (arch, onnx_path.stat().st_size))
                    self.assertEqual(tuple(batch_errors), (1, 3))


if __name__ == "__main__":
    unittest.main()
