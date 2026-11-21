"""Check a v5 MobileNet ONNX export against its PyTorch checkpoint on synthetic RGB crops."""

import argparse
import hashlib
from importlib.util import find_spec
from pathlib import Path

MAX_BYTES = 20_000_000
INPUT_NAME = "crop96_normalised"
OUTPUT_NAME = "logits"
BATCH_SIZES = (1, 3)
RTOL, ATOL = 1e-4, 1e-5


def missing_modules():
    return [name for name in ("numpy", "PIL", "torch", "torchvision", "onnx", "onnxruntime")
            if find_spec(name) is None]


def read_artifact(path):
    with path.open("rb") as f:
        artifact = f.read(MAX_BYTES + 1)
    if len(artifact) > MAX_BYTES:
        raise ValueError(f"{path} exceeds 20 MB ({MAX_BYTES:,} bytes)")
    return artifact


def _require_inline_tensors(message, tensor_proto):
    if isinstance(message, tensor_proto):
        if message.external_data or message.data_location == tensor_proto.EXTERNAL:
            raise ValueError(f"Tensor {message.name!r} uses external data; expected one self-contained ONNX file")
        return
    # Tensor data can also appear in node attributes and nested graphs.
    for field, value in message.ListFields():
        if field.message_type is not None:
            children = (value,) if hasattr(value, "ListFields") else value
            for child in children:
                _require_inline_tensors(child, tensor_proto)


def check_graph(artifact):
    import onnx

    graph = onnx.load_model_from_string(artifact)
    _require_inline_tensors(graph, onnx.TensorProto)
    onnx.checker.check_model(graph)


def check_binding(bindings, name, tail):
    if len(bindings) != 1:
        raise ValueError(f"Expected exactly one {name!r} binding, got {len(bindings)}")
    binding = bindings[0]
    shape = binding.shape
    if (binding.name != name or binding.type != "tensor(float)" or not shape
            or tuple(shape[1:]) != tail or not (shape[0] is None or isinstance(shape[0], str))):
        raise ValueError(f"Expected {name!r} float32 {('batch', *tail)} with dynamic batch, "
                         f"got {binding.name!r} {binding.type} {shape}")


def check_logits(actual, expected, shape):
    import numpy as np

    if actual.shape != shape or expected.shape != shape:
        raise ValueError(f"Expected logits shape {shape}, got ONNX {actual.shape} and PyTorch {expected.shape}")
    if not np.isfinite(actual).all() or not np.isfinite(expected).all():
        raise ValueError("ONNX and PyTorch logits must both be finite")
    np.testing.assert_allclose(actual, expected, rtol=RTOL, atol=ATOL, equal_nan=False,
                               err_msg=f"Logits differ for batch {shape[0]}")
    return float(np.max(np.abs(actual - expected)))


def synthetic_crops():
    import numpy as np
    from PIL import Image

    from crops import INPUT, cut, square_for_box

    rng = np.random.default_rng(42)
    frame = Image.fromarray(rng.integers(0, 256, (96, 128, 3), dtype=np.uint8))
    boxes = [(64, 48, 16, 20), (5, 12, 12, 8), (75, 58, 60, 35)]
    return np.stack([cut(frame, *square_for_box(*box), INPUT) for box in boxes])


def validate(checkpoint, onnx_path):
    artifact = read_artifact(onnx_path)
    missing = missing_modules()
    if missing:
        raise ModuleNotFoundError(f"missing Python modules: {', '.join(missing)}")

    import onnxruntime as ort
    import torch

    from crops import CLASSES
    from train_v5_mobilenet import SIZE, build, norm, prep

    check_graph(artifact)
    session = ort.InferenceSession(artifact, providers=["CPUExecutionProvider"])
    check_binding(session.get_inputs(), INPUT_NAME, (3, SIZE, SIZE))
    check_binding(session.get_outputs(), OUTPUT_NAME, (len(CLASSES),))

    saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if (not isinstance(saved, dict) or "model" not in saved
            or saved.get("arch") not in ("mobilenet_v3_large", "mobilenet_v3_small")):
        raise ValueError("Expected a v5 checkpoint containing its MobileNet architecture and model state")
    arch = saved["arch"]
    model = build(arch, pretrained=False).eval()
    model.load_state_dict(saved["model"])
    errors = {}
    with torch.inference_mode():
        crops = norm(prep(synthetic_crops(), "cpu"))
        for batch in BATCH_SIZES:
            x = crops[:batch]
            expected = model(x).numpy()
            actual, = session.run([OUTPUT_NAME], {INPUT_NAME: x.contiguous().numpy()})
            errors[batch] = check_logits(actual, expected, (batch, len(CLASSES)))
    return arch, len(artifact), hashlib.sha256(artifact).hexdigest(), errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path, help="Local v5 .pt checkpoint used for export")
    parser.add_argument("onnx", type=Path, help="Actual self-contained candidate .onnx file")
    args = parser.parse_args()
    try:
        arch, size, digest, errors = validate(args.checkpoint, args.onnx)
    except ModuleNotFoundError as exc:
        parser.exit(2, f"v5 ONNX parity unavailable: {exc}\n")
    except (OSError, ValueError, AssertionError) as exc:
        parser.exit(1, f"v5 ONNX validation failed: {exc}\n")
    print(f"{arch}: {size:,} ONNX bytes; SHA-256 {digest}")
    print("Synthetic CPU logit parity passed: " + ", ".join(
        f"batch {batch} max absolute error {error:.3g}" for batch, error in errors.items()))


if __name__ == "__main__":
    main()
