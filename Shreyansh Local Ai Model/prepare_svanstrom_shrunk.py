"""Shrunk test: the Svanström TEST clips with every object made exactly 7, 10 or 13 px.

    python3 prepare_svanstrom_shrunk.py     # writes data/shreyansh_crops_v3/svan_shrunk_{X.npy,meta.npz}

Why: real birds in the Svanström clips are 23-39 px, so there are almost no real 7-15 px birds to test on.
This shrinks the WHOLE frame (area averaging, like seeing it from further away) until the object's longest
side is the target size, then cuts the normal live crop (32 px minimum square). Background squares and
planes / helicopters get the same shrink, so the false-alarm rate is measured at the same scale.
Only TEST clips are used (never trained on). Every 6th frame.
"""
import json
import os
import sys
import zlib
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crops import INPUT, cut, square_for_box  # noqa: E402
from prepare_data import iou  # noqa: E402
from prepare_svanstrom import CLS, OUT, ROOT, read_labels  # noqa: E402

HERE = Path(__file__).resolve().parent
TARGETS = (7, 10, 13)


def process(r):
    import cv2
    cap = cv2.VideoCapture(str(ROOT / "Video_V" / f"{r['clip']}.mp4"))
    labels = read_labels(ROOT / "Video_V" / f"{r['clip']}_LABELS.mat")
    rng = np.random.default_rng(zlib.crc32(("shrunk" + r["clip"]).encode()))
    xs, ys, tg, f = [], [], [], 0
    while True:
        ok, frame = cap.read()
        if not ok or f >= len(labels):
            break
        if f % 6 == 0:
            img = Image.fromarray(frame[:, :, ::-1])
            w, h = img.size
            boxes = [(v[0], v[1], v[0] + v[2], v[1] + v[3], CLS[k]) for k, v in labels[f].items() if v and k in CLS and v[2] >= 1 and v[3] >= 1]
            for t in TARGETS:
                for x1, y1, x2, y2, c in boxes:
                    fct = min(1.0, t / max(x2 - x1, y2 - y1))
                    small = img.resize((max(1, round(w * fct)), max(1, round(h * fct))), Image.BOX)
                    xs.append(cut(small, *square_for_box((x1 + x2) / 2 * fct, (y1 + y2) / 2 * fct, (x2 - x1) * fct, (y2 - y1) * fct), INPUT))
                    ys.append(c); tg.append(t)
                # one background square at the scale a t-px object would have (shrink like a ~28 px bird)
                fct = t / 28.0
                small = img.resize((max(1, round(w * fct)), max(1, round(h * fct))), Image.BOX)
                sw, sh = small.size
                for _ in range(30):
                    cx, cy = rng.uniform(16, sw - 16), rng.uniform(16, sh - 16)
                    sq = (cx / fct - 16 / fct, cy / fct - 16 / fct, cx / fct + 16 / fct, cy / fct + 16 / fct)
                    if all(iou(sq, b[:4]) < 0.02 and not (sq[0] < (b[0] + b[2]) / 2 < sq[2] and sq[1] < (b[1] + b[3]) / 2 < sq[3]) for b in boxes):
                        xs.append(cut(small, cx, cy, 32, INPUT)); ys.append(2); tg.append(t); break
        f += 1
    return r, xs, ys, tg


def main():
    split = json.loads((HERE / "svanstrom_split.json").read_text())
    rows = [r for r in split["clips"] if r["part"] == "test"]
    with Pool(os.cpu_count()) as pool:
        res = pool.map(process, rows, chunksize=1)
    res = [x for x in res if x[1]]
    X = np.stack([c for x in res for c in x[1]])[:, None]
    y = np.array([v for x in res for v in x[2]], dtype=np.int64)
    target = np.array([v for x in res for v in x[3]], dtype=np.float32)
    clip = np.concatenate([np.full(len(x[2]), i) for i, x in enumerate(res)])
    np.save(OUT / "svan_shrunk_X.npy", X)
    np.savez(OUT / "svan_shrunk_meta.npz", y=y, size=target, clip=clip, clip_names=np.array([x[0]["clip"] for x in res]),
             youtube=np.array([x[0]["youtube"] for x in res]))
    for t in TARGETS:
        s = target == t
        print(f"{t} px: bird {(y[s] == 0).sum()}, drone {(y[s] == 1).sum()}, other {(y[s] == 2).sum()}")


if __name__ == "__main__":
    main()
