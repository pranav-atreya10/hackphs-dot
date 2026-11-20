"""v5: a bigger, PRETRAINED model (MobileNetV3) on the same 10 sources as v4. Meant for a GPU (Google Colab).

    python3 train_v5_mobilenet.py --arch mobilenet_v3_large --epochs 10            # ~4.2M params, 16.8 MB
    python3 train_v5_mobilenet.py --arch mobilenet_v3_small --epochs 12            # ~1.5M params, 6.1 MB
    python3 train_v5_mobilenet.py --export runs/v5_large/best.pt --arch mobilenet_v3_large   # -> ONNX for the browser

Why: the user allowed up to 20 MB. A network pretrained on ImageNet (about a million everyday photos, so it already
knows edges, shapes, feathers, propellers) usually holds up much better on cameras it has never seen than a small
network trained from scratch. On this project's 2-core CPU it trains at only ~40 crops/s (1.5 h per epoch), so run
it on a GPU: on a Colab T4 it should take roughly 2-4 minutes per epoch (estimate, not measured).
Data: the same .npy crop files train_v4.py uses (copy data/shreyansh_crops_v2, _v3, _v4 to the GPU machine, or
rebuild them with the prepare_* / sources/*.py scripts). Input: the 64x64 crops upscaled to 96x96.
Selection: same rule as v4 (mean balanced accuracy over every source's SELECT part). Test with eval scripts after
exporting (eval_v4.py / eval_voting.py load SkyNetLite; for this model use --arch with eval_v5 below).
Licences: torchvision code and weights are BSD-3; the weights were trained on ImageNet, whose own terms are for
research / non-commercial use. Check this before selling the model.
Browser: export to ONNX and run with onnxruntime-web (MIT licence); the plain-JS runner only supports SkyNetLite.
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
import torchvision

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_v2 import augment  # noqa: E402
from train_v4 import SOURCE_CAP, load_sources  # noqa: E402

HERE = Path(__file__).resolve().parent
SIZE = 96
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)


def build(arch, pretrained=True):
    fn = getattr(torchvision.models, arch)
    w = {"mobilenet_v3_large": "IMAGENET1K_V2", "mobilenet_v3_small": "IMAGENET1K_V1"}[arch] if pretrained else None
    m = fn(weights=w)
    m.classifier[-1] = torch.nn.Linear(m.classifier[-1].in_features, 3)
    return m


def prep(x_uint8, device):
    x = torch.from_numpy(np.ascontiguousarray(x_uint8)).permute(0, 3, 1, 2).float().div_(255)
    return x.to(device)


def norm(x):
    x = F.interpolate(x, size=SIZE, mode="bilinear", align_corners=False)
    return ((x - MEAN.to(x.device)) / STD.to(x.device)).contiguous(memory_format=torch.channels_last)


@torch.no_grad()
def evaluate(model, X, y, device):
    model.eval()
    p = []
    for i in range(0, len(y), 512):
        p.append(model(norm(prep(X[i:i + 512, 0], device))).argmax(1).cpu())
    p = torch.cat(p).numpy()
    rec = [float((p[y == c] == c).mean()) if (y == c).any() else float("nan") for c in range(3)]
    return {"balanced_accuracy": float(np.nanmean(rec)), "recall_bird": rec[0], "recall_drone": rec[1], "recall_other": rec[2]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="mobilenet_v3_large", choices=["mobilenet_v3_large", "mobilenet_v3_small"])
    ap.add_argument("--name", default=None)
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=45)
    ap.add_argument("--weights", default="klim_skagen:3,svanstrom:3")
    ap.add_argument("--export", default=None, help="checkpoint to export to ONNX instead of training")
    a = ap.parse_args()
    if a.export:
        m = build(a.arch, pretrained=False)
        m.load_state_dict(torch.load(a.export, map_location="cpu", weights_only=False)["model"]); m.eval()
        out = Path(a.export).with_suffix(".onnx")
        torch.onnx.export(m, torch.zeros(1, 3, SIZE, SIZE), out, input_names=["crop96_normalised"], output_names=["logits"],
                          dynamic_axes={"crop96_normalised": {0: "n"}, "logits": {0: "n"}}, opset_version=17)
        print("wrote", out, "(input: RGB 96x96, /255, ImageNet mean/std; output: bird, drone, other)"); return
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        torch.set_num_threads(max(1, torch.get_num_threads()))
    run = HERE / "runs" / (a.name or f"v5_{a.arch.split('_')[-1]}")
    run.mkdir(parents=True, exist_ok=True)
    train, select = load_sources()
    extra = dict((k, int(v)) for k, v in (kv.split(":") for kv in a.weights.split(",") if kv))
    train = [(n, X, y, extra.get(n, w)) for n, X, y, w in train]
    sizes = [min(len(y) * w, SOURCE_CAP * w) for _, _, y, w in train]
    steps = math.ceil(sum(sizes) / a.batch)
    yall = np.concatenate([y for _, _, y, _ in train])
    counts = np.bincount(yall, minlength=3)
    weights = torch.tensor(counts.sum() / (3 * counts), dtype=torch.float32, device=device)
    torch.manual_seed(a.seed)
    model = build(a.arch).to(device).to(memory_format=torch.channels_last)
    print(f"{a.arch}: {sum(p.numel() for p in model.parameters()) / 1e6:.2f}M params on {device}; {sum(sizes)} samples/epoch")
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * steps, pct_start=0.1)
    amp = torch.autocast(device, dtype=torch.bfloat16 if device == "cpu" else torch.float16)
    scaler = torch.amp.GradScaler(enabled=device == "cuda")
    best, hist, started = -1, [], time.time()
    for e in range(a.epochs):
        rng = np.random.default_rng(a.seed + e)
        src, row = [], []
        for si, (n, X, y, w) in enumerate(train):
            k = sizes[si]
            idx = rng.permutation(np.tile(np.arange(len(y)), w))[:k]
            src.append(np.full(len(idx), si)); row.append(idx)
        src, row = np.concatenate(src), np.concatenate(row)
        o = rng.permutation(len(src)); src, row = src[o], row[o]
        ver = rng.integers(0, 3, len(src))
        g = torch.Generator().manual_seed(a.seed * 1000 + e)
        model.train()
        for s in range(steps):
            sl = slice(s * a.batch, (s + 1) * a.batch)
            xs, ys = [], []
            for si in np.unique(src[sl]):
                m = src[sl] == si; r, v = row[sl][m], ver[sl][m]; oo = np.argsort(r)
                xs.append(train[si][1][r[oo], v[oo]]); ys.append(train[si][2][r[oo]])
            x = augment(prep(np.concatenate(xs), "cpu"), g).to(device)
            yb = torch.from_numpy(np.concatenate(ys)).to(device)
            with amp:
                loss = F.cross_entropy(model(norm(x)).float(), yb, weight=weights, label_smoothing=0.05)
            opt.zero_grad(set_to_none=True); scaler.scale(loss).backward(); scaler.step(opt); scaler.update(); sched.step()
        res = {n: evaluate(model, X, y, device) for n, X, y in select}
        score = float(np.mean([r["balanced_accuracy"] for n, r in res.items() if len(dict((m, yy) for m, _, yy in select)[n]) >= 100]))
        hist.append({"epoch": e + 1, "select": res, "score": score})
        if score > best:
            best = score
            torch.save({"model": model.state_dict(), "arch": a.arch, "epoch": e + 1, "score": score}, run / "best.pt")
        (run / "history.json").write_text(json.dumps(hist, indent=1))
        print(f"epoch {e + 1}/{a.epochs} mean select {score:.4f} | " + " ".join(f"{n} {r['balanced_accuracy']:.3f}" for n, r in res.items()) + f" [{time.time() - started:.0f}s]", flush=True)


if __name__ == "__main__":
    main()
