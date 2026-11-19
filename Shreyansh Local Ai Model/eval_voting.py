"""Track-level accuracy: vote over several frames of the same object instead of trusting one crop.

    python3 eval_voting.py --checkpoint runs/v4/best.pt --out results/v4 --window 5

In the live app every bird or drone is tracked across many frames, so the app can label a TRACK by the
majority of its last N per-frame answers (averaging the model's probabilities). This measures that on the
two VIDEO test sets, where crops come from consecutive frames of one object:
  - Svanström test clips (one object per clip; crops every 3rd frame, so a window of 5 spans ~0.5 s of video)
  - FBD-SV-2024 (never-seen source; frames every 10th, so 5 crops span ~1.7 s)
A window = N consecutive crops of the same clip and class (for FBD-SV: same video; birds of a video are
treated as one track, which is approximate when several birds are in view). Background crops vote the same way.
Reported: per-window accuracy for birds, drones and false alarms, with clip-bootstrap 95% CIs.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_svanstrom import rate  # noqa: E402
from model import SkyNetLite  # noqa: E402
from train import norm, to_tensor  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"


def probs(ckpt, X):
    m = SkyNetLite(); sd = torch.load(ckpt, weights_only=False); m.load_state_dict(sd["model"] if "model" in sd else sd); m.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(X), 512):
            out.append(torch.softmax(m(norm(to_tensor(np.ascontiguousarray(X[i:i + 512, 0])))), 1))
    return torch.cat(out).numpy()


def windows(y, grp, keep, n):
    """Consecutive runs of n crops with the same group and class (crops are stored in frame order)."""
    # each frame stores its object crop and its background crop next to each other, so collect each
    # (group, class) in frame order first, then cut it into runs of n
    out, runs = [], {}
    for i in np.nonzero(keep)[0]:
        runs.setdefault((grp[i], y[i]), []).append(i)
    for run in runs.values():
        out += [run[k:k + n] for k in range(0, len(run) - n + 1, n)]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--window", type=int, default=5)
    a = ap.parse_args()
    sets = []
    m = np.load(DATA / "shreyansh_crops_v3" / "svan_test_meta.npz")
    yt = m["youtube"][m["clip"]]
    sets.append(("svanstrom (real size)", DATA / "shreyansh_crops_v3" / "svan_test_X.npy", m["y"], m["clip"], ~yt))
    sets.append(("svanstrom YouTube planes/helicopters", DATA / "shreyansh_crops_v3" / "svan_test_X.npy", m["y"], m["clip"], yt))
    m = np.load(DATA / "shreyansh_crops_v3" / "svan_shrunk_meta.npz")
    yt = m["youtube"][m["clip"]]
    for px in (7, 10, 13):
        sets.append((f"svanstrom shrunk {px} px", DATA / "shreyansh_crops_v3" / "svan_shrunk_X.npy", m["y"], m["clip"], ~yt & (m["size"] == px)))
    f = DATA / "shreyansh_crops_v4" / "fbdsv2024_testonly_test_meta.npz"
    if f.exists():
        m = np.load(f)
        sets.append(("FBD-SV (never-seen source)", DATA / "shreyansh_crops_v4" / "fbdsv2024_testonly_test_X.npy", m["y"], np.unique(m["group"], return_inverse=True)[1], np.ones(len(m["y"]), bool)))
    res, lines = {}, ["| Test set | Birds: 1 frame | Birds: vote of N | Drones: 1 frame | Drones: vote of N | False alarms: 1 frame | False alarms: vote of N |", "|---|---|---|---|---|---|---|"]
    fmt = lambda r: "n/a" if not r else f"{100 * r['value']:.1f}% ({100 * r['ci95'][0]:.0f}-{100 * r['ci95'][1]:.0f})"  # noqa: E731
    cache = {}
    for name, path, y, grp, keep in sets:
        if path not in cache:
            cache[path] = probs(a.checkpoint, np.load(path, mmap_mode="r"))
        P = cache[path]
        p1 = P.argmax(1)
        win = windows(y, grp, keep, a.window)
        wy = np.array([y[w[0]] for w in win]); wg = np.array([grp[w[0]] for w in win])
        wp = np.array([P[w].mean(0).argmax() for w in win]) if win else np.array([])
        row = {}
        for c, key in ((0, "bird"), (1, "drone")):
            row[f"{key}_single"] = rate(keep & (y == c) & (p1 == c), keep & (y == c), grp)
            row[f"{key}_vote"] = rate((wy == c) & (wp == c), wy == c, wg) if len(win) else None
        row["false_alarm_single"] = rate(keep & (y == 2) & (p1 < 2), keep & (y == 2), grp)
        row["false_alarm_vote"] = rate((wy == 2) & (wp < 2), wy == 2, wg) if len(win) else None
        res[name] = row
        lines.append(f"| {name} | {fmt(row['bird_single'])} | {fmt(row['bird_vote'])} | {fmt(row['drone_single'])} | {fmt(row['drone_vote'])} | {fmt(row['false_alarm_single'])} | {fmt(row['false_alarm_vote'])} |")
        print(lines[-1], flush=True)
    d = Path(a.out); d.mkdir(parents=True, exist_ok=True)
    (d / f"voting_{a.window}.json").write_text(json.dumps(res, indent=1))
    (d / f"voting_{a.window}.md").write_text(f"# Vote of {a.window} consecutive crops per track vs 1 crop\n\n" + "\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
