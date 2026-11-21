"""v4: fine-tune v3 on ALL sources (Mendeley, Svanström + every source in data/shreyansh_crops_v4/).

    python3 train_v4.py --name v4 --init runs/v3/best.pt --epochs 8 --minutes 100     # resumable
    python3 train_v4.py --dry-run --weights klim_skagen:3,svanstrom:3,openimages:1    # metadata only

Sources are picked up automatically: every <source>_train_X.npy in data/shreyansh_crops_v4 (made by
sources/<source>.py with sources/common.py). Sources ending in "_testonly" are never trained on.
Each epoch draws up to SOURCE_CAP samples per source before applying repeats (Svanström defaults to x2).
Changing repeats also changes the optimizer steps per epoch.
One random version per sample [jittered, jittered, tiny].
Best epoch = highest mean balanced accuracy over all sources' SELECT parts plus the Mendeley holdout and
the Svanström select clips. Test parts are never read here.
"""
import argparse
import json
import sys
import time
from hashlib import sha256
from io import BytesIO
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
SOURCE_CAP = 30000


def load_sources(data=None, *, metadata_digest=None):
    data = DATA if data is None else Path(data)
    metadata_only = metadata_digest is not None

    def read(prefix, label_suffix="_meta.npz", *, required=False):
        label_file = prefix.with_name(prefix.name + label_suffix)
        labels = label_file
        if metadata_only:
            payload = label_file.read_bytes()
            metadata_digest.update(f"{label_file.parent.name}:{label_file.name}\0".encode())
            metadata_digest.update(sha256(payload).digest())
            labels = BytesIO(payload)
        if label_suffix == "_meta.npz":
            with np.load(labels) as meta:
                if "y" not in meta:
                    raise ValueError(f"{label_file}: missing label array 'y'")
                y = meta["y"]
        else:
            y = np.load(labels)
        if (not isinstance(y, np.ndarray) or y.ndim != 1 or y.dtype.kind not in "iu"
                or np.any((y < 0) | (y > 2))):
            raise ValueError(f"{label_file}: expected a 1D array of integer labels 0, 1, or 2")
        if required and not len(y):
            raise ValueError(f"{label_file}: required split is empty")
        X = None if metadata_only or not len(y) else np.load(
            prefix.with_name(prefix.name + "_X.npy"), mmap_mode="r")
        return X, y.astype(np.int64, copy=False)

    v2, v3, v4 = (data / f"shreyansh_crops_v{v}" for v in (2, 3, 4))
    train = [("mendeley", *read(v2 / "fit", "_y.npy", required=True), 1),
             ("svanstrom", *read(v3 / "svan_train", required=True), 2)]
    select = [("mendeley", *read(v2 / "holdout", "_y.npy", required=True)),
              ("svanstrom", *read(v3 / "svan_select", required=True))]
    suffix = "_meta.npz" if metadata_only else "_X.npy"
    for f in sorted(v4.glob(f"*_train{suffix}")):
        name = f.name.removesuffix(f"_train{suffix}")
        if name.endswith("_testonly"):
            continue
        X, y = read(v4 / f"{name}_train")
        if len(y):
            train.append((name, X, y, 1))
        if (v4 / f"{name}_select{suffix}").exists():
            Xs, ys = read(v4 / f"{name}_select")
            if len(ys):
                select.append((name, Xs, ys))
    return train, select


def apply_source_weights(train, recipe):
    sources = {n for n, *_ in train}
    overrides = {}
    for entry in recipe.split(",") if recipe else ():
        source, _, repeat = entry.partition(":")
        source, repeat = source.strip(), repeat.strip()
        try:
            w = int(repeat)
        except ValueError:
            w = 0
        if w < 1:
            raise ValueError(f"--weights expects source:positive_integer entries, got {entry!r}")
        if source not in sources:
            raise ValueError(f"--weights names an unavailable training source: {source!r}")
        if source in overrides:
            raise ValueError(f"--weights repeats the entry for {source!r}")
        overrides[source] = w
    return [(n, X, y, overrides.get(n, w)) for n, X, y, w in train]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="v4")
    ap.add_argument("--init", default=str(HERE / "runs" / "v3" / "best.pt"))
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--minutes", type=float, default=100)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1.5e-3)
    ap.add_argument("--seed", type=int, default=44)
    ap.add_argument("--weights", default="", help="override source repeat counts, e.g. klim_skagen:3,svanstrom:3")
    ap.add_argument("--data-dir", default=str(DATA), help="root containing shreyansh_crops_v2/v3/v4")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the sampling plan from train/select metadata; no crops or training")
    a = ap.parse_args()
    if a.batch < 1 or a.epochs < 1:
        ap.error("--batch and --epochs must be positive")
    digest = sha256() if a.dry_run else None
    try:
        train, select = load_sources(a.data_dir, metadata_digest=digest)
        train = apply_source_weights(train, a.weights)
    except (OSError, ValueError, KeyError) as exc:
        ap.error(str(exc))
    if a.dry_run:
        missing_select = {n for n, *_ in train} - {n for n, *_ in select}
        if missing_select:
            ap.error(f"missing or empty select metadata for: {', '.join(sorted(missing_select))}")

    sizes = [min(len(y), SOURCE_CAP) * w for _, _, y, w in train]
    per_epoch = sum(sizes)
    steps = (per_epoch + a.batch - 1) // a.batch
    print("training sources:", ", ".join(f"{n} {len(y)} (x{w})" for n, _, y, w in train), f"| per epoch {per_epoch}")
    print("select sets:", ", ".join(f"{n} {len(y)}" for n, _, y in select))
    if digest is not None:
        for (n, _, y, _), size in zip(train, sizes):
            bird, drone, other = np.bincount(y, minlength=3)
            print(f"{n}: bird={bird} drone={drone} other={other} | draws/epoch={size}")
        print(f"train/select metadata SHA-256: {digest.hexdigest()}")
        print(f"dry run: seed={a.seed} batch={a.batch} epochs={a.epochs} lr={a.lr} "
              f"minutes={a.minutes} init={a.init} | steps/epoch={steps}")
        return

    import torch
    import torch.nn.functional as F

    sys.path.insert(0, str(HERE))
    from model import SkyNetLite
    from train import fast, norm, to_tensor
    from train_v2 import augment, evaluate

    torch.set_num_threads(2)
    run = HERE / "runs" / a.name
    run.mkdir(parents=True, exist_ok=True)
    yall = np.concatenate([y for _, _, y, _ in train])
    counts = np.bincount(yall, minlength=3)
    weights = torch.tensor(counts.sum() / (3 * counts), dtype=torch.float32)
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
