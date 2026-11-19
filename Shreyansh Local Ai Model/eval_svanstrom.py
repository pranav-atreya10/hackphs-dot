"""Score a checkpoint on the Svanström TEST clips (never trained on, never used to pick epochs).

    python3 eval_svanstrom.py --checkpoint runs/v3/best.pt --out results/v3

Reports bird recall, drone recall and the false-alarm rate (planes, helicopters and empty sky called bird
or drone), split by object size in pixels (longest box side at the camera's 640x512):
  under 7 px | 7-15 px | over 15 px | 7 px and up
Targets set by the user: >= 95% for 7 px and up, 99-100% for over 15 px.
Confidence intervals: 95%, 1,000 bootstrap resamples of whole CLIPS (frames of one clip are near-copies,
so resampling frames would give falsely narrow intervals), seed 0.
The YouTube-sourced clips (planes / helicopters only) are reported separately as a false-alarm test.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_metrics import rate  # noqa: E402
from model import SkyNetLite  # noqa: E402
from train import norm, to_tensor  # noqa: E402

HERE = Path(__file__).resolve().parent
V3 = HERE.parent / "data" / "shreyansh_crops_v3"
BINS = [("under 7 px", 0, 7), ("7-15 px", 7, 15), ("over 15 px", 15, 1e9), ("7 px and up", 7, 1e9), ("all sizes", 0, 1e9)]


def predict(ckpt, X):
    m = SkyNetLite()
    sd = torch.load(ckpt, weights_only=False)
    m.load_state_dict(sd["model"] if "model" in sd else sd)
    m.eval()
    out = []
    with torch.no_grad():  # full float32, like the browser
        for i in range(0, len(X), 512):
            out.append(m(norm(to_tensor(np.ascontiguousarray(X[i:i + 512, 0])))).argmax(1))
    return torch.cat(out).numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--set", default="test", choices=["test", "shrunk"],
                    help="test = real sizes; shrunk = same test clips with every object made exactly 7, 10 or 13 px")
    a = ap.parse_args()
    X = np.load(V3 / f"svan_{a.set}_X.npy", mmap_mode="r")
    meta = np.load(V3 / f"svan_{a.set}_meta.npz")
    global BINS
    if a.set == "shrunk":
        BINS = [("7 px", 7, 8), ("10 px", 10, 11), ("13 px", 13, 14), ("7 px and up", 7, 1e9)]
    y, size, clip, yt = meta["y"], meta["size"], meta["clip"], meta["youtube"]
    from_youtube = yt[clip]
    p = predict(a.checkpoint, X)
    res = {"checkpoint": a.checkpoint, "checkpoint_sha256": hashlib.sha256(Path(a.checkpoint).read_bytes()).hexdigest(),
           "test_clips": [str(c) for c in meta["clip_names"]], "by_size": {}, "youtube_false_alarm": None}
    own = ~from_youtube
    for name, lo, hi in BINS:
        s = own & (size >= lo) & (size < hi)
        res["by_size"][name] = {
            "bird_recall": rate(s & (y == 0) & (p == 0), s & (y == 0), clip),
            "drone_recall": rate(s & (y == 1) & (p == 1), s & (y == 1), clip),
            "bird_or_drone_correct": rate(s & (y < 2) & (p == y), s & (y < 2), clip),
            "birds_called_drone": rate(s & (y == 0) & (p == 1), s & (y == 0), clip),
            "drones_called_bird": rate(s & (y == 1) & (p == 0), s & (y == 1), clip),
            "false_alarm_rate": rate(s & (y == 2) & (p < 2), s & (y == 2), clip),
        }
    res["youtube_false_alarm"] = rate(from_youtube & (y == 2) & (p < 2), from_youtube & (y == 2), clip)
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    (out / f"svanstrom_{a.set}.json").write_text(json.dumps(res, indent=1))
    f = lambda r: "n/a" if not r else f"{100 * r['value']:.1f}% ({100 * r['ci95'][0]:.1f}-{100 * r['ci95'][1]:.1f}), n={r['n']} in {r['clips']} clips"  # noqa: E731
    lines = ["| Size | Bird recall | Drone recall | Birds+drones correct | False alarms (planes, helicopters, sky) |", "|---|---|---|---|---|"]
    for name, *_ in BINS:
        b = res["by_size"][name]
        lines.append(f"| {name} | {f(b['bird_recall'])} | {f(b['drone_recall'])} | {f(b['bird_or_drone_correct'])} | {f(b['false_alarm_rate'])} |")
    lines.append(f"\nYouTube planes/helicopters called bird or drone: {f(res['youtube_false_alarm'])}")
    title = "real sizes" if a.set == "test" else "every object shrunk to exactly 7 / 10 / 13 px (simulated distance)"
    (out / f"svanstrom_{a.set}.md").write_text(f"# Svanström test clips: {title}\n\n" + "\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
