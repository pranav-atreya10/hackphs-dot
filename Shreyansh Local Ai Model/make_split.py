"""Make a clean validation set from the TRAIN split (the published valid split is unusable).

    python3 make_split.py      # after prepare_data.py; writes data/shreyansh_crops/{fit,holdout}.npz + split.json

Why: 1,565 of the 1,740 Mendeley VALID images are near-duplicates (pHash Hamming <= 6) of FROZEN TEST
images, and 11 are byte-identical. Choosing the best epoch on that valid split would be peeking at
the test set. So:
  1. pHash every train image. Images are grouped into "sequences": consecutive file numbers that look
     alike (Hamming <= 12) and any two images anywhere that are near-duplicates (Hamming <= 8).
  2. Train images that are within Hamming 12 of any frozen test image are dropped completely.
  3. About 12% of the sequences (chosen at random, fixed seed, separately for bird and drone) become
     the holdout used to pick the best epoch; holdout images are also checked against the test set.
  4. Everything else is the training set ("fit").
The crops themselves come from train.npz (made by prepare_data.py); nothing is cut again.
"""
import json
import os
import re
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SRC = REPO / "data" / "mendeley" / "Dataset" / "train" / "images"
CROPS = REPO / "data" / "shreyansh_crops"
SEED = 11
HOLDOUT_FRACTION = 0.12


def phash(path):
    import imagehash
    from PIL import Image
    with Image.open(path) as im:
        return int(str(imagehash.phash(im)), 16)


def hamming(a, b):
    return np.bitwise_count(np.bitwise_xor(a, b))


class Groups:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def join(self, a, b):
        self.p[self.find(a)] = self.find(b)


def main():
    tr = np.load(CROPS / "train.npz")
    names = list(tr["names"])
    with Pool(os.cpu_count()) as pool:
        h = np.array(pool.map(phash, [SRC / n for n in names], chunksize=128), dtype=np.uint64)
    manifest = json.loads((REPO / "benchmarks" / "test_sets.json").read_text())
    test_items = manifest["tiers"]["dataset"]["visual"]["items"]
    with Pool(os.cpu_count()) as pool:
        th = np.array(pool.map(phash, [REPO / i["path"] for i in test_items], chunksize=64), dtype=np.uint64)

    near_test = np.array([hamming(h[i], th).min() for i in range(len(h))])
    g = Groups(len(names))
    key = lambda n: (n.split(" ")[0], int(re.search(r"\((\d+)\)", n).group(1)))  # noqa: E731
    order = sorted(range(len(names)), key=lambda i: key(names[i]))
    for a, b in zip(order, order[1:]):  # consecutive frames of one video
        if key(names[a])[0] == key(names[b])[0] and hamming(h[a], h[b]) <= 12:
            g.join(a, b)
    for i in range(len(h)):  # near-duplicates anywhere
        for j in np.nonzero(hamming(h[i], h[i + 1:]) <= 8)[0]:
            g.join(i, i + 1 + int(j))
    group = np.array([g.find(i) for i in range(len(names))])

    dropped = set(np.nonzero(near_test <= 12)[0].tolist())
    rng = np.random.default_rng(SEED)
    holdout = set()
    for prefix in ("B", "D"):
        gs = sorted({int(group[i]) for i in range(len(names)) if names[i].startswith(prefix) and i not in dropped})
        n_images = {k: 0 for k in gs}
        for i in range(len(names)):
            if int(group[i]) in n_images and i not in dropped:
                n_images[int(group[i])] += 1
        target, taken = HOLDOUT_FRACTION * sum(n_images.values()), 0
        for k in rng.permutation(gs):
            if taken >= target:
                break
            if n_images[int(k)] > 400:  # keep any one huge sequence out of the holdout
                continue
            holdout.add(int(k)); taken += n_images[int(k)]

    img_set = {i: ("drop" if i in dropped else "holdout" if int(group[i]) in holdout else "fit") for i in range(len(names))}
    crop_img = tr["group"]
    for part in ("fit", "holdout"):
        mask = np.array([img_set[int(i)] == part for i in crop_img])
        np.savez(CROPS / f"{part}.npz", X=tr["X"][mask], y=tr["y"][mask], size=tr["size"][mask],
                 group=group[crop_img[mask]], image=crop_img[mask], names=tr["names"])
        print(f"{part}: {mask.sum()} crops from {sum(v == part for v in img_set.values())} images "
              f"(bird {(tr['y'][mask] == 0).sum()}, drone {(tr['y'][mask] == 1).sum()}, other {(tr['y'][mask] == 2).sum()})")
    report = {
        "rule": "groups = consecutive frames with pHash Hamming <= 12, plus any pair <= 8; "
                "train images within Hamming 12 of a frozen test image are dropped",
        "n_train_images": len(names), "n_groups": int(len(set(group.tolist()))),
        "dropped_near_test": sorted(names[i] for i in dropped),
        "holdout_images": sorted(names[i] for i, v in img_set.items() if v == "holdout"),
        "min_hamming_holdout_to_test": int(min((near_test[i] for i, v in img_set.items() if v == "holdout"), default=99)),
        "seed": SEED,
    }
    (HERE / "split.json").write_text(json.dumps(report, indent=1))
    print(f"groups {report['n_groups']}, dropped near test {len(dropped)}, "
          f"closest holdout image to test: Hamming {report['min_hamming_holdout_to_test']}")


if __name__ == "__main__":
    sys.exit(main())
