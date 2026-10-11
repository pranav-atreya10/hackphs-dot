"""Train the audio drone detector (small log-mel CNN) on DADS training shards.

    .venv/bin/python benchmarks/train/train_audio.py --out models/audio/v0_audio.pt

Split (protocol: test shards are never used for training or tuning):
    test  : shards 3, 36                  (frozen in test_sets.json; refused here)
    train : shards 2 (first 85%), 5, 10, 19, 24
    val   : shard 30 + last 15% of shard 2 (contiguous blocks, so one recording can't straddle)
Each epoch samples equal numbers of drone / no-drone 1 s windows.
"""

import argparse
import io
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bench.audio import SR, build_model, MelFrontend, load_wav_bytes, loop_to, mix_at_snr  # noqa: E402
from bench.common import DATA, ROOT, sha256_file, pick_device, git_info, hardware_info, now_utc  # noqa: E402

TEST_SHARDS = {3, 36}
TRAIN_SHARDS = [2, 5, 10, 19, 24]
VAL_SHARDS = [30]
VAL_TAIL_OF = {2: 0.15}
WIN = SR  # 1 s


def shard_path(i):
    return DATA / "dads" / f"train-{i:05d}-of-00039.parquet"


def read_shard(i):
    import pyarrow.parquet as pq
    t = pq.read_table(shard_path(i))
    audio = t.column("audio").to_pylist()
    labels = t.column("label").to_pylist()
    return [(load_wav_bytes(a["bytes"]), int(l)) for a, l in zip(audio, labels)]


def window_from(y, rng):
    if len(y) <= WIN:
        return loop_to(y, WIN)
    s = rng.integers(0, len(y) - WIN + 1)
    return y[s:s + WIN]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--per_class", type=int, default=12000, help="windows per class per epoch")
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--noise_aug", default="", help="v3: comma list of noise wav dirs to mix in (empty = none)")
    args = ap.parse_args()

    assert not (TEST_SHARDS & set(TRAIN_SHARDS + VAL_SHARDS)), "test shards must never be used for training"
    import torch
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    device = pick_device()

    t0 = time.time()
    train, val = {0: [], 1: []}, {0: [], 1: []}
    for i in TRAIN_SHARDS + VAL_SHARDS:
        clips = read_shard(i)
        n_val = int(len(clips) * VAL_TAIL_OF.get(i, 0))
        for j, (y, l) in enumerate(clips):
            (val if i in VAL_SHARDS or j >= len(clips) - n_val else train)[l].append(y)
        print(f"shard {i}: {len(clips)} clips", flush=True)
    for name, d in (("train", train), ("val", val)):
        print(f"{name}: no-drone {len(d[0])} clips, drone {len(d[1])} clips", flush=True)
    print(f"loaded in {time.time() - t0:.0f}s", flush=True)

    noise_pool = []
    if args.noise_aug:
        import librosa
        for d in args.noise_aug.split(","):
            for p in sorted(Path(d).glob("*.wav")):
                noise_pool.append(librosa.load(p, sr=SR, mono=True)[0])
        print(f"noise augmentation: {len(noise_pool)} noise clips", flush=True)

    model = build_model().to(device)
    front = MelFrontend(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    lossf = torch.nn.BCEWithLogitsLoss()

    # Feature normalisation from a training sample
    with torch.no_grad():
        sample = np.stack([window_from(train[c][k], rng) for c in (0, 1) for k in rng.integers(0, len(train[c]), 256)])
        f = front(torch.tensor(sample, device=device))
        norm = {"mean": float(f.mean()), "std": float(f.std())}

    def make_batch(pool, n):
        xs, ys = [], []
        for c in (0, 1):
            for k in rng.integers(0, len(pool[c]), n):
                w = window_from(pool[c][k], rng)
                if noise_pool and rng.random() < 0.5:
                    w = mix_at_snr(w, noise_pool[rng.integers(0, len(noise_pool))], rng.uniform(-10, 20), rng)
                w = w * rng.uniform(0.3, 1.0)  # gain jitter
                xs.append(w)
                ys.append(c)
        order = rng.permutation(len(xs))
        return np.stack(xs)[order], np.array(ys, np.float32)[order]

    val_x, val_y = make_batch(val, 2000)  # fixed validation windows
    best, history = -1, []
    for ep in range(args.epochs):
        model.train()
        x, y = make_batch(train, args.per_class)
        t1, losses = time.time(), []
        for s in range(0, len(x), args.batch):
            xb = torch.tensor(x[s:s + args.batch], device=device)
            yb = torch.tensor(y[s:s + args.batch], device=device)
            loss = lossf(model((front(xb) - norm["mean"]) / norm["std"]), yb)
            opt.zero_grad()
            loss.backward()
            opt.step()
            losses.append(loss.item())
        sched.step()
        model.eval()
        with torch.no_grad():
            pv = np.concatenate([torch.sigmoid(model((front(torch.tensor(val_x[s:s + 512], device=device)) - norm["mean"]) / norm["std"])).cpu().numpy()
                                 for s in range(0, len(val_x), 512)])
        from sklearn.metrics import roc_auc_score
        auc = roc_auc_score(val_y, pv)
        acc = ((pv >= 0.5) == val_y).mean()
        history.append({"epoch": ep + 1, "loss": float(np.mean(losses)), "val_auc": float(auc), "val_acc": float(acc)})
        print(f"epoch {ep + 1}/{args.epochs} loss {np.mean(losses):.4f} val_auc {auc:.4f} val_acc {acc:.4f} ({time.time() - t1:.0f}s)", flush=True)
        if auc > best:
            best = auc
            out = ROOT / args.out
            out.parent.mkdir(parents=True, exist_ok=True)
            torch.save({"model": model.state_dict(), "norm": norm}, out)

    meta = {"weights": args.out, "sha256": sha256_file(ROOT / args.out), "trained_utc": now_utc(), "args": vars(args),
            "train_shards": TRAIN_SHARDS, "val_shards": VAL_SHARDS, "val_tail_of": VAL_TAIL_OF, "test_shards_excluded": sorted(TEST_SHARDS),
            "dads_revision": (DATA / "dads" / "REVISION").read_text().strip(),
            "shard_sha256": {i: sha256_file(shard_path(i)) for i in TRAIN_SHARDS + VAL_SHARDS},
            "history": history, "best_val_auc": best, "git": git_info(), "hardware": hardware_info()}
    Path(str(ROOT / args.out) + ".json").write_text(json.dumps(meta, indent=1, default=str))
    print("saved", args.out, "best val AUC", round(best, 4))


if __name__ == "__main__":
    main()
