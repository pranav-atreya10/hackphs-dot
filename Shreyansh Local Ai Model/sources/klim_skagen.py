"""Klim / Skagen wind-farm birds -> v4 crops (source "klim_skagen", every box is a bird, cls 0).

Dataset: "Birds in wind farms" (Mid Sweden University), https://researchdata.se/en/catalogue/dataset/2021-316-1,
DOI 10.5878/x1cm-pq40, licence CC BY 4.0. Cite: "A Temporal Boosted YOLO-Based Model for Birds Detection
around Wind Farms". Frames from wide-angle monochrome cameras (stored as 3-channel JPEG/PNG; we force RGB
with 3 identical channels), one YOLO .txt per frame.

Which files (checked through HTTP range reads of the zip directories before choosing):
  - k-fold.zip (1.74 GB) holds only 1,400 unique 1920x1080 TILES (frame<N>_<row>_<col>: each 4K frame cut
    in 2x2) from 601 frame numbers, copied into 6 folds. Not used.
  - models-Klim.zip (1.91 GB, SHA-256 published) -> model1.zip -> obj.zip holds 1,433 full 3840x2160
    frames (frame<N>.jpg) whose frame numbers are a superset of every tile in k-fold / model2 / model3
    (checked: a model1 box maps exactly onto the k-fold tile box). So model1 alone = all Klim content,
    uncut. model2/model3 (tiles of the same frames) are skipped as duplicates.
  - Test-Skagen.zip (32 MB, SHA-256 published): test-m1.zip = 92 full Skagen frames (frame<N>.jpg), used;
    test-m3.zip = 130 tiles (frame<N>_<r>_<c>) - used only if their frame number is not in test-m1.
Both archives are fetched with parallel HTTP range requests (one connection to this host is ~0.4 MB/s)
into data/v4raw/klim_skagen/, SHA-256 verified, and read in place (the nested zips are STORED, so no
extraction is needed). Everything in data/v4raw/klim_skagen/ is deleted at the end.

Groups: the frames are numbered stills from continuous video, so neighbouring frame numbers are
near-identical. Group = "<site>/<frame number // 50>" (blocks of 50 consecutive frame numbers; site =
klim or skagen), so a burst of similar frames never straddles train/select/test except at block edges.
Parts come from common.split_part(group).

Run:  cd "Shreyansh Local Ai Model" && OMP_NUM_THREADS=1 nice -n 10 python3 -I sources/klim_skagen.py
"""
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from iberbirds import file_hash, ranged_download  # noqa: E402  (same parallel range downloader)

SOURCE = "klim_skagen"
BASE = "https://miun.open.care.snd.se/downloads/public/2021-316-1/1/data/"
FILES = {  # name: (bytes, sha256) from https://api.researchdata.se/dataset/2021-316-1
    "models-Klim.zip": (1911837887, "da270905c3a2ca4bfeb6cae331aaa2819dbdf57eeae9c65f76253d7c1ac9aa27"),
    "Test-Skagen.zip": (32211402, "0a7a57f1004db44017eda13ae426241040fccdfbbc74d046c92e1cd203a0ac1a"),
}
RAWDIR = common.RAW / SOURCE
BLOCK = 50


def fetch():
    RAWDIR.mkdir(parents=True, exist_ok=True)
    for name, (size, sha) in FILES.items():
        dest, ok = RAWDIR / name, RAWDIR / (name + ".sha_ok")
        if ok.exists():
            continue
        if not dest.exists() or dest.with_suffix(".zip.chunks").exists():
            print("downloading", name, flush=True)
            ranged_download(BASE + name, dest, size, workers=10, chunk=16 << 20)
        assert dest.stat().st_size == size, "size mismatch"
        got = file_hash(dest, "sha256")
        print(name, "sha256", got, "OK" if got == sha else "MISMATCH", flush=True)
        if got != sha:
            sys.exit("checksum mismatch: delete the file and rerun")
        ok.write_text(got)
        dest.with_suffix(".zip.chunks").unlink(missing_ok=True)


def nested(outer, *path):
    z = outer
    for p in path:
        z = zipfile.ZipFile(z.open(p))
    return z


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


def items():
    """Yield (site, frame number, zipfile, image name, label name)."""
    mk = zipfile.ZipFile(RAWDIR / "models-Klim.zip")
    z1 = nested(mk, "models-Klim/model1.zip", "model1/obj.zip")
    out = []
    for n in sorted(z1.namelist()):
        m = re.match(r"frame(\d+)\.(jpg|png)$", n.rsplit("/", 1)[-1])
        if m:
            out.append(("klim", int(m.group(1)), z1, n, n.rsplit(".", 1)[0] + ".txt"))
    ts = zipfile.ZipFile(RAWDIR / "Test-Skagen.zip")
    zm1 = nested(ts, "Test-Skagen/test-m1.zip")
    full = set()
    for n in sorted(zm1.namelist()):
        m = re.match(r"frame(\d+)\.(jpg|png)$", n.rsplit("/", 1)[-1])
        if m:
            full.add(int(m.group(1)))
            out.append(("skagen", int(m.group(1)), zm1, n, n.rsplit(".", 1)[0] + ".txt"))
    zm3 = nested(ts, "Test-Skagen/test-m3.zip")
    for n in sorted(zm3.namelist()):
        m = re.match(r"frame(\d+)_\d+_\d+\.(jpg|png)$", n.rsplit("/", 1)[-1])
        if m and int(m.group(1)) not in full:
            out.append(("skagen", int(m.group(1)), zm3, n, n.rsplit(".", 1)[0] + ".txt"))
    return out


def main():
    fetch()
    if "--download-only" in sys.argv:
        return
    its = items()
    print("frames", len(its), {s: sum(i[0] == s for i in its) for s in ("klim", "skagen")}, flush=True)
    writers = {p: common.CropWriter(SOURCE, p) for p in ("train", "select", "test")}
    stats = {"images": len(its), "used": 0, "leak_skipped": 0, "no_label": 0, "empty": 0, "cap_skipped": 0}
    sizes = []
    B = 32
    for i in range(0, len(its), B):
        if all(w.full() for w in writers.values()):
            break
        batch = []
        for site, num, z, n, lab in its[i:i + B]:
            try:
                txt = z.read(lab).decode("utf-8", "ignore")
            except KeyError:
                stats["no_label"] += 1
                continue
            img = Image.open(io.BytesIO(z.read(n))).convert("L").convert("RGB")  # monochrome -> 3 equal channels
            boxes = read_yolo(txt, *img.size)
            if not boxes:  # frames with no bird still give background (other) squares
                stats["empty"] += 1
            batch.append((f"{site}/{num // BLOCK}", img, boxes))
        bad = set(common.leak_check([b[1] for b in batch]))
        stats["leak_skipped"] += len(bad)
        for k, (g, img, boxes) in enumerate(batch):
            if k in bad:
                continue
            w = writers[common.split_part(g)]
            if w.full():
                stats["cap_skipped"] += 1
                continue
            w.add(img, boxes, g)
            stats["used"] += 1
            sizes += [max(b[2] - b[0], b[3] - b[1]) for b in boxes if b[2] - b[0] >= 2 and b[3] - b[1] >= 2]
        print(f"  {min(i + B, len(its))}/{len(its)} {stats}", flush=True)
    sizes = np.array(sizes)
    pct = {f"bird_px_p{q}": round(float(np.percentile(sizes, q)), 1) for q in (10, 50, 90)} if len(sizes) else {}
    pct["bird_7_15px_frac"] = round(float(((sizes >= 7) & (sizes <= 15)).mean()), 4) if len(sizes) else 0.0
    for p, w in writers.items():
        w.close(extra_meta={"licence": "CC BY 4.0", "url": "https://researchdata.se/en/catalogue/dataset/2021-316-1"})
    print("STATS", json.dumps({**stats, **pct, "boxes": int(len(sizes))}), flush=True)
    for f in RAWDIR.iterdir():  # clean up: only inside data/v4raw/klim_skagen/
        f.unlink()
    RAWDIR.rmdir()
    print("deleted", RAWDIR, flush=True)


if __name__ == "__main__":
    main()
