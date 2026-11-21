"""Supplementary test-only crop report for one already-selected checkpoint.

    python eval_v4.py --arch mobilenet_v3_large --checkpoint runs/v5_large/best.pt --out results/v5_large_crops

Legacy SkyNetLite is the default. Use a fresh output directory for each run. FBD-SV
requires externally reviewed crop and metadata hashes (--fbd-pins); a never-seen
claim additionally requires a leakage audit for the exact checkpoint. This tool
does not select a model, tune thresholds, or run the protected field holdout.
Use evaluate.py separately for the official frozen Mendeley metrics.
"""
import argparse
import hashlib
import json
import re
import sys
from importlib.metadata import version
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
BENCHMARKS = HERE.parent / "benchmarks"
sys.path.insert(0, str(BENCHMARKS))
from bench.common import git_info, hardware_info, sha256_file  # noqa: E402
from eval_inference import ARCHITECTURES, CLASSES, DEFAULT_BATCH, load_predictor, validate_crops  # noqa: E402
from eval_metrics import BOOT_SEED, N_BOOT, rate  # noqa: E402

FBD = "fbdsv2024_testonly"
V4_SOURCES = (FBD, "aod4", "dcskycam", "dut_anti_uav", "iberbirds", "klim_skagen", "openimages",
              "synth_athkot", "synth_cranfield")
METRICS = (
    ("bird_recall", "Bird recall"), ("drone_recall", "Drone recall"), ("false_alarm", "False alarms"),
    ("bird_7_15", "Birds 7-15 px"), ("obj_7_15", "Birds+drones 7-15 px"), ("obj_over_15", "Birds+drones over 15 px"),
)
STATUS = {
    "missing_split": "not scored (missing split)",
    "empty_split": "not scored (no crops in split)",
    "unpinned_split": "not scored (no reviewed crop and metadata pins)",
}

def read_fbd_pins(path):
    """Read previously reviewed SHA-256 pins; never generate or update pins here."""
    pins = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(pins, dict) or set(pins) != {"crops_sha256", "metadata_sha256"} or not all(
        isinstance(digest, str) and re.fullmatch(r"[a-fA-F0-9]{64}", digest) for digest in pins.values()
    ):
        raise ValueError(f"{path}: expected crops_sha256 and metadata_sha256 with 64 hex characters each")
    return {key: digest.lower() for key, digest in pins.items()}


def verify_fbd_pins(crops_path, meta_path, pins):
    for key, path in (("crops_sha256", crops_path), ("metadata_sha256", meta_path)):
        if sha256_file(path) != pins[key]:
            raise ValueError(f"{path}: differs from reviewed FBD-SV SHA-256 pin; refusing to score")


def _unscored(status, **details):
    return {"status": status, **{key: None for key, _ in METRICS}, **details}


def _score(p, y, size, group):
    small, big = (size >= 7) & (size < 15), size >= 15
    bird, drone, other = y == 0, y == 1, y == 2
    obj = bird | drone
    return {
        "status": "scored",
        "bird_recall": rate(bird & (p == 0), bird, group),
        "drone_recall": rate(drone & (p == 1), drone, group),
        "false_alarm": rate(other & (p < 2), other, group),
        "bird_7_15": rate(small & bird & (p == 0), small & bird, group),
        "obj_7_15": rate(small & obj & (p == y), small & obj, group),
        "obj_over_15": rate(big & obj & (p == y), big & obj, group),
    }


def _score_split(predictor, root, stem, labels, *, svan=False, fbd_pins=None):
    crops_path, meta_path = root / f"{stem}_X.npy", root / f"{stem}_meta.npz"
    missing = [path.name for path in (crops_path, meta_path) if not path.is_file()]
    if missing:
        return {name: _unscored("missing_split", missing_files=missing) for name in labels}
    if stem == f"{FBD}_test":
        if fbd_pins is None:
            return {FBD: _unscored("unpinned_split")}
        verify_fbd_pins(crops_path, meta_path, fbd_pins)

    with np.load(meta_path, allow_pickle=False) as meta:
        y, size = meta["y"], meta["size"]
        group = meta["clip" if svan else "group"]
        if y.ndim != 1 or size.shape != y.shape or group.shape != y.shape:
            raise ValueError(f"{meta_path}: labels, sizes and groups must be aligned one-dimensional arrays")
        if y.dtype.kind not in "iu" or not np.isin(y, (0, 1, 2)).all():
            raise ValueError(f"{meta_path}: unknown class code (expected 0=bird, 1=drone, 2=other)")
        if size.dtype.kind not in "fiu" or not np.isfinite(size).all() or (size < 0).any():
            raise ValueError(f"{meta_path}: invalid object sizes")
        if svan:
            youtube = meta["youtube"]
            if (group.dtype.kind not in "iu" or youtube.ndim != 1 or youtube.dtype.kind != "b"
                    or (group < 0).any() or (group >= len(youtube)).any()):
                raise ValueError(f"{meta_path}: invalid group or YouTube clip metadata")
            masks = (~youtube[group], youtube[group])
        else:
            if len(group) and (group.dtype.kind not in "US" or (np.char.str_len(group) == 0).any()):
                raise ValueError(f"{meta_path}: invalid source group IDs")
            masks = (np.ones(len(y), dtype=bool),)

    X = np.load(crops_path, mmap_mode="r", allow_pickle=False)
    validate_crops(X)
    if len(X) != len(y):
        raise ValueError(f"{crops_path}: crop count does not match labels in {meta_path.name}")
    rows = {}
    for name, keep in zip(labels, masks):
        if keep.any():
            p = predictor.predict(X if keep.all() else X[keep])
            rows[name] = _score(p, y[keep], size[keep], group[keep])
        else:
            rows[name] = _unscored("empty_split")
    return rows


def score_suite(predictor, data, fbd_pins=None):
    rows = {}
    for name in V4_SOURCES:
        rows.update(_score_split(predictor, data / "shreyansh_crops_v4", f"{name}_test", (name,), fbd_pins=fbd_pins))
    v3 = data / "shreyansh_crops_v3"
    rows.update(_score_split(predictor, v3, "svan_test",
                             ("svanstrom (real size)", "svanstrom YouTube planes/helicopters"), svan=True))
    rows.update(_score_split(predictor, v3, "svan_shrunk", ("svanstrom shrunk 7/10/13 px",), svan=True))
    return rows


def _verify_benchmark_inputs():
    from bench import manifest
    from evaluate import verify as verify_mendeley

    path = BENCHMARKS / "test_sets.json"
    data = path.read_bytes()
    man = json.loads(data)
    visual = man["tiers"]["dataset"].pop("visual")
    if not visual["items"]:
        raise ValueError("the frozen Mendeley manifest has no items")
    # Mendeley verification also checks label hashes and detects new, unlisted files.
    count, _ = verify_mendeley(visual, visual["items"])
    for group in man["tiers"].get("field", {}).values():
        if isinstance(group, dict):
            group.get("splits", {}).pop("holdout", None)
    count += manifest.verify(man, include_holdout=False)
    return {"manifest_sha256": hashlib.sha256(data).hexdigest(), "n_test_files_verified": count, "field_holdout": False}


def _report(rows, record):
    def fmt(metric):
        if metric is None:
            return "n/a (no examples)"
        lo, hi = metric["ci95"]
        return f"{100 * metric['value']:.1f}% ({100 * lo:.1f}-{100 * hi:.1f}), n={metric['n']}, groups={metric['clips']}"

    lines = [
        "# Supplementary crop tests (not for model selection)",
        "",
        f"Architecture: `{record['architecture']}`. Checkpoint SHA-256: `{record['checkpoint_sha256']}`.",
        "FBD-SV-2024 is test-only. Report it as never-seen only after a leakage audit for this exact checkpoint.",
        "Ranges are 95% group-bootstrap CIs (1,000 resamples); n is the crop count for the metric.",
        "",
        "| Test set | " + " | ".join(label for _, label in METRICS) + " |",
        "|" + "---|" * (1 + len(METRICS)),
    ]
    for name, row in rows.items():
        label = "**FBD-SV-2024 (test-only)**" if name == FBD else name
        if row["status"] == "scored":
            cells = [fmt(row[key]) for key, _ in METRICS]
        else:
            cells = [STATUS[row["status"]]] + ["-"] * (len(METRICS) - 1)
        lines.append("| " + " | ".join([label, *cells]) + " |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True, type=Path, help="already-selected, trusted local checkpoint")
    ap.add_argument("--arch", choices=ARCHITECTURES, default="skynetlite")
    ap.add_argument("--out", required=True, type=Path, help="new directory for this report")
    ap.add_argument("--fbd-pins", type=Path, help="reviewed JSON with crops_sha256 and metadata_sha256")
    a = ap.parse_args(argv)
    out = a.out.resolve()
    protected = (DATA, BENCHMARKS, HERE.parent / "test_media", HERE / "runs")
    if out.exists() or any(out.is_relative_to(root.resolve()) for root in protected):
        ap.error("--out must be a new directory outside protected data, benchmark and model paths")
    try:
        git = git_info()
        if not git["commit"] or git["dirty"]:
            raise ValueError("commit the evaluator changes before scoring; a clean git checkout is required")
        pins = read_fbd_pins(a.fbd_pins) if a.fbd_pins else None
        verification = _verify_benchmark_inputs()
        predictor = load_predictor(a.checkpoint, arch=a.arch)
        rows = score_suite(predictor, DATA, fbd_pins=pins)
        record = {
            "architecture": a.arch, "checkpoint": str(a.checkpoint), "checkpoint_sha256": predictor.checkpoint_sha256,
            "git": git, "hardware": hardware_info(), "device": "cpu",
            "settings": {"class_order": CLASSES, "crop_view": 0, "batch_size": DEFAULT_BATCH,
                         "decision_rule": "logit argmax (no tuned threshold)"},
            "bootstrap": {"unit": "source group", "resamples": N_BOOT, "seed": BOOT_SEED},
            "benchmark_verification": verification,
            "fbd_sv": {"status": rows[FBD]["status"], "reviewed_pins": pins, "leakage_audit": "not_performed"},
        }
        if a.arch != "skynetlite":
            record["hardware"]["torchvision"] = version("torchvision")
        report = _report(rows, record)
        out.mkdir(parents=True)
        for name, text in (("all_tests.json", json.dumps(rows, indent=1) + "\n"),
                           ("all_tests_run.json", json.dumps(record, indent=1) + "\n"),
                           ("all_tests.md", report)):
            with (out / name).open("x", encoding="utf-8") as file:
                file.write(text)
    except (ImportError, KeyError, OSError, ValueError) as exc:
        ap.error(str(exc))
    print(report, end="")


if __name__ == "__main__":
    main()
