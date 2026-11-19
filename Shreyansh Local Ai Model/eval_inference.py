"""Inference on frozen 64x64 RGB crops for the v4/v5 crop and voting reports."""

import hashlib
import io
import pickle
from pathlib import Path

import numpy as np

ARCHITECTURES = ("skynetlite", "mobilenet_v3_large", "mobilenet_v3_small")
CLASSES = ("bird", "drone", "other")
DEFAULT_BATCH = 512


def validate_crops(X):
    if (not isinstance(X, np.ndarray) or X.ndim != 5 or X.shape[1] < 1
            or X.shape[2:] != (64, 64, 3) or X.dtype != np.uint8):
        raise ValueError("expected uint8 RGB crops shaped (N, views, 64, 64, 3), with at least one view")


def _state_dict(checkpoint, arch):
    if not isinstance(checkpoint, dict):
        raise ValueError("expected a state dict or a checkpoint containing {'model': state_dict}")
    if "arch" in checkpoint:
        if not isinstance(checkpoint["arch"], str) or checkpoint["arch"] != arch:
            raise ValueError(f"checkpoint architecture {checkpoint['arch']!r} does not match --arch {arch}")
    elif arch != "skynetlite":
        raise ValueError(f"--arch {arch} requires the 'arch' tag written by train_v5_mobilenet.py")
    state = checkpoint.get("model", checkpoint)
    if not isinstance(state, dict) or not state:
        raise ValueError("checkpoint 'model' must be a nonempty state dict")
    return state


def load_predictor(checkpoint, *, arch):
    """Load one trusted checkpoint on CPU. Never infer architecture or load pretrained weights."""
    if arch not in ARCHITECTURES:
        raise ValueError(f"unsupported architecture {arch!r}; choose from {', '.join(ARCHITECTURES)}")
    import torch

    path = Path(checkpoint)
    content = path.read_bytes()
    try:
        payload = torch.load(io.BytesIO(content), map_location="cpu", weights_only=True)
    except (pickle.UnpicklingError, EOFError, RuntimeError, TypeError) as exc:
        raise ValueError(f"{path}: could not read a weights-only checkpoint: {exc}") from exc
    state = _state_dict(payload, arch)
    if not all(isinstance(key, str) and torch.is_tensor(value) for key, value in state.items()):
        raise ValueError(f"{path}: state dict must map weight names to tensors")

    if arch == "skynetlite":
        from model import SkyNetLite
        from train import norm, to_tensor

        model = SkyNetLite()

        def preprocess(rgb):
            return norm(to_tensor(rgb))
    else:
        from train_v5_mobilenet import build, norm, prep

        model = build(arch, pretrained=False)

        def preprocess(rgb):
            return norm(prep(rgb, "cpu"))

    try:
        model.load_state_dict(state, strict=True)
    except RuntimeError as exc:
        raise ValueError(f"{path}: weights do not match {arch}: {exc}") from exc
    return CropPredictor(model.to("cpu", dtype=torch.float32).eval(), preprocess, hashlib.sha256(content).hexdigest())


class CropPredictor:
    def __init__(self, model, preprocess, checkpoint_sha256):
        self._model = model
        self._preprocess = preprocess
        self.checkpoint_sha256 = checkpoint_sha256

    def _infer(self, X, batch_size, *, probabilities):
        import torch

        validate_crops(X)
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        pred = (np.empty((len(X), len(CLASSES)), dtype=np.float32) if probabilities
                else np.empty(len(X), dtype=np.int64))
        with torch.inference_mode():
            for start in range(0, len(X), batch_size):
                crops = np.require(X[start:start + batch_size, 0], requirements=["C", "W"])
                logits = self._model(self._preprocess(crops))
                if logits.shape != (len(crops), len(CLASSES)) or not torch.isfinite(logits).all():
                    raise ValueError("model did not produce finite bird, drone, other logits for each crop")
                output = logits.softmax(1) if probabilities else logits.argmax(1)
                pred[start:start + len(crops)] = output.numpy()
        return pred

    def predict(self, X, *, batch_size=DEFAULT_BATCH):
        """One class index per crop (the original single-crop logit argmax)."""
        return self._infer(X, batch_size, probabilities=False)

    def predict_proba(self, X, *, batch_size=DEFAULT_BATCH):
        """Uncalibrated softmax (T=1) in bird, drone, other order, for probability voting."""
        return self._infer(X, batch_size, probabilities=True)
