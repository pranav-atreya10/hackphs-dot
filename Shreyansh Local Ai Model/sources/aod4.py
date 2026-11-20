"""AOD-4 (Air-borne Object Detection, 4 classes) -> v4 crops (source "aod4").

    OMP_NUM_THREADS=1 nice -n 10 python3 -I "Shreyansh Local Ai Model/sources/aod4.py"

Dataset: Mendeley Data cd5z895tr2 version 1, https://data.mendeley.com/datasets/cd5z895tr2/1, licence
CC BY 4.0 (Mendeley adds: further permission may be needed for third-party content inside it).
One file "AOD 4.zip" (1,921,835,727 bytes); its SHA-256 comes from the Mendeley public API
(public-api/datasets/cd5z895tr2/files?folder_id=root&version=1) and is checked before use.
22,516 images (Roboflow export: every image resized to 1024x1024, i.e. STRETCHED, aspect ratio not kept),
boxes in COCO / VOC / YOLO; we read the COCO json. Classes: bird -> 0, drone -> 1, airplane -> 2,
helicopter -> 2.

What is dropped (by file name, before anything is read):
  * "yt-*"  YouTube frames (team rule: no YouTube; licence problem).
  * "V_*"   frames of the Svanstrom Drone Detection Dataset (V_DRONE_/V_AIRPLANE_/V_HELICOPTER_). Svanstrom is
            already this project's data, and its test frames are a FROZEN test set; these re-encoded,
            stretched copies cannot be mapped back to Svanstrom's clip split, so keeping them would leak
            (DATASETS.md: "drop the V_* frames if #1 is used"). Some of those clips are also YouTube-sourced.
What remains: frames of Anti-UAV videos ("20190925_131530_1_1_208"), Pexels photos ("pexels-<name>-<id>"),
Unsplash photos ("<name>-<11 char id>-unsplash") and a few others.
Note: the Anti-UAV (Jiang et al.) frames come from a dataset whose own data licence is unclear (DATASETS.md
table); they are kept here because AOD-4 as a whole is CC BY 4.0, but their groups start with
"aod4:antiuav:" so they can be filtered out later in one line.

Groups:
  * Roboflow made several augmented copies of some images ("<base>_jpg.rf.<hash>.jpg"); the group always
    uses <base>, so copies of one photo / frame never end up on two sides.
  * Anti-UAV frames: "<date>_<time>_1_<n>_<frame>" -> group "aod4:antiuav:<date>_<time>" (one recording
    session; the _1_<n> variants of one session are kept together too, which is the conservative choice).
  * Pexels: "pexels-<photographer>-<id>" -> "aod4:pexels:<photographer>" (one photographer's photos often
    come from one shoot / burst, so they stay together).
  * Unsplash: "<photographer>-<id>-unsplash" -> "aod4:unsplash:<photographer>".
  * anything else -> "aod4:misc:<base>".
Leakage: common.leak_check on every kept image; a near-duplicate drops its WHOLE group.
Disk: only the kept images and the COCO json are extracted into data/v4raw/aod4/extracted/; the zip is
deleted after extraction and the extracted files at the end.
"""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SOURCE = "aod4"
LICENCE = "CC BY 4.0"
URL = "https://data.mendeley.com/public-files/datasets/cd5z895tr2/files/fb36418a-ca4d-4628-8e42-c6e5b2575ac2/file_downloaded"
SHA = "fac56b9c0494312bcd4c63dfefcbcd8ed07ab55d4b00584131c0b55273d24518"
RAWDIR = common.RAW / SOURCE
ZIP = RAWDIR / "AOD 4.zip"
EXTRACT = RAWDIR / "extracted"
CLASS = {"bird": 0, "drone": 1, "airplane": 2, "helicopter": 2}
SPLITS = ("train", "valid", "test")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dropped(name):
    return "youtube" if name.startswith("yt-") else "svanstrom" if name.startswith("V_") else None


def download():
    RAWDIR.mkdir(parents=True, exist_ok=True)
    if (EXTRACT / ".done").exists():
        print("already extracted", flush=True)
        return
    if not (ZIP.exists() and sha256(ZIP) == SHA):
        subprocess.run(["curl", "-sSL", "--retry", "5", "-C", "-", "-o", str(ZIP), URL], check=True)
    got = sha256(ZIP)
    if got != SHA:
        raise SystemExit(f"SHA-256 mismatch for {ZIP.name}: {got}")
    print(f"{ZIP.name}: SHA-256 verified ({ZIP.stat().st_size} bytes)", flush=True)
    EXTRACT.mkdir(exist_ok=True)
    with zipfile.ZipFile(ZIP) as zf:  # zipfile strips absolute paths and '..'
        for m in zf.namelist():
            if m.endswith("_annotations.coco.json") and "/COCO Annotation format/" in m:
                zf.extract(m, EXTRACT)
            elif m.startswith("AOD 4/Images/") and not m.endswith("/") and not dropped(m.split("/")[-1]):
                zf.extract(m, EXTRACT)
    ZIP.unlink()
    (EXTRACT / ".done").touch()


def base_name(name):
    return re.split(r"_(?:jpg|jpeg|png|JPG|JPEG|PNG|webp)\.rf\.", name)[0]


def group_of(name):
    b = re.sub(r"-\d-$", "", base_name(name))  # "<photo>-1-" is a second copy of "<photo>"
    m = re.match(r"^(\d{8}_\d{6})_\d+_\d+_\d+$", b)
    if m:
        return f"aod4:antiuav:{m.group(1)}"
    m = re.match(r"^pexels-(.+)-\d+$", b)
    if m:
        return f"aod4:pexels:{m.group(1)}"
    m = re.match(r"^(.*)-[A-Za-z0-9_-]{11}-unsplash$", b) or re.match(r"^(.*)-[A-Za-z0-9_-]{10}-unsplash$", b)
    if m:
        return f"aod4:unsplash:{m.group(1)}"
    return f"aod4:misc:{b}"


def items():
    """[(split, file name, path, boxes)] for every image in the COCO files, plus drop counts."""
    out, drop, odd = [], Counter(), Counter()
    for split in SPLITS:
        coco = json.loads((EXTRACT / "AOD 4/Annotations/COCO Annotation format" / split / "_annotations.coco.json").read_text())
        cat = {c["id"]: c["name"] for c in coco["categories"]}
        anns = defaultdict(list)
        for a in coco["annotations"]:
            anns[a["image_id"]].append(a)
        for im in coco["images"]:
            name = im["file_name"]
            why = dropped(name)
            if why:
                drop[why] += 1
                continue
            W, H = im["width"], im["height"]
            boxes = []
            for a in anns[im["id"]]:
                c = CLASS.get(cat[a["category_id"]])
                if c is None:
                    odd[cat[a["category_id"]]] += 1
                    continue
                x, y, w, h = a["bbox"]
                boxes.append((max(0.0, x), max(0.0, y), min(float(W), x + w), min(float(H), y + h), c))
            out.append((split, name, EXTRACT / "AOD 4/Images" / split / name, boxes))
    if odd:
        print("boxes with an unknown category (skipped):", dict(odd), flush=True)
    return out, drop


def load(p):
    with Image.open(p) as im:
        return im.convert("RGB")


def main():
    download()
    its, drop = items()
    print(f"kept {len(its)} images; dropped by name: {dict(drop)}", flush=True)
    grp = [group_of(n) for _, n, _, _ in its]
    kinds = Counter(g.split(":")[1] for g in grp)
    print(f"images per kind: {dict(kinds)}; groups: {len(set(grp))}", flush=True)

    leak = np.zeros(len(its), bool)
    batch, idx = [], []
    for i, (_, _, p, _) in enumerate(its):
        batch.append(load(p)); idx.append(i)
        if len(batch) == 64 or i == len(its) - 1:
            for j in common.leak_check(batch):
                leak[idx[j]] = True
            batch, idx = [], []
    leak_groups = {grp[i] for i in np.nonzero(leak)[0]}
    gsize = Counter(grp)
    n_leak_drop = sum(gsize[g] for g in leak_groups)
    print(f"leak_check: {int(leak.sum())} near-duplicate images {[its[i][1] for i in np.nonzero(leak)[0]][:10]} "
          f"in groups {sorted(leak_groups)}; {n_leak_drop} images dropped with their groups", flush=True)

    writers = {p: common.CropWriter(SOURCE, p) for p in ("train", "select", "test")}
    used = Counter(); kind_part = Counter(); no_box = 0
    for i, (_, name, p, boxes) in enumerate(its):
        if grp[i] in leak_groups:
            continue
        part = common.split_part(grp[i])
        w = writers[part]
        if w.full():
            if all(x.full() for x in writers.values()):
                break
            continue
        if not boxes:
            no_box += 1
        w.add(load(p), boxes, grp[i])
        used[part] += 1
        kind_part[(grp[i].split(":")[1], part)] += 1
    print(f"images used per part: {dict(used)}; per kind and part: {dict(kind_part)}; images without boxes: {no_box}", flush=True)
    for part, w in writers.items():
        w.close({"licence": LICENCE, "images": used[part], "dropped_youtube": drop["youtube"],
                 "dropped_svanstrom": drop["svanstrom"], "leak_images": int(leak.sum()), "leak_images_dropped_with_groups": n_leak_drop})
    shutil.rmtree(EXTRACT)
    if ZIP.exists():
        ZIP.unlink()
    print("raw files deleted", flush=True)


if __name__ == "__main__":
    main()
