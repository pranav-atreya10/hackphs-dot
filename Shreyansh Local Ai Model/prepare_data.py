"""Cut training crops from the Mendeley TRAIN and VALID splits (never the frozen test split).

    python3 prepare_data.py            # writes data/shreyansh_crops/train.npz and valid.npz

For every labelled object: one square crop around it (stored at STORE px with extra context, so training
can jitter the box like a real tracker would). The class comes from the file name (B... = bird,
D... = drone), because the published Mendeley labels put both classes under one id (see
benchmarks/TESTING_LOG.md). Outline (polygon) labels are turned into boxes. The same object outlined
twice (IoU >= 0.5) is kept once.

"Other" crops: from every image, OTHER_PER_IMAGE squares of sky / background that don't touch any
labelled object, with sizes drawn from the real object sizes. These teach the model what is NOT a
bird or drone.
"""
import os
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crops import STORE, STORE_SCALE, square_for_box, cut  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "data" / "mendeley" / "Dataset"
OUT = REPO / "data" / "shreyansh_crops"
OTHER_PER_IMAGE = 2
SEED = 7


def read_boxes(label_path, w, h):
    boxes = []
    for line in Path(label_path).read_text().split("\n"):
        v = line.split()
        if len(v) < 5:
            continue
        nums = [float(t) for t in v[1:]]
        if len(nums) == 4:
            cx, cy, bw, bh = nums
            x1, y1, x2, y2 = cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2
        else:
            xs, ys = nums[0::2], nums[1::2]
            x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
        x1, y1, x2, y2 = max(x1, 0) * w, max(y1, 0) * h, min(x2, 1) * w, min(y2, 1) * h
        if x2 - x1 >= 2 and y2 - y1 >= 2:
            boxes.append((x1, y1, x2, y2))
    kept = []  # merge the same object outlined twice
    for b in sorted(boxes, key=lambda b: -(b[2] - b[0]) * (b[3] - b[1])):
        if all(iou(b, k) < 0.5 for k in kept):
            kept.append(b)
    return kept


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0


def process(args):
    idx, split, name, side_pool = args
    img = Image.open(SRC / split / "images" / name).convert("RGB")
    w, h = img.size
    boxes = read_boxes(SRC / split / "labels" / (Path(name).stem + ".txt"), w, h)
    cls = 0 if name.startswith("B") else 1
    xs, ys, sizes = [], [], []
    for (x1, y1, x2, y2) in boxes:
        cx, cy, side = square_for_box((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, STORE_SCALE)
        xs.append(cut(img, cx, cy, side, STORE)); ys.append(cls); sizes.append(max(x2 - x1, y2 - y1))
    rng = np.random.default_rng(SEED * 100003 + idx)
    found, tries = 0, 0
    while found < OTHER_PER_IMAGE and tries < 60:
        tries += 1
        live = float(rng.choice(side_pool))  # live-crop side, like a real object's
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        sq = (cx - live / 2, cy - live / 2, cx + live / 2, cy + live / 2)
        if any(iou(sq, b) >= 0.02 or (sq[0] < (b[0] + b[2]) / 2 < sq[2] and sq[1] < (b[1] + b[3]) / 2 < sq[3])
               or (b[0] < cx < b[2] and b[1] < cy < b[3]) for b in boxes):
            continue
        # The stored square has the same extra context as object crops; the object-free test is on the live square.
        xs.append(cut(img, cx, cy, live * STORE_SCALE, STORE)); ys.append(2); sizes.append(live / 1.4)
        found += 1
    return xs, ys, sizes, [idx] * len(ys)


def build(split, side_pool):
    names = sorted(os.listdir(SRC / split / "images"))
    with Pool(os.cpu_count()) as pool:
        parts = pool.map(process, [(i, split, n, side_pool) for i, n in enumerate(names)], chunksize=64)
    X = np.stack([x for p in parts for x in p[0]])
    y = np.array([v for p in parts for v in p[1]], dtype=np.int64)
    size = np.array([v for p in parts for v in p[2]], dtype=np.float32)
    group = np.array([v for p in parts for v in p[3]], dtype=np.int64)
    np.savez(OUT / f"{split}.npz", X=X, y=y, size=size, group=group, names=np.array(names))
    print(f"{split}: {len(names)} images -> {len(y)} crops "
          f"(bird {int((y == 0).sum())}, drone {int((y == 1).sum())}, other {int((y == 2).sum())})")


def live_sides(split, limit=3000):
    """Live-crop side lengths of real objects, used to size the 'other' crops."""
    rng = np.random.default_rng(SEED)
    names = sorted(os.listdir(SRC / split / "images"))
    sides = []
    for n in rng.choice(names, min(limit, len(names)), replace=False):
        for (x1, y1, x2, y2) in read_boxes(SRC / split / "labels" / (Path(n).stem + ".txt"), 640, 640):
            sides.append(square_for_box(0, 0, x2 - x1, y2 - y1)[2])
    return np.array(sides)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    pool = live_sides("train")
    for split in ["train", "valid"]:
        build(split, pool)
