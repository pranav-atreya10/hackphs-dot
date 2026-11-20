"""DUT Anti-UAV, detection part -> v4 crops (source "dut_anti_uav").

    OMP_NUM_THREADS=1 nice -n 10 python3 -I "Shreyansh Local Ai Model/sources/dut_anti_uav.py"

Dataset: Jie Zhao, Jingshu Zhang, Dongdong Li, Dong Wang (Dalian University of Technology), "Vision-based
Anti-UAV Detection and Tracking", arXiv 2205.10851. Licence: Apache-2.0 (LICENSE of
github.com/wangdongdut/DUT-Anti-UAV). Mirror used: huggingface.co/datasets/aegean-ai/dut-anti-uav, whose
zips are byte-for-byte the authors' Google Drive zips; the SHA-256 values below are from that README.
10,000 visible-light images (5,200 / 2,600 / 2,200 in the authors' train / val / test), Pascal VOC XML,
one class "UAV" -> our class 1 (drone). The authors' split is NOT ours: we use all three zips.

Groups (which frames must stay on one side of the split)
--------------------------------------------------------
The zips carry no video / sequence id, and the file numbers are shuffled: consecutive numbers are
almost never similar frames (measured: consecutive pHash distance is ~30 of 64 bits), so "consecutive file
numbers" would not keep a video together. But many images ARE frames of the same video: 7,014 of the 10,000
have another image of the same size with an identical 64-bit pHash, and these twins are spread over all three
of the authors' splits. So the groups are built from the images themselves:
  two images are linked when they have the same pixel size AND (pHash Hamming distance <= 10 OR the
  correlation of their 16x16 grey thumbnails >= 0.995); a group is a connected component of these links.
On this data that gives about 1,930 groups (largest ~176 images, ~1,600 single web photos). A looser rule
(pHash <= 14) starts chaining unrelated 1920x1080 sky frames into one 2,000+ image component, so 10 is the
loosest threshold that still makes video-sized groups. The group key is "dut:<first file in the group>".
Moving-camera clips whose frames differ by more than this can still be split; that risk remains.

Leakage: every image goes through common.leak_check (pHash <= 6 against the frozen Mendeley test images and
the Svanstrom test frames). If any image of a group is a near-duplicate, the WHOLE group is dropped
(protocol: remove the whole source clip, not only the matching frame).

Disk: the zips are verified, extracted into data/v4raw/dut_anti_uav/extracted/, the zips are deleted after
extraction, and the extracted images are deleted at the end.
"""
import hashlib
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SOURCE = "dut_anti_uav"
LICENCE = "Apache-2.0"
BASE = "https://huggingface.co/datasets/aegean-ai/dut-anti-uav/resolve/main/detection/"
SHA = {
    "train": "14f927290556df60e23cedfa80dffc10dc21e4a3b6843e150cfc49644376eece",
    "val": "238be0ceb3e7c5be6711ee3247e49df2750d52f91f54f5366c68bebac112ebf8",
    "test": "a671989a01cff98c684aeb084e59b86f4152c50499d86152eb970a9fc7fb1cbe",
}
RAWDIR = common.RAW / SOURCE
EXTRACT = RAWDIR / "extracted"
PH_T, CORR_T = 10, 0.995
Image.MAX_IMAGE_PIXELS = 300_000_000


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download():
    RAWDIR.mkdir(parents=True, exist_ok=True)
    marker = EXTRACT / ".done"
    if marker.exists():
        print("already extracted", flush=True)
        return
    for split, want in SHA.items():
        z = RAWDIR / f"{split}.zip"
        if not (z.exists() and sha256(z) == want):
            subprocess.run(["curl", "-sSL", "--retry", "5", "-C", "-", "-o", str(z), BASE + f"{split}.zip"], check=True)
        got = sha256(z)
        if got != want:
            raise SystemExit(f"SHA-256 mismatch for {z.name}: {got}")
        print(f"{z.name}: SHA-256 verified ({z.stat().st_size} bytes)", flush=True)
    EXTRACT.mkdir(exist_ok=True)
    for split in SHA:
        z = RAWDIR / f"{split}.zip"
        with zipfile.ZipFile(z) as zf:  # zipfile strips absolute paths and '..'
            for m in zf.namelist():
                if m.endswith((".jpg", ".xml")):
                    zf.extract(m, EXTRACT)
        z.unlink()
    marker.touch()


def read_xml(path, w, h):
    boxes = []
    for o in ET.parse(path).getroot().iter("object"):
        if o.findtext("name", "").strip().upper() != "UAV":
            print("unexpected class", o.findtext("name"), path, flush=True)
            continue
        b = o.find("bndbox")
        x1, y1, x2, y2 = (float(b.findtext(k)) for k in ("xmin", "ymin", "xmax", "ymax"))
        x1, x2 = max(0.0, min(x1, x2)), min(float(w), max(x1, x2))
        y1, y2 = max(0.0, min(y1, y2)), min(float(h), max(y1, y2))
        boxes.append((x1, y1, x2, y2, 1))
    return boxes


def image_list():
    out = []
    for split in SHA:
        for p in sorted((EXTRACT / split / "img").glob("*.jpg")):
            out.append((f"{split}/{p.stem}", p, EXTRACT / split / "xml" / f"{p.stem}.xml"))
    return out


def load(p):
    with Image.open(p) as im:
        return im.convert("RGB")


def pass1(items):
    """pHash + thumbnail per image (for grouping) and the frozen-test leak check."""
    import imagehash
    n = len(items)
    ph = np.zeros(n, np.uint64)
    th = np.zeros((n, 256), np.float32)
    size = np.zeros((n, 2), np.int32)
    leak = np.zeros(n, bool)
    batch, idx = [], []
    for i, (_, p, _) in enumerate(items):
        img = load(p)
        size[i] = img.size
        ph[i] = np.uint64(int(str(imagehash.phash(img)), 16))
        th[i] = np.asarray(img.convert("L").resize((16, 16), Image.BILINEAR), np.float32).ravel()
        batch.append(img); idx.append(i)
        if len(batch) == 32 or i == n - 1:
            for j in common.leak_check(batch):
                leak[idx[j]] = True
            batch, idx = [], []
        if i % 1000 == 0:
            print(f"pass 1: {i}/{n}", flush=True)
    return ph, th, size, leak


def groups(names, ph, th, size):
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components
    t = th - th.mean(1, keepdims=True)
    t /= np.linalg.norm(t, axis=1, keepdims=True) + 1e-6
    rows, cols = [], []
    for i in range(len(ph)):  # row by row, so no 10k x 10k matrices in memory
        same = (size[:, 0] == size[i, 0]) & (size[:, 1] == size[i, 1])
        link = same & ((np.bitwise_count(ph ^ ph[i]) <= PH_T) | (t @ t[i] >= CORR_T))
        j = np.nonzero(link)[0]
        rows += [i] * len(j); cols += j.tolist()
    A = csr_matrix((np.ones(len(rows), np.int8), (rows, cols)), shape=(len(ph), len(ph)))
    _, lab = connected_components(A, directed=False)
    first = {}
    for i, l in enumerate(lab):
        first.setdefault(l, names[i])
    return [f"dut:{first[l]}" for l in lab]


def main():
    download()
    items = image_list()
    names = [it[0] for it in items]
    print(f"{len(items)} images", flush=True)
    ph, th, size, leak = pass1(items)
    grp = groups(names, ph, th, size)
    leak_groups = {grp[i] for i in np.nonzero(leak)[0]}
    gsize = Counter(grp)
    print(f"groups: {len(gsize)}, largest {gsize.most_common(3)}", flush=True)
    print(f"leak_check: {int(leak.sum())} near-duplicate images in {len(leak_groups)} groups; "
          f"{sum(gsize[g] for g in leak_groups)} images dropped with their groups", flush=True)

    writers = {p: common.CropWriter(SOURCE, p) for p in ("train", "select", "test")}
    used = Counter(); no_box = 0
    for i, (name, p, xml) in enumerate(items):
        if grp[i] in leak_groups:
            continue
        part = common.split_part(grp[i])
        w = writers[part]
        if w.full():
            if all(x.full() for x in writers.values()):
                break
            continue
        boxes = read_xml(xml, *size[i])
        if not boxes:
            no_box += 1
        w.add(load(p), boxes, grp[i])
        used[part] += 1
        if i % 1000 == 0:
            print(f"pass 2: {i}/{len(items)}", flush=True)
    print(f"images used per part: {dict(used)}; images without boxes (background only): {no_box}", flush=True)
    for part, w in writers.items():
        w.close({"licence": LICENCE, "images": used[part], "group_rule": f"same size and (pHash<={PH_T} or thumb corr>={CORR_T})",
                 "leak_images": int(leak.sum()), "leak_groups_dropped": len(leak_groups)})
    shutil.rmtree(EXTRACT)
    for z in RAWDIR.glob("*.zip"):
        z.unlink()
    print("raw files deleted", flush=True)


if __name__ == "__main__":
    main()
