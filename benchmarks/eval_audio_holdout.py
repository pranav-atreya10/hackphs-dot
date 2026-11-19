"""Held-out check for the audio drone detector (NOT an official benchmark version).

    .venv/bin/python benchmarks/eval_audio_holdout.py --model VIVAN/detection/models/drone_audio_v0.json --out benchmarks/audio_holdout/v0.json
    .venv/bin/python benchmarks/eval_audio_holdout.py --model models/audio/v1_audio.pt --out benchmarks/audio_holdout/v1.json

The official pipeline (benchmark.py) can't score audio yet because the audio test sets were never frozen in
test_sets.json, and freezing them changes the manifest (needs Vivan's approval). This script uses the split the
project already documents, and never trains or tunes on it:
  - DADS shards 3 and 36 (never used for training):    drone recall and false-alarm rate per clip
  - ESC-50 folds 1-3 (training noise may only use 4-5): false alarms per category (helicopter, airplane, engine,
                                                         chirping birds, crow, wind, rain) and over all 1,200 clips
  - stress: drone test clips mixed with ESC-50 folds 1-3 wind / rain / engine at +10, +5, 0, -5, -10 dB SNR
A clip counts as "drone" if any 1 s window (0.5 s hop) reaches the threshold (0.5, as the browser uses).
95% CIs: 1,000 bootstrap resamples, percentile method, seed 0. DADS clips are cut from long recordings in order,
so DADS resamples blocks of 25 consecutive clips (not single clips); ESC-50 clips resample individually.
The model can be a PyTorch checkpoint (.pt) or the portable JSON the browser loads (export_audio_web.py).
"""

import argparse
import base64
import io
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench.audio import SR, MelFrontend, build_model, load_wav_bytes, mix_at_snr, windows  # noqa: E402
from bench.common import DATA, ROOT, sha256_file  # noqa: E402

TEST_SHARDS = [3, 36]
LOOKALIKES = ["helicopter", "airplane", "engine", "chirping_birds", "crow", "wind", "rain"]
STRESS_NOISE = ["wind", "rain", "engine"]
SNRS = [10, 5, 0, -5, -10]
THR = 0.5
BLOCK = 25


def load_model(path):
    """Returns (forward(wave_batch) -> probs, description). Works for .pt and portable .json weights."""
    import torch
    import torch.nn as nn
    path = Path(path)
    front = MelFrontend("cpu")
    if path.suffix == ".json":
        d = json.loads(path.read_text())
        f = lambda s: np.frombuffer(base64.b64decode(s), dtype="<f4")  # noqa: E731
        layers = []
        for c in d["conv"]:  # batch-norm already folded into each conv
            conv = nn.Conv2d(c["in"], c["out"], 3, padding=1)
            conv.weight.data = torch.tensor(f(c["w"]).reshape(c["out"], c["in"], 3, 3).copy())
            conv.bias.data = torch.tensor(f(c["b"]).copy())
            layers += [conv, nn.ReLU(), nn.MaxPool2d(2)]
        lin = nn.Linear(64, 1)
        lin.weight.data = torch.tensor(f(d["linear"]["w"]).reshape(1, 64).copy())
        lin.bias.data = torch.tensor([float(d["linear"]["b"])], dtype=torch.float32)
        model = nn.Sequential(*layers, nn.AdaptiveAvgPool2d(1), nn.Flatten(), lin).eval()
        norm = {"mean": d["frontend"]["norm_mean"], "std": d["frontend"]["norm_std"]}
    else:
        state = torch.load(path, map_location="cpu")
        model = build_model()
        model.load_state_dict(state["model"])
        model.eval()
        norm = state["norm"]

    def forward(wins):
        out = []
        with torch.no_grad():
            for i in range(0, len(wins), 256):
                x = torch.tensor(wins[i:i + 256])
                out.append(torch.sigmoid(model((front(x) - norm["mean"]) / norm["std"])).numpy().reshape(-1))
        return np.concatenate(out)

    if path.suffix == ".json":  # prove the rebuilt network matches the original on the stored reference signals
        from export_audio_web import reference_signals
        for name, y in reference_signals().items():
            got, want = float(forward(windows(y.astype(np.float32))[0])[0]), d["reference"][name]["prob"]
            assert abs(got - want) < 1e-3, f"portable weights mismatch on {name}: {got} vs {want}"
        print("portable JSON weights reproduce the reference outputs", flush=True)
    return forward


def detected(forward, y):
    wins, _ = windows(y)
    return bool(forward(wins).max() >= THR)


def ci(values, blocks=None, n_boot=1000, seed=0):
    """Mean with a 95% percentile bootstrap CI. blocks: list of index arrays resampled as units."""
    v = np.asarray(values, float)
    if len(v) == 0:
        return {"value": None, "ci": [None, None], "n": 0}
    rng = np.random.default_rng(seed)
    units = blocks if blocks is not None else [np.array([i]) for i in range(len(v))]
    stats = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(units), len(units))
        idx = np.concatenate([units[k] for k in pick])
        stats.append(v[idx].mean())
    lo, hi = np.percentile(stats, [2.5, 97.5])
    return {"value": round(float(v.mean()), 4), "ci": [round(float(lo), 4), round(float(hi), 4)], "n": int(len(v))}


def read_dads(i):
    import pyarrow.parquet as pq
    t = pq.read_table(DATA / "dads" / f"train-{i:05d}-of-00039.parquet")
    return [(load_wav_bytes(a["bytes"]), int(l)) for a, l in zip(t.column("audio").to_pylist(), t.column("label").to_pylist())]


def read_esc50(folds):
    import pyarrow.parquet as pq
    rows = []
    for f in sorted((DATA / "esc50").glob("*.parquet")):
        t = pq.read_table(f).to_pylist()
        rows += [r for r in t if r["fold"] in folds]
    return [(load_wav_bytes(r["audio"]["bytes"]), r["category"], r["filename"]) for r in sorted(rows, key=lambda r: r["filename"])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--stress_clips", type=int, default=300)
    a = ap.parse_args()
    forward = load_model(ROOT / a.model)

    # 1. DADS held-out shards
    res_drone, res_none, blocks_d, blocks_n = [], [], [], []
    drone_test = []
    for i in TEST_SHARDS:
        clips = read_dads(i)
        d0, n0 = len(res_drone), len(res_none)
        for y, l in clips:
            (res_drone if l == 1 else res_none).append(detected(forward, y))
            if l == 1:
                drone_test.append(y)
        blocks_d += [np.arange(s, min(s + BLOCK, len(res_drone))) for s in range(d0, len(res_drone), BLOCK)]
        blocks_n += [np.arange(s, min(s + BLOCK, len(res_none))) for s in range(n0, len(res_none), BLOCK)]
        print(f"shard {i}: {len(clips)} clips", flush=True)
    out = {"model": a.model, "model_sha256": sha256_file(ROOT / a.model), "threshold": THR,
           "dads_revision": (DATA / "dads" / "REVISION").read_text().strip(),
           "esc50_source": (DATA / "esc50" / "SOURCE").read_text().strip(),
           "dads_test": {"drone_recall": ci(res_drone, blocks_d), "false_alarm_rate": ci(res_none, blocks_n)}}
    print("DADS:", out["dads_test"], flush=True)

    # 2. ESC-50 folds 1-3: false alarms
    esc = read_esc50({1, 2, 3})
    fa = {c: [] for c in LOOKALIKES}
    fa_all = []
    for y, cat, _ in esc:
        hit = detected(forward, y)
        fa_all.append(hit)
        if cat in fa:
            fa[cat].append(hit)
    out["esc50_false_alarms"] = {"all_categories": ci(fa_all), **{c: ci(v) for c, v in fa.items()}}
    print("ESC-50 false alarms:", {k: v["value"] for k, v in out["esc50_false_alarms"].items()}, flush=True)

    # 3. Stress: drone test clips + held-out noise at fixed SNRs (fixed seed, same mixes for every model)
    rng = np.random.default_rng(0)
    noise = [y for y, cat, _ in esc if cat in STRESS_NOISE]
    pick = rng.choice(len(drone_test), min(a.stress_clips, len(drone_test)), replace=False)
    out["stress_recall"] = {}
    for snr in SNRS:
        mix_rng = np.random.default_rng(1000 + snr)
        hits = [detected(forward, mix_at_snr(drone_test[k], noise[mix_rng.integers(0, len(noise))], snr, mix_rng)) for k in pick]
        out["stress_recall"][f"{snr:+d}dB"] = ci(hits)
    print("stress recall:", {k: v["value"] for k, v in out["stress_recall"].items()}, flush=True)

    Path(ROOT / a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(ROOT / a.out).write_text(json.dumps(out, indent=1))
    print("wrote", a.out)


if __name__ == "__main__":
    main()
