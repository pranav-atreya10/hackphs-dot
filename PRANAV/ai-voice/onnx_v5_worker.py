#!/usr/bin/env python3
"""Persistent stdin->stdout JSON-lines ONNX Runtime worker for SkySentry v5 MobileNetV3 Large."""

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import os
import sys
from pathlib import Path

import numpy as np

V5_ONNX_SHA256 = "b5623ed44fff65d8d26c350728f371065ad1dd038e8aef4f0904577fba766c6a"
MAX_BYTES = 20_000_000
INPUT_NAME = "crop96_normalised"
OUTPUT_NAME = "logits"
SIZE = 96
CLASSES = ("bird", "drone", "other")
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
TENSOR_BYTES = 1 * 3 * SIZE * SIZE * 4
RGB_BYTES = SIZE * SIZE * 3

DEFAULT_MODEL_PATH = (
    Path(__file__).resolve().parents[2]
    / "Shreyansh Local Ai Model"
    / "runs"
    / "v5"
    / "best.onnx"
)


class WorkerError(Exception):
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def load_verified_session(
    model_path: Path,
    expected_sha256: str = V5_ONNX_SHA256,
    intra_threads: int = 2,
    inter_threads: int = 1,
):
    expected = (expected_sha256 or "").strip().lower()
    if len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected):
        raise WorkerError("onnx_failed", "Invalid expected SHA-256 digest")

    try:
        with model_path.open("rb") as handle:
            artifact = handle.read(MAX_BYTES + 1)
    except OSError as exc:
        raise WorkerError("onnx_failed", f"Could not read v5 ONNX artifact: {exc}") from exc

    if not artifact:
        raise WorkerError("onnx_failed", "v5 ONNX artifact is empty")
    if len(artifact) > MAX_BYTES:
        raise WorkerError("onnx_failed", "v5 ONNX artifact exceeds 20 MB safety cap")

    actual = hashlib.sha256(artifact).hexdigest().lower()
    if not hmac.compare_digest(actual, expected):
        raise WorkerError(
            "onnx_tampered",
            f"v5 ONNX SHA-256 mismatch (expected {expected}, got {actual})",
        )

    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise WorkerError("onnx_failed", f"onnxruntime is unavailable: {exc}") from exc

    try:
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, int(intra_threads))
        opts.inter_op_num_threads = max(1, int(inter_threads))
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.enable_cpu_mem_arena = False
        session = ort.InferenceSession(
            artifact,
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
    except Exception as exc:  # pragma: no cover - defensive runtime wrap
        raise WorkerError("onnx_failed", f"Failed to initialize ONNX Runtime session: {exc}") from exc

    inputs = session.get_inputs()
    outputs = session.get_outputs()
    if (
        len(inputs) != 1
        or inputs[0].name != INPUT_NAME
        or inputs[0].type != "tensor(float)"
        or tuple(inputs[0].shape[1:]) != (3, SIZE, SIZE)
    ):
        raise WorkerError("onnx_failed", f"Unexpected v5 ONNX input binding: {inputs!r}")
    if (
        len(outputs) != 1
        or outputs[0].name != OUTPUT_NAME
        or outputs[0].type != "tensor(float)"
        or tuple(outputs[0].shape[1:]) != (len(CLASSES),)
    ):
        raise WorkerError("onnx_failed", f"Unexpected v5 ONNX output binding: {outputs!r}")

    return session


def decode_input_tensor(req: dict) -> np.ndarray:
    tensor_b64 = (
        req.get("tensor_b64")
        or req.get("crop96_normalised_b64")
        or req.get("f32_b64")
    )
    rgb_b64 = req.get("rgb_b64") or req.get("rgb96_b64")

    if isinstance(tensor_b64, str) and tensor_b64:
        try:
            raw = base64.b64decode(tensor_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise WorkerError("invalid_request", f"Invalid tensor_b64 base64: {exc}") from exc
        if len(raw) != TENSOR_BYTES:
            raise WorkerError(
                "invalid_request",
                f"Expected {TENSOR_BYTES} float32 tensor bytes, got {len(raw)}",
            )
        tensor = np.frombuffer(raw, dtype="<f4").reshape(1, 3, SIZE, SIZE).copy()
        if not np.isfinite(tensor).all():
            raise WorkerError("invalid_request", "Input tensor contains non-finite values")
        return tensor

    if isinstance(rgb_b64, str) and rgb_b64:
        try:
            raw = base64.b64decode(rgb_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise WorkerError("invalid_request", f"Invalid rgb_b64 base64: {exc}") from exc
        if len(raw) != RGB_BYTES:
            raise WorkerError(
                "invalid_request",
                f"Expected {RGB_BYTES} RGB uint8 bytes, got {len(raw)}",
            )
        rgb = np.frombuffer(raw, dtype=np.uint8).reshape(SIZE, SIZE, 3).astype(np.float32)
        normed = (rgb / np.float32(255.0) - MEAN) / STD
        return np.ascontiguousarray(normed.transpose(2, 0, 1)[None, ...], dtype=np.float32)

    raise WorkerError("invalid_request", "Request must include tensor_b64 or rgb_b64")


def stable_softmax(logits_1d: np.ndarray) -> np.ndarray:
    z = logits_1d.astype(np.float64)
    shifted = z - np.max(z)
    exps = np.exp(shifted)
    denom = np.sum(exps)
    if not np.isfinite(denom) or denom <= 0.0:
        raise WorkerError("invalid_response", "Softmax denominator is non-finite")
    probs = exps / denom
    if not np.isfinite(probs).all():
        raise WorkerError("invalid_response", "Softmax probabilities are non-finite")
    return probs


def write_json(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def normalize_id(raw_id):
    if isinstance(raw_id, bool):
        return None
    if isinstance(raw_id, int):
        return raw_id
    if isinstance(raw_id, str) and raw_id:
        return raw_id
    return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        type=Path,
        default=Path(os.environ.get("ONNX_V5_MODEL_PATH") or DEFAULT_MODEL_PATH),
        help="Path to the self-contained v5 ONNX artifact",
    )
    parser.add_argument(
        "--expected-sha256",
        default=V5_ONNX_SHA256,
        help="Expected lowercase SHA-256 digest (override only for synthetic unit-test fixtures)",
    )
    parser.add_argument("--intra-threads", type=int, default=2)
    parser.add_argument("--inter-threads", type=int, default=1)
    args = parser.parse_args(argv)

    session = None
    startup_error = None
    try:
        session = load_verified_session(
            args.model,
            expected_sha256=args.expected_sha256,
            intra_threads=args.intra_threads,
            inter_threads=args.inter_threads,
        )
    except WorkerError as exc:
        startup_error = exc

    handled_any = False
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        handled_any = True
        try:
            req = json.loads(stripped)
            if not isinstance(req, dict):
                raise ValueError("JSON root must be an object")
        except ValueError:
            write_json(
                {
                    "id": None,
                    "ok": False,
                    "reason": "invalid_request",
                    "error": "Malformed JSON request",
                }
            )
            continue

        req_id = normalize_id(req.get("id"))
        if startup_error is not None:
            write_json(
                {
                    "id": req_id,
                    "ok": False,
                    "reason": startup_error.reason,
                    "error": str(startup_error),
                }
            )
            continue

        if req.get("type") == "ping":
            write_json({"id": req_id, "ok": True})
            continue

        try:
            tensor = decode_input_tensor(req)
            outputs = session.run([OUTPUT_NAME], {INPUT_NAME: tensor})
            logits = np.asarray(outputs[0], dtype=np.float32)
            if logits.shape != (1, len(CLASSES)) or not np.isfinite(logits).all():
                raise WorkerError("invalid_response", "ONNX session returned non-finite or misshapen logits")
            probs = stable_softmax(logits[0])
            reply = {
                "id": req_id,
                "ok": True,
                "probs": {
                    "bird": float(probs[0]),
                    "drone": float(probs[1]),
                    "other": float(probs[2]),
                },
            }
            if req.get("include_logits") is True:
                reply["logits"] = [float(logits[0, i]) for i in range(len(CLASSES))]
            write_json(reply)
        except WorkerError as exc:
            write_json({"id": req_id, "ok": False, "reason": exc.reason, "error": str(exc)})
        except Exception as exc:  # pragma: no cover - defensive runtime wrap
            write_json({"id": req_id, "ok": False, "reason": "onnx_failed", "error": str(exc)})

    if startup_error is not None:
        if not handled_any:
            write_json(
                {
                    "id": None,
                    "ok": False,
                    "reason": startup_error.reason,
                    "error": str(startup_error),
                }
            )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
