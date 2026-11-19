"""v4: fine-tune v3 on ALL sources (Mendeley, Svanström + every source in data/shreyansh_crops_v4/).

    python3 train_v4.py --name v4 --init runs/v3/best.pt --epochs 8 --minutes 100     # resumable

Sources are picked up automatically: every <source>_train_X.npy in data/shreyansh_crops_v4 (made by
sources/<source>.py with sources/common.py). Sources ending in "_testonly" are never trained on.
Each epoch samples a balanced mix so no single source dominates: up to SOURCE_CAP samples per source
(Svanström counts double: real distant sky footage). One random version per sample [jittered, jittered, tiny].
Best epoch = highest mean balanced accuracy over all sources' SELECT parts plus the Mendeley holdout and
the Svanström select clips. Test parts are never read here.
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
DATA = HERE.parent / "data"
SOURCE_CAP = 30000


def load_sources():
    train, select = [], []
    train.append(("mendeley", np.load(DATA / "shreyansh_crops_v2" / "fit_X.npy", mmap_mode="r"), np.load(DATA / "shreyansh_crops_v2" / "fit_y.npy"), 1))
    select.append(("mendeley", np.load(DATA / "shreyansh_crops_v2" / "holdout_X.npy", mmap_mode="r"), np.load(DATA / "shreyansh_crops_v2" / "holdout_y.npy")))
    v3 = DATA / "shreyansh_crops_v3"
    train.append(("svanstrom", np.load(v3 / "svan_train_X.npy", mmap_mode="r"), np.load(v3 / "svan_train_meta.npz")["y"], 2))
    select.append(("svanstrom", np.load(v3 / "svan_select_X.npy", mmap_mode="r"), np.load(v3 / "svan_select_meta.npz")["y"]))
    v4 = DATA / "shreyansh_crops_v4"
    for f in sorted(v4.glob("*_train_X.npy")):
        name = f.name[:-len("_train_X.npy")]
        if name.endswith("_testonly"):
            continue
        y = np.load(v4 / f"{name}_train_meta.npz")["y"]
        if len(y):
            train.append((name, np.load(f, mmap_mode="r"), y, 1))
        sf = v4 / f"{name}_select_X.npy"
        if sf.exists():
            ys = np.load(v4 / f"{name}_select_meta.npz")["y"]
            if len(ys):
                select.append((name, np.load(sf, mmap_mode="r"), ys))
    return train, select


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="v4")
    ap.add_argument("--init", default=str(HERE / "runs" / "v3" / "best.pt"))
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--minutes", type=float, default=100)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1.5e-3)
    ap.add_argument("--seed", type=int, default=44)
    ap.add_argument("--weights", default="", help="extra repeat per source, e.g. klim_skagen:3,svanstrom:3")
    a = ap.parse_args()
    torch.set_num_threads(2)
    run = HERE / "runs" / a.name
    run.mkdir(parents=True, exist_ok=True)
    train, select = load_sources()
    extra = dict((k, int(v)) for k, v in (kv.split(":") for kv in a.weights.split(",") if kv))
    train = [(n, X, y, extra.get(n, w)) for n, X, y, w in train]
    plan = []  # (source index, row index) for one epoch, fixed size so the LR schedule is stable
    sizes = [min(len(y) * w, SOURCE_CAP * w) for _, _, y, w in train]
    per_epoch = int(sum(sizes))
    steps = math.ceil(per_epoch / a.batch)
    yall = np.concatenate([y for _, _, y, _ in train])
    counts = np.bincount(yall, minlength=3)
    weights = torch.tensor(counts.sum() / (3 * counts), dtype=torch.float32)
    print("training sources:", ", ".join(f"{n} {len(y)} (x{w})" for n, _, y, w in train), f"| per epoch {per_epoch}")
    print("select sets:", ", ".join(f"{n} {len(y)}" for n, _, y in select))
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
    started = time.time()
    while state["epoch"] < a.epochs:
        e = state["epoch"]
        rng = np.random.default_rng(a.seed + e)
        src, row = [], []
        for si, (n, X, y, w) in enumerate(train):
            k = sizes[si]
            idx = rng.permutation(np.tile(np.arange(len(y)), w))[:k] if len(y) * w > k else np.tile(np.arange(len(y)), w)
            src.append(np.full(len(idx), si)); row.append(idx)
        src, row = np.concatenate(src), np.concatenate(row)
        order = rng.permutation(len(src))
        src, row = src[order], row[order]
        version = rng.integers(0, 3, len(src))
        g = torch.Generator().manual_seed(a.seed * 1000 + e * 100000 + state["step"])
        model.train()
        loss_sum, seen = 0.0, 0
        for s in range(state["step"], steps):
            sl = slice(s * a.batch, (s + 1) * a.batch)
            xs, ys = [], []
            for si in np.unique(src[sl]):
                m = src[sl] == si
                r, v = row[sl][m], version[sl][m]
                o = np.argsort(r)
                xs.append(train[si][1][r[o], v[o]]); ys.append(train[si][2][r[o]])
            x = norm(augment(to_tensor(np.ascontiguousarray(np.concatenate(xs))), g))
            yb = torch.from_numpy(np.concatenate(ys))
            with fast():
                logits = model(x)
            loss = F.cross_entropy(logits.float(), yb, weight=weights, label_smoothing=0.05)
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step()
            if sched.last_epoch + 1 < sched.total_steps:  # sources added after a resume make epochs longer
                sched.step()
            loss_sum += float(loss.detach()) * len(yb); seen += len(yb)
            state["step"] = s + 1
            if time.time() - started > a.minutes * 60:
                torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "state": state}, ckpt)
                print(f"time budget used: paused in epoch {e + 1} at step {s + 1}/{steps}")
                return
        res = {n: evaluate(model, X, y, 0) for n, X, y in select}
        for r in res.values():  # sources with only some classes (e.g. helicopters only): average the classes present
            r["balanced_accuracy"] = float(np.nanmean([r["recall_bird"], r["recall_drone"], r["recall_other"]]))
        score = float(np.mean([r["balanced_accuracy"] for n, r in res.items() if len(dict((m, y) for m, _, y in select)[n]) >= 100]))
        state["history"].append({"epoch": e + 1, "train_loss": loss_sum / max(seen, 1), "select": res, "score": score})
        state["epoch"], state["step"] = e + 1, 0
        if score > state["best"]:
            state["best"] = score
            torch.save({"model": model.state_dict(), "epoch": e + 1, "score": score, "seed": a.seed, "args": vars(a),
                        "sources": [n for n, *_ in train]}, run / "best.pt")
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "state": state}, ckpt)
        (run / "history.json").write_text(json.dumps(state["history"], indent=1))
        per = "  ".join(f"{n} {r['balanced_accuracy']:.3f}" for n, r in res.items())
        print(f"epoch {e + 1}/{a.epochs}  loss {loss_sum / max(seen, 1):.3f}  mean select {score:.4f}  | {per}  [{time.time() - started:.0f}s]", flush=True)
    print("done; best mean select", round(state["best"], 4))


if __name__ == "__main__":
    main()
