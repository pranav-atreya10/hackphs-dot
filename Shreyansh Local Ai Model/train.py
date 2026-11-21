"""Train SkyNetLite on the crops from prepare_data.py.

    python3 train.py --epochs 18 --minutes 9     # resumable: run again to continue where it stopped

Each run trains until the time budget is used up, saves a checkpoint, and picks up from it next time.
The best epoch (by balanced accuracy on the holdout crops from make_split.py) is saved as runs/<name>/best.pt.
The frozen test split is never touched here.

Training-time changes to each crop ("augmentation"), so the model copes with real camera footage:
  - box jitter: the crop is shifted and resized a bit, like an imperfect tracker box
  - far away: some crops are shrunk to 6-24 px and blown back up, like a tiny distant bird
  - fast motion: some crops get motion blur in a random direction, like a bird flying fast
  - mirror image, small tilt, brightness / contrast / colour changes, sensor noise, some greyscale
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
from crops import INPUT, STORE_SCALE  # noqa: E402
from model import MEAN, STD, SkyNetLite, count_params  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data" / "shreyansh_crops"
MEAN_T = torch.tensor(MEAN).view(1, 3, 1, 1)
STD_T = torch.tensor(STD).view(1, 3, 1, 1)


def make_blur_bank(k=9):
    """Motion-blur streaks: lengths 3..9 px at 16 directions, each normalised to sum to 1."""
    bank = []
    t = torch.linspace(-(k // 2), k // 2, 4 * k)
    for length in range(3, 10):
        for a in range(16):
            ang = math.pi * a / 16
            pts = t[t.abs() <= length / 2]
            ker = torch.zeros(k, k)
            ker[(pts * math.sin(ang)).round().long() + k // 2, (pts * math.cos(ang)).round().long() + k // 2] = 1
            bank.append(ker / ker.sum())
    return torch.stack(bank)


BLUR_BANK = make_blur_bank()


def to_tensor(x_uint8):
    return torch.from_numpy(x_uint8).permute(0, 3, 1, 2).float().div_(255)


def centre_view(x):
    """The live crop is the centre 1/STORE_SCALE of each stored crop, resized to INPUT."""
    theta = torch.zeros(len(x), 2, 3)
    theta[:, 0, 0] = theta[:, 1, 1] = 1 / STORE_SCALE
    grid = F.affine_grid(theta, (len(x), 3, INPUT, INPUT), align_corners=False)
    return F.grid_sample(x, grid, mode="bilinear", padding_mode="border", align_corners=False)


def augment(x, g):
    n = len(x)
    rnd = lambda *s: torch.rand(*s, generator=g)  # noqa: E731
    # Box jitter, mirror and small tilt in one resampling step.
    scale = (0.8 + 0.45 * rnd(n)) / STORE_SCALE            # live square x 0.8 .. 1.25
    angle = (rnd(n) - 0.5) * math.radians(30)
    flip = torch.where(rnd(n) < 0.5, -1.0, 1.0)
    shift = (rnd(n, 2) - 0.5) * 0.2 * scale.unsqueeze(1) * 2
    theta = torch.zeros(n, 2, 3)
    theta[:, 0, 0] = scale * torch.cos(angle) * flip
    theta[:, 0, 1] = -scale * torch.sin(angle)
    theta[:, 1, 0] = scale * torch.sin(angle) * flip
    theta[:, 1, 1] = scale * torch.cos(angle)
    theta[:, :, 2] = shift
    grid = F.affine_grid(theta, (n, 3, INPUT, INPUT), align_corners=False)
    x = F.grid_sample(x, grid, mode="bilinear", padding_mode="border", align_corners=False)
    # Far away: shrink a third of the crops to 6..24 px and enlarge again.
    far = (rnd(n) < 0.33).nonzero().flatten()
    for j, size in enumerate((6, 10, 16, 24)):
        idx = far[torch.arange(len(far)) % 4 == j]
        if len(idx):
            small = F.interpolate(x[idx], size=size, mode="area")
            x[idx] = F.interpolate(small, size=INPUT, mode="bilinear", align_corners=False)
    # Fast motion: blur a third of the crops along a random direction (3..9 px streak).
    blur = (rnd(n) < 0.33).nonzero().flatten()
    if len(blur):
        k = BLUR_BANK.shape[-1]
        ker = BLUR_BANK[(rnd(len(blur)) * len(BLUR_BANK)).long()].repeat_interleave(3, 0).unsqueeze(1)
        xb = x[blur].reshape(1, -1, INPUT, INPUT)
        xb = F.conv2d(F.pad(xb, (k // 2,) * 4, mode="replicate"), ker, groups=xb.shape[1])
        x[blur] = xb.reshape(len(blur), 3, INPUT, INPUT)
    # Lighting and colour.
    bright = 0.7 + 0.6 * rnd(n, 1, 1, 1)
    contrast = 0.7 + 0.6 * rnd(n, 1, 1, 1)
    mean = x.mean(dim=(1, 2, 3), keepdim=True)
    x = (x - mean) * contrast + mean * bright
    x = x * (0.9 + 0.2 * rnd(n, 3, 1, 1))
    grey = rnd(n) < 0.1
    x[grey] = x[grey].mean(dim=1, keepdim=True).expand(-1, 3, -1, -1)
    x = x + torch.randn(x.shape, generator=g) * (0.03 * rnd(n, 1, 1, 1))
    return x.clamp_(0, 1)


def norm(x):
    # channels_last + bfloat16 lets the CPU's AMX units do the convolutions (~6x faster on this Xeon).
    return ((x - MEAN_T) / STD_T).contiguous(memory_format=torch.channels_last)


def fast():
    """Mixed precision: weights stay float32, the maths inside each step uses bfloat16."""
    return torch.autocast("cpu", dtype=torch.bfloat16)


@torch.no_grad()
def evaluate(model, X, y, batch=1024):
    model.eval()
    preds = []
    for i in range(0, len(X), batch):
        with fast():
            preds.append(model(norm(centre_view(to_tensor(X[i:i + batch])))).float().argmax(1))
    p = torch.cat(preds).numpy()
    rec = [float((p[y == c] == c).mean()) for c in range(3)]
    return {"accuracy": float((p == y).mean()), "balanced_accuracy": float(np.mean(rec)),
            "recall_bird": rec[0], "recall_drone": rec[1], "recall_other": rec[2],
            "bird_as_drone": float((p[y == 0] == 1).mean()), "drone_as_bird": float((p[y == 1] == 0).mean())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="v1")
    ap.add_argument("--epochs", type=int, default=18)
    ap.add_argument("--minutes", type=float, default=9)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    torch.set_num_threads(2)
    run = HERE / "runs" / a.name
    run.mkdir(parents=True, exist_ok=True)
    tr, va = np.load(DATA / "fit.npz"), np.load(DATA / "holdout.npz")  # from make_split.py; Mendeley valid overlaps the test set
    Xtr, ytr, Xva, yva = tr["X"], tr["y"], va["X"], va["y"]
    counts = np.bincount(ytr, minlength=3)
    weights = torch.tensor(counts.sum() / (3 * counts), dtype=torch.float32)  # balance the 3 classes
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
        print(f"{count_params(model):,} parameters; train crops {counts.tolist()} (bird, drone, other); valid {np.bincount(yva).tolist()}")
    started = time.time()
    while state["epoch"] < a.epochs:
        e = state["epoch"]
        order = np.random.default_rng(a.seed + e).permutation(len(ytr))
        g = torch.Generator().manual_seed(a.seed * 1000 + e * 100000 + state["step"])
        model.train()
        loss_sum, seen = 0.0, 0
        for s in range(state["step"], steps_per_epoch):
            idx = np.sort(order[s * a.batch:(s + 1) * a.batch])
            x = norm(augment(to_tensor(Xtr[idx]), g))
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
        m = evaluate(model, Xva, yva)
        m.update(epoch=e + 1, train_loss=loss_sum / max(seen, 1))
        state["history"].append(m)
        state["epoch"], state["step"] = e + 1, 0
        if m["balanced_accuracy"] > state["best"]:
            state["best"] = m["balanced_accuracy"]
            torch.save({"model": model.state_dict(), "epoch": e + 1, "valid": m, "seed": a.seed, "args": vars(a)}, run / "best.pt")
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "state": state}, ckpt)
        (run / "history.json").write_text(json.dumps(state["history"], indent=1))
        print(f"epoch {e + 1}/{a.epochs}  loss {m['train_loss']:.3f}  valid acc {m['accuracy']:.4f}  balanced {m['balanced_accuracy']:.4f}  "
              f"bird {m['recall_bird']:.3f} drone {m['recall_drone']:.3f} other {m['recall_other']:.3f}  "
              f"[{time.time() - started:.0f}s]", flush=True)
    print("done; best valid balanced accuracy", round(state["best"], 4))


if __name__ == "__main__":
    main()
