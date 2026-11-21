"""End-to-end 10-source v5 governance, leakage preflight, temporal training, and unseen evaluation CLI."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
if str(REPO / "benchmarks") not in sys.path:
    sys.path.insert(0, str(REPO / "benchmarks"))

try:
    from scipy.fft import dctn as _scipy_dctn
except ImportError:
    _scipy_dctn = None

TEN_SOURCES = (
    "mendeley",
    "svanstrom",
    "aod4",
    "dcskycam",
    "dut_anti_uav",
    "iberbirds",
    "klim_skagen",
    "openimages",
    "synth_athkot",
    "synth_cranfield",
)
MAX_PHASH_HAMMING = 6
N_BOOTSTRAP = 1000
BOOTSTRAP_SEED = 0

_UNSET = object()
_HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_KLIM_LEGACY_BLOCK_RE = re.compile(r"^(?:klim|skagen)/\d+$", re.IGNORECASE)
_KLIM_SESSION_RE = re.compile(
    r"^(?:klim|skagen)[:/_-]session[:/_-][A-Za-z0-9][A-Za-z0-9._:/-]*$",
    re.IGNORECASE,
)
_FROZEN_TOKEN_RE = re.compile(
    r"(?:^|[\\/])(?:test_media|fbdsv2024_testonly[^\\/]*|svan_test[^\\/]*|svan_shrunk[^\\/]*)(?:$|[\\/])",
    re.IGNORECASE,
)

_DCT_N = 32
_k_idx = np.arange(_DCT_N, dtype=np.float64)[:, None]
_n_idx = np.arange(_DCT_N, dtype=np.float64)[None, :]
_DCT32_BASIS = 2.0 * np.cos(np.pi * _k_idx * (2.0 * _n_idx + 1.0) / (2.0 * _DCT_N))


class PipelineGateError(ValueError):
    """Raised when a corpus, provenance, parameter-budget, or governance gate fails."""


class LeakageError(PipelineGateError):
    """Raised when perceptual-hash near-duplicates or cross-split group overlaps are detected."""


class FrozenTestAccessError(PipelineGateError):
    """Raised when unseen/frozen test evaluation is invoked without explicit SHA-256 pins."""


def _popcount64(arr: np.ndarray) -> np.ndarray:
    x = arr.astype(np.uint64, copy=False)
    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
    x = (x & np.uint64(0x3333333333333333)) + ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
    return ((x * np.uint64(0x0101010101010101)) >> np.uint64(56)).astype(np.uint8)


def _dct2_32x32(pixels_32: np.ndarray) -> np.ndarray:
    if _scipy_dctn is not None:
        return np.asarray(_scipy_dctn(pixels_32, type=2), dtype=np.float64)
    return (_DCT32_BASIS @ pixels_32) @ _DCT32_BASIS.T


def compute_phash_uint64(image_rgb: Image.Image | np.ndarray) -> np.uint64:
    """Compute a 64-bit perceptual hash matching imagehash.phash packed big-endian into np.uint64."""
    if isinstance(image_rgb, Image.Image):
        gray = image_rgb.convert("L")
    elif isinstance(image_rgb, np.ndarray):
        if image_rgb.dtype != np.uint8:
            raise ValueError(f"image_rgb ndarray must have dtype uint8, got {image_rgb.dtype}")
        if image_rgb.ndim == 2:
            if image_rgb.shape[0] < 1 or image_rgb.shape[1] < 1:
                raise ValueError(f"Invalid grayscale image shape: {image_rgb.shape}")
            gray = Image.fromarray(image_rgb, mode="L")
        elif image_rgb.ndim == 3 and image_rgb.shape[2] == 3:
            if image_rgb.shape[0] < 1 or image_rgb.shape[1] < 1:
                raise ValueError(f"Invalid RGB image shape: {image_rgb.shape}")
            gray = Image.fromarray(image_rgb, mode="RGB").convert("L")
        else:
            raise ValueError(
                f"image_rgb ndarray must have shape (H, W, 3) or (H, W), got {image_rgb.shape}"
            )
    else:
        raise ValueError("image_rgb must be a PIL.Image.Image or uint8 RGB/grayscale np.ndarray")

    resized = gray.resize((_DCT_N, _DCT_N), Image.Resampling.LANCZOS)
    pixels = np.asarray(resized, dtype=np.float64)
    dct = _dct2_32x32(pixels)
    dctlowfreq = dct[:8, :8].reshape(-1)
    med = np.median(dctlowfreq[1:])
    bits = (dctlowfreq > med).astype(np.uint8)
    packed = np.packbits(bits)
    return np.uint64(int.from_bytes(packed.tobytes(), byteorder="big"))


def compute_phashes_uint64(images_rgb: Any) -> np.ndarray:
    """Compute a 1D np.uint64 pHash array for a sequence or 4D (N, H, W, 3) array of images."""
    if isinstance(images_rgb, (Image.Image, str, bytes, bytearray)):
        raise ValueError("images_rgb must be a sequence or 4D uint8 RGB array, not a single image/string")
    if isinstance(images_rgb, np.ndarray):
        if images_rgb.ndim == 4 and images_rgb.dtype == np.uint8 and images_rgb.shape[-1] == 3:
            return np.array([compute_phash_uint64(images_rgb[i]) for i in range(len(images_rgb))], dtype=np.uint64)
        if images_rgb.ndim == 1 and images_rgb.dtype == object:
            return np.array([compute_phash_uint64(item) for item in images_rgb], dtype=np.uint64)
        raise ValueError(
            f"images_rgb ndarray must have shape (N, H, W, 3) with dtype uint8, got {images_rgb.shape} ({images_rgb.dtype})"
        )
    if not isinstance(images_rgb, Iterable):
        raise ValueError("images_rgb must be an iterable of images or a 4D uint8 RGB ndarray")
    items = list(images_rgb)
    if not items:
        return np.empty(0, dtype=np.uint64)
    return np.array([compute_phash_uint64(im) for im in items], dtype=np.uint64)


def _coerce_hashes_1d(values: Any, name: str) -> np.ndarray:
    if isinstance(values, np.ndarray):
        if values.ndim == 4 and values.dtype == np.uint8 and values.shape[-1] == 3:
            return compute_phashes_uint64(values)
        if values.ndim != 1 or values.dtype != np.uint64:
            raise PipelineGateError(f"{name} must be a 1D np.uint64 array, got shape {values.shape} dtype {values.dtype}")
        return values
    if isinstance(values, (list, tuple)):
        if values and all(isinstance(v, (Image.Image, np.ndarray)) for v in values):
            if all(isinstance(v, Image.Image) or (isinstance(v, np.ndarray) and v.ndim in (2, 3)) for v in values):
                return compute_phashes_uint64(values)
        if all(
            not isinstance(v, bool)
            and isinstance(v, (int, np.uint64, np.unsignedinteger))
            and 0 <= int(v) <= 0xFFFFFFFFFFFFFFFF
            for v in values
        ):
            return np.array([np.uint64(int(v)) for v in values], dtype=np.uint64)
    raise PipelineGateError(f"{name} must be a 1D np.uint64 array")


def audit_phash_leakage(
    candidate_hashes: Any,
    reference_hashes: Any,
    *,
    max_hamming: int = MAX_PHASH_HAMMING,
    strict: bool = True,
) -> dict[str, Any]:
    """Check candidate pHashes against reference pHashes for Hamming distance <= max_hamming."""
    if isinstance(max_hamming, bool) or not isinstance(max_hamming, (int, np.integer)) or not (0 <= int(max_hamming) <= 64):
        raise PipelineGateError(f"max_hamming must be an integer in [0, 64], got {max_hamming!r}")

    cand = _coerce_hashes_1d(candidate_hashes, "candidate_hashes")
    ref = _coerce_hashes_1d(reference_hashes, "reference_hashes")
    if len(ref) == 0:
        raise PipelineGateError("reference_hashes must be non-empty")

    max_h = int(max_hamming)
    n_cand = len(cand)
    if n_cand == 0:
        min_dists = np.empty(0, dtype=np.uint8)
    else:
        min_dists = np.empty(n_cand, dtype=np.uint8)
        # Bound intermediate (chunk, len(ref)) uint64 array to ~16 MB.
        chunk = max(1, min(4096, (2 * 1024 * 1024) // max(1, len(ref))))
        use_builtin = hasattr(np, "bitwise_count")
        for start in range(0, n_cand, chunk):
            end = min(start + chunk, n_cand)
            xor = ref[None, :] ^ cand[start:end, None]
            dists = np.bitwise_count(xor) if use_builtin else _popcount64(xor)
            min_dists[start:end] = dists.min(axis=1)

    leak_indices = [int(i) for i in np.flatnonzero(min_dists <= max_h)]
    report = {
        "items_checked": int(n_cand),
        "reference_items": int(len(ref)),
        "max_hamming": max_h,
        "leak_count": int(len(leak_indices)),
        "leak_indices": leak_indices,
        "min_distance": int(min_dists.min()) if n_cand else None,
    }
    if strict and leak_indices:
        raise LeakageError(
            f"pHash leakage gate failed: {len(leak_indices)} candidate item(s) within Hamming <= {max_h} "
            f"(min_distance={report['min_distance']}, indices={leak_indices[:10]})"
        )
    return report


def _validate_klim_group_id(group_id: Any) -> str:
    if not isinstance(group_id, str) or not group_id.strip() or group_id != group_id.strip() or not group_id.isprintable():
        raise PipelineGateError(f"Klim/Skagen group ID must be a non-blank trimmed printable string, got {group_id!r}")
    if _KLIM_LEGACY_BLOCK_RE.fullmatch(group_id):
        raise PipelineGateError(
            f"Legacy Klim/Skagen site/frame//50 blocks are not recording-session IDs ({group_id!r}); "
            "require explicit session-scoped IDs such as 'klim:session:<id>' or 'skagen:session:<id>'"
        )
    if not _KLIM_SESSION_RE.fullmatch(group_id):
        raise PipelineGateError(
            f"Klim/Skagen group ID must be an explicit session-scoped ID (e.g. 'klim:session:<id>' or "
            f"'skagen:session:<id>'), got {group_id!r}"
        )
    return group_id


def _validate_klim_iterable(groups: Any, label: str) -> set[str]:
    if isinstance(groups, (str, bytes, bytearray)) or not isinstance(groups, Iterable):
        raise PipelineGateError(f"{label} must be a non-string iterable of session group IDs")
    items = list(groups)
    if not items:
        raise PipelineGateError(f"{label} must contain at least one session group ID")
    return {_validate_klim_group_id(g) for g in items}


def audit_small_bird_sources(
    klim_groups: Any = None,
    *,
    klim_split_groups: dict[str, Any] | None = None,
    airbirds_metadata: Path | str | dict[str, Any] | None = None,
    airbirds_role: str = "none",
) -> dict[str, Any]:
    """Validate Klim/Skagen recording-session grouping and AirBirds CC BY-NC-SA test/research-only intake."""
    if isinstance(klim_groups, dict):
        if klim_split_groups is not None:
            raise PipelineGateError("Pass Klim/Skagen split mapping via klim_split_groups or klim_groups, not both")
        klim_split_groups = klim_groups
        klim_groups = None

    klim_checked = False
    unique_sessions: set[str] = set()
    split_counts: dict[str, int] = {}
    disjoint_splits: bool | None = None

    if klim_groups is not None:
        klim_checked = True
        unique_sessions |= _validate_klim_iterable(klim_groups, "klim_groups")

    if klim_split_groups is not None:
        if not isinstance(klim_split_groups, dict) or not klim_split_groups:
            raise PipelineGateError("klim_split_groups must be a non-empty dict mapping split names to session IDs")
        klim_checked = True
        split_sets: dict[str, set[str]] = {}
        for split_name, raw_ids in klim_split_groups.items():
            if not isinstance(split_name, str) or not split_name.strip() or split_name != split_name.strip():
                raise PipelineGateError(f"Invalid split name in klim_split_groups: {split_name!r}")
            validated = _validate_klim_iterable(raw_ids, f"klim_split_groups[{split_name!r}]")
            split_sets[split_name] = validated
            split_counts[split_name] = len(validated)
            unique_sessions |= validated

        split_names = list(split_sets.keys())
        for i in range(len(split_names)):
            for j in range(i + 1, len(split_names)):
                overlap = sorted(split_sets[split_names[i]] & split_sets[split_names[j]])
                if overlap:
                    raise LeakageError(
                        f"Cross-split Klim/Skagen recording-session overlap between "
                        f"{split_names[i]!r} and {split_names[j]!r}: {overlap[:5]}"
                    )
        disjoint_splits = True

    if not isinstance(airbirds_role, str) or airbirds_role not in ("none", "test_only", "research_only"):
        raise PipelineGateError(
            "AirBirds (CC BY-NC-SA) is strictly research/test-only and cannot be admitted to train or select"
        )

    intake_summary = None
    if airbirds_metadata is not None:
        if airbirds_role == "none":
            raise PipelineGateError(
                "Specify airbirds_role='test_only' or 'research_only' when supplying AirBirds metadata"
            )
        from small_bird_preflight import check_intake

        if isinstance(airbirds_metadata, (Path, str)):
            meta_path = Path(airbirds_metadata)
            try:
                meta_obj = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PipelineGateError(
                    f"Failed to read AirBirds intake metadata ({sanitize_paths(str(meta_path))}): {exc}"
                ) from exc
        elif isinstance(airbirds_metadata, dict):
            meta_obj = airbirds_metadata
        else:
            raise PipelineGateError("airbirds_metadata must be a dict or JSON file path")

        try:
            intake_summary = check_intake(meta_obj)
        except ValueError as exc:
            raise PipelineGateError(f"AirBirds native-frame intake preflight failed: {exc}") from exc

    return {
        "klim_skagen": {
            "checked": klim_checked,
            "session_groups": len(unique_sessions),
            "splits": split_counts,
            "disjoint_splits": disjoint_splits,
        },
        "airbirds": {
            "role": airbirds_role,
            "checked": intake_summary is not None,
            "train_select_allowed": False,
            "intake": intake_summary,
        },
    }


def _reject_frozen_test_path(path: Path | str, context: str) -> Path:
    p = Path(path)
    if _FROZEN_TOKEN_RE.search(str(p)):
        raise FrozenTestAccessError(
            f"{context} must never reference frozen test artifacts ({sanitize_paths(str(p))})"
        )
    return p


def verify_ten_source_preflight(
    data_root: Path | str,
    *,
    inventory_only: bool = False,
    klim_session_groups: Any = None,
    airbirds_metadata: Path | str | dict[str, Any] | None = None,
    airbirds_role: str = "none",
) -> dict[str, Any]:
    """Run read-only 10-source train/SELECT manifest, checksum, and small-bird provenance preflight."""
    root = _reject_frozen_test_path(data_root, "data_root")
    small_bird = audit_small_bird_sources(
        klim_session_groups,
        airbirds_metadata=airbirds_metadata,
        airbirds_role=airbirds_role,
    )

    from sources import verify_corpus as _vc
    from sources.verify_corpus import CorpusError, verify_corpus

    inspect_fn = getattr(_vc, "inspect_corpus", None)
    try:
        if inspect_fn is not None:
            corpus = inspect_fn(Path(root), inventory_only=inventory_only)
        elif inventory_only:
            corpus = _vc._inspect(Path(root), inventory_only=True)
        else:
            corpus = verify_corpus(Path(root))
    except CorpusError as exc:
        raise PipelineGateError(f"10-source corpus verification blocked: {sanitize_paths(str(exc))}") from exc

    splits = corpus.get("splits")
    if not isinstance(splits, dict) or set(splits.keys()) != set(TEN_SOURCES):
        missing = sorted(set(TEN_SOURCES) - set(splits or ()))
        extra = sorted(set(splits or ()) - set(TEN_SOURCES))
        raise PipelineGateError(
            f"Corpus splits do not match exact 10 sources; missing={missing}, unexpected={extra}"
        )

    for rel_key in corpus.get("files", {}):
        _reject_frozen_test_path(rel_key, "verified corpus file")

    return sanitize_paths(
        {
            **corpus,
            "ten_sources": list(TEN_SOURCES),
            "small_bird_audit": small_bird,
        }
    )


def paired_group_bootstrap_ci(
    candidate_hits: Any,
    baseline_hits: Any,
    eligible_mask: Any,
    group_ids: Any = _UNSET,
    *,
    n_boot: int = N_BOOTSTRAP,
    n_bootstrap: int | None = None,
    seed: int = BOOTSTRAP_SEED,
) -> dict[str, Any] | None:
    """Compute 1,000-resample whole-group paired 95% bootstrap CIs and protocol CI-overlap significance."""
    if n_bootstrap is not None:
        n_boot = n_bootstrap
    if isinstance(n_boot, bool) or not isinstance(n_boot, (int, np.integer)) or int(n_boot) < 1:
        raise ValueError(f"n_boot must be a positive integer, got {n_boot!r}")
    if isinstance(seed, bool) or not isinstance(seed, (int, np.integer)):
        raise ValueError(f"seed must be an integer, got {seed!r}")

    if group_ids is _UNSET:
        # 3-argument convenience call: (baseline_hits, candidate_hits, group_ids)
        base_raw = np.asarray(candidate_hits)
        cand_raw = np.asarray(baseline_hits)
        grp_raw = np.asarray(eligible_mask)
        if base_raw.ndim != 1 or cand_raw.ndim != 1 or grp_raw.ndim != 1:
            raise ValueError("baseline_hits, candidate_hits, and group_ids must be 1D arrays")
        if not (len(base_raw) == len(cand_raw) == len(grp_raw)):
            raise ValueError("baseline_hits, candidate_hits, and group_ids must have identical length")
        mask = np.ones(len(grp_raw), dtype=bool)
    else:
        cand_raw = np.asarray(candidate_hits)
        base_raw = np.asarray(baseline_hits)
        mask_raw = np.asarray(eligible_mask)
        grp_raw = np.asarray(group_ids)
        if cand_raw.ndim != 1 or base_raw.ndim != 1 or mask_raw.ndim != 1 or grp_raw.ndim != 1:
            raise ValueError("candidate_hits, baseline_hits, eligible_mask, and group_ids must be 1D arrays")
        if not (len(cand_raw) == len(base_raw) == len(mask_raw) == len(grp_raw)):
            raise ValueError("candidate_hits, baseline_hits, eligible_mask, and group_ids must have identical length")
        if mask_raw.dtype.kind not in ("b", "i", "u"):
            raise ValueError(f"eligible_mask must have boolean or integer dtype, got {mask_raw.dtype}")
        mask = np.asarray(mask_raw, dtype=bool)

    if not mask.any():
        return None

    cand_f = np.asarray(cand_raw[mask], dtype=np.float64)
    base_f = np.asarray(base_raw[mask], dtype=np.float64)
    if not (np.isfinite(cand_f).all() and np.isfinite(base_f).all()):
        raise ValueError("candidate_hits and baseline_hits must be finite on eligible items")

    grp_masked = grp_raw[mask]
    if grp_masked.dtype.kind in ("U", "S", "O"):
        for g in grp_masked:
            if g is None or (isinstance(g, str) and not g.strip()):
                raise ValueError("group_ids on eligible items must be non-blank")

    _, g_idx = np.unique(grp_masked, return_inverse=True)
    n_groups = int(g_idx.max()) + 1
    den = np.bincount(g_idx).astype(np.float64)
    cand_num = np.bincount(g_idx, weights=cand_f)
    base_num = np.bincount(g_idx, weights=base_f)

    total_den = float(den.sum())
    cand_val = float(cand_num.sum() / total_den)
    base_val = float(base_num.sum() / total_den)
    delta_val = float(cand_val - base_val)

    rng = np.random.default_rng(int(seed))
    picks = rng.integers(0, n_groups, size=(int(n_boot), n_groups))
    den_b = den[picks].sum(axis=1)
    cand_sum_b = cand_num[picks].sum(axis=1)
    base_sum_b = base_num[picks].sum(axis=1)
    valid = den_b > 0
    den_b = den_b[valid]
    cand_b = cand_sum_b[valid] / den_b
    base_b = base_sum_b[valid] / den_b
    delta_b = cand_b - base_b

    cand_lo, cand_hi = np.percentile(cand_b, [2.5, 97.5])
    base_lo, base_hi = np.percentile(base_b, [2.5, 97.5])
    delta_lo, delta_hi = np.percentile(delta_b, [2.5, 97.5])

    from bench.stats import significant

    raw_sig = significant(
        {"value": cand_val, "lo": float(cand_lo), "hi": float(cand_hi)},
        {"value": base_val, "lo": float(base_lo), "hi": float(base_hi)},
    )
    if n_groups < 2 or raw_sig == "not significant" or (cand_lo <= base_hi and base_lo <= cand_hi):
        ci_overlap = "not significant"
    else:
        ci_overlap = "significant"

    paired_delta = {
        "value": delta_val,
        "lo": float(delta_lo),
        "hi": float(delta_hi),
        "ci95": [float(delta_lo), float(delta_hi)],
    }
    return {
        "n": int(round(total_den)),
        "groups": int(n_groups),
        "usable_draws": int(len(cand_b)),
        "baseline": {
            "value": base_val,
            "lo": float(base_lo),
            "hi": float(base_hi),
            "ci95": [float(base_lo), float(base_hi)],
            "numerator": int(round(base_num.sum())),
        },
        "candidate": {
            "value": cand_val,
            "lo": float(cand_lo),
            "hi": float(cand_hi),
            "ci95": [float(cand_lo), float(cand_hi)],
            "numerator": int(round(cand_num.sum())),
        },
        "paired_delta": paired_delta,
        "delta": paired_delta,
        "ci_overlap": ci_overlap,
        "significance": ci_overlap,
    }


def enforce_unseen_fbd_gate(
    eval_unseen: bool | Path | str | None,
    fbd_pins: Path | str | None | object = _UNSET,
) -> dict[str, str] | None:
    """Gate unseen FBD-SV-2024 access behind an explicit SHA-256 pins JSON before touching any data file."""
    if fbd_pins is _UNSET:
        if isinstance(eval_unseen, bool):
            if not eval_unseen:
                return None
            pins_arg: Path | str | None = None
        else:
            pins_arg = eval_unseen
    else:
        if not bool(eval_unseen):
            return None
        pins_arg = fbd_pins  # type: ignore[assignment]

    if pins_arg is None or (isinstance(pins_arg, str) and not pins_arg.strip()):
        raise FrozenTestAccessError(
            "Unseen FBD-SV-2024 evaluation requires explicit --fbd-pins SHA-256 pins JSON"
        )

    pins_path = Path(pins_arg)
    if not pins_path.is_file():
        raise FrozenTestAccessError(
            f"--fbd-pins SHA-256 pins JSON does not exist: {sanitize_paths(str(pins_path))}"
        )

    try:
        raw = json.loads(pins_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FrozenTestAccessError(
            f"--fbd-pins must be valid UTF-8 JSON ({sanitize_paths(str(pins_path))}): {exc}"
        ) from exc

    if not isinstance(raw, dict):
        raise FrozenTestAccessError("--fbd-pins must be a JSON object with 'crops_sha256' and 'metadata_sha256'")

    normalized: dict[str, str] = {}
    for required_key in ("crops_sha256", "metadata_sha256"):
        digest = raw.get(required_key)
        if not isinstance(digest, str) or not _HEX64_RE.fullmatch(digest):
            raise FrozenTestAccessError(
                f"--fbd-pins missing valid 64-hex SHA-256 for {required_key!r}"
            )
        normalized[required_key] = digest.lower()
    return normalized


_REPO_WIN = str(REPO)
_REPO_POSIX = REPO.as_posix()
_REPO_PATTERN = re.compile(
    rf"(?:{re.escape(_REPO_WIN)}|{re.escape(_REPO_POSIX)})(?:[\\/]([^\"'\r\n<>|;|]*))?",
    re.IGNORECASE,
)
_STAGING_WHOLE_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|/mnt/[A-Za-z]/)skysentry[^\r\n]*$", re.IGNORECASE)
_STAGING_INLINE_RE = re.compile(
    r"(?:[A-Za-z]:[\\/]|/mnt/[A-Za-z]/)skysentry[^\s\"';,<>|]*(?:[\\/][^\s\"';,<>|]*)*",
    re.IGNORECASE,
)
_WIN_USERS_WHOLE_RE = re.compile(r"^[A-Za-z]:[\\/]Users[\\/][^\r\n]+$", re.IGNORECASE)
_POSIX_USERS_WHOLE_RE = re.compile(r"^/(?:Users|home)/[^\r\n]+$")
_WIN_USERS_INLINE_RE = re.compile(r"[A-Za-z]:[\\/]Users[\\/][^\s\"';,<>|]+", re.IGNORECASE)
_POSIX_USERS_INLINE_RE = re.compile(r"(?<![A-Za-z0-9_])/(?:Users|home)/[^\s\"';,<>|]+")
_ACTIVE_USERS = tuple(
    sorted(
        {
            u.strip()
            for u in (os.environ.get("USERNAME"), os.environ.get("USER"), Path.home().name)
            if isinstance(u, str) and len(u.strip()) >= 3
        }
    )
)
_USERNAME_RE = (
    re.compile("|".join(re.escape(u) for u in _ACTIVE_USERS), re.IGNORECASE)
    if _ACTIVE_USERS
    else None
)


def _sanitize_str(text: str) -> str:
    def _repo_repl(match: re.Match[str]) -> str:
        rel = match.group(1)
        if not rel:
            return "."
        cleaned = rel.replace("\\", "/").rstrip("/")
        return cleaned if cleaned else "."

    out = _REPO_PATTERN.sub(_repo_repl, text)
    if _STAGING_WHOLE_RE.fullmatch(out):
        return "<external-staging>"
    if _WIN_USERS_WHOLE_RE.fullmatch(out) or _POSIX_USERS_WHOLE_RE.fullmatch(out):
        return "<redacted-path>"

    out = _STAGING_INLINE_RE.sub("<external-staging>", out)
    out = _WIN_USERS_INLINE_RE.sub("<redacted-path>", out)
    out = _POSIX_USERS_INLINE_RE.sub("<redacted-path>", out)
    if _USERNAME_RE is not None:
        out = _USERNAME_RE.sub("<redacted-user>", out)
    return out


def sanitize_paths(value: Any) -> Any:
    """Recursively scrub host/user/staging filesystem paths from strings, dicts, lists, and tuples."""
    if isinstance(value, str):
        return _sanitize_str(value)
    if isinstance(value, Path):
        return _sanitize_str(str(value))
    if isinstance(value, dict):
        return {
            (_sanitize_str(k) if isinstance(k, str) else sanitize_paths(k)): sanitize_paths(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [sanitize_paths(v) for v in value]
    if isinstance(value, tuple):
        return tuple(sanitize_paths(v) for v in value)
    return value


def _window_select_metrics(pred: np.ndarray, y: np.ndarray, labels: tuple[str, ...]) -> dict[str, float | None]:
    recalls = {
        f"recall_{name}": float((pred[y == cls_idx] == cls_idx).mean()) if (y == cls_idx).any() else None
        for cls_idx, name in enumerate(labels)
    }
    present = [val for val in recalls.values() if val is not None]
    return {
        "balanced_accuracy": float(np.mean(present)) if present else 0.0,
        **recalls,
    }


def _validate_window_split(
    logits: Any,
    kinematics: Any,
    y: Any,
    frame_indices: Any,
    split_name: str,
    window_size: int,
    num_classes: int,
    num_kinematics: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    from v5_temporal_kinematics import validate_chronological_frames

    fl = np.asarray(logits, dtype=np.float32)
    kin = np.asarray(kinematics, dtype=np.float32)
    y_arr = np.asarray(y)

    if fl.ndim != 3 or fl.shape[1:] != (window_size, num_classes) or len(fl) < 1:
        raise PipelineGateError(
            f"{split_name}_logits must have shape (N, {window_size}, {num_classes}) with N >= 1, got {fl.shape}"
        )
    if kin.ndim != 3 or kin.shape != (len(fl), window_size, num_kinematics):
        raise PipelineGateError(
            f"{split_name}_kinematics must have shape ({len(fl)}, {window_size}, {num_kinematics}), got {kin.shape}"
        )
    if not (np.isfinite(fl).all() and np.isfinite(kin).all()):
        raise PipelineGateError(f"{split_name} logits and kinematics must be finite")
    if y_arr.ndim != 1 or len(y_arr) != len(fl) or y_arr.dtype.kind not in ("i", "u"):
        raise PipelineGateError(f"{split_name}_y must be a 1D integer array of length {len(fl)}")
    y_i64 = y_arr.astype(np.int64, copy=False)
    if (y_i64 < 0).any() or (y_i64 >= num_classes).any():
        raise PipelineGateError(f"{split_name}_y class labels must be in [0, {num_classes - 1}]")

    if frame_indices is not None:
        idx = validate_chronological_frames(frame_indices)
        if idx.ndim == 1:
            if len(fl) != 1:
                raise PipelineGateError(
                    f"{split_name}_frame_indices must have shape ({len(fl)}, {window_size}), got {idx.shape}"
                )
        elif idx.shape[0] != len(fl):
            raise PipelineGateError(
                f"{split_name}_frame_indices batch size {idx.shape[0]} != {len(fl)}"
            )
    return np.ascontiguousarray(fl), np.ascontiguousarray(kin), np.ascontiguousarray(y_i64)


def train_temporal_head(
    train_logits: Any,
    train_kinematics: Any,
    train_y: Any,
    select_logits: Any = None,
    select_kinematics: Any = None,
    select_y: Any = None,
    *,
    train_frame_indices: Any = None,
    sample_weights: Any = None,
    select_frame_indices: Any = None,
    device: str | None = None,
    seed: int = 44,
    epochs: int = 24,
    batch_size: int = 128,
    lr: float = 3e-3,
    weight_decay: float = 1e-3,
    label_smoothing: float = 0.03,
):
    """Deterministically train TemporalKinematicsHead with inverse-class weights, AdamW, and OneCycleLR."""
    import torch
    import torch.nn.functional as F
    from v5_temporal_kinematics import (
        LABELS,
        MAX_PARAMETERS,
        NUM_CLASSES,
        NUM_KINEMATICS,
        WINDOW_SIZE,
        TemporalKinematicsHead,
        count_parameters,
    )

    if isinstance(epochs, bool) or not isinstance(epochs, int) or epochs < 1:
        raise PipelineGateError(f"epochs must be a positive integer, got {epochs!r}")
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size < 1:
        raise PipelineGateError(f"batch_size must be a positive integer, got {batch_size!r}")
    if not (math.isfinite(lr) and lr > 0.0):
        raise PipelineGateError(f"lr must be positive and finite, got {lr!r}")
    if not (math.isfinite(weight_decay) and weight_decay >= 0.0):
        raise PipelineGateError(f"weight_decay must be non-negative and finite, got {weight_decay!r}")
    if not (math.isfinite(label_smoothing) and 0.0 <= label_smoothing < 1.0):
        raise PipelineGateError(f"label_smoothing must be in [0, 1), got {label_smoothing!r}")

    if device is None:
        resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        if device not in ("cuda", "cpu"):
            raise PipelineGateError(f"device must be 'cuda' or 'cpu', got {device!r}")
        if device == "cuda" and not torch.cuda.is_available():
            raise PipelineGateError("device='cuda' requested, but torch.cuda.is_available() is False")
        resolved_device = device

    tr_fl, tr_kin, tr_y = _validate_window_split(
        train_logits,
        train_kinematics,
        train_y,
        train_frame_indices,
        "train",
        WINDOW_SIZE,
        NUM_CLASSES,
        NUM_KINEMATICS,
    )

    has_any_select = any(x is not None for x in (select_logits, select_kinematics, select_y))
    if has_any_select and any(x is None for x in (select_logits, select_kinematics, select_y)):
        raise PipelineGateError("select_logits, select_kinematics, and select_y must all be provided together")
    if has_any_select:
        sel_fl, sel_kin, sel_y = _validate_window_split(
            select_logits,
            select_kinematics,
            select_y,
            select_frame_indices,
            "select",
            WINDOW_SIZE,
            NUM_CLASSES,
            NUM_KINEMATICS,
        )
    else:
        sel_fl = sel_kin = sel_y = None

    if sample_weights is not None:
        sw_np = np.asarray(sample_weights, dtype=np.float32)
        if sw_np.ndim != 1 or len(sw_np) != len(tr_y) or not np.isfinite(sw_np).all() or (sw_np < 0.0).any():
            raise PipelineGateError(f"sample_weights must be a finite non-negative 1D array of length {len(tr_y)}")
        if float(sw_np.sum()) <= 0.0:
            raise PipelineGateError("sample_weights must have positive total weight")
    else:
        sw_np = None

    counts = np.bincount(tr_y, minlength=NUM_CLASSES).astype(np.float64)
    present = counts > 0
    inv_freq = np.ones(NUM_CLASSES, dtype=np.float32)
    inv_freq[present] = (counts[present].sum() / ( float(present.sum()) * counts[present] )).astype(np.float32)

    prev_det = torch.are_deterministic_algorithms_enabled()
    prev_cudnn_bench = torch.backends.cudnn.benchmark
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    try:
        random.seed(int(seed))
        np.random.seed(int(seed))
        torch.manual_seed(int(seed))
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(int(seed))

        model = TemporalKinematicsHead().to(resolved_device)
        n_params = count_parameters(model)
        if not (0 < n_params < MAX_PARAMETERS):
            raise PipelineGateError(f"TemporalKinematicsHead parameter budget violated: {n_params} >= {MAX_PARAMETERS}")

        n_train = len(tr_y)
        steps_per_epoch = max(1, math.ceil(n_train / batch_size))
        total_steps = epochs * steps_per_epoch
        optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
        scheduler = torch.optim.lr_scheduler.OneCycleLR(
            optimizer,
            max_lr=lr,
            total_steps=total_steps,
            pct_start=0.1,
        )

        tr_fl_t = torch.from_numpy(tr_fl).to(resolved_device)
        tr_kin_t = torch.from_numpy(tr_kin).to(resolved_device)
        tr_y_t = torch.from_numpy(tr_y).to(resolved_device)
        class_w_t = torch.from_numpy(inv_freq).to(resolved_device)
        sw_t = torch.from_numpy(sw_np).to(resolved_device) if sw_np is not None else None

        if has_any_select:
            sel_fl_t = torch.from_numpy(sel_fl).to(resolved_device)
            sel_kin_t = torch.from_numpy(sel_kin).to(resolved_device)
        else:
            sel_fl_t = sel_kin_t = None

        history: list[dict[str, Any]] = []
        best_score = -1.0
        best_state: dict[str, torch.Tensor] | None = None

        for epoch_idx in range(epochs):
            rng = np.random.default_rng(int(seed) + epoch_idx)
            perm = torch.from_numpy(rng.permutation(n_train)).to(resolved_device, dtype=torch.long)
            model.train()
            epoch_loss_sum = 0.0
            seen = 0

            for step in range(steps_per_epoch):
                batch_idx = perm[step * batch_size : (step + 1) * batch_size]
                xb_fl = tr_fl_t.index_select(0, batch_idx)
                xb_kin = tr_kin_t.index_select(0, batch_idx)
                yb = tr_y_t.index_select(0, batch_idx)

                fused = model(xb_fl, xb_kin)
                if sw_t is None:
                    loss = F.cross_entropy(
                        fused,
                        yb,
                        weight=class_w_t,
                        label_smoothing=label_smoothing,
                    )
                else:
                    per_sample = F.cross_entropy(
                        fused,
                        yb,
                        weight=class_w_t,
                        reduction="none",
                        label_smoothing=label_smoothing,
                    )
                    wb = sw_t.index_select(0, batch_idx)
                    loss = (per_sample * wb).sum() / wb.sum().clamp_min(1e-8)

                if not torch.isfinite(loss):
                    raise PipelineGateError(f"Non-finite temporal training loss at epoch {epoch_idx + 1}")

                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                optimizer.step()
                scheduler.step()

                bsz = int(yb.numel())
                epoch_loss_sum += float(loss.detach().item()) * bsz
                seen += bsz

            mean_loss = epoch_loss_sum / max(1, seen)
            row: dict[str, Any] = {
                "epoch": epoch_idx + 1,
                "train_loss": mean_loss,
                "lr": float(optimizer.param_groups[0]["lr"]),
            }

            if has_any_select and sel_fl_t is not None and sel_kin_t is not None and sel_y is not None:
                model.eval()
                preds = []
                with torch.inference_mode():
                    for start in range(0, len(sel_y), batch_size):
                        out = model(sel_fl_t[start : start + batch_size], sel_kin_t[start : start + batch_size])
                        if not torch.isfinite(out).all():
                            raise PipelineGateError("Non-finite SELECT logits during temporal head training")
                        preds.append(out.argmax(dim=-1).cpu().numpy())
                pred_np = np.concatenate(preds, axis=0)
                sel_metrics = _window_select_metrics(pred_np, sel_y, LABELS)
                score = float(sel_metrics["balanced_accuracy"] or 0.0)
                row["select_balanced_accuracy"] = score
                row["select"] = sel_metrics
                if score > best_score:
                    best_score = score
                    best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            else:
                row["select_balanced_accuracy"] = None
                row["select"] = None

            history.append(row)

        if best_state is not None:
            model.load_state_dict({k: v.to(resolved_device) for k, v in best_state.items()}, strict=True)
        model.eval()
        return model, history
    finally:
        torch.use_deterministic_algorithms(prev_det)
        torch.backends.cudnn.benchmark = prev_cudnn_bench


def _load_npz_windows(path: Path, split_name: str) -> dict[str, np.ndarray]:
    _reject_frozen_test_path(path, f"{split_name} window archive")
    if not path.is_file():
        raise PipelineGateError(f"Missing {split_name} window archive: {sanitize_paths(str(path))}")
    from v5_temporal_kinematics import compute_kinematics_features

    with np.load(path, allow_pickle=False) as z:
        keys = set(z.files)
        logits_key = "frame_logits" if "frame_logits" in keys else "logits"
        if logits_key not in keys or "y" not in keys:
            raise PipelineGateError(f"{split_name} archive must contain '{logits_key}' and 'y'")
        logits = z[logits_key]
        y = z["y"]
        frame_indices = z["frame_indices"] if "frame_indices" in keys else None
        if "kinematics" in keys:
            kinematics = z["kinematics"]
        elif "boxes_xywh" in keys and frame_indices is not None:
            frame_wh = z["frame_wh"] if "frame_wh" in keys else (640.0, 512.0)
            kinematics = compute_kinematics_features(z["boxes_xywh"], frame_indices, frame_wh=frame_wh)
        else:
            raise PipelineGateError(
                f"{split_name} archive must contain 'kinematics' or both 'boxes_xywh' and 'frame_indices'"
            )
        out: dict[str, np.ndarray] = {"logits": logits, "kinematics": kinematics, "y": y}
        if frame_indices is not None:
            out["frame_indices"] = frame_indices
        if "sample_weights" in keys:
            out["sample_weights"] = z["sample_weights"]
        if "group" in keys:
            out["groups"] = z["group"]
        elif "groups" in keys:
            out["groups"] = z["groups"]
        return out


def _build_unseen_predictor_loader(temporal_checkpoint: Path | None, window: int):
    from bench.common import sha256_file
    from eval_inference import ARCHITECTURES, load_predictor

    if temporal_checkpoint is None:
        def _uniform_loader(checkpoint: Path, *, arch: str):
            if arch not in ARCHITECTURES:
                raise PipelineGateError(f"--arch must be one of {', '.join(ARCHITECTURES)}")
            return load_predictor(checkpoint, arch=arch)

        return _uniform_loader

    import torch
    from eval_voting import ARCHIVES, ids, vector, windows
    from v5_temporal_kinematics import (
        WINDOW_SIZE,
        compute_kinematics_features,
        load_checkpoint,
    )

    temporal_model, _ = load_checkpoint(temporal_checkpoint)
    temporal_sha = sha256_file(temporal_checkpoint)

    class _TemporalOrUniformPredictor:
        def __init__(self, base_pred):
            self._base = base_pred
            combined = f"{base_pred.checkpoint_sha256}:{temporal_sha}".encode("ascii")
            self.checkpoint_sha256 = hashlib.sha256(combined).hexdigest()

        def _crop_logits(self, crops: np.ndarray, batch_size: int) -> np.ndarray:
            out = np.empty((len(crops), 3), dtype=np.float32)
            with torch.inference_mode():
                for start in range(0, len(crops), batch_size):
                    chunk = np.require(crops[start : start + batch_size, 0], requirements=["C", "W"])
                    logits = self._base._model(self._base._preprocess(chunk))
                    if logits.shape != (len(chunk), 3) or not torch.isfinite(logits).all():
                        raise ValueError("Backbone did not produce finite (N, 3) logits")
                    out[start : start + len(chunk)] = logits.cpu().numpy()
            return out

        def predict_proba(self, crops: np.ndarray, *, batch_size: int = 512) -> np.ndarray:
            base_probs = self._base.predict_proba(crops, batch_size=batch_size)
            filename = getattr(crops, "filename", None)
            if window != WINDOW_SIZE or filename is None:
                return base_probs
            x_path = Path(filename)
            if not x_path.name.endswith("_X.npy"):
                return base_probs
            meta_path = x_path.with_name(x_path.name[:-6] + "_meta.npz")
            if not meta_path.is_file():
                return base_probs

            with np.load(meta_path, allow_pickle=False) as meta:
                if "track_id" not in meta or "frame_index" not in meta:
                    return base_probs
                n_rows = len(crops)
                y = vector(meta["y"], "y", "iu", n_rows)
                tracks = ids(meta["track_id"], "track_id", n_rows)
                frames = ids(meta["frame_index"], "frame_index", n_rows, kinds="iu")
                stem = x_path.name[:-6]
                if stem == ARCHIVES[0][1]:
                    groups = ids(meta["group"], "group", n_rows)
                    cohort_masks = [np.ones(n_rows, dtype=bool)]
                else:
                    clips = ids(meta["clip"], "clip", n_rows, kinds="iu")
                    names = ids(meta["clip_names"], "clip_names", None, unique=True)
                    yt = vector(meta["youtube"], "youtube", "b", len(names))[clips]
                    groups = names[clips]
                    if stem == "svan_test":
                        cohort_masks = [~yt, yt]
                    else:
                        px = vector(meta["size"], "size", "iuf", n_rows)
                        cohort_masks = [~yt & (px == t) for t in (7, 10, 13)]

                boxes_all = meta["boxes_xywh"] if "boxes_xywh" in meta else None
                frame_wh = meta["frame_wh"] if "frame_wh" in meta else (640.0, 512.0)

            crop_logits = self._crop_logits(crops, batch_size=batch_size)
            adjusted = base_probs.copy()
            for keep in cohort_masks:
                win = windows(y, groups, keep, window, tracks=tracks, frames=frames)
                if len(win) == 0:
                    continue
                fl_win = crop_logits[win]
                fr_win = frames[win]
                if boxes_all is not None:
                    kin_win = compute_kinematics_features(boxes_all[win], fr_win, frame_wh=frame_wh)
                else:
                    neutral_boxes = np.broadcast_to(
                        np.array([312.0, 248.0, 16.0, 16.0], dtype=np.float32),
                        (len(win), window, 4),
                    )
                    kin_win = compute_kinematics_features(neutral_boxes, fr_win, frame_wh=frame_wh)
                with torch.inference_mode():
                    fused = temporal_model(
                        torch.from_numpy(fl_win),
                        torch.from_numpy(kin_win),
                        frame_indices=fr_win,
                    )
                    fused_probs = torch.softmax(fused, dim=-1).cpu().numpy().astype(np.float32)
                adjusted[win] = fused_probs[:, None, :]
            return adjusted

    def _loader(checkpoint: Path, *, arch: str):
        if arch not in ARCHITECTURES:
            raise PipelineGateError(f"--arch must be one of {', '.join(ARCHITECTURES)}")
        return _TemporalOrUniformPredictor(load_predictor(checkpoint, arch=arch))

    return _loader


def _load_optional_json(path: Path | None) -> Any:
    if path is None:
        return None
    if not path.is_file():
        raise PipelineGateError(f"JSON file does not exist: {sanitize_paths(str(path))}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PipelineGateError(f"Invalid JSON file ({sanitize_paths(str(path))}): {exc}") from exc


def _run_preflight_mode(args: argparse.Namespace) -> dict[str, Any]:
    from v5_temporal_kinematics import (
        ARCH as TEMPORAL_ARCH,
        KINEMATICS_FEATURES,
        LABELS,
        MAX_ONNX_BYTES,
        MAX_PARAMETERS,
        WINDOW_SIZE,
        TemporalKinematicsHead,
        count_parameters,
    )

    head = TemporalKinematicsHead()
    n_params = count_parameters(head)
    if not (0 < n_params < MAX_PARAMETERS):
        raise PipelineGateError(f"TemporalKinematicsHead parameter budget exceeded: {n_params} >= {MAX_PARAMETERS}")

    klim_groups = _load_optional_json(args.klim_groups_json)
    small_bird = audit_small_bird_sources(
        klim_groups,
        airbirds_metadata=args.airbirds_metadata,
        airbirds_role=args.airbirds_role,
    )

    corpus_summary = None
    if args.verify_data_root:
        corpus_summary = verify_ten_source_preflight(
            args.data_root,
            inventory_only=args.inventory_only,
            klim_session_groups=klim_groups,
            airbirds_metadata=args.airbirds_metadata,
            airbirds_role=args.airbirds_role,
        )

    return sanitize_paths(
        {
            "status": "ok",
            "mode": "preflight",
            "ten_sources": list(TEN_SOURCES),
            "max_phash_hamming": MAX_PHASH_HAMMING,
            "bootstrap": {"n_resamples": N_BOOTSTRAP, "seed": BOOTSTRAP_SEED},
            "temporal_head": {
                "arch": TEMPORAL_ARCH,
                "window_size": WINDOW_SIZE,
                "labels": list(LABELS),
                "kinematics_features": list(KINEMATICS_FEATURES),
                "parameters": n_params,
                "max_parameters": MAX_PARAMETERS,
                "max_onnx_bytes": MAX_ONNX_BYTES,
            },
            "small_bird_audit": small_bird,
            "unseen_fbd_gate_enforced": enforce_unseen_fbd_gate(False, None) is None,
            "corpus_preflight": corpus_summary,
        }
    )


def _run_train_backbone_mode(args: argparse.Namespace) -> dict[str, Any]:
    klim_groups = _load_optional_json(args.klim_groups_json)
    preflight_info = verify_ten_source_preflight(
        args.data_root,
        inventory_only=False,
        klim_session_groups=klim_groups,
        airbirds_metadata=args.airbirds_metadata,
        airbirds_role=args.airbirds_role,
    )
    if args.pretrained_weights is None or not args.pretrained_sha256:
        raise PipelineGateError("--mode train-backbone requires --pretrained-weights and --pretrained-sha256")

    script = HERE / "train_v5_mobilenet.py"
    cmd = [
        sys.executable,
        "-B",
        str(script),
        "--train",
        "--arch",
        args.arch,
        "--name",
        args.name,
        "--data-root",
        str(args.data_root),
        "--pretrained-weights",
        str(args.pretrained_weights),
        "--pretrained-sha256",
        str(args.pretrained_sha256),
    ]
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise PipelineGateError(
            f"train_v5_mobilenet.py failed (exit {proc.returncode}): {sanitize_paths(proc.stderr.strip())}"
        )
    return sanitize_paths(
        {
            "status": "ok",
            "mode": "train-backbone",
            "run_name": args.name,
            "corpus_status": preflight_info.get("status"),
            "stdout": proc.stdout.strip(),
        }
    )


def _run_train_temporal_mode(args: argparse.Namespace) -> dict[str, Any]:
    import torch
    from v5_temporal_kinematics import (
        LABELS,
        export_browser_json,
        export_onnx,
        save_checkpoint,
        uniform_vote_probs,
    )

    if args.train_windows is None or args.out is None:
        raise PipelineGateError("--mode train-temporal requires --train-windows and --out")
    out_dir = _reject_frozen_test_path(args.out, "--out")
    if out_dir.exists():
        raise PipelineGateError(f"Output directory already exists: {sanitize_paths(str(out_dir))}")

    tr = _load_npz_windows(args.train_windows, "train")
    sel = _load_npz_windows(args.select_windows, "select") if args.select_windows is not None else None

    head, history = train_temporal_head(
        tr["logits"],
        tr["kinematics"],
        tr["y"],
        sel["logits"] if sel is not None else None,
        sel["kinematics"] if sel is not None else None,
        sel["y"] if sel is not None else None,
        train_frame_indices=tr.get("frame_indices"),
        sample_weights=tr.get("sample_weights"),
        select_frame_indices=sel.get("frame_indices") if sel is not None else None,
        device=args.device,
        seed=args.seed,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        weight_decay=args.weight_decay,
        label_smoothing=args.label_smoothing,
    )

    out_dir.mkdir(parents=True, exist_ok=False)
    ckpt_meta = save_checkpoint(head, out_dir / "temporal_head.pt", metadata={"seed": args.seed, "epochs": args.epochs})
    onnx_meta = export_onnx(out_dir / "temporal_head.pt", out_dir / "temporal_head.onnx")
    json_meta = export_browser_json(out_dir / "temporal_head.pt", out_dir / "temporal_head.json")

    paired_select: dict[str, Any] | None = None
    if sel is not None:
        sel_groups = sel.get("groups")
        if sel_groups is None:
            sel_groups = np.array([f"win_{i}" for i in range(len(sel["y"]))])
        head_cpu = head.to("cpu").eval()
        with torch.inference_mode():
            cand_pred = head_cpu(
                torch.from_numpy(np.asarray(sel["logits"], dtype=np.float32)),
                torch.from_numpy(np.asarray(sel["kinematics"], dtype=np.float32)),
            ).argmax(dim=-1).numpy()
        base_pred = uniform_vote_probs(sel["logits"]).argmax(axis=-1)
        y_sel = np.asarray(sel["y"], dtype=np.int64)
        paired_select = {
            "bird_recall": paired_group_bootstrap_ci(cand_pred == 0, base_pred == 0, y_sel == 0, sel_groups),
            "drone_recall": paired_group_bootstrap_ci(cand_pred == 1, base_pred == 1, y_sel == 1, sel_groups),
            "false_alarm": paired_group_bootstrap_ci(cand_pred < 2, base_pred < 2, y_sel == 2, sel_groups),
        }

    report = sanitize_paths(
        {
            "status": "ok",
            "mode": "train-temporal",
            "labels": list(LABELS),
            "epochs": args.epochs,
            "seed": args.seed,
            "artifacts": {
                "checkpoint": ckpt_meta,
                "onnx": onnx_meta,
                "browser_json": json_meta,
            },
            "history": history,
            "select_paired_bootstrap": paired_select,
        }
    )
    (out_dir / "temporal_report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return report


def _run_eval_unseen_mode(args: argparse.Namespace) -> dict[str, Any]:
    fbd_verified = enforce_unseen_fbd_gate(True, args.fbd_pins)
    if args.svanstrom_pins is None:
        raise FrozenTestAccessError(
            "Unseen evaluation requires explicit --svanstrom-pins SHA-256 pins JSON"
        )
    if not Path(args.svanstrom_pins).is_file():
        raise FrozenTestAccessError(
            f"--svanstrom-pins SHA-256 pins JSON does not exist: {sanitize_paths(str(args.svanstrom_pins))}"
        )
    if args.checkpoint is None or args.out is None:
        raise PipelineGateError("--mode eval-unseen requires --checkpoint and --out")

    from eval_voting import run_report

    loader = _build_unseen_predictor_loader(args.temporal_checkpoint, args.window)
    markdown_text = run_report(
        args.checkpoint,
        args.arch,
        args.out,
        args.window,
        args.fbd_pins,
        args.svanstrom_pins,
        data=args.data_root,
        predictor_loader=loader,
    )
    return sanitize_paths(
        {
            "status": "ok",
            "mode": "eval-unseen",
            "window": args.window,
            "fbd_pins": fbd_verified,
            "report_dir": str(args.out),
            "summary_lines": len(markdown_text.splitlines()),
        }
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        required=True,
        choices=("preflight", "train-backbone", "train-temporal", "eval-unseen"),
        help="Pipeline stage to run",
    )
    parser.add_argument("--data-root", type=Path, default=REPO / "data")
    parser.add_argument("--verify-data-root", action="store_true", help="Verify 10-source corpus in preflight mode")
    parser.add_argument("--inventory-only", action="store_true", help="Check corpus inventory without evidence JSON")
    parser.add_argument("--klim-groups-json", type=Path, default=None, help="JSON session IDs for Klim/Skagen")
    parser.add_argument("--airbirds-metadata", type=Path, default=None, help="AirBirds native-frame intake JSON")
    parser.add_argument("--airbirds-role", default="none", help="AirBirds role: none, test_only, or research_only")

    parser.add_argument("--arch", default="mobilenet_v3_large", help="Backbone architecture")
    parser.add_argument("--name", default="v5_ten_source", help="Run directory name for --mode train-backbone")
    parser.add_argument("--pretrained-weights", type=Path, default=None, help="Local ImageNet V2 weights .pth")
    parser.add_argument("--pretrained-sha256", default=None, help="Approved 64-hex SHA-256 of pretrained weights")

    parser.add_argument("--train-windows", type=Path, default=None, help="Precomputed train windows .npz")
    parser.add_argument("--select-windows", type=Path, default=None, help="Precomputed SELECT windows .npz")
    parser.add_argument("--device", default=None, help="Training device ('cuda' or 'cpu')")
    parser.add_argument("--seed", type=int, default=44)
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-3)
    parser.add_argument("--label-smoothing", type=float, default=0.03)

    parser.add_argument("--checkpoint", type=Path, default=None, help="Backbone checkpoint for --mode eval-unseen")
    parser.add_argument("--temporal-checkpoint", type=Path, default=None, help="Optional TemporalKinematicsHead .pt")
    parser.add_argument("--window", type=int, default=5, help="Evaluation window size")
    parser.add_argument("--out", type=Path, default=None, help="New output directory for temporal/eval artifacts")
    parser.add_argument("--fbd-pins", type=Path, default=None, help="Explicit SHA-256 pins JSON for FBD-SV-2024")
    parser.add_argument("--svanstrom-pins", type=Path, default=None, help="Explicit SHA-256 pins JSON for Svanstrom")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.mode == "preflight":
        summary = _run_preflight_mode(args)
    elif args.mode == "train-backbone":
        summary = _run_train_backbone_mode(args)
    elif args.mode == "train-temporal":
        summary = _run_train_temporal_mode(args)
    else:
        summary = _run_eval_unseen_mode(args)
    print(json.dumps(sanitize_paths(summary), indent=2, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (PipelineGateError, ValueError, OSError) as exc:
        print(f"{type(exc).__name__}: {sanitize_paths(str(exc))}", file=sys.stderr)
        sys.exit(1)
