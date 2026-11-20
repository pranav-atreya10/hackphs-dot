"""v3: fine-tune v2 on Mendeley + Svanström (real distant birds, drones, planes, helicopters).

    python3 train_v3.py --name v3 --init runs/v2/best.pt --epochs 10 --minutes 100   # resumable

- starts from v2's weights (faster than from scratch)
- each epoch: all Mendeley fit samples + every Svanström train sample twice (they are the distant,
  airport-like examples), one random version of each [jittered, jittered, tiny]
- best epoch picked on the mean of: Mendeley holdout balanced accuracy and Svanström SELECT balanced
  accuracy (clips never used in training). The Svanström TEST clips are never looked at here.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import SkyNetLite  # noqa: E402
from train import fast, norm, to_tensor  # noqa: E402
from train_v2 import augment, evaluate  # noqa: E402

HERE = Path(__file__).resolve().parent
V2 = HERE.parent / "data" / "shreyansh_crops_v2"
V3 = HERE.parent / "data" / "shreyansh_crops_v3"


def size_recall(model, X, y, size, lo, hi):
    sel = np.nonzero((y < 2) & (size >= lo) & (size < hi))[0]
    if not len(sel):
        return None
    model.eval()
    with torch.no_grad(), fast():
        p = torch.cat([model(norm(to_tensor(np.ascontiguousarray(X[sel[i:i + 1024], 0])))).float().argmax(1)
                       for i in range(0, len(sel), 1024)]).numpy()
    return float((p == y[sel]).mean()), len(sel)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="v3")
    ap.add_argument("--init", default=str(HERE / "runs" / "v2" / "best.pt"))
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--minutes", type=float, default=100)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1.5e-3)
    ap.add_argument("--seed", type=int, default=43)
    a = ap.parse_args()
    torch.set_num_threads(2)
    run = HERE / "runs" / a.name
    run.mkdir(parents=True, exist_ok=True)
    Xm, ym = np.load(V2 / "fit_X.npy", mmap_mode="r"), np.load(V2 / "fit_y.npy")
    Xs = np.load(V3 / "svan_train_X.npy", mmap_mode="r")
    ys = np.load(V3 / "svan_train_meta.npz")["y"]
    Xmh, ymh = np.load(V2 / "holdout_X.npy", mmap_mode="r"), np.load(V2 / "holdout_y.npy")
    Xsel = np.load(V3 / "svan_select_X.npy", mmap_mode="r")
    msel = np.load(V3 / "svan_select_meta.npz")
    ysel, ssel = msel["y"], msel["size"]
    # One index space: Mendeley samples first, then Svanström samples listed twice.
    src = np.concatenate([np.zeros(len(ym), int), np.ones(2 * len(ys), int)])
    loc = np.concatenate([np.arange(len(ym)), np.arange(len(ys)), np.arange(len(ys))])
    yall = np.concatenate([ym, ys, ys])
    counts = np.bincount(yall, minlength=3)
    weights = torch.tensor(counts.sum() / (3 * counts), dtype=torch.float32)
    steps = math.ceil(len(yall) / a.batch)
    torch.manual_seed(a.seed)
    model = SkyNetLite().to(memory_format=torch.channels_last)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=5e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * steps, pct_start=0.1)
    state = {"epoch": 0, "step": 0, "best": -1.0, "history": []}
    ckpt = run / "last.pt"
    if ckpt.exists():
        c = torch.load(ckpt, weights_only=False)
        model.load_state_dict(c["model"]); opt.load_state_dict(c["opt"]); sched.load_state_dict(c["sched"]); state = c["state"]
        print(f"resuming at epoch {state['epoch']} step {state['step']}")
    else:
        model.load_state_dict(torch.load(a.init, weights_only=False)["model"])
        print(f"start from {a.init}; samples per epoch {len(yall)} (bird, drone, other = {counts.tolist()}); "
              f"Svanström train {len(ys)} x2, select {len(ysel)}")
    started = time.time()
    while state["epoch"] < a.epochs:
        e = state["epoch"]
        rng = np.random.default_rng(a.seed + e)
        order = rng.permutation(len(yall))
        version = rng.integers(0, 3, len(yall))
        g = torch.Generator().manual_seed(a.seed * 1000 + e * 100000 + state["step"])
        model.train()
        loss_sum, seen = 0.0, 0
        for s in range(state["step"], steps):
            idx = order[s * a.batch:(s + 1) * a.batch]
            parts = []
            for which, X in ((0, Xm), (1, Xs)):
                k = idx[src[idx] == which]
                if len(k):
                    o = np.argsort(loc[k])
                    parts.append((k[o], X[loc[k][o], version[k][o]]))
            kk = np.concatenate([p[0] for p in parts])
            x = norm(augment(to_tensor(np.ascontiguousarray(np.concatenate([p[1] for p in parts]))), g))
            yb = torch.from_numpy(yall[kk])
            with fast():
                logits = model(x)
            loss = F.cross_entropy(logits.float(), yb, weight=weights, label_smoothing=0.05)
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step()
            loss_sum += float(loss.detach()) * len(kk); seen += len(kk)
            state["step"] = s + 1
            if time.time() - started > a.minutes * 60:
                torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "state": state}, ckpt)
                print(f"time budget used: paused in epoch {e + 1} at step {s + 1}/{steps}")
                return
        mh = evaluate(model, Xmh, ymh, 0)
        ms = evaluate(model, Xsel, ysel, 0)
        bins = {f"{lo}-{hi}px": size_recall(model, Xsel, ysel, ssel, lo, hi) for lo, hi in ((0, 7), (7, 15), (15, 9999))}
        score = (mh["balanced_accuracy"] + ms["balanced_accuracy"]) / 2
        state["history"].append({"epoch": e + 1, "train_loss": loss_sum / max(seen, 1), "mendeley_holdout": mh, "svan_select": ms,
                                 "svan_select_bird_drone_recall_by_size": bins, "score": score})
        state["epoch"], state["step"] = e + 1, 0
        if score > state["best"]:
            state["best"] = score
            torch.save({"model": model.state_dict(), "epoch": e + 1, "score": score, "seed": a.seed, "args": vars(a)}, run / "best.pt")
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "state": state}, ckpt)
        (run / "history.json").write_text(json.dumps(state["history"], indent=1))
        b = "  ".join(f"{k}: {v[0]:.3f} (n={v[1]})" for k, v in bins.items() if v)
        print(f"epoch {e + 1}/{a.epochs}  loss {loss_sum / max(seen, 1):.3f}  mendeley holdout {mh['balanced_accuracy']:.4f}  "
              f"svan select {ms['balanced_accuracy']:.4f} (bird {ms['recall_bird']:.3f} drone {ms['recall_drone']:.3f} other {ms['recall_other']:.3f})  "
              f"| bird+drone by size: {b}  [{time.time() - started:.0f}s]", flush=True)
    print("done; best score", round(state["best"], 4))


if __name__ == "__main__":
    main()
