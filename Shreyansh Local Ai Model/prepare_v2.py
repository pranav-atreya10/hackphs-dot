"""v2 training crops: cut exactly like the live app, plus realistic TINY versions.

    python3 prepare_v2.py     # needs make_split.py's split.json; writes data/shreyansh_crops_v2/

Changes from prepare_data.py (v1):
  1. Crops are cut in ONE step at 64 px with crops.cut, exactly like evaluate.py and the browser
     (v1 cut 80 px and resampled again during training, which made training crops slightly different).
     Box jitter (scale 0.8-1.25, shift +-10%) is applied to the box BEFORE cutting.
  2. Every object and every background square also gets a TINY version: the whole frame is shrunk
     (area averaging, like a real camera seeing it from further away) until the object's longest side is
     3-12 px (but the frame never below 128 px, so big close-up objects become medium-distance instead), then the normal live crop rule is applied (32 px minimum square, so real sky surrounds the
     tiny object). Background squares get the same shrink, so "small and padded" does not mean "bird".
Each sample has 3 versions: [jittered, jittered, tiny]. Training picks one at random each epoch.
The holdout gets [centre crop, tiny] (no jitter) for measuring.
Same images, same fit / holdout / dropped split as v1 (split.json). Never touches the test split.
"""
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crops import INPUT, square_for_box, cut  # noqa: E402
from prepare_data import SRC, iou, read_boxes  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "data" / "shreyansh_crops_v2"
OTHER_PER_IMAGE = 2
SEED = 2026
V = 3
MIN_SHRINK = 0.2  # never shrink the 640 px frame below 128 px


def tiny_version(img, box, rng, target=None):
    """Shrink the frame so the box's longest side becomes 3-12 px, then cut the live crop."""
    x1, y1, x2, y2 = box
    longest = max(x2 - x1, y2 - y1)
    target = target or rng.uniform(3, 12)
    f = max(min(1.0, target / longest), MIN_SHRINK)  # keep the frame >= 128 px so the crop is real sky, not padding
    if f < 1.0:
        w, h = img.size
        small = img.resize((max(1, round(w * f)), max(1, round(h * f))), Image.BOX)
    else:
        small = img
    cx, cy, side = square_for_box((x1 + x2) / 2 * f, (y1 + y2) / 2 * f, (x2 - x1) * f, (y2 - y1) * f)
    return cut(small, cx, cy, side, INPUT)


def jittered(img, box, rng):
    x1, y1, x2, y2 = box
    cx, cy, side = square_for_box((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, rng.uniform(0.8, 1.25))
    cx += rng.uniform(-0.1, 0.1) * side
    cy += rng.uniform(-0.1, 0.1) * side
    return cut(img, cx, cy, side, INPUT)


def centre(img, box):
    x1, y1, x2, y2 = box
    return cut(img, *square_for_box((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1), INPUT)


def process(args):
    idx, name, role, side_pool = args
    img = Image.open(SRC / "train" / "images" / name).convert("RGB")
    w, h = img.size
    boxes = read_boxes(SRC / "train" / "labels" / (Path(name).stem + ".txt"), w, h)
    cls = 0 if name.startswith("B") else 1
    rng = np.random.default_rng(SEED * 100003 + idx)
    targets = [(b, cls) for b in boxes]
    tries = 0
    while sum(c == 2 for _, c in targets) < OTHER_PER_IMAGE and tries < 60:  # background squares
        tries += 1
        live = float(rng.choice(side_pool))
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        sq = (cx - live / 2, cy - live / 2, cx + live / 2, cy + live / 2)
        if any(iou(sq, b) >= 0.02 or (sq[0] < (b[0] + b[2]) / 2 < sq[2] and sq[1] < (b[1] + b[3]) / 2 < sq[3])
               or (b[0] < cx < b[2] and b[1] < cy < b[3]) for b in boxes):
            continue
        s = live / 1.4  # a pretend "box" whose live square is exactly this square
        targets.append(((cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2), 2))
    xs, ys = [], []
    for box, c in targets:
        if role == "fit":
            xs.append(np.stack([jittered(img, box, rng), jittered(img, box, rng), tiny_version(img, box, rng)]))
        else:
            xs.append(np.stack([centre(img, box), tiny_version(img, box, rng, target=7.0)]))
        ys.append(c)
    return xs, ys


def main():
    split = json.loads((HERE / "split.json").read_text())
    holdout, dropped = set(split["holdout_images"]), set(split["dropped_near_test"])
    names = sorted(os.listdir(SRC / "train" / "images"))
    from prepare_data import live_sides
    pool_sides = live_sides("train")
    OUT.mkdir(parents=True, exist_ok=True)
    for role in ("holdout", "fit"):
        jobs = [(i, n, role, pool_sides) for i, n in enumerate(names)
                if n not in dropped and ((n in holdout) == (role == "holdout"))]
        X = None
        y_all, k = [], 0
        with Pool(os.cpu_count()) as pool:
            for xs, ys in pool.imap(process, jobs, chunksize=32):
                if X is None:  # write straight to disk so RAM stays small
                    cap = len(jobs) * 8
                    X = np.lib.format.open_memmap(OUT / f"{role}_X_tmp.npy", "w+", np.uint8, (cap,) + xs[0].shape)
                for x in xs:
                    X[k] = x; k += 1
                y_all += ys
        X.flush()
        final = np.lib.format.open_memmap(OUT / f"{role}_X.npy", "w+", np.uint8, (k,) + X.shape[1:])
        for i in range(0, k, 4096):
            final[i:i + 4096] = X[i:min(i + 4096, k)]
        final.flush(); del X, final
        os.remove(OUT / f"{role}_X_tmp.npy")
        y = np.array(y_all, dtype=np.int64)
        np.save(OUT / f"{role}_y.npy", y)
        print(f"{role}: {k} samples x {V if role == 'fit' else 2} versions "
              f"(bird {(y == 0).sum()}, drone {(y == 1).sum()}, other {(y == 2).sum()})", flush=True)


if __name__ == "__main__":
    main()
