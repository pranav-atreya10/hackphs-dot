"""Open Images V7 subset -> bird / other crops (train / select / test by ImageID hash).

Source:  https://storage.googleapis.com/openimages/web/factsfigures_v7.html
Licence: boxes CC BY 4.0 (Google); images are Flickr photos listed as CC BY 2.0 (Google says to check
         each image). Per-image credit (author, original URL, licence) is written to
         sources/openimages_attribution.csv for every image that gave crops.

Images: only the boxes of the official *validation* and *test* box CSVs (v5, human-drawn boxes); together
they give ~12k usable target objects, so the 2.26 GB train box CSV is not needed. Pixels come from
https://open-images-dataset.s3.amazonaws.com/<subset>/<ImageID>.jpg (no account).

Classes (Open Images label -> our class):
  Bird (/m/015p6) and its hierarchy children (Eagle, Owl, Duck, Goose, Swan, Falcon, Sparrow, Raven,
      Magpie, Woodpecker, Blue jay, Parrot, Canary, Chicken, Turkey, Penguin, Ostrich)     -> 0 bird
  Aircraft (+ children Fixed-wing aircraft = "Airplane", Helicopter, Rocket), Kite, Balloon,
      Insect (+ children Bee, Beetle, Ladybug, Ant, Moths and butterflies, Caterpillar, Butterfly,
      Dragonfly), Parachute                                                                  -> 2 other
  Open Images has no drone class; nothing is mapped to 1.
  The children are included because Open Images box CSVs are NOT hierarchy-expanded: an eagle is often
  boxed only as "Eagle". Leaving children out would let a background square land on it labelled "other".
  Same-class duplicate boxes (parent + child on one object, IoU > 0.7) are merged.

Filters: IsDepiction=1 (drawings, toys, statues) and IsInside=1 (shot from inside the object) boxes are
dropped, and any image that has such a box is skipped entirely (so a depicted bird cannot become an
"other" background square). IsGroupOf=1 boxes are KEPT: for birds these are flocks - one box around
several birds, so that crop shows a group, not a single bird (counted in the info json as group_of_*).
Images whose Rotation field is not 0.0 (non-zero or unknown, ~14%) are skipped, because the S3 files are
unrotated originals and the boxes refer to the upright image.
No easy "object is in the sky" signal exists in the CSVs, so all images are taken; many are close-ups
on the ground (pets, poultry, insects on flowers).
Big photos are decoded with JPEG draft mode so the long side is >= 1024 px (like Open Images' own
1024-px release); box pixel sizes in the meta refer to that scale.

Run:   OMP_NUM_THREADS=1 nice -n 10 python3 -I "sources/openimages.py" [--keep]
"""
import argparse
import base64
import csv
import hashlib
import shutil
import subprocess
import sys
import threading
import queue
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common  # noqa: E402
from common import CropWriter, leak_check, split_part  # noqa: E402

SOURCE = "openimages"
RAW = common.RAW / SOURCE
CSVD = RAW / "csv"
GCS = "https://storage.googleapis.com/openimages/"
FILES = {  # name -> path under GCS; md5 is checked against the x-goog-hash header GCS publishes
    "classes": "v7/oidv7-class-descriptions-boxable.csv",
    "hierarchy": "2018_04/bbox_labels_600_hierarchy.json",
    "validation_boxes": "v5/validation-annotations-bbox.csv",
    "test_boxes": "v5/test-annotations-bbox.csv",
    "validation_ids": "2018_04/validation/validation-images-with-rotation.csv",
    "test_ids": "2018_04/test/test-images-with-rotation.csv",
}
S3 = "https://open-images-dataset.s3.amazonaws.com/{subset}/{iid}.jpg"
BIRD_ROOT = "/m/015p6"
OTHER_ROOTS = ["/m/0k5j", "/m/02zt3", "/m/01j51", "/m/03vt0", "/m/0cyfs"]  # Aircraft, Kite, Balloon, Insect, Parachute
BATCH = 300


def fetch(path):
    """Download a GCS file and verify its md5 against the published x-goog-hash."""
    CSVD.mkdir(parents=True, exist_ok=True)
    dst = CSVD / Path(path).name
    head = requests.head(GCS + path, timeout=60)
    head.raise_for_status()
    md5 = [h.split("=", 1)[1] for h in head.headers.get("x-goog-hash", "").split(",") if h.strip().startswith("md5=")]
    if not dst.exists():
        subprocess.run(["curl", "-sS", "-L", "--retry", "5", "-o", str(dst), GCS + path], check=True)
    got = base64.b64encode(hashlib.md5(dst.read_bytes()).digest()).decode()
    if md5:
        assert got == md5[0], f"{path}: md5 {got} != {md5[0]}"
    print(f"{path}: md5 {'ok' if md5 else 'not published'} {got}", flush=True)
    return dst, got


def descendants(tree, label):
    def find(n):
        if n.get("LabelName") == label:
            return n
        for c in n.get("Subcategory", []):
            r = find(c)
            if r:
                return r

    def walk(n):
        out = []
        for c in n.get("Subcategory", []):
            out += [c["LabelName"]] + walk(c)
        return out
    return [label] + walk(find(tree))


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0


def downloader(jobs, out, sess):
    while True:
        j = jobs.get()
        if j is None:
            out.put(None)
            return
        subset, iid = j
        data = None
        for _ in range(3):
            try:
                r = sess.get(S3.format(subset=subset, iid=iid), timeout=60)
                if r.status_code == 200:
                    data = r.content
                    break
            except requests.RequestException:
                pass
        if data is not None:
            p = RAW / "img" / f"{iid}.jpg"  # raw images live briefly on disk, deleted after use
            p.write_bytes(data)
            out.put((subset, iid, p))
        else:
            out.put((subset, iid, None))


def load(p):
    im = Image.open(p)
    w, h = im.size
    f = max(w, h) / 1024
    if f >= 2:  # JPEG DCT scaling to the smallest 1/2, 1/4, 1/8 size whose long side is still >= 1024
        im.draft("RGB", (int(w / f) + 1, int(h / f) + 1))
    im = im.convert("RGB")
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="debug: only this many images")
    args = ap.parse_args()

    import json
    got = {k: fetch(v) for k, v in FILES.items()}
    names = dict(csv.reader(open(got["classes"][0], encoding="utf-8")))
    tree = json.loads(got["hierarchy"][0].read_text())
    cls_of = {lab: 0 for lab in descendants(tree, BIRD_ROOT)}
    for r in OTHER_ROOTS:
        for lab in descendants(tree, r):
            cls_of.setdefault(lab, 2)
    print("bird labels:", [names[l] for l, c in cls_of.items() if c == 0])
    print("other labels:", [names[l] for l, c in cls_of.items() if c == 2])

    st = Counter()
    per_img = defaultdict(list)  # (subset, iid) -> [(xmin,ymin,xmax,ymax,cls,groupof,label)]
    dropped_imgs = set()
    for subset in ("validation", "test"):
        with open(got[f"{subset}_boxes"][0], newline="") as f:
            for r in csv.DictReader(f):
                c = cls_of.get(r["LabelName"])
                if c is None:
                    continue
                key = (subset, r["ImageID"])
                if r["IsDepiction"] == "1":
                    st[f"boxes_dropped_depiction_cls{c}"] += 1
                    dropped_imgs.add(key)
                    continue
                if r["IsInside"] == "1":
                    st[f"boxes_dropped_inside_cls{c}"] += 1
                    dropped_imgs.add(key)
                    continue
                per_img[key].append((float(r["XMin"]), float(r["YMin"]), float(r["XMax"]), float(r["YMax"]), c,
                                     r["IsGroupOf"] == "1", names.get(r["LabelName"], r["LabelName"])))
    st["images_only_dropped_boxes"] = len(dropped_imgs - set(per_img))

    meta = {}
    for subset in ("validation", "test"):
        with open(got[f"{subset}_ids"][0], newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if (subset, r["ImageID"]) in per_img:
                    meta[(subset, r["ImageID"])] = r
    todo = []
    for key in sorted(per_img, key=lambda k: k[1]):
        m = meta.get(key)
        if m is None:
            st["images_no_id_row"] += 1
            continue
        if key in dropped_imgs:
            st["images_skipped_has_depiction_or_inside_box"] += 1
            continue
        if m["Rotation"] != "0.0":
            st["images_skipped_rotation_" + (m["Rotation"] or "unknown")] += 1
            continue
        todo.append(key)
    if args.limit:
        todo = todo[: args.limit]
    print("images to fetch", len(todo), dict(st), flush=True)

    writers = {p: CropWriter(SOURCE, p) for p in ("train", "select", "test")}
    (RAW / "img").mkdir(parents=True, exist_ok=True)
    jobs, out = queue.Queue(), queue.Queue(maxsize=BATCH * 2)  # bounded: at most ~600 raw images on disk
    sess = requests.Session()
    threads = [threading.Thread(target=downloader, args=(jobs, out, sess), daemon=True) for _ in range(2)]
    for t in threads:
        t.start()
    for k in todo:
        jobs.put(k)
    for _ in threads:
        jobs.put(None)

    used = []
    done_threads, batch = 0, []
    labels_used = Counter()

    def flush(batch):
        imgs = []
        for subset, iid, p in batch:
            try:
                imgs.append(load(p))
            except Exception:
                imgs.append(None)
                st["images_unreadable"] += 1
            p.unlink(missing_ok=True)
        ok = [(b, im) for b, im in zip(batch, imgs) if im is not None]
        bad = set(leak_check([im for _, im in ok]))
        st["images_leak_dropped"] += len(bad)
        for i, ((subset, iid, _), im) in enumerate(ok):
            if i in bad:
                continue
            W, H = im.size
            boxes, kept = [], []
            for x1, y1, x2, y2, c, grp, lab in per_img[(subset, iid)]:
                b = (x1 * W, y1 * H, x2 * W, y2 * H, c)
                if any(k[4] == c and iou(k, b) > 0.7 for k in boxes):
                    st[f"boxes_merged_duplicate_cls{c}"] += 1
                    continue
                boxes.append(b)
                kept.append((c, grp, lab))
            w = writers[split_part(iid)]
            if w.full():
                st["images_skipped_cap"] += 1
                continue
            w.add(im, boxes, iid)
            st["images_used"] += 1
            for c, grp, lab in kept:
                st[f"boxes_cls{c}"] += 1
                st[f"group_of_cls{c}"] += grp
                labels_used[lab] += 1
            used.append((subset, iid))

    n = 0
    while done_threads < len(threads):
        item = out.get()
        if item is None:
            done_threads += 1
            continue
        if item[2] is None:
            st["images_download_failed"] += 1
            continue
        batch.append(item)
        n += 1
        if len(batch) >= BATCH:
            flush(batch)
            batch = []
            print(n, "/", len(todo), dict(st), flush=True)
    if batch:
        flush(batch)

    extra = {"licence": "boxes CC BY 4.0; images CC BY 2.0 (Flickr, per-image credit in sources/openimages_attribution.csv)",
             "csv_md5_b64": {k: v[1] for k, v in got.items()}, **{k: int(v) for k, v in st.items()}}
    infos = {p: w.close(extra_meta=extra) for p, w in writers.items()}
    print("stats", dict(st))
    print("labels used", dict(labels_used.most_common()))
    sizes = []
    for p in writers:
        m = np.load(common.OUT / f"{SOURCE}_{p}_meta.npz")
        sizes.append(m["size"][m["y"] == 0])
    s = np.concatenate(sizes)
    print("bird size px p10/p50/p90", np.percentile(s, [10, 50, 90]).round(1).tolist())

    cols = ["ImageID", "Subset", "OriginalURL", "OriginalLandingURL", "License", "AuthorProfileURL", "Author", "Title"]
    with open(HERE / "openimages_attribution.csv", "w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(cols + ["Part"])
        for key in sorted(used, key=lambda k: k[1]):
            m = meta[key]
            wr.writerow([m[c] for c in cols] + [split_part(key[1])])
    print("licences of used images", dict(Counter(meta[k]["License"] for k in used)))
    if not args.keep:
        shutil.rmtree(RAW)
        print("removed", RAW)
    return infos


if __name__ == "__main__":
    main()
