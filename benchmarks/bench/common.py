"""Shared helpers: paths, hashing, run records, the append-only results log."""

import csv
import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]          # repo root
# SKYSENTRY_BENCH_DIR redirects every output (results.csv, vN/, charts, manifest) to a scratch folder.
# Used only by selftest.py, so pipeline tests never touch the real append-only results.
BENCH = Path(os.environ.get("SKYSENTRY_BENCH_DIR", ROOT / "benchmarks"))
DATA = ROOT / "data"
MODELS = ROOT / "models"
VERSIONS = Path(os.environ.get("SKYSENTRY_VERSIONS_DIR", MODELS / "versions"))  # vN.json = one version's config
RESULTS_CSV = BENCH / "results.csv"
CHANGELOG = BENCH / "CHANGELOG.md"
MANIFEST = BENCH / "test_sets.json"

# Fixed columns of results.csv. Every metric (with CI) goes in metrics_json, so new metrics in later
# versions never require rewriting the header of an append-only file.
RESULT_COLUMNS = [
    "row_type", "version", "timestamp_utc", "hypothesis", "decision", "reason",
    "final_run", "git_commit", "git_dirty", "manifest_sha256",
    "visual_drone_recall", "visual_drone_recall_lo", "visual_drone_recall_hi",
    "visual_fa_rate", "visual_fa_rate_lo", "visual_fa_rate_hi",
    "audio_drone_recall", "audio_drone_recall_lo", "audio_drone_recall_hi",
    "audio_fa_per_hour", "audio_fa_per_hour_lo", "audio_fa_per_hour_hi",
    "weights_json", "thresholds_json", "hardware_json", "metrics_json",
]


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def git_info():
    def run(*args):
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    dirty = bool(run("status", "--porcelain", "--untracked-files=no"))
    return {"commit": run("rev-parse", "HEAD"), "branch": run("rev-parse", "--abbrev-ref", "HEAD"), "dirty": dirty}


def hardware_info():
    info = {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": sys.version.split()[0],
    }
    if sys.platform == "darwin":
        def sysctl(key):
            return subprocess.run(["sysctl", "-n", key], capture_output=True, text=True).stdout.strip()
        info["cpu"] = sysctl("machdep.cpu.brand_string")
        info["ram_gb"] = round(int(sysctl("hw.memsize") or 0) / 2**30, 1)
    try:
        import torch
        info["torch"] = torch.__version__
        info["accelerator"] = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    except ImportError:
        pass
    for mod in ("ultralytics", "numpy", "librosa", "sklearn"):
        try:
            info[mod] = __import__(mod).__version__
        except Exception:
            pass
    return info


def pick_device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def rel(path):
    """Repo-relative path when inside the repo, absolute otherwise."""
    path = Path(path)
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def load_version_config(version):
    path = VERSIONS / f"{version}.json"
    if not path.exists():
        raise SystemExit(f"No config for {version}: create {rel(path)} first (one change per version).")
    cfg = json.loads(path.read_text())
    cfg["_config_path"] = rel(path)
    cfg["_config_sha256"] = sha256_file(path)
    return cfg


def weight_hashes(cfg):
    out = {}
    for key in ("visual_weights", "audio_weights"):
        p = cfg.get(key)
        if p:
            full = ROOT / p
            out[key] = {"path": p, "sha256": sha256_file(full) if full.exists() else "MISSING"}
    return out


def version_dir(version, create=True):
    d = BENCH / version
    if create:
        finished = (d / "run.json").exists() or any(r["row_type"] == "run" and r["version"] == version for r in read_results())
        if finished:
            raise SystemExit(f"benchmarks/{version}/ already has a finished run. Outputs are never overwritten: use a new version number.")
        # A crashed run left no result row and no run.json; its partial files may be replaced.
        d.mkdir(parents=True, exist_ok=True)
        (d / "errors").mkdir(exist_ok=True)
    return d


def append_result(row):
    """Append one row to results.csv. Never rewrites or removes existing rows."""
    new_file = not RESULTS_CSV.exists()
    with open(RESULTS_CSV, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=RESULT_COLUMNS, extrasaction="raise")
        if new_file:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in RESULT_COLUMNS})


def read_results():
    if not RESULTS_CSV.exists():
        return []
    with open(RESULTS_CSV, newline="") as f:
        return list(csv.DictReader(f))


def now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def dumps(obj):
    return json.dumps(obj, sort_keys=True, default=float)
