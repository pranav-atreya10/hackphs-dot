"""Offline unit tests for the v5 temporal kinematics head and 10-source pipeline."""

import json
import math
import shutil
import subprocess
import sys
import tempfile
import unittest
from importlib.util import find_spec
from pathlib import Path

import numpy as np

HAS_TORCH = find_spec("torch") is not None
HAS_ONNX = find_spec("onnx") is not None
HAS_ORT = find_spec("onnxruntime") is not None

if HAS_TORCH:
    import torch
    import torch.nn.functional as F
if HAS_ONNX:
    import onnx
if HAS_ORT:
    import onnxruntime as ort

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

if HAS_TORCH:
    from v5_temporal_kinematics import (  # noqa: E402
        ARCH,
        BROWSER_RUNTIME_JS,
        KINEMATICS_FEATURES,
        LABELS,
        MAX_ONNX_BYTES,
        MAX_PARAMETERS,
        NUM_CLASSES,
        NUM_KINEMATICS,
        SCHEMA_VERSION,
        WINDOW_SIZE,
        TemporalKinematicsHead,
        compute_kinematics_features,
        count_parameters,
        export_browser_json,
        export_onnx,
        load_browser_json,
        load_checkpoint,
        predict_temporal_window_js,
        run_browser_json,
        save_checkpoint,
        uniform_vote_probs,
        validate_chronological_frames,
    )
else:
    WINDOW_SIZE = 5
    NUM_CLASSES = 3
    NUM_KINEMATICS = 6

from run_v5_ten_source_pipeline import (  # noqa: E402
    FrozenTestAccessError,
    LeakageError,
    MAX_PHASH_HAMMING,
    N_BOOTSTRAP,
    PipelineGateError,
    TEN_SOURCES,
    audit_phash_leakage,
    audit_small_bird_sources,
    compute_phash_uint64,
    compute_phashes_uint64,
    enforce_unseen_fbd_gate,
    paired_group_bootstrap_ci,
    sanitize_paths,
    train_temporal_head,
    verify_ten_source_preflight,
)


def _require_inline_tensors(message, tensor_proto):
    if isinstance(message, tensor_proto):
        if message.external_data or message.data_location == tensor_proto.EXTERNAL:
            raise ValueError(f"Tensor {message.name!r} uses external data")
        return
    for field, value in message.ListFields():
        if field.message_type is not None:
            children = (value,) if hasattr(value, "ListFields") else value
            for child in children:
                _require_inline_tensors(child, tensor_proto)


def _component_parameters(model, attr_name):
    component = getattr(model, attr_name)
    if isinstance(component, torch.nn.Parameter):
        return [component]
    if isinstance(component, torch.nn.Module):
        return list(component.parameters())
    raise TypeError(f"Unexpected component type for {attr_name}: {type(component)!r}")


def _hamming_uint64(a, b):
    return int(int(a) ^ int(b)).bit_count()


@unittest.skipUnless(HAS_TORCH, "PyTorch is not installed")
class TemporalKinematicsHeadTests(unittest.TestCase):
    def test_architecture_constants_and_parameter_budget(self):
        self.assertIsInstance(ARCH, str)
        self.assertTrue(ARCH)
        self.assertGreaterEqual(int(SCHEMA_VERSION), 1)
        self.assertEqual(WINDOW_SIZE, 5)
        self.assertEqual(NUM_CLASSES, 3)
        self.assertEqual(len(LABELS), NUM_CLASSES)
        self.assertEqual(NUM_KINEMATICS, 6)
        self.assertEqual(len(KINEMATICS_FEATURES), NUM_KINEMATICS)
        self.assertEqual(MAX_PARAMETERS, 8_000)
        self.assertEqual(MAX_ONNX_BYTES, 100_000)

        torch.manual_seed(11)
        model = TemporalKinematicsHead()
        n_params = count_parameters(model)
        self.assertGreater(n_params, 0)
        self.assertLess(n_params, MAX_PARAMETERS)

    def test_batched_and_unbatched_forward_match_and_are_finite(self):
        torch.manual_seed(17)
        model = TemporalKinematicsHead().eval()
        with torch.no_grad():
            if float(model.residual_scale.abs().max()) == 0.0:
                model.residual_scale.fill_(0.35)
        logits = torch.randn(4, WINDOW_SIZE, NUM_CLASSES, dtype=torch.float32)
        kin = torch.randn(4, WINDOW_SIZE, NUM_KINEMATICS, dtype=torch.float32)

        with torch.no_grad():
            batched = model(logits, kin)
            self.assertEqual(tuple(batched.shape), (4, NUM_CLASSES))
            self.assertTrue(torch.isfinite(batched).all())
            for idx in range(4):
                single = model(logits[idx], kin[idx])
                self.assertEqual(tuple(single.shape), (NUM_CLASSES,))
                self.assertTrue(torch.isfinite(single).all())
                max_err = float((batched[idx] - single).abs().max())
                self.assertLessEqual(max_err, 1e-6)

    def test_backward_pass_and_adamw_updates_all_required_components(self):
        torch.manual_seed(23)
        model = TemporalKinematicsHead().train()
        initial = {name: param.detach().clone() for name, param in model.named_parameters()}
        optimizer = torch.optim.AdamW(model.parameters(), lr=1e-2, weight_decay=1e-4)

        logits = torch.randn(8, WINDOW_SIZE, NUM_CLASSES, dtype=torch.float32)
        kin = torch.randn(8, WINDOW_SIZE, NUM_KINEMATICS, dtype=torch.float32)
        targets = torch.tensor([0, 1, 2, 0, 1, 2, 1, 0], dtype=torch.long)

        # Two steps guarantee non-zero upstream gradients even when residual_scale starts at 0.
        for step in range(2):
            optimizer.zero_grad(set_to_none=True)
            out = model(logits, kin)
            loss = F.cross_entropy(out, targets)
            self.assertTrue(torch.isfinite(loss))
            loss.backward()
            if step == 1:
                for name in ("in_proj", "q_proj", "mlp1", "pool_gate", "residual_head", "residual_scale"):
                    params = _component_parameters(model, name)
                    self.assertTrue(params, f"{name} has no parameters")
                    grad_max = 0.0
                    for param in params:
                        self.assertIsNotNone(param.grad, f"{name} missing gradient")
                        self.assertTrue(torch.isfinite(param.grad).all(), f"{name} has non-finite gradient")
                        grad_max = max(grad_max, float(param.grad.detach().abs().max()))
                    self.assertGreater(grad_max, 0.0, f"{name} gradient remained identically zero")
            optimizer.step()

        for name, param in model.named_parameters():
            self.assertTrue(torch.isfinite(param).all(), f"{name} became non-finite after AdamW")
            delta = float((param.detach() - initial[name]).abs().max())
            self.assertGreater(delta, 0.0, f"{name} did not update under AdamW")

    def test_zero_residual_scale_recovers_uniform_vote_probs(self):
        torch.manual_seed(29)
        model = TemporalKinematicsHead().eval()
        with torch.no_grad():
            model.residual_scale.fill_(0.0)

        logits_batch = torch.randn(4, WINDOW_SIZE, NUM_CLASSES, dtype=torch.float32)
        kin_batch = torch.randn(4, WINDOW_SIZE, NUM_KINEMATICS, dtype=torch.float32)

        with torch.no_grad():
            probs_batch = torch.softmax(model(logits_batch, kin_batch), dim=-1)
            expected_batch = torch.as_tensor(uniform_vote_probs(logits_batch), dtype=torch.float32)
            self.assertEqual(tuple(probs_batch.shape), (4, NUM_CLASSES))
            self.assertLessEqual(float((probs_batch - expected_batch).abs().max()), 1e-6)

            probs_single = torch.softmax(model(logits_batch[0], kin_batch[0]), dim=-1)
            expected_single = torch.as_tensor(uniform_vote_probs(logits_batch[0]), dtype=torch.float32)
            self.assertEqual(tuple(probs_single.shape), (NUM_CLASSES,))
            self.assertLessEqual(float((probs_single - expected_single).abs().max()), 1e-6)


@unittest.skipUnless(HAS_TORCH, "PyTorch is not installed")
class ChronologyAndKinematicsTests(unittest.TestCase):
    def test_chronological_frames_accepted_and_invalid_inputs_rejected(self):
        torch.manual_seed(31)
        model = TemporalKinematicsHead().eval()
        boxes_single = np.array([[100.0 + 4.0 * i, 120.0, 12.0, 12.0] for i in range(WINDOW_SIZE)], dtype=np.float32)
        boxes_batch = np.stack([boxes_single, boxes_single + 5.0], axis=0)
        logits_single = torch.randn(WINDOW_SIZE, NUM_CLASSES, dtype=torch.float32)
        kin_single = torch.randn(WINDOW_SIZE, NUM_KINEMATICS, dtype=torch.float32)
        logits_batch = torch.randn(2, WINDOW_SIZE, NUM_CLASSES, dtype=torch.float32)
        kin_batch = torch.randn(2, WINDOW_SIZE, NUM_KINEMATICS, dtype=torch.float32)

        valid_single = [0, 3, 6, 9, 12]
        valid_batch = [[0, 1, 2, 3, 4], [2, 5, 9, 12, 20]]

        validate_chronological_frames(valid_single)
        validate_chronological_frames(valid_batch)
        self.assertEqual(compute_kinematics_features(boxes_single, valid_single).shape, (WINDOW_SIZE, NUM_KINEMATICS))
        self.assertEqual(compute_kinematics_features(boxes_batch, valid_batch).shape, (2, WINDOW_SIZE, NUM_KINEMATICS))
        with torch.no_grad():
            self.assertEqual(tuple(model(logits_single, kin_single, frame_indices=valid_single).shape), (NUM_CLASSES,))
            self.assertEqual(tuple(model(logits_batch, kin_batch, frame_indices=valid_batch).shape), (2, NUM_CLASSES))

        invalid_single_cases = [
            ("out_of_order", [0, 6, 3, 9, 12]),
            ("duplicate", [0, 3, 3, 6, 9]),
            ("negative", [-1, 0, 1, 2, 3]),
            ("wrong_length_short", [0, 1, 2, 3]),
            ("bool_list", [False, True, True, True, True]),
            ("bool_ndarray", np.array([False, True, False, True, True], dtype=bool)),
            ("bool_tensor", torch.tensor([False, True, True, True, True], dtype=torch.bool)),
        ]
        for label, bad_frames in invalid_single_cases:
            with self.subTest(target="validate", case=label), self.assertRaises(ValueError):
                validate_chronological_frames(bad_frames)
            with self.subTest(target="kinematics", case=label), self.assertRaises(ValueError):
                compute_kinematics_features(boxes_single, bad_frames)
            with self.subTest(target="forward", case=label), self.assertRaises(ValueError):
                model(logits_single, kin_single, frame_indices=bad_frames)

        bad_batch = [[0, 1, 2, 3, 4], [0, 6, 3, 9, 12]]
        with self.assertRaises(ValueError):
            validate_chronological_frames(bad_batch)
        with self.assertRaises(ValueError):
            compute_kinematics_features(boxes_batch, bad_batch)
        with self.assertRaises(ValueError):
            model(logits_batch, kin_batch, frame_indices=bad_batch)

    def test_kinematics_constant_velocity_east_exact_values(self):
        feat_idx = {name: idx for idx, name in enumerate(KINEMATICS_FEATURES)}
        boxes = np.array(
            [[100.0 + 12.8 * step, 200.0, 10.0, 10.0] for step in range(WINDOW_SIZE)],
            dtype=np.float32,
        )
        frames = [0, 2, 4, 6, 8]
        kin = np.asarray(compute_kinematics_features(boxes, frames, frame_wh=(640.0, 512.0)), dtype=np.float64)
        self.assertEqual(kin.shape, (WINDOW_SIZE, NUM_KINEMATICS))

        for t in range(WINDOW_SIZE):
            self.assertAlmostEqual(kin[t, feat_idx["log_box_px"]], math.log(10.0), places=6)
        for t in range(1, WINDOW_SIZE):
            self.assertAlmostEqual(kin[t, feat_idx["dx"]], 0.01, places=6)
            self.assertAlmostEqual(kin[t, feat_idx["dy"]], 0.0, places=6)
            self.assertAlmostEqual(kin[t, feat_idx["speed"]], 0.01, places=6)
            self.assertAlmostEqual(kin[t, feat_idx["scale_delta"]], 0.0, places=6)
        for t in range(2, WINDOW_SIZE):
            self.assertAlmostEqual(kin[t, feat_idx["turn_cos"]], 1.0, places=6)

    def test_kinematics_turn_cosine_90_and_180_degrees(self):
        feat_idx = {name: idx for idx, name in enumerate(KINEMATICS_FEATURES)}
        # Step 0->1: +dx (+0.1, 0); Step 1->2: +dy (0, +0.1) => 90 deg;
        # Step 2->3: +dx (+0.1, 0) => 90 deg; Step 3->4: -dx (-0.1, 0) => 180 deg reversal.
        boxes = np.array(
            [
                [100.0, 100.0, 10.0, 10.0],
                [164.0, 100.0, 10.0, 10.0],
                [164.0, 151.2, 10.0, 10.0],
                [228.0, 151.2, 10.0, 10.0],
                [164.0, 151.2, 10.0, 10.0],
            ],
            dtype=np.float32,
        )
        frames = [0, 1, 2, 3, 4]
        kin = np.asarray(compute_kinematics_features(boxes, frames, frame_wh=(640.0, 512.0)), dtype=np.float64)
        self.assertAlmostEqual(kin[2, feat_idx["turn_cos"]], 0.0, places=6)
        self.assertAlmostEqual(kin[3, feat_idx["turn_cos"]], 0.0, places=6)
        self.assertAlmostEqual(kin[4, feat_idx["turn_cos"]], -1.0, places=6)

    def test_kinematics_approaching_target_scale_delta(self):
        feat_idx = {name: idx for idx, name in enumerate(KINEMATICS_FEATURES)}
        sizes = [8.0, 16.0, 16.0, 16.0, 16.0]
        boxes = np.array(
            [[320.0 - s / 2.0, 256.0 - s / 2.0, s, s] for s in sizes],
            dtype=np.float32,
        )
        frames = [0, 1, 2, 3, 4]
        kin = np.asarray(compute_kinematics_features(boxes, frames, frame_wh=(640.0, 512.0)), dtype=np.float64)
        self.assertAlmostEqual(kin[0, feat_idx["log_box_px"]], math.log(8.0), places=6)
        self.assertAlmostEqual(kin[1, feat_idx["log_box_px"]], math.log(16.0), places=6)
        self.assertAlmostEqual(kin[1, feat_idx["scale_delta"]], math.log(2.0), places=6)


@unittest.skipUnless(HAS_TORCH and HAS_ONNX and HAS_ORT, "PyTorch/onnx/onnxruntime required")
class ExportAndBrowserParityTests(unittest.TestCase):
    def _train_four_steps(self):
        torch.manual_seed(101)
        model = TemporalKinematicsHead().train()
        init_snapshot = {k: v.detach().clone() for k, v in model.state_dict().items()}
        optimizer = torch.optim.AdamW(model.parameters(), lr=2e-2, weight_decay=1e-4)
        logits = torch.randn(16, WINDOW_SIZE, NUM_CLASSES, dtype=torch.float32)
        kin = torch.randn(16, WINDOW_SIZE, NUM_KINEMATICS, dtype=torch.float32)
        targets = torch.arange(16, dtype=torch.long) % NUM_CLASSES
        for _ in range(4):
            optimizer.zero_grad(set_to_none=True)
            loss = F.cross_entropy(model(logits, kin), targets)
            loss.backward()
            optimizer.step()
        model.eval()
        moved = max(float((model.state_dict()[k] - init_snapshot[k]).abs().max()) for k in init_snapshot)
        self.assertGreater(moved, 1e-4)
        return model

    def test_checkpoint_onnx_browser_json_and_node_v8_parity(self):
        model = self._train_four_steps()
        torch.manual_seed(202)
        test_logits = torch.randn(4, WINDOW_SIZE, NUM_CLASSES, dtype=torch.float32)
        test_kin = torch.randn(4, WINDOW_SIZE, NUM_KINEMATICS, dtype=torch.float32)
        with torch.no_grad():
            pt_batch = model(test_logits, test_kin).cpu().numpy()
            pt_single = model(test_logits[0], test_kin[0]).cpu().numpy()

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            ckpt_path = tmp_dir / "temporal_head.pt"
            onnx_path = tmp_dir / "temporal_head.onnx"
            json_path = tmp_dir / "temporal_head.json"

            save_checkpoint(model, ckpt_path, metadata={"test_run": True})
            reloaded = load_checkpoint(ckpt_path)
            reloaded_model = reloaded[0] if isinstance(reloaded, tuple) else reloaded
            reloaded_model.eval()
            with torch.no_grad():
                reloaded_out = reloaded_model(test_logits, test_kin).cpu().numpy()
            self.assertLessEqual(float(np.max(np.abs(reloaded_out - pt_batch))), 1e-6)

            export_onnx(ckpt_path, onnx_path)
            self.assertTrue(onnx_path.is_file())
            onnx_bytes = onnx_path.read_bytes()
            self.assertGreater(len(onnx_bytes), 0)
            self.assertLessEqual(len(onnx_bytes), MAX_ONNX_BYTES)

            proto = onnx.load_model_from_string(onnx_bytes)
            _require_inline_tensors(proto, onnx.TensorProto)
            onnx.checker.check_model(proto)
            opsets = {imp.domain or "ai.onnx": imp.version for imp in proto.opset_import}
            self.assertEqual(opsets.get("ai.onnx"), 17)

            session = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
            inputs = session.get_inputs()
            outputs = session.get_outputs()
            self.assertEqual(len(inputs), 2)
            self.assertEqual(len(outputs), 1)
            for binding in (*inputs, *outputs):
                self.assertTrue(
                    binding.shape[0] is None or isinstance(binding.shape[0], str),
                    f"Expected dynamic batch dimension on {binding.name}, got {binding.shape}",
                )

            for batch_size in (1, 4):
                feed = {
                    inputs[0].name: np.ascontiguousarray(test_logits[:batch_size].numpy(), dtype=np.float32),
                    inputs[1].name: np.ascontiguousarray(test_kin[:batch_size].numpy(), dtype=np.float32),
                }
                (ort_logits,) = session.run([outputs[0].name], feed)
                self.assertEqual(ort_logits.shape, (batch_size, NUM_CLASSES))
                max_err = float(np.max(np.abs(ort_logits - pt_batch[:batch_size])))
                self.assertLessEqual(max_err, 1e-6)

            export_browser_json(ckpt_path, json_path)
            self.assertTrue(json_path.is_file())
            spec = load_browser_json(json_path)
            spec_from_dict = load_browser_json(json.loads(json_path.read_text(encoding="utf-8")))
            self.assertIsInstance(spec, dict)
            self.assertIsInstance(spec_from_dict, dict)

            py_js_single = np.asarray(
                predict_temporal_window_js(spec, test_logits[0].numpy(), test_kin[0].numpy(), frame_indices=[0, 2, 4, 6, 8]),
                dtype=np.float32,
            )
            if py_js_single.ndim == 2 and py_js_single.shape[0] == 1:
                py_js_single = py_js_single[0]
            self.assertLessEqual(float(np.max(np.abs(py_js_single - pt_single))), 1e-6)

            py_js_batch = np.asarray(
                predict_temporal_window_js(spec, test_logits.numpy(), test_kin.numpy()),
                dtype=np.float32,
            )
            self.assertEqual(py_js_batch.shape, (4, NUM_CLASSES))
            self.assertLessEqual(float(np.max(np.abs(py_js_batch - pt_batch))), 1e-6)

            runner_out = np.asarray(run_browser_json(json_path, test_logits.numpy(), test_kin.numpy()), dtype=np.float32)
            self.assertEqual(runner_out.shape, (4, NUM_CLASSES))
            self.assertLessEqual(float(np.max(np.abs(runner_out - pt_batch))), 1e-6)

            ref_cases = spec.get("reference_cases", [])
            self.assertTrue(len(ref_cases) >= 1, "Expected embedded reference_cases in browser JSON")
            for case in ref_cases:
                ref_logits_in = np.asarray(case["frame_logits"], dtype=np.float32)
                ref_kin_in = np.asarray(case["kinematics"], dtype=np.float32)
                ref_expected = np.asarray(case["expected_logits" if "expected_logits" in case else "logits"], dtype=np.float32)
                ref_frames = case.get("frame_indices")
                ref_actual = np.asarray(
                    predict_temporal_window_js(spec, ref_logits_in, ref_kin_in, frame_indices=ref_frames),
                    dtype=np.float32,
                )
                self.assertLessEqual(float(np.max(np.abs(ref_actual - ref_expected))), 1e-6)
                with torch.no_grad():
                    ref_pt = model(torch.from_numpy(ref_logits_in), torch.from_numpy(ref_kin_in)).cpu().numpy()
                self.assertLessEqual(float(np.max(np.abs(ref_pt - ref_expected))), 1e-6)

            for bad_frames in ([0, 6, 3, 9, 12], [0, 3, 3, 6, 9], [-1, 0, 1, 2, 3], [0, 1, 2, 3]):
                with self.subTest(bad_frames=bad_frames), self.assertRaises(ValueError):
                    predict_temporal_window_js(spec, test_logits[0].numpy(), test_kin[0].numpy(), frame_indices=bad_frames)

            node_bin = shutil.which("node")
            if node_bin:
                runtime_js_path = tmp_dir / "temporal_runtime.mjs"
                harness_js_path = tmp_dir / "verify_v8.mjs"
                payload_path = tmp_dir / "v8_inputs.json"
                runtime_js_path.write_text(BROWSER_RUNTIME_JS, encoding="utf-8")
                payload_path.write_text(
                    json.dumps(
                        {
                            "single_logits": test_logits[0].tolist(),
                            "single_kin": test_kin[0].tolist(),
                            "batch_logits": test_logits.tolist(),
                            "batch_kin": test_kin.tolist(),
                        }
                    ),
                    encoding="utf-8",
                )
                harness_js_path.write_text(
                    """
import { readFileSync } from 'node:fs';
import * as runtime from './temporal_runtime.mjs';

const rawSpec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inputs = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const spec = runtime.loadTemporalSpecJs ? runtime.loadTemporalSpecJs(rawSpec) : rawSpec;
const fn = runtime.predictTemporalWindowJs;
if (typeof fn !== 'function') {
  throw new Error('predictTemporalWindowJs is not exported by BROWSER_RUNTIME_JS');
}

const toPlain = (res) => {
  if (Array.isArray(res) || ArrayBuffer.isView(res)) {
    return Array.from(res, (x) => (Array.isArray(x) || ArrayBuffer.isView(x) ? Array.from(x) : x));
  }
  if (res && res.logits !== undefined) return toPlain(res.logits);
  throw new Error('Unexpected return value from predictTemporalWindowJs');
};

const singleOut = toPlain(fn(spec, inputs.single_logits, inputs.single_kin, [0, 2, 4, 6, 8]));
const batchOut = toPlain(
  fn(spec, inputs.batch_logits, inputs.batch_kin, [
    [0, 1, 2, 3, 4],
    [1, 3, 5, 7, 9],
    [2, 4, 6, 8, 10],
    [0, 2, 5, 9, 14],
  ])
);
const refOuts = (rawSpec.reference_cases || []).map((c) =>
  toPlain(fn(spec, c.frame_logits, c.kinematics, c.frame_indices))
);

let rejectedBadOrder = false;
try {
  fn(spec, inputs.single_logits, inputs.single_kin, [0, 5, 2, 7, 9]);
} catch (_err) {
  rejectedBadOrder = true;
}

process.stdout.write(JSON.stringify({ singleOut, batchOut, refOuts, rejectedBadOrder }));
""".lstrip(),
                    encoding="utf-8",
                )
                completed = subprocess.run(
                    [node_bin, str(harness_js_path), str(json_path), str(payload_path)],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                v8_res = json.loads(completed.stdout)
                v8_single = np.asarray(v8_res["singleOut"], dtype=np.float32).reshape(NUM_CLASSES)
                v8_batch = np.asarray(v8_res["batchOut"], dtype=np.float32).reshape(4, NUM_CLASSES)
                self.assertLessEqual(float(np.max(np.abs(v8_single - pt_single))), 1e-6)
                self.assertLessEqual(float(np.max(np.abs(v8_batch - pt_batch))), 1e-6)
                for case, v8_ref in zip(ref_cases, v8_res["refOuts"]):
                    ref_expected = np.asarray(case["expected_logits"], dtype=np.float32)
                    self.assertLessEqual(float(np.max(np.abs(np.asarray(v8_ref, dtype=np.float32) - ref_expected))), 1e-6)
                self.assertTrue(v8_res["rejectedBadOrder"], "Node V8 runtime must reject non-chronological frameIndices")


class TenSourcePipelineTests(unittest.TestCase):
    def test_phash_hamming_and_leakage_gate(self):
        self.assertEqual(MAX_PHASH_HAMMING, 6)
        yy, xx = np.mgrid[0:64, 0:64].astype(np.float32)
        base = np.zeros((64, 64, 3), dtype=np.uint8)
        grad_x = np.clip((xx / 63.0) * 220.0 + 15.0, 0, 255)
        grad_x[12:44, 8:30] = 245.0
        base[..., 0] = grad_x.astype(np.uint8)
        base[..., 1] = np.clip(grad_x * 0.9, 0, 255).astype(np.uint8)
        base[..., 2] = np.clip(grad_x * 0.8, 0, 255).astype(np.uint8)

        identical = base.copy()
        bright_tweaked = np.clip(base.astype(np.int16) + 2, 0, 255).astype(np.uint8)

        # Orthogonal pattern: vertical step/checkerboard orthogonal to horizontal gradient.
        orthogonal = np.zeros((64, 64, 3), dtype=np.uint8)
        checker = (((xx // 8).astype(int) + (yy // 4).astype(int)) % 2) * 230 + 10
        orthogonal[..., 0] = checker.astype(np.uint8)
        orthogonal[..., 1] = (255 - checker).astype(np.uint8)
        orthogonal[..., 2] = np.clip((yy / 63.0) * 240.0, 0, 255).astype(np.uint8)

        h_base = compute_phash_uint64(base)
        h_ident = compute_phash_uint64(identical)
        h_bright = compute_phash_uint64(bright_tweaked)
        h_ortho = compute_phash_uint64(orthogonal)

        batch_hashes = compute_phashes_uint64(np.stack([base, identical, bright_tweaked, orthogonal], axis=0))
        self.assertEqual(len(batch_hashes), 4)
        self.assertEqual(int(batch_hashes[0]), int(h_base))

        self.assertEqual(_hamming_uint64(h_base, h_ident), 0)
        self.assertLessEqual(_hamming_uint64(h_base, h_bright), MAX_PHASH_HAMMING)
        self.assertGreater(_hamming_uint64(h_base, h_ortho), MAX_PHASH_HAMMING)

        with self.assertRaises(LeakageError):
            audit_phash_leakage(
                np.stack([base], axis=0),
                np.stack([identical], axis=0),
                strict=True,
            )
        with self.assertRaises(LeakageError):
            audit_phash_leakage(
                np.stack([base], axis=0),
                np.stack([bright_tweaked], axis=0),
                strict=True,
            )

        clean_audit = audit_phash_leakage(
            np.stack([base], axis=0),
            np.stack([orthogonal], axis=0),
            strict=True,
        )
        self.assertEqual(clean_audit["leak_count"], 0)

    def test_audit_small_bird_sources_enforces_sessions_and_airbirds_licence(self):
        valid_airbirds_meta = {
            "used_source_groups": ["klim:session:s1", "skagen:session:s2"],
            "frames": [
                {
                    "geometry": "native",
                    "source_group": "airbirds:seq:001",
                    "frame_id": "frame-0001",
                    "frame_size": [1920, 1080],
                    "bird_boxes_xyxy": [
                        [10, 10, 15.5, 14.0],
                        [40, 40, 50.0, 48.0],
                        [100, 100, 122.0, 118.0],
                    ],
                }
            ],
        }

        for legacy_list in (["klim/0", "klim/1"], ["skagen/3"]):
            with self.subTest(legacy_list=legacy_list), self.assertRaises(PipelineGateError):
                audit_small_bird_sources(legacy_list)

        for legacy_groups in (
            {"train": ["klim/0", "klim/1"], "select": ["skagen:session:s2"]},
            {"train": ["klim:session:s1"], "select": ["skagen/3"]},
        ):
            with self.subTest(legacy_dict=legacy_groups), self.assertRaises(PipelineGateError):
                audit_small_bird_sources(
                    legacy_groups,
                    airbirds_role="test_only",
                    airbirds_metadata=valid_airbirds_meta,
                )

        self.assertTrue(issubclass(LeakageError, PipelineGateError))
        with self.assertRaises(LeakageError):
            audit_small_bird_sources(
                {"train": ["klim:session:s1"], "select": ["klim:session:s1"]},
                airbirds_role="test_only",
                airbirds_metadata=valid_airbirds_meta,
            )

        for bad_role in ("train", "select"):
            with self.subTest(airbirds_role=bad_role), self.assertRaises(PipelineGateError):
                audit_small_bird_sources(
                    {"train": ["klim:session:s1"], "select": ["skagen:session:s2"]},
                    airbirds_role=bad_role,
                    airbirds_metadata=valid_airbirds_meta,
                )

        report = audit_small_bird_sources(
            {"train": ["klim:session:s1"], "select": ["skagen:session:s2"]},
            airbirds_role="test_only",
            airbirds_metadata=valid_airbirds_meta,
        )
        self.assertEqual(report["klim_skagen"]["session_groups"], 2)
        self.assertTrue(report["klim_skagen"]["disjoint_splits"])
        self.assertEqual(report["airbirds"]["role"], "test_only")
        self.assertFalse(report["airbirds"]["train_select_allowed"])
        by_size = report["airbirds"]["intake"]["bird_boxes_by_native_size_px"]
        self.assertEqual(by_size["<7"]["bird_boxes"], 1)
        self.assertEqual(by_size["7-15"]["bird_boxes"], 1)
        self.assertEqual(by_size[">15"]["bird_boxes"], 1)

    def test_verify_ten_source_preflight_rejects_incomplete_temp_data_root(self):
        self.assertEqual(len(TEN_SOURCES), 10)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            empty_root = tmp_dir / "empty_data_root"
            with self.assertRaises(PipelineGateError):
                verify_ten_source_preflight(empty_root)
            empty_root.mkdir(parents=True, exist_ok=True)
            with self.assertRaises(PipelineGateError):
                verify_ten_source_preflight(empty_root)
            with self.assertRaises(FrozenTestAccessError):
                verify_ten_source_preflight(tmp_dir / "test_media")

    def test_paired_group_bootstrap_ci_significance_and_point_estimates(self):
        self.assertEqual(N_BOOTSTRAP, 1000)

        # Single-group input must flag "not significant" even when point rates differ.
        single_base = np.array([1, 0, 0, 0], dtype=np.float64)
        single_cand = np.array([1, 1, 1, 1], dtype=np.float64)
        single_groups = np.array(["clip_only"] * 4)
        single_res = paired_group_bootstrap_ci(
            single_cand,
            single_base,
            np.ones(4, dtype=bool),
            single_groups,
            n_boot=N_BOOTSTRAP,
            seed=42,
        )
        self.assertAlmostEqual(single_res["baseline"]["value"], 0.25, places=6)
        self.assertAlmostEqual(single_res["candidate"]["value"], 1.0, places=6)
        self.assertAlmostEqual(single_res["paired_delta"]["value"], 0.75, places=6)
        self.assertEqual(single_res["significance"], "not significant")

        # Overlapping 20-group synthetic inputs -> "not significant".
        rng = np.random.default_rng(7)
        groups_20 = np.repeat([f"grp_{i:02d}" for i in range(20)], 5)
        overlap_base = rng.integers(0, 2, size=100).astype(np.float64)
        overlap_cand = overlap_base.copy()
        overlap_cand[0] = 1.0 - overlap_cand[0]
        overlap_res = paired_group_bootstrap_ci(
            overlap_cand,
            overlap_base,
            np.ones(100, dtype=bool),
            groups_20,
            n_boot=N_BOOTSTRAP,
            seed=7,
        )
        self.assertEqual(overlap_res["usable_draws"], N_BOOTSTRAP)
        self.assertEqual(overlap_res["significance"], "not significant")

        # Well-separated 20-group synthetic inputs -> "significant".
        sep_base = np.tile(np.array([1.0, 0.0, 0.0, 0.0, 0.0]), 20)
        sep_cand = np.tile(np.array([1.0, 1.0, 1.0, 1.0, 1.0]), 20)
        sep_res = paired_group_bootstrap_ci(
            sep_cand,
            sep_base,
            np.ones(100, dtype=bool),
            groups_20,
            n_boot=N_BOOTSTRAP,
            seed=99,
        )
        self.assertEqual(sep_res["groups"], 20)
        self.assertEqual(sep_res["usable_draws"], N_BOOTSTRAP)
        self.assertAlmostEqual(sep_res["baseline"]["value"], 0.2, places=6)
        self.assertAlmostEqual(sep_res["candidate"]["value"], 1.0, places=6)
        self.assertAlmostEqual(sep_res["paired_delta"]["value"], 0.8, places=6)
        self.assertEqual(sep_res["significance"], "significant")

    def test_enforce_unseen_fbd_gate_and_cli_isolation(self):
        self.assertIsNone(enforce_unseen_fbd_gate(False, fbd_pins=None))
        with self.assertRaises(FrozenTestAccessError):
            enforce_unseen_fbd_gate(None)
        with self.assertRaises(FrozenTestAccessError):
            enforce_unseen_fbd_gate(True, fbd_pins=None)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            bad_pins = tmp_dir / "bad_pins.json"
            bad_pins.write_text(
                json.dumps({"crops_sha256": "not-a-64-char-hex", "metadata_sha256": "1234"}),
                encoding="utf-8",
            )
            with self.assertRaises(FrozenTestAccessError):
                enforce_unseen_fbd_gate(True, fbd_pins=bad_pins)

            good_pins_payload = {
                "crops_sha256": "A" * 64,
                "metadata_sha256": "b" * 64,
            }
            good_pins = tmp_dir / "good_pins.json"
            good_pins.write_text(json.dumps(good_pins_payload), encoding="utf-8")
            validated = enforce_unseen_fbd_gate(True, fbd_pins=good_pins)
            self.assertEqual(
                validated,
                {"crops_sha256": "a" * 64, "metadata_sha256": "b" * 64},
            )

        script = HERE / "run_v5_ten_source_pipeline.py"
        proc = subprocess.run(
            [sys.executable, "-B", str(script), "--mode", "eval-unseen"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("FrozenTestAccessError", proc.stderr)

    def test_sanitize_paths_strips_local_machine_roots(self):
        win_users = "C:" + "\\Users"
        posix_users = "/" + "Users"
        staging_prefix = "D:" + "\\skysentry"
        home_name = Path.home().name
        raw = {
            "win_path": f"{win_users}\\operator_box\\work\\runs\\best.pt",
            "posix_path": f"{posix_users}/operator_box/work/data/klim_train.npz",
            "home_path": str(Path.home() / "local_check.pt"),
            "staging": [
                f"{staging_prefix}-stage-box\\svanstrom\\svan_X.npy",
                {"nested": f"Loaded from {win_users}\\operator_box\\checkpoint.onnx and {staging_prefix}-stage-box\\svanstrom"},
            ],
            "count": 5,
        }
        cleaned = sanitize_paths(raw)
        serialized = json.dumps(cleaned)
        if len(home_name) >= 3:
            self.assertNotIn(home_name, serialized)
        self.assertNotIn("operator_box", serialized)
        self.assertNotIn(f"{posix_users}/operator_box", serialized)
        self.assertNotIn("stage-box", serialized)
        self.assertEqual(cleaned["count"], 5)

    @unittest.skipUnless(HAS_TORCH, "PyTorch is not installed")
    def test_train_temporal_head_smoke_on_synthetic_windows(self):
        rng = np.random.default_rng(55)
        train_logits = rng.normal(size=(12, WINDOW_SIZE, NUM_CLASSES)).astype(np.float32)
        train_kin = rng.normal(size=(12, WINDOW_SIZE, NUM_KINEMATICS)).astype(np.float32)
        train_y = (np.arange(12) % NUM_CLASSES).astype(np.int64)
        select_logits = rng.normal(size=(6, WINDOW_SIZE, NUM_CLASSES)).astype(np.float32)
        select_kin = rng.normal(size=(6, WINDOW_SIZE, NUM_KINEMATICS)).astype(np.float32)
        select_y = (np.arange(6) % NUM_CLASSES).astype(np.int64)

        result = train_temporal_head(
            train_logits,
            train_kin,
            train_y,
            select_logits,
            select_kin,
            select_y,
            epochs=2,
            seed=55,
        )
        self.assertIsNotNone(result)


if __name__ == "__main__":
    unittest.main()
