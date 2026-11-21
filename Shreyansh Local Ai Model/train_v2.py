"""Train v2 on the crops from prepare_v2.py (one-step crops + realistic tiny versions).

    python3 train_v2.py --name v2 --epochs 20 --minutes 100     # resumable, like train.py

Differences from train.py (v1), all bundled into v2 at the user's request:
  - crops already match the live app (cut in one step), so no extra resampling here except mirroring
  - each epoch uses one of each sample's 3 versions at random: [jittered, jittered, tiny]
  - stronger motion blur: half the crops, streaks 3-15 px (v1: a third, 3-9 px)
  - "far away" shrink of the crop kept but milder (a quarter of crops), since real tiny versions exist now
  - 20 epochs (v1: 12)
The best epoch is picked on the holdout's normal crops; the holdout's tiny crops are reported too.
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
from crops import INPUT  # noqa: E402
from model import SkyNetLite, count_params  # noqa: E402
from train import fast, make_blur_bank, norm, to_tensor  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data" / "shreyansh_crops_v2"
BLUR_BANK_V2 = torch.cat([make_blur_bank(15)[:, :, :]], 0)  # lengths 3..9 on a 15 px grid
_long = []
for length in range(10, 16):  # add longer streaks 10..15 px
    for a in range(16):
        ang = math.pi * a / 16
        t = torch.linspace(-7, 7, 60)
        pts = t[t.abs() <= length / 2]
        ker = torch.zeros(15, 15)
        ker[(pts * math.sin(ang)).round().long() + 7, (pts * math.cos(ang)).round().long() + 7] = 1
        _long.append(ker / ker.sum())
BLUR_BANK_V2 = torch.cat([BLUR_BANK_V2, torch.stack(_long)], 0)


def augment(x, g):
    n = len(x)
    rnd = lambda *s: torch.rand(*s, generator=g)  # noqa: E731
    flip = rnd(n) < 0.5
    x[flip] = x[flip].flip(-1)
    far = (rnd(n) < 0.25).nonzero().flatten()
    for j, size in enumerate((8, 12, 16, 24)):
        idx = far[torch.arange(len(far)) % 4 == j]
        if len(idx):
            x[idx] = F.interpolate(F.interpolate(x[idx], size=size, mode="area"), size=INPUT, mode="bilinear", align_corners=False)
    blur = (rnd(n) < 0.5).nonzero().flatten()
    if len(blur):
        k = BLUR_BANK_V2.shape[-1]
        ker = BLUR_BANK_V2[(rnd(len(blur)) * len(BLUR_BANK_V2)).long()].repeat_interleave(3, 0).unsqueeze(1)
        xb = x[blur].reshape(1, -1, INPUT, INPUT)
        xb = F.conv2d(F.pad(xb, (k // 2,) * 4, mode="replicate"), ker, groups=xb.shape[1])
        x[blur] = xb.reshape(len(blur), 3, INPUT, INPUT)
    bright = 0.7 + 0.6 * rnd(n, 1, 1, 1)
    contrast = 0.7 + 0.6 * rnd(n, 1, 1, 1)
    mean = x.mean(dim=(1, 2, 3), keepdim=True)
    x = (x - mean) * contrast + mean * bright
    x = x * (0.9 + 0.2 * rnd(n, 3, 1, 1))
    grey = rnd(n) < 0.1
    x[grey] = x[grey].mean(dim=1, keepdim=True).expand(-1, 3, -1, -1)
    x = x + torch.randn(x.shape, generator=g) * (0.03 * rnd(n, 1, 1, 1))
    return x.clamp_(0, 1)


@torch.no_grad()
def evaluate(model, X, y, version, batch=1024):
    model.eval()
    preds = []
    for i in range(0, len(y), batch):
        with fast():
            preds.append(model(norm(to_tensor(np.ascontiguousarray(X[i:i + batch, version])))).float().argmax(1))
    p = torch.cat(preds).numpy()
    rec = [float((p[y == c] == c).mean()) for c in range(3)]
    return {"accuracy": float((p == y).mean()), "balanced_accuracy": float(np.mean(rec)),
            "recall_bird": rec[0], "recall_drone": rec[1], "recall_other": rec[2],
            "bird_as_drone": float((p[y == 0] == 1).mean()), "drone_as_bird": float((p[y == 1] == 0).mean())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="v2")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--minutes", type=float, default=100)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    torch.set_num_threads(2)
    run = HERE / "runs" / a.name
    run.mkdir(parents=True, exist_ok=True)
    Xtr, ytr = np.load(DATA / "fit_X.npy", mmap_mode="r"), np.load(DATA / "fit_y.npy")
    Xva, yva = np.load(DATA / "holdout_X.npy", mmap_mode="r"), np.load(DATA / "holdout_y.npy")
    tiny_idx = np.load(DATA / "holdout_tiny_idx.npy")  # holdout objects that end up <= 12 px in their tiny version
    Xti, yti = np.ascontiguousarray(Xva[tiny_idx]), yva[tiny_idx]
    counts = np.bincount(ytr, minlength=3)
    weights = torch.tensor(counts.sum() / (3 * counts), dtype=torch.float32)
    steps_per_epoch = math.ceil(len(ytr) / a.batch)
    torch.manual_seed(a.seed)
    model = SkyNetLite().to(memory_format=torch.channels_last)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=5e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * steps_per_epoch, pct_start=0.15)
    state = {"epoch": 0, "step": 0, "best": -1.0, "history": []}
    ckpt = run / "last.pt"
    if ckpt.exists():
        c = torch.load(ckpt, weights_only=False)
        model.load_state_dict(c["model"]); opt.load_state_dict(c["opt"]); sched.load_state_dict(c["sched"])
        state = c["state"]
        print(f"resuming at epoch {state['epoch']} step {state['step']}")
    else:
        print(f"{count_params(model):,} parameters; fit {counts.tolist()} (bird, drone, other) x {Xtr.shape[1]} versions; holdout {np.bincount(yva).tolist()}")
    started = time.time()
    while state["epoch"] < a.epochs:
        e = state["epoch"]
        rng = np.random.default_rng(a.seed + e)
        order = rng.permutation(len(ytr))
        version = rng.integers(0, Xtr.shape[1], len(ytr))
        g = torch.Generator().manual_seed(a.seed * 1000 + e * 100000 + state["step"])
        model.train()
        loss_sum, seen = 0.0, 0
        for s in range(state["step"], steps_per_epoch):
            idx = np.sort(order[s * a.batch:(s + 1) * a.batch])
            x = norm(augment(to_tensor(np.ascontiguousarray(Xtr[idx, version[idx]])), g))
            yb = torch.from_numpy(ytr[idx])
            with fast():
                logits = model(x)
            loss = F.cross_entropy(logits.float(), yb, weight=weights, label_smoothing=0.05)
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step()
            loss_sum += float(loss.detach()) * len(idx); seen += len(idx)
            state["step"] = s + 1
            if time.time() - started > a.minutes * 60:
                torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "state": state}, ckpt)
                print(f"time budget used: paused in epoch {e + 1} at step {s + 1}/{steps_per_epoch}")
                return
        m = evaluate(model, Xva, yva, 0)
        tiny = evaluate(model, Xti, yti, 1)
        m.update(epoch=e + 1, train_loss=loss_sum / max(seen, 1), tiny_le12px={k: tiny[k] for k in ("recall_bird", "recall_drone", "bird_as_drone", "drone_as_bird")})
        state["history"].append(m)
        state["epoch"], state["step"] = e + 1, 0
        if m["balanced_accuracy"] > state["best"]:
            state["best"] = m["balanced_accuracy"]
            torch.save({"model": model.state_dict(), "epoch": e + 1, "valid": m, "seed": a.seed, "args": vars(a)}, run / "best.pt")
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "state": state}, ckpt)
        (run / "history.json").write_text(json.dumps(state["history"], indent=1))
        print(f"epoch {e + 1}/{a.epochs}  loss {m['train_loss']:.3f}  holdout balanced {m['balanced_accuracy']:.4f}  "
              f"bird {m['recall_bird']:.3f} drone {m['recall_drone']:.3f} other {m['recall_other']:.3f}  |  "
              f"tiny<=12px: bird {tiny['recall_bird']:.3f} drone {tiny['recall_drone']:.3f}  "
              f"[{time.time() - started:.0f}s]", flush=True)
    print("done; best holdout balanced accuracy", round(state["best"], 4))


if __name__ == "__main__":
    main()
