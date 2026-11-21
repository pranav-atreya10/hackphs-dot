"""IBERBIRDS -> v4 crops (source "iberbirds", every box is a bird, cls 0).

Dataset: "IBERBIRDS: A dataset of flying bird species present in the Iberian Peninsula",
https://zenodo.org/records/15090760, licence CC BY 4.0. 4,000 photos (10 species x 400) of flying birds,
one YOLO .txt per image (class = species id 0-9; we map every species to cls 0 = bird).

Download: the single IBERBIRDS_dataset.zip (4,566,494,643 bytes) is fetched with parallel HTTP range
requests (one connection to this host is ~1-2 MB/s here) into data/v4raw/iberbirds/, and its published
MD5 (379d49674e798d9e115268ed08652c77) is verified. Images are read straight out of the zip (no
extraction, so the raw data on disk never exceeds the 4.6 GB archive). The archive is deleted at the end.

Groups: these are single photos, not video, but a photographer's burst of the same bird gives runs of
near-identical consecutive shots. Group = species folder + file-name stem with its trailing number cut to
blocks of 10 (e.g. "<species>/<prefix>_0123" -> "<species>/<prefix>_12"), so consecutive file numbers
(a burst) stay on one side of the split. If a file name has no number, the stem itself is the group.
Parts come from common.split_part(group) (80/10/10 train/select/test).

Run:  cd "Shreyansh Local Ai Model" && OMP_NUM_THREADS=1 nice -n 10 python3 -I sources/iberbirds.py
"""
import hashlib
import io
import json
import re
import sys
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SOURCE = "iberbirds"
URL = "https://zenodo.org/api/records/15090760/files/IBERBIRDS_dataset.zip/content"
SIZE = 4566494643
MD5 = "379d49674e798d9e115268ed08652c77"
RAWDIR = common.RAW / SOURCE
ZIP = RAWDIR / "IBERBIRDS_dataset.zip"
IMG_EXT = (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp")


def ranged_download(url, dest, size, workers=6, chunk=32 << 20):
    """Parallel HTTP range download into a preallocated file; finished chunks are logged so a rerun resumes."""
    done_log = dest.with_suffix(dest.suffix + ".chunks")
    done = set(json.loads(done_log.read_text())) if done_log.exists() and dest.exists() else set()
    if not dest.exists():
        with open(dest, "wb") as f:
            f.truncate(size)
        done_log.write_text("[]")
    lock = threading.Lock()
    starts = [s for s in range(0, size, chunk) if s not in done]

    def get(start):
        end = min(start + chunk, size) - 1
        for attempt in range(8):
            try:
                r = requests.get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=120, allow_redirects=True)
                r.raise_for_status()
                if r.status_code != 206 or len(r.content) != end - start + 1:
                    raise IOError(f"bad range reply {r.status_code} {len(r.content)}")
                with open(dest, "r+b") as f:
                    f.seek(start); f.write(r.content)
                with lock:
                    done.add(start); done_log.write_text(json.dumps(sorted(done)))
                    print(f"  {len(done) * chunk / 1e9:.2f} / {size / 1e9:.2f} GB", flush=True) if len(done) % 10 == 0 else None
                return
            except Exception as e:  # noqa: BLE001
                print(f"  retry {start} ({e})", flush=True)
        raise IOError(f"chunk {start} failed")

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(get, starts))


def file_hash(path, algo):
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(8 << 20), b""):
            h.update(b)
    return h.hexdigest()


def group_of(name):
    p = Path(name)
    stem, folder = p.stem, p.parent.name
    m = re.match(r"^(.*?)(\d+)$", stem)
    return f"{folder}/{m.group(1)}{int(m.group(2)) // 10}" if m else f"{folder}/{stem}"


def read_yolo(text, w, h):
    boxes = []
    for line in text.splitlines():
        v = line.split()
        if len(v) < 5:
            continue
        cx, cy, bw, bh = (float(t) for t in v[1:5])
        x1, y1 = max(0.0, (cx - bw / 2) * w), max(0.0, (cy - bh / 2) * h)
        x2, y2 = min(float(w), (cx + bw / 2) * w), min(float(h), (cy + bh / 2) * h)
        if x2 > x1 and y2 > y1:
            boxes.append((x1, y1, x2, y2, 0))
    return boxes


def main():
    RAWDIR.mkdir(parents=True, exist_ok=True)
    ok_flag = RAWDIR / "md5_ok"
    if not ok_flag.exists():
        if not ZIP.exists() or (ZIP.with_suffix(".zip.chunks")).exists():
            print("downloading", URL, flush=True)
            ranged_download(URL, ZIP, SIZE)
        assert ZIP.stat().st_size == SIZE, "size mismatch"
        got = file_hash(ZIP, "md5")
        print("md5", got, "OK" if got == MD5 else "MISMATCH", flush=True)
        if got != MD5:
            sys.exit("checksum mismatch: delete the zip and rerun")
        ok_flag.write_text(got)
        ZIP.with_suffix(".zip.chunks").unlink(missing_ok=True)
    if "--download-only" in sys.argv:
        return

    z = zipfile.ZipFile(ZIP)
    names = set(z.namelist())
    imgs = sorted(n for n in names if n.lower().endswith(IMG_EXT) and "__MACOSX" not in n)
    print("images in zip", len(imgs), flush=True)

    def label_for(n):
        stem = n.rsplit(".", 1)[0]
        cands = [stem + ".txt", stem.replace("/images/", "/labels/") + ".txt"]
        for c in cands:
            if c in names:
                return c
        return None

    writers = {p: common.CropWriter(SOURCE, p) for p in ("train", "select", "test")}
    stats = {"images": len(imgs), "used": 0, "leak_skipped": 0, "no_label": 0, "empty": 0, "cap_skipped": 0}
    sizes = []
    rng = np.random.default_rng(0)
    order = list(imgs)
    rng.shuffle(order)  # species folders interleaved, so a cap (if hit) does not cut whole species
    B = 64
    for i in range(0, len(order), B):
        if all(w.full() for w in writers.values()):
            break
        batch = []
        for n in order[i:i + B]:
            lab = label_for(n)
            if lab is None:
                stats["no_label"] += 1
                continue
            with z.open(n) as f:
                img = Image.open(io.BytesIO(f.read())).convert("RGB")
            boxes = read_yolo(z.read(lab).decode("utf-8", "ignore"), *img.size)
            if not boxes:
                stats["empty"] += 1
                continue
            batch.append((n, img, boxes))
        bad = set(common.leak_check([b[1] for b in batch]))
        stats["leak_skipped"] += len(bad)
        for k, (n, img, boxes) in enumerate(batch):
            if k in bad:
                continue
            g = group_of(n)
            w = writers[common.split_part(g)]
            if w.full():
                stats["cap_skipped"] += 1
                continue
            w.add(img, boxes, g)
            stats["used"] += 1
            sizes += [max(b[2] - b[0], b[3] - b[1]) for b in boxes if b[2] - b[0] >= 2 and b[3] - b[1] >= 2]
        print(f"  {min(i + B, len(order))}/{len(order)} {stats}", flush=True)
    sizes = np.array(sizes)
    pct = {f"bird_px_p{q}": round(float(np.percentile(sizes, q)), 1) for q in (10, 50, 90)} if len(sizes) else {}
    pct["bird_7_15px_frac"] = round(float(((sizes >= 7) & (sizes <= 15)).mean()), 4) if len(sizes) else 0.0
    for p, w in writers.items():
        w.close(extra_meta={"licence": "CC BY 4.0", "url": "https://zenodo.org/records/15090760"})
    print("STATS", json.dumps({**stats, **pct, "boxes": int(len(sizes))}), flush=True)
    z.close()
    # clean up: only inside data/v4raw/iberbirds/
    for f in RAWDIR.iterdir():
        f.unlink()
    RAWDIR.rmdir()
    print("deleted", RAWDIR, flush=True)


if __name__ == "__main__":
    main()
