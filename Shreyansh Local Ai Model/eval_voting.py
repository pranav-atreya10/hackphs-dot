"""Compare mean-probability voting to the first crop in each of the same complete windows.

FBD-SV-2024 is the never-seen headline, for testing only; do not use it to pick a checkpoint,
window, threshold, or any other setting. This script cannot run the private field holdout.
Run only after the checkpoint and recipe are fixed, research use is cleared, and a source-overlap
audit is complete. Input hashes verify bytes, not whether the checkpoint has seen the source.

Frozen metadata audit: FBD-SV's crop writer saves y/size/group, not the decoded frame index or
object identity. Svanstrom's two legacy writers save clip metadata, not frame/track IDs either.
Legacy windows use archive order within each clip/class; crops can share a frame or depict
different objects. Neither a fixed time span nor track-level accuracy is implied.

Strict chronological windows require provided track_id and frame_index vectors (one per crop).
The track ID is scoped to its clip; frame indices must be unique within each evaluated track
and class must be constant. Frames are sorted, not assumed adjacent. If present, sample_id
must be unique within the archive. IDs are nonnegative integers or nonblank Unicode strings;
frame_index is a nonnegative integer. Frame indices alone are not evidence of object identity.

Use a new --out directory. Pass the same reviewed --fbd-pins JSON as eval_v4.py
({"crops_sha256": "...", "metadata_sha256": "..."}) and --svanstrom-pins, a reviewed JSON
map from Svanstrom archive filenames (.npy/.npz) to SHA-256 digests. These are in addition
to the non-holdout checks in benchmarks/test_sets.json, which doesn't pin these derived
arrays. Do not reconstruct or re-pin missing/changed inputs to run this evaluator.
Historical v4.1 files in results/v4_1 are unchanged; their all-crop and vote columns have
different denominators and are not a paired comparison or a strict-track baseline.
"""
import argparse
import json
import platform
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from zipfile import BadZipFile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
sys.path.insert(0, str(ROOT / "benchmarks"))
from bench.common import git_info, sha256_file  # noqa: E402
from bench.stats import N_BOOT, ratio_ci, significant  # noqa: E402

FBD = "FBD-SV (never-seen source)"
LEGACY = "legacy clip/class window"
TRACK = "chronological track window"
ARCHIVES = (("shreyansh_crops_v4", "fbdsv2024_testonly_test"),
            ("shreyansh_crops_v3", "svan_test"), ("shreyansh_crops_v3", "svan_shrunk"))
METRICS = ("bird_recall", "drone_recall", "false_alarm")
SEED = 0  # keep the v4.1 resampling seed


@dataclass(frozen=True)
class Cohort:
    name: str
    crops: np.ndarray
    y: np.ndarray
    groups: np.ndarray
    keep: np.ndarray
    windows: np.ndarray
    window_unit: str
    has_sample_ids: bool
    has_frame_indices: bool


def vector(value, key, kinds, n=None):
    if value.ndim != 1 or (n is not None and len(value) != n) or value.dtype.kind not in kinds:
        raise ValueError(f"{key} must be a one-dimensional vector of the expected length and type")
    return value


def ids(value, key, n, *, kinds="iuU", unique=False):
    value = vector(value, key, kinds, n)
    if value.dtype.kind == "U":
        valid = all(s and s.isprintable() and s == s.strip() for s in value)
    else:
        valid = not (value < 0).any()
    if not valid or (unique and len(np.unique(value)) != len(value)):
        raise ValueError(f"{key} contains invalid or duplicate IDs")
    return value


def windows(y, groups, keep, n, *, tracks=None, frames=None):
    """Make complete non-overlapping windows; never fall back from invalid track metadata."""
    if n < 1:
        raise ValueError("--window must be at least 1")
    if tracks is not None and frames is None:
        raise ValueError("track_id requires frame_index; archive order is not track chronology")
    runs = {}
    for i in np.flatnonzero(keep):
        key = (groups[i], y[i] if tracks is None else tracks[i])
        runs.setdefault(key, []).append(i)
    out = []
    for key, run in runs.items():
        if tracks is not None:
            if len(np.unique(y[run])) != 1:
                raise ValueError(f"track {key!r} has mixed classes")
            run = sorted(run, key=frames.__getitem__)
            if len(np.unique(frames[run])) != len(run):
                raise ValueError(f"track {key!r} has a repeated frame_index")
        out.extend(run[k:k + n] for k in range(0, len(run) - n + 1, n))
    return np.asarray(out, dtype=np.intp).reshape(-1, n)


def archive_cohorts(crops, meta, stem, n):
    y = vector(meta["y"], "y", "iu")
    size = len(y)
    if not size or not np.isin(y, [0, 1, 2]).all():
        raise ValueError("expected nonempty y with bird=0, drone=1, other=2")
    if (not isinstance(crops, np.ndarray) or crops.dtype != np.uint8 or crops.ndim != 5
            or crops.shape[0] != size or crops.shape[1] < 1 or crops.shape[2:] != (64, 64, 3)):
        raise ValueError("crops must align with y and have uint8 shape (N, V, 64, 64, 3)")

    sample_ids = "sample_id" in meta
    if sample_ids:
        ids(meta["sample_id"], "sample_id", size, unique=True)
    tracks = ids(meta["track_id"], "track_id", size) if "track_id" in meta else None
    frames = ids(meta["frame_index"], "frame_index", size, kinds="iu") if "frame_index" in meta else None
    unit = TRACK if tracks is not None else LEGACY

    if stem == ARCHIVES[0][1]:
        groups = ids(meta["group"], "group", size)
        views = [(FBD, np.ones(size, dtype=bool))]
    else:
        clips = ids(meta["clip"], "clip", size, kinds="iu")
        names = ids(meta["clip_names"], "clip_names", None, unique=True)
        youtube = vector(meta["youtube"], "youtube", "b", len(names))
        if (clips >= len(names)).any():
            raise ValueError("clip references a missing clip_names entry")
        groups, yt = names[clips], youtube[clips]
        if stem == "svan_test":
            views = [("Svanstrom (real size)", ~yt), ("Svanstrom YouTube planes/helicopters", yt)]
        else:
            px = vector(meta["size"], "size", "iuf", size)
            if not np.isin(px, [7, 10, 13]).all():
                raise ValueError("unexpected Svanstrom shrunk size")
            views = [(f"Svanstrom shrunk {t} px", ~yt & (px == t)) for t in (7, 10, 13)]

    rows = []
    for name, keep in views:
        win = windows(y, groups, keep, n, tracks=tracks, frames=frames)
        if name == FBD and not np.isin([0, 2], y[win[:, 0]]).all():
            raise ValueError("headline FBD-SV requires complete bird and background windows")
        rows.append(Cohort(name, crops, y, groups, keep, win, unit, sample_ids, frames is not None))
    return rows


def read_pins(path, option):
    if not path.is_file():
        raise ValueError(f"{option} requires a reviewed SHA-256 pins file: {path}")
    pins = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(pins, dict):
        raise ValueError(f"{option} requires a JSON object of approved SHA-256 digests")
    return pins


def load_cohorts(data, n, fbd_pins_path, svan_pins_path):
    pairs = [(stem, data / folder / f"{stem}_X.npy", data / folder / f"{stem}_meta.npz")
             for folder, stem in ARCHIVES]
    for stem, crops_path, meta_path in pairs:
        for path in (crops_path, meta_path):
            if not path.is_file():
                name = f"headline {FBD}" if stem == ARCHIVES[0][1] else stem
                raise ValueError(f"missing frozen {name} input: {path}")

    manifest_sha256 = verify_protocol_manifest() if data == DATA else None
    fbd_pins = read_pins(fbd_pins_path, "--fbd-pins")
    svan_pins = read_pins(svan_pins_path, "--svanstrom-pins")
    verified = {}
    for stem, crops_path, meta_path in pairs:
        for path, key in ((crops_path, "crops_sha256"), (meta_path, "metadata_sha256")):
            expected = fbd_pins.get(key) if stem == ARCHIVES[0][1] else svan_pins.get(path.name)
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
                raise ValueError(f"missing or invalid approved SHA-256 for {path.name}")
            actual = sha256_file(path)
            if actual != expected.lower():
                raise ValueError(f"frozen archive checksum mismatch: {path.name}; do not replace the input")
            verified[path.name] = actual

    rows = []
    for stem, crops_path, meta_path in pairs:
        try:
            with np.load(meta_path, allow_pickle=False) as meta:
                crops = np.load(crops_path, mmap_mode="r", allow_pickle=False)
                rows.extend(archive_cohorts(crops, meta, stem, n))
        except (BadZipFile, KeyError, ValueError) as exc:
            raise ValueError(f"{stem}: invalid frozen metadata or crops: {exc}") from exc
    return rows, verified, manifest_sha256


def verify_protocol_manifest():
    from bench.manifest import verify

    path = ROOT / "benchmarks" / "test_sets.json"
    verify(json.loads(path.read_text(encoding="utf-8")), include_holdout=False)
    return sha256_file(path)


def grouped_rate(hit, eligible, groups):
    if not eligible.any():
        return None
    _, clip_idx = np.unique(groups[eligible], return_inverse=True)
    # Each entry is one whole clip, even when the scoring unit is a track window.
    den = np.bincount(clip_idx)
    num = np.bincount(clip_idx, weights=hit[eligible])
    value, lo, hi = ratio_ci(num, den, n_boot=N_BOOT, seed=SEED)
    return {"value": value, "ci95": [lo, hi], "n": int(den.sum()), "groups": len(den)}


def score_cohort(row, probabilities):
    first = row.windows[:, 0]
    predicted = probabilities.argmax(axis=1)
    voted = probabilities[row.windows].mean(axis=1).argmax(axis=1)
    metrics = {}
    for label, key in enumerate(METRICS):
        single_hit = predicted < 2 if label == 2 else predicted == label
        vote_hit = voted < 2 if label == 2 else voted == label
        crops = grouped_rate(single_hit, row.keep & (row.y == label), row.groups)
        first_crop = grouped_rate(single_hit[first], row.y[first] == label, row.groups[first])
        vote = grouped_rate(vote_hit, row.y[first] == label, row.groups[first])
        flag = None
        if vote is not None and vote["groups"] < 2:
            flag = "not significant"
        elif vote is not None:
            flag = significant(dict(zip(("lo", "hi"), vote["ci95"])),
                               dict(zip(("lo", "hi"), first_crop["ci95"])))
        metrics[key] = {"all_crops": crops, "first_crop_per_window": first_crop, "vote_per_window": vote,
                        "vote_vs_first_ci_overlap": flag}
    return {"window_unit": row.window_unit, "bootstrap_unit": "source clip",
            "has_sample_ids": row.has_sample_ids, "has_frame_indices": row.has_frame_indices,
            "crops": int(row.keep.sum()), "windows": len(first),
            "crops_outside_complete_windows": int(row.keep.sum() - row.windows.size), "metrics": metrics}


def markdown(report):
    def fmt(rate):
        if rate is None:
            return "n/a"
        lo, hi = rate["ci95"]
        return (f"{rate['value']:.1%} ({lo:.1%} to {hi:.1%}); "
                f"n={rate['n']}, clips={rate['groups']}")

    lines = [
        f"# Voting evaluation: {report['window']} crops per window",
        "",
        f"**Headline: {FBD}.** Test-only; never use for tuning or model selection. This headline assumes "
        "the checkpoint did not see FBD-SV or its derivatives; input hashes do not establish training "
        "provenance. No private field holdout.",
        "",
        "Legacy clip/class windows follow archive order and may mix objects or repeat frames. Chronological "
        "track windows use supplied object IDs and distinct observed frames in order, not necessarily adjacent.",
        "Compare first-crop and vote rates on the **same complete windows**. All-crop rates are context only. "
        "False alarm means calling an 'other' crop or window a bird or drone. Intervals are 95% percentile "
        "bootstrap intervals (1,000 whole-clip resamples within each row, seed 0). Overlapping intervals "
        "or fewer than two clips are not significant. Svanstrom variants reuse clips; the flag does not "
        "compare checkpoints or sources.",
        "",
        "Historical v4.1 (`results/v4_1/voting_5.md` and `.json`) used all crops vs legacy clip/class windows. "
        "Do not compare it to the paired or chronological columns. When comparing checkpoints, match the "
        "frozen archive hashes, source/cohort, window length, and metric unit.",
        "",
        "| Test set | Window unit | Metric | All crops (context) | First crop per window | Mean vote per window | Vote vs first (CI overlap rule) |",
        "|---|---|---|---|---|---|---|",
    ]
    for name, row in report["sources"].items():
        for key, metric in row["metrics"].items():
            lines.append(f"| {name} | {row['window_unit']} | {key.replace('_', ' ')} | "
                         f"{fmt(metric['all_crops'])} | {fmt(metric['first_crop_per_window'])} | "
                         f"{fmt(metric['vote_per_window'])} | {metric['vote_vs_first_ci_overlap'] or 'n/a'} |")
    return "\n".join(lines) + "\n"


def run_report(checkpoint, arch, out, n, fbd_pins, svan_pins, *, data=DATA, predictor_loader=None):
    if n < 1:
        raise ValueError("--window must be at least 1")
    if out.exists():
        raise ValueError(f"report directory already exists: {out}; choose a new --out")
    if any(f.resolve() in out.resolve().parents for f in (data, ROOT / "test_media")):
        raise ValueError("--out must be outside the frozen data and field footage directories")
    cohorts, checksums, manifest_sha256 = load_cohorts(data, n, fbd_pins, svan_pins)
    git = git_info()
    if data == DATA and (not git["commit"] or git["dirty"]):
        raise ValueError("commit the evaluation code before producing a voting report")
    if predictor_loader is None:
        from eval_inference import ARCHITECTURES, load_predictor

        if arch not in ARCHITECTURES:
            raise ValueError(f"--arch must be one of {', '.join(ARCHITECTURES)}")
        predictor_loader = load_predictor
    predictor = predictor_loader(checkpoint, arch=arch)
    runtime = {"device": "cpu", "precision": "float32", "platform": platform.platform(),
               "processor": platform.processor(), "python": platform.python_version(), "numpy": np.__version__}
    for lib in ("torch", "torchvision"):
        version = getattr(sys.modules.get(lib), "__version__", None)
        if version is not None:
            runtime[lib] = str(version)
    report = {
        "schema_version": 2, "headline_source": FBD, "headline_test_only": True, "window": n,
        "checkpoint_sha256": predictor.checkpoint_sha256, "arch": arch,
        "decision_rule": "argmax of class probabilities (mean probabilities for a vote)",
        "bootstrap": {"n_resamples": N_BOOT, "seed": SEED, "confidence_level": 0.95},
        "frozen_inputs_sha256": checksums, "benchmark_manifest_sha256": manifest_sha256, "git": git,
        "runtime": runtime, "sources": {},
    }
    last_crops = None
    for row in cohorts:
        if row.crops is not last_crops:
            last_crops = row.crops
            p = predictor.predict_proba(row.crops, batch_size=512)
            if (not isinstance(p, np.ndarray) or p.shape != (len(row.y), 3) or p.dtype.kind != "f"
                    or not np.isfinite(p).all()
                    or (p < 0).any() or (p > 1).any() or not np.allclose(p.sum(axis=1), 1, rtol=0, atol=1e-5)):
                raise ValueError(f"{row.name}: predictor must return aligned bird/drone/other probabilities")
        report["sources"][row.name] = score_cohort(row, p)

    text = markdown(report)
    out.mkdir(parents=True, exist_ok=False)
    (out / f"voting_{n}.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    (out / f"voting_{n}.md").write_text(text, encoding="utf-8")
    return text


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", required=True, type=Path)
    ap.add_argument("--arch", default="skynetlite", help="checkpoint architecture (default: skynetlite)")
    ap.add_argument("--out", required=True, type=Path, help="new report directory")
    ap.add_argument("--window", type=int, default=5, help="fixed window length, not tuned on these sets")
    ap.add_argument("--fbd-pins", required=True, type=Path, help="reviewed FBD-SV crop and metadata SHA-256 pins")
    ap.add_argument("--svanstrom-pins", required=True, type=Path, help="reviewed Svanstrom archive SHA-256 pins")
    a = ap.parse_args()
    try:
        print(run_report(a.checkpoint, a.arch, a.out, a.window, a.fbd_pins, a.svanstrom_pins), end="", flush=True)
    except (OSError, ValueError) as exc:
        ap.exit(1, f"Voting report refused: {exc}\n")


if __name__ == "__main__":
    main()
