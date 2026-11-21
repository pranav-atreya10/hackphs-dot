"""Two synthetic sources for v4 (computer-generated images; extra variety, not real cameras).

  synth_athkot   : "Drone and Bird Synthetic 10k" (athkot/drone-vs-bird-synthetic-10k, CC BY 4.0), yolo/dataset-yolo.zip
                   (LFS sha256 starts 7c13162528f61f04, verified). 640x640 AI-generated images, YOLO labels:
                   0 drone -> 1, 1 bird -> 0, 2 airplane -> 2 (other), 3 helicopter -> 2.
                   Group = file stem (each image is generated independently).
  synth_cranfield: Cranfield Synthetic Drone Detection (mazqtpopx/cranfield-synthetic-drone-detection, CC BY 4.0),
                   multi_drone_no_birds_40m_small.zip (0.89 GB, sha256 starts 297671d67e6b06c0, verified; the 5.9 GB
                   drones_with_birds_40m.zip did not fit the disk). 1920x1080 renders + masks; boxes = connected
                   components of the mask (pixel value > 100), drones -> 1. Group = index // 25 (renders come in runs of about 5).

    cd "Shreyansh Local Ai Model" && OMP_NUM_THREADS=1 python3 -I sources/synth.py
Downloads were unpacked by hand into data/v4raw/<source>/ex/ (see the session log); this script reads them.
"""
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from sources.common import RAW, CropWriter, leak_check, split_part  # noqa: E402

ATH = {0: 1, 1: 0, 2: 2, 3: 2}


def athkot():
    root = next((RAW / "synth_athkot" / "ex").glob("*-yolo"))
    writers = {p: CropWriter("synth_athkot", p) for p in ("train", "select", "test")}
    imgs = sorted((root / "images").rglob("*.*"))
    batch = []
    for path in imgs:
        lab = root / "labels" / path.parent.name / (path.stem + ".txt")
        if not lab.exists():
            continue
        img = Image.open(path).convert("RGB")
        w, h = img.size
        boxes = []
        for line in lab.read_text().split("\n"):
            v = line.split()
            if len(v) == 5:
                c, cx, cy, bw, bh = int(v[0]), *map(float, v[1:])
                boxes.append(((cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h, ATH[c]))
        batch.append((img, boxes, path.stem))
        if len(batch) == 64:
            flush(batch, writers); batch = []
        if all(wr.full() for wr in writers.values()):
            break
    flush(batch, writers)
    for wr in writers.values():
        wr.close({"licence": "CC BY 4.0", "synthetic": True})


def cranfield():
    from scipy import ndimage
    root = next((RAW / "synth_cranfield" / "ex").iterdir())
    masks = {int(re.match(r"Mask(\d+)", m.name).group(1)): m for m in (root / "Masks").glob("*.png")}
    writers = {p: CropWriter("synth_cranfield", p) for p in ("train", "select", "test")}
    batch = []
    for path in sorted((root / "Images").glob("*.jpg")):
        idx = int(re.search(r"(\d+)", path.stem).group(1))
        m = masks.get(idx + OFFSET)
        if m is None:
            continue
        a = np.asarray(Image.open(m))[..., 0] > 100
        lab, n = ndimage.label(a)
        boxes = []
        for sl in ndimage.find_objects(lab):
            if sl is None:
                continue
            y1, y2, x1, x2 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
            if (x2 - x1) >= 2 and (y2 - y1) >= 2:
                boxes.append((x1, y1, x2, y2, 1))
        batch.append((Image.open(path).convert("RGB"), boxes, f"run{idx // 5}"))
        if len(batch) == 32:
            flush(batch, writers, check=False); batch = []
    flush(batch, writers, check=False)
    for wr in writers.values():
        wr.close({"licence": "CC BY 4.0", "synthetic": True, "mask_offset": OFFSET,
                  "leak_check": "skipped: computer-generated renders cannot copy real test footage, and plain-sky renders give false pHash matches"})


def flush(batch, writers, check=True):
    if not batch:
        return
    bad = set(leak_check([b[0] for b in batch])) if check else set()
    for i, (img, boxes, group) in enumerate(batch):
        if i not in bad:
            writers[split_part(group)].add(img, boxes, group)


def find_offset():
    """Masks are named Mask0000.png_0001.png; the FIRST number is the image index (the second cycles 1-50). Check the shift
    by how much darker / different the image is inside the mask than around it."""
    root = next((RAW / "synth_cranfield" / "ex").iterdir())
    masks = {int(re.match(r"Mask(\d+)", m.name).group(1)): m for m in (root / "Masks").glob("*.png")}
    imgs = {int(re.search(r"(\d+)", p.stem).group(1)): p for p in (root / "Images").glob("*.jpg")}
    score = {}
    for off in (-1, 0, 1):
        s = []
        for i in sorted(imgs)[5:25]:
            if i + off not in masks:
                continue
            a = np.asarray(Image.open(masks[i + off]))[..., 0] > 100
            if not a.any():
                continue
            g = np.asarray(Image.open(imgs[i]).convert("L"), dtype=float)
            ys, xs = np.nonzero(a)
            ring = g[max(ys.min() - 20, 0):ys.max() + 20, max(xs.min() - 20, 0):xs.max() + 20]
            s.append(abs(g[a].mean() - np.median(ring)))
        score[off] = float(np.mean(s)) if s else -1
    return max(score, key=score.get), score


if __name__ == "__main__":
    OFFSET, sc = find_offset()
    print("cranfield mask offset", OFFSET, sc, flush=True)
    which = sys.argv[1:] or ["athkot", "cranfield"]
    if "athkot" in which:
        athkot()
    if "cranfield" in which:
        cranfield()
