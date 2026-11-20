"""Shared crop writer for v4's extra data sources (one script per source in this folder).

Every source script does the same three things:
  1. download its dataset into data/v4raw/<source>/ (its own folder) and verify any published checksum;
  2. call CropWriter(<source>, part).add(img, boxes, group) for every image, where
       img   = PIL RGB image (a full camera frame or photo),
       boxes = [(x1, y1, x2, y2, cls), ...] in pixels, cls 0 = bird, 1 = drone, 2 = other
               (airplane, helicopter, kite, balloon, insect, parachute ...),
       group = an id shared by frames of one video / sequence (splits and confidence intervals use it);
     or CropWriter.add_crop(crop_img, cls, group) for datasets that only ship ready-made crops;
  3. writer.close() -> data/shreyansh_crops_v4/<source>_<part>_X.npy + _meta.npz.
Parts: "train" (3 versions per object: [jittered, jittered, tiny], like prepare_v2.py) and "select" / "test"
(1 centre crop at the real size). Every full frame also gives background squares that touch no object (other).
Use leak_check() before training: pHash Hamming <= 6 against the frozen Mendeley test images and the
Svanström test frames means a near-duplicate; those images are dropped.
Splits go by GROUP (never frames of one video on two sides): split_part(group_key) gives a fixed
80 / 10 / 10 train / select / test split from a stable hash of the group id.
"""
import json
import sys
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
MODEL_DIR = HERE.parent
sys.path.insert(0, str(MODEL_DIR))
from crops import INPUT, cut, square_for_box  # noqa: E402
from prepare_data import iou  # noqa: E402
from prepare_v2 import jittered, tiny_version  # noqa: E402

REPO = MODEL_DIR.parent
RAW = REPO / "data" / "v4raw"
OUT = REPO / "data" / "shreyansh_crops_v4"
CAP = {"train": 15000, "select": 2500, "test": 4000}  # max objects (bird+drone+other boxes) per source and part


def split_part(group_key):
    h = zlib.crc32(str(group_key).encode()) % 100
    return "test" if h < 10 else "select" if h < 20 else "train"


class CropWriter:
    def __init__(self, source, part, cap=None, bg_per_image=1, seed=0):
        self.source, self.part = source, part
        self.cap = cap or CAP[part]
        self.bg = bg_per_image
        self.rng = np.random.default_rng(zlib.crc32(f"{source}{part}{seed}".encode()))
        self.V = 3 if part == "train" else 1
        OUT.mkdir(parents=True, exist_ok=True)
        self.tmp = OUT / f"{source}_{part}_X.tmp.npy"
        self.X = np.lib.format.open_memmap(self.tmp, "w+", np.uint8, (self.cap * 3 + 256, self.V, INPUT, INPUT, 3))
        self.y, self.size, self.group, self.n = [], [], [], 0
        self.n_obj = 0

    def full(self):
        return self.n_obj >= self.cap or self.n >= len(self.X) - 200

    def _put(self, versions, cls, size, group):
        if self.n >= len(self.X):
            return
        self.X[self.n] = versions
        self.y.append(int(cls)); self.size.append(float(size)); self.group.append(str(group)); self.n += 1

    def _versions(self, img, box):
        if self.V == 3:
            return np.stack([jittered(img, box, self.rng), jittered(img, box, self.rng), tiny_version(img, box, self.rng)])
        x1, y1, x2, y2 = box
        return cut(img, *square_for_box((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1), INPUT)[None]

    def add(self, img, boxes, group):
        """A full frame / photo with its labelled boxes."""
        if self.full():
            return
        w, h = img.size
        good = [b for b in boxes if b[2] - b[0] >= 2 and b[3] - b[1] >= 2]
        for x1, y1, x2, y2, c in good:
            self._put(self._versions(img, (x1, y1, x2, y2)), c, max(x2 - x1, y2 - y1), group)
            self.n_obj += 1
        for _ in range(self.bg):  # background squares that touch no labelled object
            for _try in range(30):
                live = float(self.rng.choice([32, 48, 64, 96, 128]))
                if live >= min(w, h):
                    break
                cx, cy = self.rng.uniform(live / 2, w - live / 2), self.rng.uniform(live / 2, h - live / 2)
                sq = (cx - live / 2, cy - live / 2, cx + live / 2, cy + live / 2)
                if all(iou(sq, b[:4]) < 0.02 and not (sq[0] - 4 < (b[0] + b[2]) / 2 < sq[2] + 4 and sq[1] - 4 < (b[1] + b[3]) / 2 < sq[3] + 4) for b in good):
                    s = live / 1.4
                    self._put(self._versions(img, (cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2)), 2, s, group)
                    break

    def add_crop(self, crop, cls, group):
        """A dataset that ships ready-made crops: the crop is treated as the live square around the object."""
        if self.full():
            return
        crop = crop.convert("RGB")
        s = max(crop.size)
        canvas = Image.new("RGB", (int(s * 1.0), int(s * 1.0)))
        canvas.paste(crop, ((s - crop.size[0]) // 2, (s - crop.size[1]) // 2))
        box = (s / 2 - s / 2.8, s / 2 - s / 2.8, s / 2 + s / 2.8, s / 2 + s / 2.8)  # live square = whole crop
        self._put(self._versions(canvas, box), cls, s / 1.4, group)
        self.n_obj += 1

    def close(self, extra_meta=None):
        X = np.lib.format.open_memmap(OUT / f"{self.source}_{self.part}_X.npy", "w+", np.uint8, (self.n,) + self.X.shape[1:])
        for i in range(0, self.n, 4096):
            X[i:min(i + 4096, self.n)] = self.X[i:min(i + 4096, self.n)]
        X.flush(); del X, self.X
        self.tmp.unlink()
        y = np.array(self.y, dtype=np.int64)
        np.savez(OUT / f"{self.source}_{self.part}_meta.npz", y=y, size=np.array(self.size, np.float32), group=np.array(self.group))
        info = {"source": self.source, "part": self.part, "crops": int(self.n), "bird": int((y == 0).sum()),
                "drone": int((y == 1).sum()), "other": int((y == 2).sum()), "groups": len(set(self.group)), **(extra_meta or {})}
        (OUT / f"{self.source}_{self.part}_info.json").write_text(json.dumps(info, indent=1))
        print(info, flush=True)
        return info


_REF = None


def leak_check(images, max_hamming=6):
    """Return the indices of PIL images that are near-duplicates of any frozen test image (Mendeley test,
    Svanström test frames). Uses the same pHash rule as benchmarks/leakage_check.py."""
    global _REF
    import imagehash
    if _REF is None:
        ref = []
        man = json.loads((REPO / "benchmarks" / "test_sets.json").read_text())
        for it in man["tiers"]["dataset"]["visual"]["items"]:
            with Image.open(REPO / it["path"]) as im:
                ref.append(int(str(imagehash.phash(im)), 16))
        cache = OUT / "svan_test_phash.npy"
        if cache.exists():
            ref += np.load(cache).tolist()
        _REF = np.array(ref, dtype=np.uint64)
    bad = []
    for i, im in enumerate(images):
        h = np.uint64(int(str(imagehash.phash(im)), 16))
        if np.bitwise_count(_REF ^ h).min() <= max_hamming:
            bad.append(i)
    return bad
