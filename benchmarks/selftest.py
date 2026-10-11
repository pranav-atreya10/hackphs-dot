"""End-to-end self-test of the benchmark pipeline on tiny synthetic data, in a scratch folder.
Never touches benchmarks/results.csv or the real manifest.

    .venv/bin/python benchmarks/selftest.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PY = str(ROOT / ".venv" / "bin" / "python")


def main():
    work = Path(tempfile.mkdtemp(prefix="skysentry_selftest_"))
    bench, versions, data = work / "bench", work / "versions", work / "data"
    for d in (bench, versions, data / "img", data / "aud"):
        d.mkdir(parents=True)
    env = {**os.environ, "SKYSENTRY_BENCH_DIR": str(bench), "SKYSENTRY_VERSIONS_DIR": str(versions)}
    sys.path.insert(0, str(ROOT / "benchmarks"))
    import cv2
    import soundfile as sf
    import torch
    from bench.common import sha256_file
    from bench.audio import build_model, SR

    rng = np.random.default_rng(0)
    vis = []
    for i in range(16):
        img = np.full((320, 320, 3), (230, 190, 140), np.uint8)
        boxes = []
        for _ in range(rng.integers(1, 3)):
            cls = int(rng.integers(0, 2))
            s = int(rng.integers(6, 60))
            x, y = int(rng.integers(10, 300 - s)), int(rng.integers(10, 300 - s))
            cv2.ellipse(img, (x + s // 2, y + s // 2), (s // 2, max(2, s // 4)), 0, 0, 360, (40, 40, 40), -1)
            area = (s * s) / (320 * 320)
            boxes.append({"cls": cls, "x1": x / 320, "y1": y / 320, "x2": (x + s) / 320, "y2": (y + s) / 320,
                          "size_tag": "small" if area < 0.01 else "medium" if area < 0.1 else "large"})
        p = data / "img" / f"img{i}.jpg"
        cv2.imwrite(str(p), img)
        vis.append({"item_id": f"img{i}", "path": str(p), "sha256": sha256_file(p), "boxes": boxes,
                    "condition_tag": ["clear", "cloudy", "backlit", "cluttered"][i % 4]})

    def write(name, y):
        p = data / "aud" / f"{name}.wav"
        sf.write(p, y.astype(np.float32), SR)
        return p

    t = np.arange(3 * SR) / SR
    buzz = sum(np.sin(2 * np.pi * f * t) / (k + 1) for k, f in enumerate((180, 360, 540))) * 0.2
    aud, stress, look = [], [], []
    for i in range(10):
        lab = i % 2
        y = buzz + rng.normal(0, 0.02, len(t)) if lab else rng.normal(0, 0.05, 6 * SR)
        p = write(f"clip{i}", y)
        aud.append({"item_id": f"clip{i}", "path": str(p), "sha256": sha256_file(p), "tier": "dads_test" if lab or i < 6 else "ambient",
                    "label": lab, "seconds": len(y) / SR, "source": "dads_no_drone" if not lab else "dads", "snr_db": None, "noise_type": None})
    from bench.audio import mix_at_snr
    for nt in ("wind", "rain"):
        for snr in (10, 0, -10):
            for j in range(3):
                p = write(f"mix_{nt}_{snr}_{j}", mix_at_snr(buzz, rng.normal(0, 1, 5 * SR), snr, rng))
                stress.append({"item_id": p.stem, "path": str(p), "sha256": sha256_file(p), "tier": "stress", "label": 1,
                               "seconds": 3.0, "source": "mix", "snr_db": snr, "noise_type": nt})
    for j in range(2):
        p = write(f"heli{j}", rng.normal(0, 0.1, 5 * SR))
        look.append({"item_id": p.stem, "path": str(p), "sha256": sha256_file(p), "tier": "lookalike", "label": 0,
                     "seconds": 5.0, "source": "esc50_helicopter", "snr_db": None, "noise_type": None})
    manifest = {"created_utc": "selftest", "tiers": {"dataset": {"visual": {"items": vis}, "audio": {"items": aud}},
                                                    "stress": {"audio_mix": {"items": stress}, "audio_lookalike": {"items": look}}}}
    (bench / "test_sets.json").write_text(json.dumps(manifest))

    aw = work / "audio.pt"
    torch.save({"model": build_model().state_dict(), "norm": {"mean": 0.0, "std": 1.0}}, aw)
    for v, conf in (("v0", 0.25), ("v1", 0.5)):
        (versions / f"{v}.json").write_text(json.dumps({"visual_weights": str(ROOT / "models/pretrained/yolo11n.pt"), "imgsz": 320,
                                                        "visual_conf": conf, "audio_weights": str(aw), "audio_threshold": 0.5,
                                                        "audio_min_consecutive": 1}))

    def run(*args):
        r = subprocess.run([PY, *args], cwd=ROOT, env=env, capture_output=True, text=True)
        if r.returncode:
            print(r.stdout[-3000:], r.stderr[-3000:])
            raise SystemExit(f"FAILED: {' '.join(args)}")
        return r.stdout

    print(run("benchmarks/benchmark.py", "--version", "v0", "--hypothesis", "selftest baseline", "--n_boot", "50")[-600:])
    print(run("benchmarks/decide.py", "--version", "v0", "--keep", "--reason", "selftest"))
    print(run("benchmarks/benchmark.py", "--version", "v1", "--hypothesis", "selftest: raise visual conf to 0.5", "--n_boot", "50")[-400:])
    print(run("benchmarks/decide.py", "--version", "v1", "--revert", "--reason", "selftest revert"))
    # Refusals that must hold
    r = subprocess.run([PY, "benchmarks/benchmark.py", "--version", "v1", "--hypothesis", "again", "--n_boot", "50"], cwd=ROOT, env=env, capture_output=True, text=True)
    assert r.returncode != 0 and "never overwritten" in (r.stdout + r.stderr), "re-running a finished version must be refused"
    open(vis[0]["path"], "ab").write(b"x")  # tamper with a test file
    (versions / "v2.json").write_text((versions / "v1.json").read_text())
    r = subprocess.run([PY, "benchmarks/benchmark.py", "--version", "v2", "--hypothesis", "tampered", "--n_boot", "50"], cwd=ROOT, env=env, capture_output=True, text=True)
    assert r.returncode != 0 and "verification FAILED" in (r.stdout + r.stderr), "a changed test file must stop the run"
    print(run("benchmarks/make_charts.py"))
    print(run("benchmarks/report.py", "--version", "v1"))
    charts = sorted(p.name for p in (bench / "charts").glob("*.png"))
    must = ["v0/predictions.parquet", "v0/metrics.json", "v0/run.json", "v1/report.html", "results.csv", "CHANGELOG.md", "SUMMARY.md"]
    missing = [m for m in must if not (bench / m).exists()]
    assert not missing, missing
    rows = (bench / "results.csv").read_text().strip().splitlines()
    assert len(rows) == 5, f"expected header + 2 runs + 2 decisions, got {len(rows)}"
    print("charts:", charts)
    print(f"SELFTEST PASSED (scratch: {work})")
    if "--keep" not in sys.argv:
        shutil.rmtree(work)


if __name__ == "__main__":
    main()
