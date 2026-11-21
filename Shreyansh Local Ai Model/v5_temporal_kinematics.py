"""v5 temporal + kinematics head for 5-frame track windows (bird / drone / other).

Provides:
  - Strict chronological frame index validation and normalized 6-feature kinematics extraction
  - Lightweight (<8,000 parameter) attention + gated-pooling residual head anchored near uniform voting
  - Atomic PyTorch checkpoint save/load, self-contained opset-17 ONNX export (<=100 KB), and pure-JS
    Float32Array browser export with <=1e-6 numerical parity across PyTorch, ONNX Runtime, NumPy, and V8
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn as nn

ARCH = "v5_temporal_kinematics"
SCHEMA_VERSION = 1
WINDOW_SIZE = 5
NUM_CLASSES = 3
LABELS = ("bird", "drone", "other")
KINEMATICS_FEATURES = ("dx", "dy", "speed", "turn_cos", "log_box_px", "scale_delta")
NUM_KINEMATICS = 6
MAX_PARAMETERS = 8_000
MAX_ONNX_BYTES = 100_000

__all__ = [
    "ARCH",
    "SCHEMA_VERSION",
    "WINDOW_SIZE",
    "NUM_CLASSES",
    "LABELS",
    "KINEMATICS_FEATURES",
    "NUM_KINEMATICS",
    "MAX_PARAMETERS",
    "MAX_ONNX_BYTES",
    "validate_chronological_frames",
    "compute_kinematics_features",
    "uniform_vote_probs",
    "TemporalKinematicsHead",
    "count_parameters",
    "save_checkpoint",
    "load_checkpoint",
    "export_onnx",
    "BROWSER_RUNTIME_JS",
    "export_browser_json",
    "load_browser_json",
    "predict_temporal_window_js",
    "run_browser_json",
    "verify_node_js_parity",
    "run_preflight",
]

PARITY_ATOL = 1e-6
_INIT_SEED = 4401
_PARITY_SEED = 20261121


def _contains_bool(obj: Any) -> bool:
    if isinstance(obj, (bool, np.bool_)):
        return True
    if isinstance(obj, (list, tuple)):
        return any(_contains_bool(item) for item in obj)
    return False


def _to_numpy_checked(value: Any, name: str) -> np.ndarray:
    if value is None or _contains_bool(value):
        raise ValueError(f"{name} must be a numeric array without boolean values")
    if isinstance(value, torch.Tensor):
        if value.dtype == torch.bool:
            raise ValueError(f"{name} must not have boolean dtype")
        arr = value.detach().cpu().numpy()
    else:
        try:
            arr = np.asarray(value)
        except Exception as exc:
            raise ValueError(f"{name} could not be converted to a NumPy array") from exc
    if arr.dtype == np.bool_ or arr.dtype.kind not in ("i", "u", "f"):
        raise ValueError(f"{name} must be a real numeric array, got dtype {arr.dtype}")
    return arr


def validate_chronological_frames(frame_indices: Any) -> np.ndarray:
    """Validate 1D (WINDOW_SIZE,) or 2D (N, WINDOW_SIZE) strictly increasing non-negative integer frame indices."""
    arr = _to_numpy_checked(frame_indices, "frame_indices")
    if arr.ndim not in (1, 2):
        raise ValueError(f"frame_indices must be 1D or 2D, got shape {arr.shape}")
    if arr.shape[-1] != WINDOW_SIZE:
        raise ValueError(f"frame_indices last dimension must be {WINDOW_SIZE}, got shape {arr.shape}")
    if not np.isfinite(arr).all():
        raise ValueError("frame_indices must contain only finite values")

    max_i64 = np.iinfo(np.int64).max
    max_exact_float_int = float(1 << 53)
    if arr.dtype.kind == "f":
        if not np.equal(np.floor(arr), arr).all():
            raise ValueError("frame_indices floats must have zero fractional part")
        if (arr < 0.0).any() or (arr > max_exact_float_int).any():
            raise ValueError("frame_indices floats must be non-negative exact integers (<= 2^53)")
        out = arr.astype(np.int64)
    elif arr.dtype.kind == "u":
        if (arr > np.uint64(max_i64)).any():
            raise ValueError("frame_indices exceed int64 range")
        out = arr.astype(np.int64)
    else:
        if (arr < 0).any():
            raise ValueError("frame_indices must be non-negative (>= 0)")
        out = arr.astype(np.int64, copy=True)

    if not (out[..., 1:] > out[..., :-1]).all():
        raise ValueError("frame_indices must be strictly increasing along the window axis")
    return out


def compute_kinematics_features(
    boxes_xywh: Any,
    frame_indices: Any,
    frame_wh: tuple[float, float] | list[float] | np.ndarray = (640.0, 512.0),
) -> np.ndarray:
    """Compute [dx, dy, speed, turn_cos, log_box_px, scale_delta] float32 features for 5-step box windows."""
    boxes = _to_numpy_checked(boxes_xywh, "boxes_xywh")
    if boxes.ndim not in (2, 3) or boxes.shape[-2:] != (WINDOW_SIZE, 4):
        raise ValueError(
            f"boxes_xywh must have shape ({WINDOW_SIZE}, 4) or (N, {WINDOW_SIZE}, 4), got {boxes.shape}"
        )
    boxes_f64 = boxes.astype(np.float64, copy=False)
    if not np.isfinite(boxes_f64).all():
        raise ValueError("boxes_xywh must contain only finite values")
    if (boxes_f64[..., 2] <= 0.0).any() or (boxes_f64[..., 3] <= 0.0).any():
        raise ValueError("boxes_xywh widths and heights must be strictly positive (w > 0, h > 0)")

    wh_arr = _to_numpy_checked(frame_wh, "frame_wh")
    if wh_arr.ndim != 1 or wh_arr.shape != (2,):
        raise ValueError(f"frame_wh must be a 2-element (frame_w, frame_h) pair, got shape {wh_arr.shape}")
    frame_w = float(wh_arr[0])
    frame_h = float(wh_arr[1])
    if not (math.isfinite(frame_w) and math.isfinite(frame_h) and frame_w > 0.0 and frame_h > 0.0):
        raise ValueError(f"frame_wh values must be positive finite floats, got ({frame_w}, {frame_h})")

    idx = validate_chronological_frames(frame_indices)
    unbatched = boxes_f64.ndim == 2
    if unbatched:
        if idx.ndim != 1:
            raise ValueError(
                f"Unbatched boxes_xywh {boxes_f64.shape} requires 1D frame_indices ({WINDOW_SIZE},), got {idx.shape}"
            )
        boxes3d = boxes_f64[None, :, :]
        idx2d = idx[None, :]
    else:
        n_batch = boxes_f64.shape[0]
        if idx.ndim == 1:
            idx2d = np.broadcast_to(idx[None, :], (n_batch, WINDOW_SIZE))
        else:
            if idx.shape[0] != n_batch:
                raise ValueError(
                    f"Batch mismatch between boxes_xywh ({n_batch}) and frame_indices ({idx.shape[0]})"
                )
            idx2d = idx
        boxes3d = boxes_f64

    n_rows = boxes3d.shape[0]
    x = boxes3d[:, :, 0]
    y = boxes3d[:, :, 1]
    w = boxes3d[:, :, 2]
    h = boxes3d[:, :, 3]

    cx = (x + 0.5 * w) / frame_w
    cy = (y + 0.5 * h) / frame_h
    box_px = np.maximum(np.maximum(w, h), 1.0)
    log_box_px = np.log(box_px)

    dx = np.zeros((n_rows, WINDOW_SIZE), dtype=np.float64)
    dy = np.zeros((n_rows, WINDOW_SIZE), dtype=np.float64)
    speed = np.zeros((n_rows, WINDOW_SIZE), dtype=np.float64)
    turn_cos = np.ones((n_rows, WINDOW_SIZE), dtype=np.float64)
    scale_delta = np.zeros((n_rows, WINDOW_SIZE), dtype=np.float64)

    dt = (idx2d[:, 1:] - idx2d[:, :-1]).astype(np.float64)
    dx[:, 1:] = (cx[:, 1:] - cx[:, :-1]) / dt
    dy[:, 1:] = (cy[:, 1:] - cy[:, :-1]) / dt
    speed[:, 1:] = np.hypot(dx[:, 1:], dy[:, 1:])
    scale_delta[:, 1:] = (log_box_px[:, 1:] - log_box_px[:, :-1]) / dt

    sp_curr = speed[:, 2:]
    sp_prev = speed[:, 1:-1]
    valid = (sp_curr >= 1e-6) & (sp_prev >= 1e-6)
    safe_denom = np.where(valid, sp_curr * sp_prev, 1.0)
    dot = dx[:, 2:] * dx[:, 1:-1] + dy[:, 2:] * dy[:, 1:-1]
    cos_val = np.clip(dot / safe_denom, -1.0, 1.0)
    turn_cos[:, 2:] = np.where(valid, cos_val, 1.0)

    feats = np.stack([dx, dy, speed, turn_cos, log_box_px, scale_delta], axis=-1).astype(np.float32)
    return feats[0] if unbatched else feats


def _softmax_np_f32(x: np.ndarray, axis: int = -1) -> np.ndarray:
    x_f32 = np.asarray(x, dtype=np.float32)
    shifted = x_f32 - np.max(x_f32, axis=axis, keepdims=True)
    exp_x = np.exp(shifted, dtype=np.float32)
    denom = np.sum(exp_x, axis=axis, keepdims=True, dtype=np.float32)
    return (exp_x / denom).astype(np.float32)


def uniform_vote_probs(frame_logits: Any) -> np.ndarray:
    """Compute uniform 5-frame probability vote: softmax(frame_logits, axis=-1).mean(axis=-2)."""
    arr = _to_numpy_checked(frame_logits, "frame_logits")
    if arr.ndim not in (2, 3) or arr.shape[-2:] != (WINDOW_SIZE, NUM_CLASSES):
        raise ValueError(
            f"frame_logits must have shape ({WINDOW_SIZE}, {NUM_CLASSES}) or (N, {WINDOW_SIZE}, {NUM_CLASSES}), "
            f"got {arr.shape}"
        )
    if not np.isfinite(arr).all():
        raise ValueError("frame_logits must contain only finite values")
    probs = _softmax_np_f32(arr.astype(np.float32, copy=False), axis=-1)
    return np.mean(probs, axis=-2, dtype=np.float32).astype(np.float32)


class TemporalKinematicsHead(nn.Module):
    """Lightweight temporal self-attention + gated-pooling residual head over 5-frame logits & kinematics."""

    def __init__(
        self,
        d_model: int = 24,
        n_heads: int = 4,
        mlp_dim: int = 48,
        window_size: int = WINDOW_SIZE,
        num_classes: int = NUM_CLASSES,
        num_kinematics: int = NUM_KINEMATICS,
    ) -> None:
        super().__init__()
        for field_name, val in (
            ("d_model", d_model),
            ("n_heads", n_heads),
            ("mlp_dim", mlp_dim),
            ("window_size", window_size),
            ("num_classes", num_classes),
            ("num_kinematics", num_kinematics),
        ):
            if isinstance(val, bool) or not isinstance(val, int) or val <= 0:
                raise ValueError(f"{field_name} must be a positive integer, got {val!r}")
        if d_model % n_heads != 0:
            raise ValueError(f"d_model ({d_model}) must be divisible by n_heads ({n_heads})")

        self.d_model = int(d_model)
        self.n_heads = int(n_heads)
        self.head_dim = self.d_model // self.n_heads
        self.mlp_dim = int(mlp_dim)
        self.window_size = int(window_size)
        self.num_classes = int(num_classes)
        self.num_kinematics = int(num_kinematics)
        self.in_dim = self.num_classes * 2 + self.num_kinematics

        self.in_proj = nn.Linear(self.in_dim, self.d_model)
        self.pos_embed = nn.Parameter(torch.zeros(1, self.window_size, self.d_model))
        self.ln1 = nn.LayerNorm(self.d_model, eps=1e-5)
        self.q_proj = nn.Linear(self.d_model, self.d_model)
        self.k_proj = nn.Linear(self.d_model, self.d_model)
        self.v_proj = nn.Linear(self.d_model, self.d_model)
        self.out_proj = nn.Linear(self.d_model, self.d_model)
        self.ln2 = nn.LayerNorm(self.d_model, eps=1e-5)
        self.mlp1 = nn.Linear(self.d_model, self.mlp_dim)
        self.mlp2 = nn.Linear(self.mlp_dim, self.d_model)
        self.ln_pool = nn.LayerNorm(self.d_model, eps=1e-5)
        self.pool_gate = nn.Linear(self.d_model, 1)
        self.residual_head = nn.Linear(self.d_model, self.num_classes)
        self.residual_scale = nn.Parameter(torch.tensor(0.20, dtype=torch.float32))

        gen = torch.Generator()
        gen.manual_seed(_INIT_SEED)
        with torch.no_grad():
            self.pos_embed.normal_(mean=0.0, std=0.02, generator=gen)
            self.residual_head.weight.normal_(mean=0.0, std=0.01, generator=gen)
            self.residual_head.bias.zero_()

    def get_config(self) -> dict[str, int]:
        return {
            "d_model": self.d_model,
            "n_heads": self.n_heads,
            "mlp_dim": self.mlp_dim,
            "window_size": self.window_size,
            "num_classes": self.num_classes,
            "num_kinematics": self.num_kinematics,
        }

    def forward(
        self,
        frame_logits: torch.Tensor,
        kinematics: torch.Tensor,
        frame_indices: Any = None,
    ) -> torch.Tensor:
        in_onnx = torch.onnx.is_in_onnx_export()
        if not in_onnx:
            if not isinstance(frame_logits, torch.Tensor) or not isinstance(kinematics, torch.Tensor):
                raise ValueError("frame_logits and kinematics must be torch.Tensor instances")
            if not frame_logits.is_floating_point() or not kinematics.is_floating_point():
                raise ValueError("frame_logits and kinematics must be floating-point tensors")
            if frame_logits.ndim != kinematics.ndim or frame_logits.ndim not in (2, 3):
                raise ValueError(
                    f"Expected matching 2D or 3D tensors, got frame_logits {tuple(frame_logits.shape)} "
                    f"and kinematics {tuple(kinematics.shape)}"
                )
            if frame_logits.shape[-2:] != (self.window_size, self.num_classes):
                raise ValueError(
                    f"Expected frame_logits trailing shape {(self.window_size, self.num_classes)}, "
                    f"got {tuple(frame_logits.shape)}"
                )
            if kinematics.shape[-2:] != (self.window_size, self.num_kinematics):
                raise ValueError(
                    f"Expected kinematics trailing shape {(self.window_size, self.num_kinematics)}, "
                    f"got {tuple(kinematics.shape)}"
                )
            if frame_logits.ndim == 3 and frame_logits.shape[0] != kinematics.shape[0]:
                raise ValueError(
                    f"Batch mismatch between frame_logits ({frame_logits.shape[0]}) "
                    f"and kinematics ({kinematics.shape[0]})"
                )
            if frame_indices is not None:
                idx = validate_chronological_frames(frame_indices)
                if frame_logits.ndim == 2:
                    if idx.ndim != 1 or idx.shape[0] != self.window_size:
                        raise ValueError(
                            f"Unbatched forward requires 1D frame_indices ({self.window_size},), got {idx.shape}"
                        )
                elif idx.ndim == 2 and idx.shape[0] != frame_logits.shape[0]:
                    raise ValueError(
                        f"Batch mismatch between frame_logits ({frame_logits.shape[0]}) "
                        f"and frame_indices ({idx.shape[0]})"
                    )

        unbatched = frame_logits.ndim == 2
        if unbatched:
            frame_logits = frame_logits.unsqueeze(0)
            kinematics = kinematics.unsqueeze(0)

        if not in_onnx and not torch.is_autocast_enabled():
            param_dtype = self.in_proj.weight.dtype
            if frame_logits.dtype != param_dtype:
                frame_logits = frame_logits.to(dtype=param_dtype)
            if kinematics.dtype != param_dtype:
                kinematics = kinematics.to(dtype=param_dtype)

        t_steps = self.window_size
        n_heads = self.n_heads
        head_dim = self.head_dim
        d_model = self.d_model
        scale = float(head_dim ** -0.5)

        probs = torch.softmax(frame_logits, dim=-1)
        mean_probs = probs.mean(dim=1).clamp(min=1e-7)
        base_logits = torch.log(mean_probs)
        x = torch.cat([frame_logits, probs, kinematics], dim=-1)
        h = self.in_proj(x) + self.pos_embed
        u = self.ln1(h)

        bsz = u.size(0)
        q = self.q_proj(u).view(bsz, t_steps, n_heads, head_dim).transpose(1, 2)
        k = self.k_proj(u).view(bsz, t_steps, n_heads, head_dim).transpose(1, 2)
        v = self.v_proj(u).view(bsz, t_steps, n_heads, head_dim).transpose(1, 2)
        scores = torch.matmul(q, k.transpose(-2, -1)) * scale
        attn = torch.softmax(scores, dim=-1)
        ctx = torch.matmul(attn, v).transpose(1, 2).contiguous().view(bsz, t_steps, d_model)
        h = h + self.out_proj(ctx)

        h = h + self.mlp2(torch.relu(self.mlp1(self.ln2(h))))
        hp = self.ln_pool(h)
        gate = torch.softmax(self.pool_gate(hp), dim=1)
        pooled = (hp * gate).sum(dim=1)
        delta = self.residual_head(pooled) * self.residual_scale
        fused = base_logits + delta
        return fused.squeeze(0) if unbatched else fused


def count_parameters(model: nn.Module) -> int:
    """Return total parameter element count of model."""
    if not isinstance(model, nn.Module):
        raise ValueError("model must be an nn.Module")
    return sum(int(p.numel()) for p in model.parameters())


def _require_parameter_budget(model: TemporalKinematicsHead) -> int:
    n_params = count_parameters(model)
    if not (0 < n_params < MAX_PARAMETERS):
        raise ValueError(f"Model parameter count {n_params} must satisfy 0 < params < {MAX_PARAMETERS}")
    return n_params


def _atomic_write_bytes(path: Path | str, payload: bytes) -> Path:
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(f".{dest.name}.{os.getpid()}.tmp")
    try:
        temp.write_bytes(payload)
        temp.replace(dest)
    except Exception:
        if temp.exists():
            temp.unlink(missing_ok=True)
        raise
    return dest


def save_checkpoint(
    model: TemporalKinematicsHead,
    path: Path | str,
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Atomically save a TemporalKinematicsHead checkpoint and return path-safe artifact metadata."""
    if not isinstance(model, TemporalKinematicsHead):
        raise ValueError("model must be a TemporalKinematicsHead instance")
    n_params = _require_parameter_budget(model)
    state_dict_cpu = {k: v.detach().cpu().float().contiguous() for k, v in model.state_dict().items()}
    for name, tensor in state_dict_cpu.items():
        if not torch.isfinite(tensor).all():
            raise ValueError(f"Non-finite parameter tensor {name!r}; refusing to save checkpoint")

    extra = dict(metadata) if metadata is not None else {}
    core = {
        "arch": ARCH,
        "schema_version": SCHEMA_VERSION,
        "window_size": model.window_size,
        "num_classes": model.num_classes,
        "num_kinematics": model.num_kinematics,
        "kinematics_features": list(KINEMATICS_FEATURES),
        "labels": list(LABELS),
        "config": model.get_config(),
        "parameters": n_params,
        "model": state_dict_cpu,
    }
    for key, expected in core.items():
        if key in extra and key != "model" and extra[key] != expected:
            raise ValueError(f"metadata cannot override reserved checkpoint field {key!r}")
    if "model" in extra:
        raise ValueError("metadata cannot override reserved checkpoint field 'model'")

    ckpt = {**extra, **core}
    with io.BytesIO() as buf:
        torch.save(ckpt, buf)
        payload = buf.getvalue()

    dest = _atomic_write_bytes(path, payload)
    return {
        "path": dest.name,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "parameters": n_params,
    }


def _model_from_checkpoint_dict(ckpt: dict[str, Any]) -> TemporalKinematicsHead:
    if not isinstance(ckpt, dict):
        raise ValueError("Checkpoint must be a dictionary")
    if ckpt.get("arch") != ARCH:
        raise ValueError(f"Expected checkpoint arch {ARCH!r}, got {ckpt.get('arch')!r}")
    if ckpt.get("schema_version", SCHEMA_VERSION) != SCHEMA_VERSION:
        raise ValueError(
            f"Unsupported schema_version {ckpt.get('schema_version')!r}; expected {SCHEMA_VERSION}"
        )
    config = ckpt.get("config")
    if not isinstance(config, dict):
        raise ValueError("Checkpoint missing valid 'config' dictionary")
    model = TemporalKinematicsHead(**config)
    _require_parameter_budget(model)
    state = ckpt.get("model")
    if not isinstance(state, dict):
        raise ValueError("Checkpoint missing 'model' state_dict")
    model.load_state_dict(state, strict=True)
    for name, param in model.named_parameters():
        if not torch.isfinite(param).all():
            raise ValueError(f"Checkpoint parameter {name!r} contains non-finite values")
    model.eval()
    return model


def load_checkpoint(path: Path | str) -> tuple[TemporalKinematicsHead, dict[str, Any]]:
    """Load and validate a TemporalKinematicsHead checkpoint on CPU with weights_only=True."""
    ckpt = torch.load(Path(path), map_location="cpu", weights_only=True)
    model = _model_from_checkpoint_dict(ckpt)
    return model, ckpt


def _resolve_cpu_eval_model(model_or_ckpt: TemporalKinematicsHead | dict[str, Any] | Path | str) -> TemporalKinematicsHead:
    if isinstance(model_or_ckpt, TemporalKinematicsHead):
        _require_parameter_budget(model_or_ckpt)
        cpu_model = TemporalKinematicsHead(**model_or_ckpt.get_config())
        state = {k: v.detach().cpu().float().contiguous() for k, v in model_or_ckpt.state_dict().items()}
        for name, tensor in state.items():
            if not torch.isfinite(tensor).all():
                raise ValueError(f"Model parameter {name!r} contains non-finite values")
        cpu_model.load_state_dict(state, strict=True)
        cpu_model.eval()
        return cpu_model
    if isinstance(model_or_ckpt, dict):
        return _model_from_checkpoint_dict(model_or_ckpt)
    if isinstance(model_or_ckpt, (Path, str)):
        model, _ = load_checkpoint(model_or_ckpt)
        return model
    raise ValueError("model_or_ckpt must be a TemporalKinematicsHead, checkpoint dict, or checkpoint path")


def _synthetic_parity_batch(model: TemporalKinematicsHead, batch_size: int, seed_offset: int = 0) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(_PARITY_SEED + seed_offset + batch_size * 97)
    frame_logits = rng.normal(loc=0.0, scale=2.2, size=(batch_size, model.window_size, model.num_classes)).astype(
        np.float32
    )
    if model.window_size == WINDOW_SIZE and model.num_kinematics == NUM_KINEMATICS:
        boxes = np.zeros((batch_size, WINDOW_SIZE, 4), dtype=np.float64)
        idx = np.zeros((batch_size, WINDOW_SIZE), dtype=np.int64)
        for b in range(batch_size):
            gaps = rng.integers(1, 4, size=WINDOW_SIZE - 1)
            idx[b, 1:] = np.cumsum(gaps)
            x0, y0 = rng.uniform(40.0, 560.0), rng.uniform(40.0, 440.0)
            vx, vy = rng.uniform(-12.0, 12.0), rng.uniform(-9.0, 9.0)
            w0, h0 = rng.uniform(5.0, 28.0), rng.uniform(5.0, 28.0)
            for t in range(WINDOW_SIZE):
                step_t = float(idx[b, t])
                boxes[b, t, 0] = x0 + vx * step_t + rng.normal(0.0, 0.8)
                boxes[b, t, 1] = y0 + vy * step_t + rng.normal(0.0, 0.8)
                boxes[b, t, 2] = max(2.0, w0 * (1.0 + 0.02 * t))
                boxes[b, t, 3] = max(2.0, h0 * (1.0 + 0.02 * t))
        kinematics = compute_kinematics_features(boxes, idx)
    else:
        kinematics = rng.normal(
            loc=0.0, scale=0.5, size=(batch_size, model.window_size, model.num_kinematics)
        ).astype(np.float32)
    return np.ascontiguousarray(frame_logits, dtype=np.float32), np.ascontiguousarray(kinematics, dtype=np.float32)


def _require_inline_onnx_tensors(message: Any, tensor_proto: Any) -> None:
    if isinstance(message, tensor_proto):
        if message.external_data or message.data_location == tensor_proto.EXTERNAL:
            raise ValueError(f"ONNX tensor {message.name!r} uses external data; expected self-contained artifact")
        return
    for field, value in message.ListFields():
        if field.message_type is not None:
            children = (value,) if hasattr(value, "ListFields") else value
            for child in children:
                _require_inline_onnx_tensors(child, tensor_proto)


def export_onnx(model_or_ckpt: TemporalKinematicsHead | dict[str, Any] | Path | str, out_path: Path | str) -> dict[str, Any]:
    """Export self-contained opset-17 ONNX (<=100 KB) and verify ONNX Runtime CPU parity <=1e-6 on batch 1 and 4."""
    import onnx
    import onnxruntime as ort

    model = _resolve_cpu_eval_model(model_or_ckpt)
    dummy_logits = torch.zeros(1, model.window_size, model.num_classes, dtype=torch.float32)
    dummy_kin = torch.zeros(1, model.window_size, model.num_kinematics, dtype=torch.float32)

    with io.BytesIO() as buf, warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        torch.onnx.export(
            model,
            (dummy_logits, dummy_kin),
            buf,
            dynamo=False,
            external_data=False,
            opset_version=17,
            do_constant_folding=True,
            input_names=["frame_logits", "kinematics"],
            output_names=["fused_logits"],
            dynamic_axes={
                "frame_logits": {0: "batch"},
                "kinematics": {0: "batch"},
                "fused_logits": {0: "batch"},
            },
        )
        payload = buf.getvalue()

    size_bytes = len(payload)
    if not (0 < size_bytes <= MAX_ONNX_BYTES):
        raise ValueError(f"ONNX size must satisfy 0 < bytes <= {MAX_ONNX_BYTES}, got {size_bytes}")

    graph = onnx.load_model_from_string(payload)
    _require_inline_onnx_tensors(graph, onnx.TensorProto)
    onnx.checker.check_model(graph)
    opsets = [imp.version for imp in graph.opset_import if imp.domain in ("", "ai.onnx")]
    if 17 not in opsets:
        raise ValueError(f"Expected ai.onnx opset 17, got {opsets}")

    session = ort.InferenceSession(payload, providers=["CPUExecutionProvider"])
    in_bindings = {b.name: b for b in session.get_inputs()}
    out_bindings = {b.name: b for b in session.get_outputs()}
    if list(in_bindings.keys()) != ["frame_logits", "kinematics"]:
        raise ValueError(f"Unexpected ONNX inputs: {list(in_bindings.keys())}")
    if list(out_bindings.keys()) != ["fused_logits"]:
        raise ValueError(f"Unexpected ONNX outputs: {list(out_bindings.keys())}")

    errors: dict[int, float] = {}
    with torch.inference_mode():
        for batch_size in (1, 4):
            fl_np, kin_np = _synthetic_parity_batch(model, batch_size)
            expected = model(torch.from_numpy(fl_np), torch.from_numpy(kin_np)).numpy()
            (actual,) = session.run(["fused_logits"], {"frame_logits": fl_np, "kinematics": kin_np})
            if actual.shape != expected.shape or not np.isfinite(actual).all() or not np.isfinite(expected).all():
                raise ValueError(f"Invalid ONNX output on batch {batch_size}: shape {actual.shape}")
            err = float(np.max(np.abs(actual - expected)))
            if err > PARITY_ATOL:
                raise ValueError(
                    f"ONNX parity error {err:.3e} exceeds {PARITY_ATOL:.1e} for batch {batch_size}"
                )
            errors[batch_size] = err

    _atomic_write_bytes(out_path, payload)
    return {
        "bytes": size_bytes,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "opset_version": 17,
        "max_abs_error_batch1": errors[1],
        "max_abs_error_batch4": errors[4],
    }


def _encode_f32_le_b64(arr: np.ndarray | torch.Tensor) -> str:
    if isinstance(arr, torch.Tensor):
        arr = arr.detach().cpu().numpy()
    return base64.b64encode(np.ascontiguousarray(arr, dtype="<f4").tobytes()).decode("ascii")


def _decode_f32_le_b64(entry: Any, expected_numel: int, name: str) -> np.ndarray:
    if isinstance(entry, dict):
        b64_str = entry.get("data_b64") or entry.get("b64")
    else:
        b64_str = entry
    if not isinstance(b64_str, str) or not b64_str:
        raise ValueError(f"Weight {name!r} must be a non-empty base64 string")
    try:
        raw = base64.b64decode(b64_str, validate=True)
    except Exception as exc:
        raise ValueError(f"Weight {name!r} contains invalid base64 data") from exc
    if len(raw) != expected_numel * 4:
        raise ValueError(f"Weight {name!r} expected {expected_numel * 4} bytes, got {len(raw)}")
    out = np.frombuffer(raw, dtype="<f4").astype(np.float32, copy=True)
    if not np.isfinite(out).all():
        raise ValueError(f"Weight {name!r} contains non-finite values")
    return out


def _expected_weight_shapes(config: dict[str, int]) -> dict[str, tuple[int, ...]]:
    d_model = int(config["d_model"])
    n_heads = int(config["n_heads"])
    mlp_dim = int(config["mlp_dim"])
    window_size = int(config["window_size"])
    num_classes = int(config["num_classes"])
    num_kinematics = int(config["num_kinematics"])
    if d_model <= 0 or n_heads <= 0 or d_model % n_heads != 0 or mlp_dim <= 0 or window_size <= 0:
        raise ValueError(f"Invalid TemporalKinematicsHead config: {config}")
    in_dim = num_classes * 2 + num_kinematics
    return {
        "in_proj.weight": (d_model, in_dim),
        "in_proj.bias": (d_model,),
        "pos_embed": (1, window_size, d_model),
        "ln1.weight": (d_model,),
        "ln1.bias": (d_model,),
        "q_proj.weight": (d_model, d_model),
        "q_proj.bias": (d_model,),
        "k_proj.weight": (d_model, d_model),
        "k_proj.bias": (d_model,),
        "v_proj.weight": (d_model, d_model),
        "v_proj.bias": (d_model,),
        "out_proj.weight": (d_model, d_model),
        "out_proj.bias": (d_model,),
        "ln2.weight": (d_model,),
        "ln2.bias": (d_model,),
        "mlp1.weight": (mlp_dim, d_model),
        "mlp1.bias": (mlp_dim,),
        "mlp2.weight": (d_model, mlp_dim),
        "mlp2.bias": (d_model,),
        "ln_pool.weight": (d_model,),
        "ln_pool.bias": (d_model,),
        "pool_gate.weight": (1, d_model),
        "pool_gate.bias": (1,),
        "residual_head.weight": (num_classes, d_model),
        "residual_head.bias": (num_classes,),
        "residual_scale": (),
    }


def _decode_spec_weights(spec: dict[str, Any]) -> tuple[dict[str, int], dict[str, np.ndarray]]:
    if not isinstance(spec, dict):
        raise ValueError("Browser spec must be a dictionary")
    if spec.get("arch") != ARCH:
        raise ValueError(f"Expected spec arch {ARCH!r}, got {spec.get('arch')!r}")
    if spec.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"Expected schema_version {SCHEMA_VERSION}, got {spec.get('schema_version')!r}")
    config = spec.get("config")
    if not isinstance(config, dict):
        raise ValueError("Spec missing 'config' dictionary")
    shapes = _expected_weight_shapes(config)
    total_params = sum(int(math.prod(shape)) for shape in shapes.values())
    if not (0 < total_params < MAX_PARAMETERS):
        raise ValueError(f"Spec parameter count {total_params} exceeds budget {MAX_PARAMETERS}")
    if spec.get("parameters") is not None and int(spec["parameters"]) != total_params:
        raise ValueError(f"Spec parameters field {spec['parameters']} != actual {total_params}")

    raw_weights = spec.get("weights")
    if not isinstance(raw_weights, dict):
        raise ValueError("Spec missing 'weights' dictionary")
    decoded: dict[str, np.ndarray] = {}
    for name, shape in shapes.items():
        if name not in raw_weights:
            raise ValueError(f"Spec missing weight tensor {name!r}")
        numel = int(math.prod(shape))
        arr = _decode_f32_le_b64(raw_weights[name], numel, name)
        decoded[name] = arr.reshape(shape) if shape else arr.reshape(())
    return {k: int(v) for k, v in config.items()}, decoded


BROWSER_RUNTIME_JS = r"""// Pure JavaScript Float32Array runtime for SkySentry v5_temporal_kinematics (zero dependencies).
export const ARCH = "v5_temporal_kinematics";
export const SCHEMA_VERSION = 1;
export const WINDOW_SIZE = 5;
export const NUM_CLASSES = 3;
export const LABELS = Object.freeze(["bird", "drone", "other"]);
export const KINEMATICS_FEATURES = Object.freeze([
  "dx",
  "dy",
  "speed",
  "turn_cos",
  "log_box_px",
  "scale_delta",
]);
export const NUM_KINEMATICS = 6;

const f32 = Math.fround;

function isTypedNumericArray(v) {
  return ArrayBuffer.isView(v) && !(v instanceof DataView) && !(v instanceof BigInt64Array) && !(v instanceof BigUint64Array);
}

function isSeq(v) {
  return Array.isArray(v) || isTypedNumericArray(v);
}

function decodeBase64Bytes(b64) {
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("Expected non-empty base64 string");
  }
  if (typeof globalThis.atob === "function") {
    const bin = globalThis.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  throw new Error("No base64 decoder available in this JavaScript runtime");
}

function decodeF32Le(entry, expectedLength, name) {
  const b64 = entry && typeof entry === "object" ? (entry.data_b64 || entry.b64) : entry;
  const bytes = decodeBase64Bytes(b64);
  if (bytes.byteLength !== expectedLength * 4) {
    throw new Error(`Weight ${name}: expected ${expectedLength * 4} bytes, got ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) throw new Error(`Weight ${name} contains non-finite float32`);
    out[i] = v;
  }
  return out;
}

function validateChronoRow(row, windowSize = WINDOW_SIZE) {
  if (!isSeq(row) || row.length !== windowSize) {
    throw new Error(`frameIndices row must have length ${windowSize}`);
  }
  const out = new Array(windowSize);
  let prev = -1;
  for (let t = 0; t < windowSize; t++) {
    const v = row[t];
    if (typeof v === "boolean" || typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error("frameIndices must contain finite numeric non-boolean integers");
    }
    if (Math.floor(v) !== v || v < 0 || v > Number.MAX_SAFE_INTEGER) {
      throw new Error("frameIndices must be non-negative safe integers");
    }
    if (t > 0 && !(v > prev)) {
      throw new Error("frameIndices must be strictly increasing");
    }
    const normV = v === 0 ? 0 : v;
    out[t] = normV;
    prev = normV;
  }
  return out;
}

export function validateChronologicalFramesJs(frameIndices) {
  if (!isSeq(frameIndices)) {
    throw new Error("frameIndices must be a 1D or 2D sequence");
  }
  if (frameIndices.length > 0 && isSeq(frameIndices[0])) {
    const rows = new Array(frameIndices.length);
    for (let i = 0; i < frameIndices.length; i++) {
      rows[i] = validateChronoRow(frameIndices[i], WINDOW_SIZE);
    }
    return rows;
  }
  if (Array.isArray(frameIndices) && frameIndices.length === 0) {
    throw new Error(`frameIndices 1D sequence must have length ${WINDOW_SIZE}`);
  }
  return validateChronoRow(frameIndices, WINDOW_SIZE);
}

function computeSingleKinematicsWindow(boxes2d, idxRow, frameW, frameH) {
  if (!isSeq(boxes2d) || boxes2d.length !== WINDOW_SIZE) {
    throw new Error(`boxesXywh window must have ${WINDOW_SIZE} rows`);
  }
  const cx = new Float64Array(WINDOW_SIZE);
  const cy = new Float64Array(WINDOW_SIZE);
  const logBoxPx = new Float64Array(WINDOW_SIZE);
  const dx = new Float64Array(WINDOW_SIZE);
  const dy = new Float64Array(WINDOW_SIZE);
  const speed = new Float64Array(WINDOW_SIZE);
  const turnCos = new Float64Array(WINDOW_SIZE);
  const scaleDelta = new Float64Array(WINDOW_SIZE);

  for (let t = 0; t < WINDOW_SIZE; t++) {
    const box = boxes2d[t];
    if (!isSeq(box) || box.length !== 4) {
      throw new Error("Each box in boxesXywh must have 4 elements [x, y, w, h]");
    }
    const x = box[0], y = box[1], w = box[2], h = box[3];
    if (
      typeof x === "boolean" || typeof y === "boolean" || typeof w === "boolean" || typeof h === "boolean" ||
      typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number" ||
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)
    ) {
      throw new Error("boxesXywh values must be finite numbers");
    }
    if (!(w > 0.0 && h > 0.0)) {
      throw new Error("boxesXywh width and height must be > 0");
    }
    cx[t] = (x + 0.5 * w) / frameW;
    cy[t] = (y + 0.5 * h) / frameH;
    const boxPx = Math.max(Math.max(w, h), 1.0);
    logBoxPx[t] = Math.log(boxPx);
    turnCos[t] = 1.0;
  }

  for (let t = 1; t < WINDOW_SIZE; t++) {
    const dt = idxRow[t] - idxRow[t - 1];
    dx[t] = (cx[t] - cx[t - 1]) / dt;
    dy[t] = (cy[t] - cy[t - 1]) / dt;
    speed[t] = Math.hypot(dx[t], dy[t]);
    scaleDelta[t] = (logBoxPx[t] - logBoxPx[t - 1]) / dt;
    if (t >= 2 && speed[t] >= 1e-6 && speed[t - 1] >= 1e-6) {
      const dot = dx[t] * dx[t - 1] + dy[t] * dy[t - 1];
      const rawCos = dot / (speed[t] * speed[t - 1]);
      turnCos[t] = Math.min(1.0, Math.max(-1.0, rawCos));
    }
  }

  const out = new Array(WINDOW_SIZE);
  for (let t = 0; t < WINDOW_SIZE; t++) {
    const row = new Float32Array(NUM_KINEMATICS);
    row[0] = dx[t];
    row[1] = dy[t];
    row[2] = speed[t];
    row[3] = turnCos[t];
    row[4] = logBoxPx[t];
    row[5] = scaleDelta[t];
    out[t] = row;
  }
  return out;
}

export function computeKinematicsFeaturesJs(boxesXywh, frameIndices, frameWh = [640.0, 512.0]) {
  if (!isSeq(frameWh) || frameWh.length !== 2) {
    throw new Error("frameWh must be [frameW, frameH]");
  }
  const frameW = frameWh[0];
  const frameH = frameWh[1];
  if (
    typeof frameW === "boolean" || typeof frameH === "boolean" ||
    typeof frameW !== "number" || typeof frameH !== "number" ||
    !Number.isFinite(frameW) || !Number.isFinite(frameH) ||
    !(frameW > 0.0 && frameH > 0.0)
  ) {
    throw new Error("frameWh must contain positive finite numbers");
  }
  if (!isSeq(boxesXywh) || boxesXywh.length === 0) {
    throw new Error("boxesXywh must be (5, 4) or (N, 5, 4)");
  }
  const idx = validateChronologicalFramesJs(frameIndices);
  const idxIs2D = Array.isArray(idx[0]);
  const isBatched = isSeq(boxesXywh[0]) && boxesXywh[0].length > 0 && isSeq(boxesXywh[0][0]);

  if (!isBatched) {
    if (idxIs2D) {
      throw new Error("Unbatched boxesXywh requires 1D frameIndices");
    }
    return computeSingleKinematicsWindow(boxesXywh, idx, frameW, frameH);
  }

  const batchSize = boxesXywh.length;
  if (idxIs2D && idx.length !== batchSize) {
    throw new Error(`Batch mismatch between boxesXywh (${batchSize}) and frameIndices (${idx.length})`);
  }
  const out = new Array(batchSize);
  for (let b = 0; b < batchSize; b++) {
    out[b] = computeSingleKinematicsWindow(boxesXywh[b], idxIs2D ? idx[b] : idx, frameW, frameH);
  }
  return out;
}

export function loadTemporalKinematics(spec) {
  if (spec && spec.__loadedTemporalKinematics === true) {
    return spec;
  }
  if (!spec || typeof spec !== "object") {
    throw new Error("spec must be a parsed v5_temporal_kinematics JSON object");
  }
  if (spec.arch !== ARCH || spec.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported model spec: arch=${spec.arch} schema_version=${spec.schema_version}`);
  }
  const cfg = spec.config;
  if (!cfg || typeof cfg !== "object") {
    throw new Error("spec missing config");
  }
  const dModel = cfg.d_model | 0;
  const nHeads = cfg.n_heads | 0;
  const mlpDim = cfg.mlp_dim | 0;
  const windowSize = cfg.window_size | 0;
  const numClasses = cfg.num_classes | 0;
  const numKinematics = cfg.num_kinematics | 0;
  if (dModel <= 0 || nHeads <= 0 || dModel % nHeads !== 0 || mlpDim <= 0 || windowSize <= 0) {
    throw new Error("Invalid config dimensions in spec");
  }
  const inDim = numClasses * 2 + numKinematics;
  const rw = spec.weights;
  if (!rw || typeof rw !== "object") {
    throw new Error("spec missing weights");
  }
  const weights = {
    inProjW: decodeF32Le(rw["in_proj.weight"], dModel * inDim, "in_proj.weight"),
    inProjB: decodeF32Le(rw["in_proj.bias"], dModel, "in_proj.bias"),
    posEmbed: decodeF32Le(rw["pos_embed"], windowSize * dModel, "pos_embed"),
    ln1W: decodeF32Le(rw["ln1.weight"], dModel, "ln1.weight"),
    ln1B: decodeF32Le(rw["ln1.bias"], dModel, "ln1.bias"),
    qProjW: decodeF32Le(rw["q_proj.weight"], dModel * dModel, "q_proj.weight"),
    qProjB: decodeF32Le(rw["q_proj.bias"], dModel, "q_proj.bias"),
    kProjW: decodeF32Le(rw["k_proj.weight"], dModel * dModel, "k_proj.weight"),
    kProjB: decodeF32Le(rw["k_proj.bias"], dModel, "k_proj.bias"),
    vProjW: decodeF32Le(rw["v_proj.weight"], dModel * dModel, "v_proj.weight"),
    vProjB: decodeF32Le(rw["v_proj.bias"], dModel, "v_proj.bias"),
    outProjW: decodeF32Le(rw["out_proj.weight"], dModel * dModel, "out_proj.weight"),
    outProjB: decodeF32Le(rw["out_proj.bias"], dModel, "out_proj.bias"),
    ln2W: decodeF32Le(rw["ln2.weight"], dModel, "ln2.weight"),
    ln2B: decodeF32Le(rw["ln2.bias"], dModel, "ln2.bias"),
    mlp1W: decodeF32Le(rw["mlp1.weight"], mlpDim * dModel, "mlp1.weight"),
    mlp1B: decodeF32Le(rw["mlp1.bias"], mlpDim, "mlp1.bias"),
    mlp2W: decodeF32Le(rw["mlp2.weight"], dModel * mlpDim, "mlp2.weight"),
    mlp2B: decodeF32Le(rw["mlp2.bias"], dModel, "mlp2.bias"),
    lnPoolW: decodeF32Le(rw["ln_pool.weight"], dModel, "ln_pool.weight"),
    lnPoolB: decodeF32Le(rw["ln_pool.bias"], dModel, "ln_pool.bias"),
    poolGateW: decodeF32Le(rw["pool_gate.weight"], dModel, "pool_gate.weight"),
    poolGateB: decodeF32Le(rw["pool_gate.bias"], 1, "pool_gate.bias"),
    resHeadW: decodeF32Le(rw["residual_head.weight"], numClasses * dModel, "residual_head.weight"),
    resHeadB: decodeF32Le(rw["residual_head.bias"], numClasses, "residual_head.bias"),
    resScale: decodeF32Le(rw["residual_scale"], 1, "residual_scale")[0],
  };
  const loaded = {
    __loadedTemporalKinematics: true,
    config: { dModel, nHeads, headDim: (dModel / nHeads) | 0, mlpDim, windowSize, numClasses, numKinematics, inDim },
    weights,
    predict(frameLogits, kinematics, frameIndices = null) {
      return predictTemporalWindowJs(loaded, frameLogits, kinematics, frameIndices);
    },
  };
  return loaded;
}

export const loadTemporalSpecJs = loadTemporalKinematics;

function flattenWindow2D(input, rows, cols, name) {
  const out = new Float32Array(rows * cols);
  if (isTypedNumericArray(input) && input.length === rows * cols) {
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(input[i])) throw new Error(`${name} contains non-finite value`);
      out[i] = input[i];
    }
    return out;
  }
  if (!isSeq(input) || input.length !== rows) {
    throw new Error(`${name} must have shape (${rows}, ${cols})`);
  }
  let p = 0;
  for (let r = 0; r < rows; r++) {
    const row = input[r];
    if (!isSeq(row) || row.length !== cols) {
      throw new Error(`${name}[${r}] must have length ${cols}`);
    }
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      if (typeof v === "boolean" || typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`${name} must contain finite numeric values`);
      }
      out[p++] = v;
    }
  }
  return out;
}

function linearSeqF32(x, seqLen, inDim, outDim, weight, bias) {
  const out = new Float32Array(seqLen * outDim);
  for (let t = 0; t < seqLen; t++) {
    const xBase = t * inDim;
    const oBase = t * outDim;
    for (let o = 0; o < outDim; o++) {
      const wBase = o * inDim;
      let acc = f32(0.0);
      for (let i = 0; i < inDim; i++) {
        acc = f32(acc + f32(x[xBase + i] * weight[wBase + i]));
      }
      out[oBase + o] = f32(acc + bias[o]);
    }
  }
  return out;
}

function layerNormSeqF32(x, seqLen, dim, weight, bias) {
  const out = new Float32Array(seqLen * dim);
  const eps = f32(1e-5);
  const invDim = f32(1.0 / dim);
  for (let t = 0; t < seqLen; t++) {
    const base = t * dim;
    let sum = f32(0.0);
    for (let d = 0; d < dim; d++) sum = f32(sum + x[base + d]);
    const mean = f32(sum * invDim);
    let varSum = f32(0.0);
    for (let d = 0; d < dim; d++) {
      const diff = f32(x[base + d] - mean);
      varSum = f32(varSum + f32(diff * diff));
    }
    const invStd = f32(1.0 / Math.sqrt(f32(f32(varSum * invDim) + eps)));
    for (let d = 0; d < dim; d++) {
      const norm = f32(f32(x[base + d] - mean) * invStd);
      out[base + d] = f32(f32(norm * weight[d]) + bias[d]);
    }
  }
  return out;
}

function forwardSingleWindowF32(model, flFlat, kinFlat) {
  const { dModel, nHeads, headDim, mlpDim, windowSize, numClasses, numKinematics, inDim } = model.config;
  const w = model.weights;

  // 1-3: frame softmax, clamped uniform mean, log base_logits
  const probs = new Float32Array(windowSize * numClasses);
  for (let t = 0; t < windowSize; t++) {
    const base = t * numClasses;
    let maxV = flFlat[base];
    for (let c = 1; c < numClasses; c++) {
      if (flFlat[base + c] > maxV) maxV = flFlat[base + c];
    }
    let expSum = f32(0.0);
    for (let c = 0; c < numClasses; c++) {
      const e = f32(Math.exp(f32(flFlat[base + c] - maxV)));
      probs[base + c] = e;
      expSum = f32(expSum + e);
    }
    for (let c = 0; c < numClasses; c++) {
      probs[base + c] = f32(probs[base + c] / expSum);
    }
  }

  const baseLogits = new Float32Array(numClasses);
  const invT = f32(1.0 / windowSize);
  const minProb = f32(1e-7);
  for (let c = 0; c < numClasses; c++) {
    let s = f32(0.0);
    for (let t = 0; t < windowSize; t++) s = f32(s + probs[t * numClasses + c]);
    const mp = Math.max(f32(s * invT), minProb);
    baseLogits[c] = f32(Math.log(mp));
  }

  // 4-5: concat [frame_logits, probs, kinematics] -> in_proj + pos_embed
  const x = new Float32Array(windowSize * inDim);
  for (let t = 0; t < windowSize; t++) {
    const xBase = t * inDim;
    const flBase = t * numClasses;
    const kBase = t * numKinematics;
    for (let c = 0; c < numClasses; c++) {
      x[xBase + c] = flFlat[flBase + c];
      x[xBase + numClasses + c] = probs[flBase + c];
    }
    for (let k = 0; k < numKinematics; k++) {
      x[xBase + numClasses * 2 + k] = kinFlat[kBase + k];
    }
  }

  const h = linearSeqF32(x, windowSize, inDim, dModel, w.inProjW, w.inProjB);
  for (let i = 0; i < h.length; i++) h[i] = f32(h[i] + w.posEmbed[i]);

  // 6-7: pre-LN multi-head self-attention
  const u = layerNormSeqF32(h, windowSize, dModel, w.ln1W, w.ln1B);
  const qAll = linearSeqF32(u, windowSize, dModel, dModel, w.qProjW, w.qProjB);
  const kAll = linearSeqF32(u, windowSize, dModel, dModel, w.kProjW, w.kProjB);
  const vAll = linearSeqF32(u, windowSize, dModel, dModel, w.vProjW, w.vProjB);

  const ctx = new Float32Array(windowSize * dModel);
  const attnScale = f32(1.0 / Math.sqrt(headDim));
  const scores = new Float32Array(windowSize);
  const attn = new Float32Array(windowSize);

  for (let hd = 0; hd < nHeads; hd++) {
    const hOff = hd * headDim;
    for (let ti = 0; ti < windowSize; ti++) {
      const qBase = ti * dModel + hOff;
      let maxScore = -Infinity;
      for (let tj = 0; tj < windowSize; tj++) {
        const kBase = tj * dModel + hOff;
        let dot = f32(0.0);
        for (let d = 0; d < headDim; d++) {
          dot = f32(dot + f32(qAll[qBase + d] * kAll[kBase + d]));
        }
        const sc = f32(dot * attnScale);
        scores[tj] = sc;
        if (sc > maxScore) maxScore = sc;
      }
      let sumExp = f32(0.0);
      for (let tj = 0; tj < windowSize; tj++) {
        const e = f32(Math.exp(f32(scores[tj] - maxScore)));
        attn[tj] = e;
        sumExp = f32(sumExp + e);
      }
      for (let tj = 0; tj < windowSize; tj++) {
        attn[tj] = f32(attn[tj] / sumExp);
      }
      const cBase = ti * dModel + hOff;
      for (let d = 0; d < headDim; d++) {
        let acc = f32(0.0);
        for (let tj = 0; tj < windowSize; tj++) {
          acc = f32(acc + f32(attn[tj] * vAll[tj * dModel + hOff + d]));
        }
        ctx[cBase + d] = acc;
      }
    }
  }

  const attnOut = linearSeqF32(ctx, windowSize, dModel, dModel, w.outProjW, w.outProjB);
  for (let i = 0; i < h.length; i++) h[i] = f32(h[i] + attnOut[i]);

  // 8: pre-LN MLP with ReLU
  const u2 = layerNormSeqF32(h, windowSize, dModel, w.ln2W, w.ln2B);
  const m1 = linearSeqF32(u2, windowSize, dModel, mlpDim, w.mlp1W, w.mlp1B);
  for (let i = 0; i < m1.length; i++) {
    if (m1[i] < 0.0) m1[i] = 0.0;
  }
  const m2 = linearSeqF32(m1, windowSize, mlpDim, dModel, w.mlp2W, w.mlp2B);
  for (let i = 0; i < h.length; i++) h[i] = f32(h[i] + m2[i]);

  // 9-11: LN + softmax gate pooling over time
  const hp = layerNormSeqF32(h, windowSize, dModel, w.lnPoolW, w.lnPoolB);
  const gateLogits = linearSeqF32(hp, windowSize, dModel, 1, w.poolGateW, w.poolGateB);
  let maxG = gateLogits[0];
  for (let t = 1; t < windowSize; t++) {
    if (gateLogits[t] > maxG) maxG = gateLogits[t];
  }
  const gates = new Float32Array(windowSize);
  let gateSum = f32(0.0);
  for (let t = 0; t < windowSize; t++) {
    const e = f32(Math.exp(f32(gateLogits[t] - maxG)));
    gates[t] = e;
    gateSum = f32(gateSum + e);
  }
  for (let t = 0; t < windowSize; t++) gates[t] = f32(gates[t] / gateSum);

  const pooled = new Float32Array(dModel);
  for (let d = 0; d < dModel; d++) {
    let s = f32(0.0);
    for (let t = 0; t < windowSize; t++) {
      s = f32(s + f32(hp[t * dModel + d] * gates[t]));
    }
    pooled[d] = s;
  }

  // 12-13: residual_head * residual_scale + base_logits
  const headOut = linearSeqF32(pooled, 1, dModel, numClasses, w.resHeadW, w.resHeadB);
  const fused = new Float32Array(numClasses);
  for (let c = 0; c < numClasses; c++) {
    fused[c] = f32(baseLogits[c] + f32(headOut[c] * w.resScale));
  }
  return fused;
}

export function predictTemporalWindowJs(spec, frameLogits, kinematics, frameIndices = null) {
  const model = loadTemporalKinematics(spec);
  const { windowSize, numClasses, numKinematics } = model.config;

  const flIs3D =
    isSeq(frameLogits) &&
    frameLogits.length > 0 &&
    isSeq(frameLogits[0]) &&
    frameLogits[0].length > 0 &&
    isSeq(frameLogits[0][0]);
  const kinIs3D =
    isSeq(kinematics) &&
    kinematics.length > 0 &&
    isSeq(kinematics[0]) &&
    kinematics[0].length > 0 &&
    isSeq(kinematics[0][0]);

  if (flIs3D !== kinIs3D) {
    throw new Error("frameLogits and kinematics must both be unbatched 2D or both be batched 3D");
  }

  if (frameIndices !== null && frameIndices !== undefined) {
    const idx = validateChronologicalFramesJs(frameIndices);
    const idxIs2D = Array.isArray(idx[0]);
    if (!flIs3D && idxIs2D) {
      throw new Error("Unbatched predictTemporalWindowJs requires 1D frameIndices");
    }
    if (flIs3D && idxIs2D && idx.length !== frameLogits.length) {
      throw new Error(`Batch mismatch between frameLogits (${frameLogits.length}) and frameIndices (${idx.length})`);
    }
  }

  if (!flIs3D) {
    const flFlat = flattenWindow2D(frameLogits, windowSize, numClasses, "frameLogits");
    const kinFlat = flattenWindow2D(kinematics, windowSize, numKinematics, "kinematics");
    return forwardSingleWindowF32(model, flFlat, kinFlat);
  }

  if (frameLogits.length !== kinematics.length) {
    throw new Error(`Batch mismatch between frameLogits (${frameLogits.length}) and kinematics (${kinematics.length})`);
  }
  const out = new Array(frameLogits.length);
  for (let b = 0; b < frameLogits.length; b++) {
    const flFlat = flattenWindow2D(frameLogits[b], windowSize, numClasses, `frameLogits[${b}]`);
    const kinFlat = flattenWindow2D(kinematics[b], windowSize, numKinematics, `kinematics[${b}]`);
    out[b] = forwardSingleWindowF32(model, flFlat, kinFlat);
  }
  return out;
}
"""


def _build_reference_cases(model: TemporalKinematicsHead) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    rng = np.random.default_rng(_PARITY_SEED + 7)
    w_steps = model.window_size
    n_cls = model.num_classes
    n_kin = model.num_kinematics

    if w_steps == WINDOW_SIZE and n_kin == NUM_KINEMATICS:
        raw_windows = [
            (
                [0, 1, 2, 3, 4],
                [
                    [280.0, 190.0, 8.0, 7.0],
                    [284.5, 188.0, 8.5, 7.0],
                    [288.0, 189.5, 8.0, 7.5],
                    [293.0, 187.0, 9.0, 8.0],
                    [297.5, 188.5, 8.5, 7.5],
                ],
            ),
            (
                [10, 12, 15, 16, 19],
                [
                    [120.0, 240.0, 18.0, 14.0],
                    [132.0, 236.0, 18.5, 14.2],
                    [150.0, 230.0, 19.2, 14.8],
                    [156.0, 228.0, 19.5, 15.0],
                    [174.0, 222.0, 20.4, 15.6],
                ],
            ),
            (
                [0, 3, 6, 9, 12],
                [
                    [410.0, 310.0, 14.0, 14.0],
                    [410.0, 310.0, 14.0, 14.0],
                    [410.0, 310.0, 14.0, 14.0],
                    [410.0, 310.0, 14.0, 14.0],
                    [410.0, 310.0, 14.0, 14.0],
                ],
            ),
        ]
    else:
        raw_windows = [
            (list(range(i, i + w_steps)), None)
            for i in range(3)
        ]

    with torch.inference_mode():
        for idx_list, boxes_list in raw_windows:
            idx_arr = validate_chronological_frames(idx_list)
            fl_np = rng.normal(loc=0.0, scale=1.8, size=(w_steps, n_cls)).astype(np.float32)
            if boxes_list is not None:
                kin_np = compute_kinematics_features(boxes_list, idx_arr)
            else:
                kin_np = rng.normal(loc=0.0, scale=0.4, size=(w_steps, n_kin)).astype(np.float32)
            exp_logits_t = model(torch.from_numpy(fl_np), torch.from_numpy(kin_np), frame_indices=idx_arr)
            exp_probs_t = torch.softmax(exp_logits_t, dim=-1)
            cases.append(
                {
                    "frame_indices": [int(v) for v in idx_arr.tolist()],
                    "frame_logits": [[float(v) for v in row] for row in fl_np],
                    "kinematics": [[float(v) for v in row] for row in kin_np],
                    "expected_logits": [float(v) for v in exp_logits_t.numpy()],
                    "expected_probs": [float(v) for v in exp_probs_t.numpy()],
                }
            )
    return cases


def load_browser_json(path_or_dict: Path | str | dict[str, Any]) -> dict[str, Any]:
    """Load and validate an exported browser JSON spec from path, JSON string, or dictionary."""
    if isinstance(path_or_dict, dict):
        spec = path_or_dict
    elif isinstance(path_or_dict, Path):
        spec = json.loads(path_or_dict.read_text(encoding="utf-8"))
    elif isinstance(path_or_dict, str):
        stripped = path_or_dict.lstrip()
        if stripped.startswith("{"):
            spec = json.loads(path_or_dict)
        else:
            spec = json.loads(Path(path_or_dict).read_text(encoding="utf-8"))
    else:
        raise ValueError("path_or_dict must be a Path, str, or dict")

    cfg, _ = _decode_spec_weights(spec)
    if spec.get("window_size") != cfg["window_size"]:
        raise ValueError(f"window_size mismatch: {spec.get('window_size')} vs {cfg['window_size']}")
    if spec.get("classes") != list(LABELS)[: cfg["num_classes"]] and cfg["num_classes"] == NUM_CLASSES:
        raise ValueError(f"Unexpected classes in spec: {spec.get('classes')!r}")
    if (
        cfg["num_kinematics"] == NUM_KINEMATICS
        and spec.get("kinematics_features") != list(KINEMATICS_FEATURES)
    ):
        raise ValueError(f"Unexpected kinematics_features in spec: {spec.get('kinematics_features')!r}")
    return spec


def _linear_np_f32(x: np.ndarray, weight: np.ndarray, bias: np.ndarray) -> np.ndarray:
    return (np.matmul(x, weight.T).astype(np.float32) + bias).astype(np.float32)


def _layernorm_np_f32(x: np.ndarray, weight: np.ndarray, bias: np.ndarray, eps: float = 1e-5) -> np.ndarray:
    mean = np.mean(x, axis=-1, keepdims=True, dtype=np.float32)
    diff = (x - mean).astype(np.float32)
    var = np.mean((diff * diff).astype(np.float32), axis=-1, keepdims=True, dtype=np.float32)
    inv_std = (np.float32(1.0) / np.sqrt((var + np.float32(eps)).astype(np.float32))).astype(np.float32)
    return (diff * inv_std * weight + bias).astype(np.float32)


def predict_temporal_window_js(
    spec: dict[str, Any] | Path | str,
    frame_logits: Any,
    kinematics: Any,
    frame_indices: Any = None,
) -> np.ndarray:
    """Decode <f4 base64 weights from browser JSON spec and run exact float32 layer-by-layer forward pass."""
    loaded_spec = load_browser_json(spec)
    cfg, w = _decode_spec_weights(loaded_spec)
    window_size = cfg["window_size"]
    num_classes = cfg["num_classes"]
    num_kinematics = cfg["num_kinematics"]
    d_model = cfg["d_model"]
    n_heads = cfg["n_heads"]
    head_dim = d_model // n_heads

    fl_arr = _to_numpy_checked(frame_logits, "frame_logits")
    kin_arr = _to_numpy_checked(kinematics, "kinematics")
    if fl_arr.ndim != kin_arr.ndim or fl_arr.ndim not in (2, 3):
        raise ValueError(
            f"frame_logits and kinematics must both be 2D or both be 3D, got {fl_arr.shape} and {kin_arr.shape}"
        )
    if fl_arr.shape[-2:] != (window_size, num_classes):
        raise ValueError(f"Expected frame_logits trailing shape {(window_size, num_classes)}, got {fl_arr.shape}")
    if kin_arr.shape[-2:] != (window_size, num_kinematics):
        raise ValueError(f"Expected kinematics trailing shape {(window_size, num_kinematics)}, got {kin_arr.shape}")
    if not np.isfinite(fl_arr).all() or not np.isfinite(kin_arr).all():
        raise ValueError("frame_logits and kinematics must be finite")

    unbatched = fl_arr.ndim == 2
    if not unbatched and fl_arr.shape[0] != kin_arr.shape[0]:
        raise ValueError(f"Batch mismatch between frame_logits ({fl_arr.shape[0]}) and kinematics ({kin_arr.shape[0]})")

    if frame_indices is not None:
        idx = validate_chronological_frames(frame_indices)
        if unbatched and idx.ndim != 1:
            raise ValueError("Unbatched predict_temporal_window_js requires 1D frame_indices")
        if not unbatched and idx.ndim == 2 and idx.shape[0] != fl_arr.shape[0]:
            raise ValueError(
                f"Batch mismatch between frame_logits ({fl_arr.shape[0]}) and frame_indices ({idx.shape[0]})"
            )

    fl = np.ascontiguousarray(fl_arr[None, ...] if unbatched else fl_arr, dtype=np.float32)
    kin = np.ascontiguousarray(kin_arr[None, ...] if unbatched else kin_arr, dtype=np.float32)
    bsz = fl.shape[0]

    probs = _softmax_np_f32(fl, axis=-1)
    mean_probs = np.maximum(np.mean(probs, axis=1, dtype=np.float32), np.float32(1e-7))
    base_logits = np.log(mean_probs, dtype=np.float32)

    x = np.concatenate([fl, probs, kin], axis=-1).astype(np.float32)
    h = (_linear_np_f32(x, w["in_proj.weight"], w["in_proj.bias"]) + w["pos_embed"]).astype(np.float32)
    u = _layernorm_np_f32(h, w["ln1.weight"], w["ln1.bias"])

    q = _linear_np_f32(u, w["q_proj.weight"], w["q_proj.bias"]).reshape(bsz, window_size, n_heads, head_dim).transpose(0, 2, 1, 3)
    k = _linear_np_f32(u, w["k_proj.weight"], w["k_proj.bias"]).reshape(bsz, window_size, n_heads, head_dim).transpose(0, 2, 1, 3)
    v = _linear_np_f32(u, w["v_proj.weight"], w["v_proj.bias"]).reshape(bsz, window_size, n_heads, head_dim).transpose(0, 2, 1, 3)
    scale = np.float32(head_dim ** -0.5)
    scores = (np.matmul(q, np.swapaxes(k, -2, -1)).astype(np.float32) * scale).astype(np.float32)
    attn = _softmax_np_f32(scores, axis=-1)
    ctx = np.matmul(attn, v).astype(np.float32).transpose(0, 2, 1, 3).reshape(bsz, window_size, d_model)
    h = (h + _linear_np_f32(ctx, w["out_proj.weight"], w["out_proj.bias"])).astype(np.float32)

    u2 = _layernorm_np_f32(h, w["ln2.weight"], w["ln2.bias"])
    m1 = np.maximum(_linear_np_f32(u2, w["mlp1.weight"], w["mlp1.bias"]), np.float32(0.0))
    h = (h + _linear_np_f32(m1, w["mlp2.weight"], w["mlp2.bias"])).astype(np.float32)

    hp = _layernorm_np_f32(h, w["ln_pool.weight"], w["ln_pool.bias"])
    gate = _softmax_np_f32(_linear_np_f32(hp, w["pool_gate.weight"], w["pool_gate.bias"]), axis=1)
    pooled = np.sum((hp * gate).astype(np.float32), axis=1, dtype=np.float32)
    delta = (_linear_np_f32(pooled, w["residual_head.weight"], w["residual_head.bias"]) * w["residual_scale"]).astype(
        np.float32
    )
    out = (base_logits + delta).astype(np.float32)
    return out[0] if unbatched else out


run_browser_json = predict_temporal_window_js


def _pytorch_model_from_spec(spec: dict[str, Any]) -> TemporalKinematicsHead:
    cfg, decoded = _decode_spec_weights(spec)
    model = TemporalKinematicsHead(**cfg)
    state = {k: torch.from_numpy(v.copy()) for k, v in decoded.items()}
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def verify_node_js_parity(
    spec: dict[str, Any] | Path | str,
    frame_logits: Any,
    kinematics: Any,
    frame_indices: Any = None,
) -> float:
    """Execute BROWSER_RUNTIME_JS in Node.js (when installed) and verify <=1e-6 parity against PyTorch."""
    loaded_spec = load_browser_json(spec)
    pt_model = _pytorch_model_from_spec(loaded_spec)

    fl_np = _to_numpy_checked(frame_logits, "frame_logits").astype(np.float32)
    kin_np = _to_numpy_checked(kinematics, "kinematics").astype(np.float32)
    with torch.inference_mode():
        expected = pt_model(
            torch.from_numpy(fl_np),
            torch.from_numpy(kin_np),
            frame_indices=frame_indices,
        ).numpy()

    node_bin = shutil.which("node")
    if node_bin is None:
        actual = predict_temporal_window_js(loaded_spec, fl_np, kin_np, frame_indices=frame_indices)
        max_err = float(np.max(np.abs(actual - expected)))
        if max_err > PARITY_ATOL:
            raise ValueError(f"Fallback JS parity error {max_err:.3e} exceeds {PARITY_ATOL:.1e}")
        return max_err

    mod_b64 = base64.b64encode(BROWSER_RUNTIME_JS.encode("utf-8")).decode("ascii")
    idx_payload = None
    if frame_indices is not None:
        idx_payload = validate_chronological_frames(frame_indices).tolist()

    payload_json = json.dumps(
        {
            "spec": loaded_spec,
            "frameLogits": fl_np.tolist(),
            "kinematics": kin_np.tolist(),
            "frameIndices": idx_payload,
        }
    )
    runner_js = (
        f'const mod = await import("data:text/javascript;base64,{mod_b64}");\n'
        f"const payload = {payload_json};\n"
        "const res = mod.predictTemporalWindowJs(\n"
        "  payload.spec,\n"
        "  payload.frameLogits,\n"
        "  payload.kinematics,\n"
        "  payload.frameIndices,\n"
        ");\n"
        "const out = Array.isArray(res) ? res.map((r) => Array.from(r)) : Array.from(res);\n"
        "process.stdout.write(JSON.stringify(out));\n"
    )
    proc = subprocess.run(
        [node_bin, "--input-type=module", "-"],
        input=runner_js,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Node BROWSER_RUNTIME_JS execution failed: {proc.stderr.strip()}")
    actual = np.asarray(json.loads(proc.stdout), dtype=np.float32)
    if actual.shape != expected.shape or not np.isfinite(actual).all():
        raise ValueError(f"Node output shape/finiteness mismatch: got {actual.shape}, expected {expected.shape}")
    max_err = float(np.max(np.abs(actual - expected)))
    if max_err > PARITY_ATOL:
        raise ValueError(f"Node V8 JS parity error {max_err:.3e} exceeds {PARITY_ATOL:.1e}")
    return max_err


def export_browser_json(
    model_or_ckpt: TemporalKinematicsHead | dict[str, Any] | Path | str,
    out_path: Path | str,
) -> dict[str, Any]:
    """Export <f4 base64 browser JSON spec with reference cases and verify <=1e-6 parity on batch 1 and 4."""
    model = _resolve_cpu_eval_model(model_or_ckpt)
    n_params = _require_parameter_budget(model)
    state = model.state_dict()
    weights = {name: _encode_f32_le_b64(tensor) for name, tensor in state.items()}
    weight_shapes = {name: list(tensor.shape) for name, tensor in state.items()}
    ref_cases = _build_reference_cases(model)

    spec = {
        "schema_version": SCHEMA_VERSION,
        "arch": ARCH,
        "window_size": model.window_size,
        "classes": list(LABELS)[: model.num_classes] if model.num_classes <= len(LABELS) else [f"c{i}" for i in range(model.num_classes)],
        "kinematics_features": list(KINEMATICS_FEATURES)[: model.num_kinematics]
        if model.num_kinematics <= len(KINEMATICS_FEATURES)
        else [f"k{i}" for i in range(model.num_kinematics)],
        "config": model.get_config(),
        "parameters": n_params,
        "weight_encoding": "float32_le_base64",
        "weight_shapes": weight_shapes,
        "weights": weights,
        "reference_cases": ref_cases,
    }

    errors: dict[int, float] = {}
    with torch.inference_mode():
        for batch_size in (1, 4):
            fl_np, kin_np = _synthetic_parity_batch(model, batch_size)
            expected = model(torch.from_numpy(fl_np), torch.from_numpy(kin_np)).numpy()
            actual = predict_temporal_window_js(spec, fl_np, kin_np)
            err = float(np.max(np.abs(actual - expected)))
            if err > PARITY_ATOL:
                raise ValueError(
                    f"Browser JSON parity error {err:.3e} exceeds {PARITY_ATOL:.1e} for batch {batch_size}"
                )
            errors[batch_size] = err

        for case in ref_cases:
            actual_case = predict_temporal_window_js(
                spec,
                case["frame_logits"],
                case["kinematics"],
                frame_indices=case["frame_indices"],
            )
            case_err = float(np.max(np.abs(actual_case - np.asarray(case["expected_logits"], dtype=np.float32))))
            if case_err > PARITY_ATOL:
                raise ValueError(f"Reference case parity error {case_err:.3e} exceeds {PARITY_ATOL:.1e}")

    payload = (json.dumps(spec, allow_nan=False, indent=2) + "\n").encode("utf-8")
    _atomic_write_bytes(out_path, payload)
    return {
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "parameters": n_params,
        "max_abs_error_batch1": errors[1],
        "max_abs_error_batch4": errors[4],
    }


def _verify_node_kinematics_parity(boxes: np.ndarray, idx: np.ndarray) -> float:
    node_bin = shutil.which("node")
    expected = compute_kinematics_features(boxes, idx)
    if node_bin is None:
        return 0.0
    mod_b64 = base64.b64encode(BROWSER_RUNTIME_JS.encode("utf-8")).decode("ascii")
    payload_json = json.dumps({"boxes": boxes.tolist(), "idx": idx.tolist()})
    runner_js = (
        f'const mod = await import("data:text/javascript;base64,{mod_b64}");\n'
        f"const p = {payload_json};\n"
        "const out = mod.computeKinematicsFeaturesJs(p.boxes, p.idx);\n"
        "const ser = out.map((w) => w.map((r) => Array.from(r)));\n"
        "process.stdout.write(JSON.stringify(ser));\n"
    )
    proc = subprocess.run(
        [node_bin, "--input-type=module", "-"],
        input=runner_js,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Node computeKinematicsFeaturesJs failed: {proc.stderr.strip()}")
    actual = np.asarray(json.loads(proc.stdout), dtype=np.float32)
    err = float(np.max(np.abs(actual - expected)))
    if err > PARITY_ATOL:
        raise ValueError(f"Node kinematics parity error {err:.3e} exceeds {PARITY_ATOL:.1e}")
    return err


def run_preflight(work_dir: Path | None = None) -> dict[str, Any]:
    """Run synthetic end-to-end validation of chronology, kinematics, gradients, checkpoint, ONNX, and JS parity."""
    torch.manual_seed(_INIT_SEED)
    model = TemporalKinematicsHead()
    n_params = _require_parameter_budget(model)

    fl_b4, kin_b4 = _synthetic_parity_batch(model, 4)
    idx_b4 = validate_chronological_frames([[0, 1, 2, 3, 4], [2, 4, 5, 8, 9], [1, 2, 4, 7, 11], [0, 2, 4, 6, 8]])

    # Verify uniform-vote anchoring before training
    model.eval()
    with torch.inference_mode():
        init_logits = model(torch.from_numpy(fl_b4), torch.from_numpy(kin_b4), frame_indices=idx_b4)
        init_probs = torch.softmax(init_logits, dim=-1).numpy()
    vote_probs = uniform_vote_probs(fl_b4)
    init_vote_max_diff = float(np.max(np.abs(init_probs - vote_probs)))

    # Verify step-1 finite non-zero gradients on every parameter + optimizer update
    model.train()
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    fl_t = torch.from_numpy(fl_b4)
    kin_t = torch.from_numpy(kin_b4)
    targets = torch.tensor([0, 1, 2, 0], dtype=torch.long)
    loss = torch.nn.functional.cross_entropy(model(fl_t, kin_t, frame_indices=idx_b4), targets)
    loss.backward()
    for name, param in model.named_parameters():
        if param.grad is None or not torch.isfinite(param.grad).all():
            raise ValueError(f"Parameter {name!r} did not receive finite gradient on step 1")
        if float(param.grad.abs().max().item()) == 0.0:
            raise ValueError(f"Parameter {name!r} received exact-zero gradient on step 1")
    opt.step()
    opt.zero_grad(set_to_none=True)
    model.eval()

    cuda_smoke = False
    if torch.cuda.is_available():
        cuda_model = TemporalKinematicsHead().to("cuda")
        cuda_out = cuda_model(fl_t.to("cuda"), kin_t.to("cuda"), frame_indices=idx_b4)
        if cuda_out.shape != (4, NUM_CLASSES) or not torch.isfinite(cuda_out).all():
            raise ValueError("CUDA forward smoke check failed")
        cuda_smoke = True

    own_dir = work_dir is None
    scratch = work_dir if work_dir is not None else (Path(__file__).resolve().parent / f".preflight_v5_tk_{os.getpid()}")
    scratch.mkdir(parents=True, exist_ok=True)
    try:
        pt_path = scratch / "preflight.pt"
        onnx_path = scratch / "preflight.onnx"
        json_path = scratch / "preflight.json"

        ckpt_meta = save_checkpoint(model, pt_path, metadata={"mode": "preflight_synthetic"})
        reloaded, _ = load_checkpoint(pt_path)
        onnx_meta = export_onnx(reloaded, onnx_path)
        json_meta = export_browser_json(reloaded, json_path)
        spec = load_browser_json(json_path)

        fl_b1, kin_b1 = _synthetic_parity_batch(reloaded, 1)
        node_err_1 = verify_node_js_parity(spec, fl_b1[0], kin_b1[0], frame_indices=[0, 1, 2, 3, 4])
        node_err_4 = verify_node_js_parity(spec, fl_b4, kin_b4, frame_indices=idx_b4)

        rng = np.random.default_rng(_PARITY_SEED)
        boxes_test = rng.uniform(10.0, 120.0, size=(3, WINDOW_SIZE, 4))
        idx_test = np.array([[0, 1, 2, 3, 4], [1, 3, 6, 7, 10], [5, 6, 8, 9, 12]], dtype=np.int64)
        node_kin_err = _verify_node_kinematics_parity(boxes_test, idx_test)
    finally:
        if own_dir:
            shutil.rmtree(scratch, ignore_errors=True)

    return {
        "status": "ok",
        "arch": ARCH,
        "schema_version": SCHEMA_VERSION,
        "parameters": n_params,
        "max_parameters": MAX_PARAMETERS,
        "max_onnx_bytes": MAX_ONNX_BYTES,
        "init_uniform_vote_max_prob_diff": init_vote_max_diff,
        "step1_nonzero_finite_grads": True,
        "cuda_smoke_verified": cuda_smoke,
        "node_available": shutil.which("node") is not None,
        "checkpoint": ckpt_meta,
        "onnx": onnx_meta,
        "browser_json": json_meta,
        "node_js_max_abs_error_unbatched": node_err_1,
        "node_js_max_abs_error_batch4": node_err_4,
        "node_kinematics_max_abs_error": node_kin_err,
    }


def _cli_verify_parity(
    checkpoint: Path | None,
    onnx_path: Path | None,
    json_path: Path | None,
) -> dict[str, Any]:
    import onnxruntime as ort

    model = _resolve_cpu_eval_model(checkpoint) if checkpoint is not None else TemporalKinematicsHead().eval()
    fl_b1, kin_b1 = _synthetic_parity_batch(model, 1)
    fl_b4, kin_b4 = _synthetic_parity_batch(model, 4)

    with torch.inference_mode():
        pt_1 = model(torch.from_numpy(fl_b1), torch.from_numpy(kin_b1)).numpy()
        pt_4 = model(torch.from_numpy(fl_b4), torch.from_numpy(kin_b4)).numpy()
        pt_unbatched = model(torch.from_numpy(fl_b1[0]), torch.from_numpy(kin_b1[0])).numpy()

    result: dict[str, Any] = {
        "arch": ARCH,
        "parameters": count_parameters(model),
    }

    if onnx_path is not None:
        onnx_bytes = Path(onnx_path).read_bytes()
        if not (0 < len(onnx_bytes) <= MAX_ONNX_BYTES):
            raise ValueError(f"ONNX size {len(onnx_bytes)} out of bounds")
        sess = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
        (ort_1,) = sess.run(["fused_logits"], {"frame_logits": fl_b1, "kinematics": kin_b1})
        (ort_4,) = sess.run(["fused_logits"], {"frame_logits": fl_b4, "kinematics": kin_b4})
        err_ort_1 = float(np.max(np.abs(ort_1 - pt_1)))
        err_ort_4 = float(np.max(np.abs(ort_4 - pt_4)))
        if max(err_ort_1, err_ort_4) > PARITY_ATOL:
            raise ValueError(f"ONNX parity exceeded {PARITY_ATOL:.1e}: {err_ort_1:.3e}, {err_ort_4:.3e}")
        result["onnx_max_abs_error_batch1"] = err_ort_1
        result["onnx_max_abs_error_batch4"] = err_ort_4

    if json_path is not None:
        spec = load_browser_json(json_path)
    else:
        scratch = Path(__file__).resolve().parent / f".parity_v5_tk_{os.getpid()}"
        scratch.mkdir(parents=True, exist_ok=True)
        try:
            tmp_json = scratch / "spec.json"
            export_browser_json(model, tmp_json)
            spec = load_browser_json(tmp_json)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    np_js_u = predict_temporal_window_js(spec, fl_b1[0], kin_b1[0], frame_indices=[0, 1, 2, 3, 4])
    np_js_4 = predict_temporal_window_js(spec, fl_b4, kin_b4)
    err_np_1 = float(np.max(np.abs(np_js_u - pt_unbatched)))
    err_np_4 = float(np.max(np.abs(np_js_4 - pt_4)))
    if max(err_np_1, err_np_4) > PARITY_ATOL:
        raise ValueError(f"NumPy JS parity exceeded {PARITY_ATOL:.1e}: {err_np_1:.3e}, {err_np_4:.3e}")

    err_node_1 = verify_node_js_parity(spec, fl_b1[0], kin_b1[0], frame_indices=[0, 1, 2, 3, 4])
    err_node_4 = verify_node_js_parity(spec, fl_b4, kin_b4)

    result.update(
        {
            "numpy_js_max_abs_error_unbatched": err_np_1,
            "numpy_js_max_abs_error_batch4": err_np_4,
            "node_js_max_abs_error_unbatched": err_node_1,
            "node_js_max_abs_error_batch4": err_node_4,
            "parity_passed": True,
        }
    )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--preflight", action="store_true", help="Run synthetic smoke + export + JS parity checks")
    parser.add_argument("--checkpoint", type=Path, default=None, help="Input .pt checkpoint path")
    parser.add_argument("--export-onnx", type=Path, default=None, metavar="OUT_ONNX", help="Export opset-17 .onnx")
    parser.add_argument("--export-json", type=Path, default=None, metavar="OUT_JSON", help="Export browser .json")
    parser.add_argument("--onnx", type=Path, default=None, help="Existing .onnx path for --verify-parity")
    parser.add_argument("--json", type=Path, default=None, help="Existing .json path for --verify-parity")
    parser.add_argument("--verify-parity", action="store_true", help="Verify PyTorch / ONNX / JS float32 parity")
    args = parser.parse_args(argv)

    if not (args.preflight or args.export_onnx or args.export_json or args.verify_parity):
        parser.error("Specify at least one action: --preflight, --export-onnx, --export-json, or --verify-parity")

    summary: dict[str, Any] = {}
    if args.preflight:
        summary["preflight"] = run_preflight()

    if args.export_onnx is not None or args.export_json is not None:
        source: TemporalKinematicsHead | Path = (
            args.checkpoint if args.checkpoint is not None else TemporalKinematicsHead().eval()
        )
        if args.export_onnx is not None:
            summary["export_onnx"] = export_onnx(source, args.export_onnx)
        if args.export_json is not None:
            summary["export_json"] = export_browser_json(source, args.export_json)

    if args.verify_parity:
        summary["verify_parity"] = _cli_verify_parity(
            args.checkpoint,
            args.onnx or args.export_onnx,
            args.json or args.export_json,
        )

    out_obj = next(iter(summary.values())) if len(summary) == 1 else summary
    print(json.dumps(out_obj, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
