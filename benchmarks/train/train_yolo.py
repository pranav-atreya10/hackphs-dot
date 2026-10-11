"""Train / fine-tune a YOLO bird+drone detector on the Mendeley TRAIN and VALID splits only.

    .venv/bin/python benchmarks/train/train_yolo.py --src data/mendeley --base models/pretrained/yolo11n.pt \
        --name v0_yolo11n --epochs 40

Builds a clean training view in data/yolo_train/<name>/ (symlinked images, labels remapped to
0 = bird, 1 = drone by class NAME). Images without a label file are dropped by default: in YOLO an
unlabeled image means "nothing here", and ~4,300 Mendeley drone images have no labels.
The test split is never read.
"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bench.common import DATA, MODELS, ROOT, git_info, hardware_info, now_utc, pick_device, sha256_file  # noqa: E402

OURS = {"bird": 0, "drone": 1}


def find_split(src, names):
    for n in names:
        p = Path(src) / n
        if (p / "images").exists():
            return p
    return None


def build_view(src, out, src_names, drop_unlabeled):
    out.mkdir(parents=True, exist_ok=True)
    remap = {}
    for i, n in enumerate(src_names):
        key = n.strip().lower()
        for ours in OURS:
            if ours in key:
                remap[i] = OURS[ours]
    if set(remap.values()) != {0, 1}:
        raise SystemExit(f"Can't map source classes {src_names} to bird/drone")
    stats = {}
    for split, names in (("train", ["train"]), ("val", ["valid", "val"])):
        s = find_split(src, names)
        if s is None:
            raise SystemExit(f"No {split} split under {src}")
        (out / split / "images").mkdir(parents=True, exist_ok=True)
        (out / split / "labels").mkdir(parents=True, exist_ok=True)
        kept = dropped = boxes = 0
        for img in sorted((s / "images").iterdir()):
            if img.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            lab = s / "labels" / (img.stem + ".txt")
            if not lab.exists() and drop_unlabeled:
                dropped += 1
                continue
            lines = []
            if lab.exists():
                for line in lab.read_text().splitlines():
                    parts = line.split()
                    if len(parts) >= 5 and int(float(parts[0])) in remap:
                        lines.append(" ".join([str(remap[int(float(parts[0]))])] + parts[1:]))
            dst = out / split / "images" / img.name
            if not dst.exists():
                dst.symlink_to(img.resolve())
            (out / split / "labels" / (img.stem + ".txt")).write_text("\n".join(lines))
            kept += 1
            boxes += len(lines)
        stats[split] = {"images": kept, "dropped_unlabeled": dropped, "boxes": boxes}
        print(f"{split}: kept {kept} images ({boxes} boxes), dropped {dropped} without labels", flush=True)
    (out / "data.yaml").write_text(f"path: {out}\ntrain: train/images\nval: val/images\nnames:\n  0: bird\n  1: drone\n")
    return stats, remap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--base", required=True, help="pretrained weights to fine-tune")
    ap.add_argument("--name", required=True)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--keep-unlabeled", action="store_true")
    ap.add_argument("--extra-args", default="{}", help="JSON of extra ultralytics train args (e.g. augmentation for v4)")
    a = ap.parse_args()

    import yaml
    from ultralytics import YOLO
    src_yaml = next(Path(a.src).rglob("data.yaml"), None) or next(Path(a.src).rglob("*.yaml"), None)
    names = yaml.safe_load(open(src_yaml))["names"]
    names = list(names.values()) if isinstance(names, dict) else names
    view = DATA / "yolo_train" / a.name
    if view.exists():
        shutil.rmtree(view)
    stats, remap = build_view(a.src, view, names, not a.keep_unlabeled)

    t0 = time.time()
    model = YOLO(str(ROOT / a.base))
    model.train(data=str(view / "data.yaml"), epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, device=pick_device(),
                seed=a.seed, deterministic=True, project=str(ROOT / "runs"), name=a.name, exist_ok=False,
                patience=10, plots=True, verbose=True, **json.loads(a.extra_args))
    best = ROOT / "runs" / a.name / "weights" / "best.pt"
    dst = MODELS / "visual" / f"{a.name}.pt"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, dst)
    meta = {"weights": str(dst.relative_to(ROOT)), "sha256": sha256_file(dst), "base": a.base, "base_sha256": sha256_file(ROOT / a.base),
            "src": a.src, "source_names": names, "remap": remap, "view_stats": stats, "args": vars(a),
            "train_minutes": round((time.time() - t0) / 60, 1), "trained_utc": now_utc(), "git": git_info(), "hardware": hardware_info()}
    Path(str(dst) + ".json").write_text(json.dumps(meta, indent=1, default=str))
    print("saved", dst.relative_to(ROOT))


if __name__ == "__main__":
    main()
