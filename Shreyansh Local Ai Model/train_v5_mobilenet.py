"""v5 architecture/pretraining trial: MobileNetV3 Large, with the v4.1 fit and SELECT recipe.

    python train_v5_mobilenet.py --preflight --smoke-batch 256    # CUDA, synthetic only; no checkpoint
    python train_v5_mobilenet.py --train --data-root <audited-data> --pretrained-weights <local-pth> --pretrained-sha256 <approved-sha256>
    python train_v5_mobilenet.py --export "runs\\v5_large\\best.pt"

Train only after sign-off on the exact approved corpus, ImageNet V2 initial weights and GPU resources.
No downloads, CPU fallback, test-set reads or resume. The default run directory must not exist.
64x64 RGB crops are upscaled to 96x96 and normalised for the pretrained backbone. SELECT uses
the first crop version, mean recall across classes present, then equal weight across sources
with at least 100 SELECT rows. Mendeley's train-derived holdout counts as SELECT, not test.
This tests the MobileNet + pretraining + preprocessing bundle, not an architecture-only
effect against the historical v4.1 checkpoint. Benchmark separately after selection.
Check ImageNet weight terms before deployment.
"""
import argparse
import hashlib
import io
import json
import math
import os
import platform
import random
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "benchmarks"))
from bench.common import now_utc, sha256_file  # noqa: E402

ARCH = "mobilenet_v3_large"
ARCHES = (ARCH, "mobilenet_v3_small")
INITIAL_WEIGHTS = "MobileNet_V3_Large_Weights.IMAGENET1K_V2"
INITIAL_HASH_PREFIX = "5c1a4163"
CROP_SIZE = 64
SIZE = 96
MEAN, STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)
LABELS = ("bird", "drone", "other")
MAX_BYTES = 20_000_000
SEED, EPOCHS, BATCH = 44, 4, 256
LR, WEIGHT_DECAY, SMOOTHING, WARMUP = 1e-3, 5e-4, 0.05, 0.1
MIN_SELECT = 100
HYPOTHESIS = "ImageNet-pretrained MobileNetV3 Large will lower the unseen-source drone false-alarm rate at comparable drone recall."
# Source repeats and crop counts recorded by the v4.1 run.
V4_1 = {
    "mendeley": (1, 82758, 11255),
    "svanstrom": (3, 23282, 7218),
    "aod4": (1, 15488, 1484),
    "dcskycam": (1, 3817, 381),
    "dut_anti_uav": (1, 16206, 2196),
    "iberbirds": (1, 5230, 492),
    "klim_skagen": (3, 2242, 1230),
    "openimages": (1, 18665, 2364),
    "synth_athkot": (1, 20717, 3438),
    "synth_cranfield": (1, 6586, 669),
}


def build(arch, pretrained=False, *, weights_path=None):
    import torch
    from torchvision import models

    if arch not in ARCHES:
        raise ValueError(f"Unknown architecture: {arch}")
    m = getattr(models, arch)(weights=None)
    if pretrained:
        if weights_path is None:
            raise ValueError("Pretraining requires a locally verified ImageNet weights file")
        m.load_state_dict(torch.load(weights_path, map_location="cpu", weights_only=True))
    m.classifier[-1] = torch.nn.Linear(m.classifier[-1].in_features, len(LABELS))
    return m


def prep(x_uint8, device):
    import torch

    x = torch.from_numpy(np.array(x_uint8, order="C", copy=True)).permute(0, 3, 1, 2).float().div_(255)
    return x.to(device)


def norm(x):
    import torch

    x = torch.nn.functional.interpolate(x, size=SIZE, mode="bilinear", align_corners=False)
    return ((x - x.new_tensor(MEAN).view(1, 3, 1, 1)) /
            x.new_tensor(STD).view(1, 3, 1, 1)).contiguous(memory_format=torch.channels_last)


def select_metrics(p, y):
    rec = {f"recall_{name}": float((p[y == c] == c).mean()) if (y == c).any() else None
           for c, name in enumerate(LABELS)}
    return {"balanced_accuracy": float(np.mean([r for r in rec.values() if r is not None])), **rec}


def evaluate(model, X, y, device):
    import torch

    model.eval()
    predictions = []
    with torch.inference_mode():
        for i in range(0, len(y), BATCH):
            x = norm(prep(X[i:i + BATCH, 0], device))
            with torch.autocast(device, dtype=torch.bfloat16):
                logits = model(x)
            if not torch.isfinite(logits).all():
                raise ValueError("Non-finite SELECT logits; refusing to score this checkpoint")
            predictions.append(logits.argmax(1).cpu())
    return select_metrics(torch.cat(predictions).numpy(), y)


def source_paths(name, role):
    if name == "mendeley":
        stem = "fit" if role == "train" else "holdout"
        folder = Path("shreyansh_crops_v2")
        return folder / f"{stem}_X.npy", folder / f"{stem}_y.npy"
    if name == "svanstrom":
        folder, name = Path("shreyansh_crops_v3"), "svan"
    else:
        folder = Path("shreyansh_crops_v4")
    return folder / f"{name}_{role}_X.npy", folder / f"{name}_{role}_meta.npz"


def load_sources(root, verified_files):
    train, select = [], []
    for name, (repeat, n_train, n_select) in V4_1.items():
        for role, rows in (("train", n_train), ("select", n_select)):
            crop, labels = source_paths(name, role)
            if any(path.as_posix() not in verified_files for path in (crop, labels)):
                raise ValueError(f"{name} {role} is not in the verified corpus inventory")
            X = np.load(root / crop, mmap_mode="r", allow_pickle=False)
            if labels.suffix == ".npz":
                with np.load(root / labels, allow_pickle=False) as meta:
                    y = meta["y"]
            else:
                y = np.load(root / labels, allow_pickle=False)
            versions = 3 if role == "train" else 2 if name == "mendeley" else 1
            if X.dtype != np.uint8 or X.shape != (rows, versions, CROP_SIZE, CROP_SIZE, 3):
                raise ValueError(f"{name} {role} crop layout or row count differs from v4.1")
            if y.shape != (rows,) or y.dtype.kind not in "iu" or (y < 0).any() or (y >= len(LABELS)).any():
                raise ValueError(f"{name} {role} must have one valid class label per crop")
            entry = (name, X, y.astype(np.int64, copy=False))
            if role == "train":
                train.append((*entry, repeat))
            else:
                select.append(entry)
    return train, select


def runtime(device):
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    import torch
    import torchvision

    if device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA torch is not available; install a matched CUDA torch/torchvision pair and run --preflight")
    if device == "cuda" and not torch.cuda.is_bf16_supported(including_emulation=False):
        raise ValueError("Native CUDA bfloat16 is required to preserve the v4.1 precision recipe")
    torch.set_num_threads(2)
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cuda.matmul.allow_tf32 = False
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)
    info = {"os": platform.platform(), "cpu": platform.processor() or platform.machine(),
            "logical_cpus": os.cpu_count(), "python": platform.python_version(),
            "torch": torch.__version__, "torchvision": torchvision.__version__, "numpy": np.__version__,
            "device": device}
    if sys.platform == "win32":
        import ctypes

        kb = ctypes.c_ulonglong()
        if ctypes.windll.kernel32.GetPhysicallyInstalledSystemMemory(ctypes.byref(kb)):
            info["host_ram_bytes"] = kb.value * 1024
    elif "SC_PHYS_PAGES" in getattr(os, "sysconf_names", {}):
        info["host_ram_bytes"] = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    if device == "cuda":
        props = torch.cuda.get_device_properties(0)
        free, _ = torch.cuda.mem_get_info()
        info.update(gpu=props.name, gpu_bytes=props.total_memory, gpu_free_bytes=free,
                    capability=[props.major, props.minor], cuda=torch.version.cuda,
                    cudnn=torch.backends.cudnn.version())
    return torch, info


def preflight(a):
    torch, info = runtime(a.device)
    from train_v2 import augment

    model = build(a.arch).to(device=a.device, memory_format=torch.channels_last)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    if a.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    rng = np.random.default_rng(SEED)
    crops = rng.integers(0, 256, (a.smoke_batch, CROP_SIZE, CROP_SIZE, 3), dtype=np.uint8)
    x = norm(augment(prep(crops, "cpu"), torch.Generator().manual_seed(SEED * 1000)).to(a.device))
    with torch.autocast(a.device, dtype=torch.bfloat16, enabled=a.device == "cuda"):
        logits = model(x)
    if logits.shape != (a.smoke_batch, len(LABELS)) or not torch.isfinite(logits).all():
        raise ValueError(f"Expected finite {(a.smoke_batch, len(LABELS))} logits, got {tuple(logits.shape)}")
    y = torch.arange(a.smoke_batch, device=a.device) % len(LABELS)
    head = model.classifier[-1].weight.detach()
    before = head.clone()
    torch.nn.functional.cross_entropy(logits.float(), y, label_smoothing=SMOOTHING).backward()
    optimizer.step()
    if not torch.isfinite(head).all() or torch.equal(head, before):
        raise ValueError("Synthetic optimizer step did not produce finite, updated classifier weights")
    with io.BytesIO() as buf:
        torch.save({"model": model.state_dict(), "arch": a.arch}, buf)
        with buf.getbuffer() as payload:
            checkpoint_bytes = payload.nbytes
            checkpoint_sha256 = hashlib.sha256(payload).hexdigest()
    if checkpoint_bytes > MAX_BYTES:
        raise ValueError(f"Synthetic checkpoint exceeds {MAX_BYTES} bytes: {checkpoint_bytes}")
    if a.device == "cuda":
        info["peak_cuda_reserved_bytes"] = torch.cuda.max_memory_reserved()
    print(json.dumps({"mode": "synthetic smoke only; no checkpoint, training corpus, or metrics",
                      "arch": a.arch, "seed": SEED, "parameters": sum(p.numel() for p in model.parameters()),
                      "input_shape": list(x.shape), "logits_shape": list(logits.shape),
                      "precision": "bfloat16 autocast" if a.device == "cuda" else "float32",
                      "optimizer_step_verified": True, "cap_bytes": MAX_BYTES,
                      "synthetic_checkpoint_bytes": checkpoint_bytes, "synthetic_checkpoint_sha256": checkpoint_sha256,
                      "runtime": info}, indent=2))


def export(checkpoint, arch):
    out = checkpoint.with_suffix(".onnx")
    if out.exists():
        raise ValueError(f"Refusing to overwrite {out}")
    import torch

    saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if saved.get("arch") != arch:
        raise ValueError(f"Checkpoint architecture {saved.get('arch')!r} does not match --arch {arch}")
    model = build(arch, pretrained=False)
    model.load_state_dict(saved["model"])
    model.eval()
    with io.BytesIO() as buf:
        torch.onnx.export(model, torch.zeros(1, 3, SIZE, SIZE), buf, dynamo=False, external_data=False,
                          input_names=["crop96_normalised"], output_names=["logits"],
                          dynamic_axes={"crop96_normalised": {0: "n"}, "logits": {0: "n"}}, opset_version=17)
        with buf.getbuffer() as payload:
            if not 0 < payload.nbytes <= MAX_BYTES:
                raise ValueError(f"ONNX deployment artifact must be non-empty and at most {MAX_BYTES} bytes; got {payload.nbytes}")
            with out.open("xb") as f:
                f.write(payload)
    print(f"wrote {out} ({out.stat().st_size} bytes, SHA-256 {sha256_file(out)})")


def write_json(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def fit(a):
    run = HERE / "runs" / a.name
    if run.exists():
        raise ValueError(f"Refusing to reuse run directory: {run}")
    status = subprocess.check_output(["git", "--no-pager", "status", "--porcelain"], cwd=REPO, text=True)
    if status.strip():
        raise ValueError("The training checkout must be clean")
    commit = subprocess.check_output(["git", "--no-pager", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    from sources.verify_corpus import verify_corpus

    device = "cuda"
    torch, info = runtime(device)
    from train_v2 import augment
    from train_v4 import SOURCE_CAP

    initial_hash = sha256_file(a.pretrained_weights)
    if initial_hash != a.pretrained_sha256 or not initial_hash.startswith(INITIAL_HASH_PREFIX):
        raise ValueError(f"Pretrained checkpoint SHA-256 does not match approved {INITIAL_WEIGHTS}")
    data_root = a.data_root.resolve()
    audit = verify_corpus(data_root)
    if audit.get("status") != "verified_train_select":
        raise ValueError("A passing train/SELECT audit is required, not just a corpus inventory")
    train, select = load_sources(data_root, audit["files"])
    sizes = [min(len(y), SOURCE_CAP) * w for _, _, y, w in train]
    steps = math.ceil(sum(sizes) / BATCH)
    yall = np.concatenate([y for _, _, y, _ in train])
    counts = np.bincount(yall, minlength=len(LABELS))
    if (counts == 0).any():
        raise ValueError("The audited training corpus must contain all three classes")
    weights = torch.tensor(counts.sum() / (len(LABELS) * counts), dtype=torch.float32, device=device)
    eligible = {n for n, _, y in select if len(y) >= MIN_SELECT}
    if not eligible:
        raise ValueError("No SELECT source meets the scoring minimum")
    model = build(ARCH, pretrained=True, weights_path=a.pretrained_weights)
    model = model.to(device=device, memory_format=torch.channels_last)
    opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=LR, total_steps=EPOCHS * steps, pct_start=WARMUP)

    run_info = {
        "status": "training", "started_utc": now_utc(), "git_commit": commit, "git_dirty": False,
        "baseline_checkpoint_sha256": sha256_file(HERE / "runs" / "v4_1" / "best.pt"),
        "comparison": {"baseline": "v4.1", "matched_control": False,
                       "differences": ["backbone", "ImageNet V2 instead of v4 initialization",
                                       "96 px resize and ImageNet normalization", "CUDA instead of CPU"]},
        "hypothesis": HYPOTHESIS, "arch": ARCH, "labels": LABELS, "thresholds": None,
        "initial_weights": {"name": INITIAL_WEIGHTS, "sha256": initial_hash},
        "seeds": {"python": SEED, "numpy": SEED, "torch": SEED, "epoch_sampling": f"{SEED} + zero_based_epoch",
                  "augmentation": f"{SEED * 1000} + 100000 * zero_based_epoch"},
        "recipe": {"epochs": EPOCHS, "batch": BATCH, "lr": LR, "weight_decay": WEIGHT_DECAY,
                   "label_smoothing": SMOOTHING, "one_cycle_pct_start": WARMUP, "precision": "bfloat16 autocast",
                   "optimizer": "AdamW", "deterministic": True, "source_cap": SOURCE_CAP,
                   "samples_per_epoch": sum(sizes), "steps_per_epoch": steps,
                   "class_counts": counts.tolist(), "class_weights": weights.cpu().tolist(),
                   "input_size": SIZE, "mean": MEAN, "std": STD},
        "sources": {n: {"repeat": w, "train_rows": t, "select_rows": s} for n, (w, t, s) in V4_1.items()},
        "selection": {"split": "SELECT", "crop_version": 0, "min_rows": MIN_SELECT,
                      "score_sources": sorted(eligible), "rule": "mean source balanced accuracy"},
        "corpus": audit, "runtime": info, "max_artifact_bytes": MAX_BYTES,
    }
    run.mkdir(exist_ok=False)
    write_json(run / "run.json", run_info)
    print(f"{ARCH} on {info['gpu']}; {sum(sizes)} samples/epoch; run: {run}", flush=True)

    best, hist, started = -1, [], time.time()
    candidate = run / "best.pending"
    for e in range(EPOCHS):
        rng = np.random.default_rng(SEED + e)
        src, row = [], []
        for si, (_, _, y, w) in enumerate(train):
            idx = np.tile(np.arange(len(y)), w)
            if len(idx) > sizes[si]:
                idx = rng.permutation(idx)[:sizes[si]]
            src.append(np.full(len(idx), si))
            row.append(idx)
        src, row = np.concatenate(src), np.concatenate(row)
        order = rng.permutation(len(src))
        src, row = src[order], row[order]
        ver = rng.integers(0, 3, len(src))
        g = torch.Generator().manual_seed(SEED * 1000 + e * 100000)
        model.train()
        for s in range(steps):
            sl = slice(s * BATCH, (s + 1) * BATCH)
            xs, ys = [], []
            for si in np.unique(src[sl]):
                m = src[sl] == si
                r, v = row[sl][m], ver[sl][m]
                order = np.argsort(r)
                xs.append(train[si][1][r[order], v[order]])
                ys.append(train[si][2][r[order]])
            x = norm(augment(prep(np.concatenate(xs), "cpu"), g).to(device))
            yb = torch.from_numpy(np.concatenate(ys)).to(device)
            with torch.autocast(device, dtype=torch.bfloat16):
                logits = model(x)
            loss = torch.nn.functional.cross_entropy(logits.float(), yb, weight=weights, label_smoothing=SMOOTHING)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
        res = {n: evaluate(model, X, y, device) for n, X, y in select}
        score = float(np.mean([r["balanced_accuracy"] for n, r in res.items() if n in eligible]))
        hist.append({"epoch": e + 1, "select": res, "score": score})
        if score > best:
            temp = run / "best.tmp"
            torch.save({"model": model.state_dict(), "arch": ARCH, "epoch": e + 1, "score": score, "seed": SEED}, temp)
            if temp.stat().st_size > MAX_BYTES:
                raise ValueError(f"Checkpoint exceeds {MAX_BYTES} bytes: {temp.stat().st_size}")
            temp.replace(candidate)
            best = score
        write_json(run / "history.json", hist)
        print(f"epoch {e + 1}/{EPOCHS} mean SELECT {score:.4f} [{time.time() - started:.0f}s]", flush=True)
    best_file = candidate.rename(run / "best.pt")
    run_info.update(status="complete", finished_utc=now_utc(),
                    checkpoint={"name": best_file.name, "sha256": sha256_file(best_file),
                                "bytes": best_file.stat().st_size,
                                "epoch": max(hist, key=lambda epoch: epoch["score"])["epoch"],
                                "select_score": best})
    write_json(run / "run.json", run_info)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--preflight", action="store_true", help="run a synthetic forward/backward check without saving a model")
    mode.add_argument("--train", action="store_true", help="run the fixed v5 trial after corpus and GPU approval")
    mode.add_argument("--export", type=Path, help="export a checkpoint to a new ONNX file alongside it")
    ap.add_argument("--arch", default=ARCH, choices=ARCHES, help="v5 training is Large only")
    ap.add_argument("--device", default="cuda", choices=("cuda", "cpu"), help="device for --preflight")
    ap.add_argument("--smoke-batch", type=int, default=2, help="synthetic batch size for --preflight")
    ap.add_argument("--name", default="v5_large", help="new directory name under runs for --train")
    ap.add_argument("--data-root", type=Path, default=REPO / "data")
    ap.add_argument("--pretrained-weights", type=Path, help="approved local ImageNet V2 state dict; no download")
    ap.add_argument("--pretrained-sha256", help="approved full SHA-256 of the ImageNet V2 file")
    a = ap.parse_args()
    if a.train:
        if a.arch != ARCH or a.device != "cuda":
            ap.error("--train requires MobileNetV3 Large and CUDA")
        if not re.fullmatch(r"v5_[A-Za-z0-9][A-Za-z0-9_-]*", a.name):
            ap.error("--name must start with v5_ and contain only letters, digits, underscores or dashes")
        if a.pretrained_weights is None or not re.fullmatch(r"[a-f0-9]{64}", a.pretrained_sha256 or ""):
            ap.error("--train requires --pretrained-weights and a lowercase 64-digit --pretrained-sha256")
    if a.preflight and not 1 <= a.smoke_batch <= BATCH:
        ap.error(f"--smoke-batch must be between 1 and {BATCH}")
    try:
        if a.preflight:
            preflight(a)
        elif a.train:
            fit(a)
        else:
            export(a.export, a.arch)
    except ModuleNotFoundError as e:
        if e.name in ("torch", "torchvision"):
            ap.exit(1, f"Missing {e.name}; install a compatible torch/torchvision pair before preflight, training, or export.\n")
        if e.name == "sources.verify_corpus":
            ap.exit(1, "The training corpus verifier is missing; integrate it before training.\n")
        raise
    except (OSError, ValueError, subprocess.CalledProcessError) as e:
        ap.exit(1, f"v5: {e}\n")


if __name__ == "__main__":
    main()
