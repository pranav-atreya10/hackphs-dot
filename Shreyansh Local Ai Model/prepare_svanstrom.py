"""Crops from the Svanström drone detection dataset (CC0) for v3: real distant birds, drones, planes, helicopters.

    python3 prepare_svanstrom.py     # writes data/shreyansh_crops_v3/ and svanstrom_split.json

Source: Zenodo record 5500576, Drone-detection-dataset-v1.0.0.zip (md5 5d9b891a87857b3d9ee8872e8a1f0f0f),
unzipped into data/svanstrom/extracted/. Only the visible-light videos (Data/Video_V, 640x512) are used.
The 49 clips whose source is a YouTube channel (38 helicopter, 11 airplane) go to TEST ONLY (the user's
choice): they are never trained on, and they are reported as their own row.

Labels are MATLAB "groundTruth" objects; read_labels() decodes them with scipy (no MATLAB needed):
one [x y w h] box per frame (MATLAB pixels start at 1), under the class name.

Classes: BIRD -> bird, DRONE -> drone, AIRPLANE and HELICOPTER -> other (things that are NOT a bird or drone),
plus one background square per sampled frame (other).

Split by WHOLE CLIP (never frames of one clip on both sides), per class and distance bin, fixed seed:
  train 65% | select 15% (picks the best epoch) | test 20% (reported, never used for any decision).
Train clips: every 4th frame, versions [jittered, jittered, tiny] like prepare_v2.py.
Select / test clips: every 3rd frame, one centre crop at the object's real size (no shrinking), so the
size bins in the results are real distances, not simulated.
"""
import collections
import hashlib
import io
import json
import zlib
import os
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.io as sio
from PIL import Image
from scipy.io.matlab import _mio5 as M

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crops import INPUT, cut, square_for_box  # noqa: E402
from prepare_data import iou  # noqa: E402
from prepare_v2 import jittered, tiny_version  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent / "data" / "svanstrom" / "extracted" / "DroneDetectionThesis-Drone-detection-dataset-e7a6eaf" / "Data"
OUT = HERE.parent / "data" / "shreyansh_crops_v3"
SEED = 31
CLS = {"BIRD": 0, "DRONE": 1, "AIRPLANE": 2, "HELICOPTER": 2}


def _load_store(path):
    ws = sio.loadmat(path)["__function_workspace__"].tobytes()
    hdr = b"MATLAB 5.0 MAT-file".ljust(116, b" ") + b"\x00" * 8 + ws[:4]
    r = M.MatFile5Reader(io.BytesIO(hdr + ws[8:]), struct_as_record=False, squeeze_me=False)
    r.mat_stream.seek(0); r.initialize_read(); r.mat_stream.seek(128)
    h, _ = r.read_var_header()
    return r.read_var_array(h, process=True)


def _walk(x, path, out):
    if isinstance(x, np.ndarray) and x.dtype.names:
        for n in x.dtype.names:
            for i, y in enumerate(x[n].flat):
                _walk(y, f"{path}.{n}[{i}]", out)
    elif isinstance(x, np.ndarray) and x.dtype == object:
        for i, y in enumerate(x.flat):
            _walk(y, f"{path}[{i}]", out)
    elif hasattr(x, "_fieldnames"):
        for n in x._fieldnames:
            _walk(getattr(x, n), f"{path}.{n}", out)
    elif isinstance(x, np.ndarray):
        out.append((path, x))


def read_labels(path):
    """List (one entry per video frame) of {CLASS: [x0, y0, w, h] in 0-based pixels, or None}."""
    out = []
    _walk(_load_store(path), "", out)
    per = collections.OrderedDict()
    for p, a in out:
        if ".LabelData" in p and a.dtype.kind == "f":
            key, lab = p.rsplit(".", 1)
            box = a.ravel()[:4].astype(float).tolist() if a.size == 4 else None
            if box:
                box[0] -= 1; box[1] -= 1
            per.setdefault(key, {})[lab.split("[")[0]] = box
    return list(per.values())


def clips():
    df = pd.read_excel(ROOT / "Video_dataset_description.xlsx")
    df = df[df.SENSOR.astype(str).str.strip().str.upper() == "V"]
    rows = []
    for _, r in df.iterrows():
        name = f"V_{str(r.CLASS).strip().upper()}_{int(r.NUMBER):03d}"
        internet = bool(pd.Series([str(r["DRONE TYPE / INTERNET SOURCE"])]).str.contains("youtu|http|www", case=False)[0])
        rows.append({"clip": name, "cls": str(r.CLASS).strip().upper(), "distance": str(r["DISTANCE  BIN"]).strip().upper(),
                     "youtube": internet})
    return rows


def split(rows):
    rng = np.random.default_rng(SEED)
    groups = collections.defaultdict(list)
    for r in rows:
        if r["youtube"]:
            r["part"] = "test"  # user's choice: YouTube-sourced clips are used for testing only, never training
            continue
        groups[(r["cls"], r["distance"])].append(r)
    for key in sorted(groups):
        g = sorted(groups[key], key=lambda r: r["clip"])
        order = rng.permutation(len(g))
        n_test = max(1, round(0.20 * len(g))); n_sel = max(1, round(0.15 * len(g))) if len(g) >= 3 else 0
        for rank, i in enumerate(order):
            g[i]["part"] = "test" if rank < n_test else "select" if rank < n_test + n_sel else "train"
    return rows


def process(r):
    import cv2
    cap = cv2.VideoCapture(str(ROOT / "Video_V" / f"{r['clip']}.mp4"))
    labels = read_labels(ROOT / "Video_V" / f"{r['clip']}_LABELS.mat")
    step = 4 if r["part"] == "train" else 3
    rng = np.random.default_rng(zlib.crc32(r["clip"].encode()))  # stable across runs (v3 data was built with Python hash(), so its background squares differ per run)
    xs, ys, size, frame_ids = [], [], [], []
    f = 0
    while True:
        ok, frame = cap.read()
        if not ok or f >= len(labels):
            break
        if f % step == 0:
            img = Image.fromarray(frame[:, :, ::-1])
            w, h = img.size
            boxes = [(v[0], v[1], v[0] + v[2], v[1] + v[3], CLS[k]) for k, v in labels[f].items() if v and k in CLS and v[2] >= 1 and v[3] >= 1]
            items = [((x1, y1, x2, y2), c) for x1, y1, x2, y2, c in boxes]
            for _ in range(30):  # one background square away from every labelled object
                live = float(rng.choice([32, 40, 48, 64, 96]))
                cx, cy = rng.uniform(live / 2, w - live / 2), rng.uniform(live / 2, h - live / 2)
                sq = (cx - live / 2, cy - live / 2, cx + live / 2, cy + live / 2)
                if all(iou(sq, b[:4]) < 0.02 and not (sq[0] - 8 < (b[0] + b[2]) / 2 < sq[2] + 8 and sq[1] - 8 < (b[1] + b[3]) / 2 < sq[3] + 8) for b in boxes):
                    s = live / 1.4
                    items.append(((cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2), 2)); break
            for box, c in items:
                x1, y1, x2, y2 = box
                if r["part"] == "train":
                    xs.append(np.stack([jittered(img, box, rng), jittered(img, box, rng), tiny_version(img, box, rng)]))
                else:
                    xs.append(cut(img, *square_for_box((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1), INPUT)[None])
                ys.append(c); size.append(max(x2 - x1, y2 - y1)); frame_ids.append(f)
        f += 1
    return r, xs, ys, size, frame_ids


def main():
    rows = split(clips())
    OUT.mkdir(parents=True, exist_ok=True)
    with Pool(os.cpu_count()) as pool:
        results = pool.map(process, rows, chunksize=1)
    summary = {}
    for part in ("train", "select", "test"):
        res = [x for x in results if x[0]["part"] == part]
        X = np.concatenate([np.stack(x[1]) for x in res if x[1]])
        y = np.concatenate([np.array(x[2], dtype=np.int64) for x in res if x[1]])
        size = np.concatenate([np.array(x[3], dtype=np.float32) for x in res if x[1]])
        clip = np.concatenate([np.full(len(x[2]), i) for i, x in enumerate(res) if x[1]])
        names = np.array([x[0]["clip"] for x in res])
        np.save(OUT / f"svan_{part}_X.npy", X)
        np.savez(OUT / f"svan_{part}_meta.npz", y=y, size=size, clip=clip, clip_names=names,
                 distance=np.array([x[0]["distance"] for x in res]), youtube=np.array([x[0]["youtube"] for x in res]))
        summary[part] = {"clips": len(res), "crops": int(len(y)), "bird": int((y == 0).sum()), "drone": int((y == 1).sum()),
                         "other": int((y == 2).sum()), "bird_size_px_p10_p50_p90": np.percentile(size[y == 0], [10, 50, 90]).round(1).tolist() if (y == 0).any() else None}
        print(part, summary[part], flush=True)
    manifest = {"source": "Zenodo 5500576 Drone-detection-dataset-v1.0.0.zip (CC0 1.0), visible videos; YouTube-sourced clips test-only",
                "seed": SEED, "clips": rows,
                "video_sha256": {r["clip"]: hashlib.sha256((ROOT / "Video_V" / f"{r['clip']}.mp4").read_bytes()).hexdigest() for r in rows},
                "summary": summary}
    (HERE / "svanstrom_split.json").write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
