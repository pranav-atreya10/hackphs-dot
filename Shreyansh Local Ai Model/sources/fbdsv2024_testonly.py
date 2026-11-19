"""FBD-SV-2024 (Flying Bird Dataset in Surveillance Video) -> TEST-ONLY crops.

Source:  https://figshare.com/articles/dataset/FBD-SV-2024/27377595  (paper arXiv 2409.00317)
Licence: figshare field says CC BY 4.0, but the description says "for learning and research purposes
         only, not for commercial use" -> treat as NON-COMMERCIAL. Credit: Zi-Wei Sun, Ze-Xi Hua et al.,
         Southwest Jiaotong University.
Use:     TEST ONLY. Never train on it. Every frame goes to part "test" (cap 6000 objects), whatever
         the dataset's own train/val split says. This is the "brand-new source the model has never seen".

The zip (one file, md5 published by figshare) holds 483 mp4 clips (1280x720) and labels.rar
(one VOC XML per frame, class "bird", a 'difficult' flag). We sample every STEP-th frame, group = clip id
("train/bird_12" / "val/bird_3"; the dataset's own split name is kept only to make ids unique).
Boxes with a 'difficult' level > 0 are kept (they are real birds, usually tiny or blurred) and counted.
Frames with no bird still give one background square (cls 2) each, from real surveillance scenes.

Needs: pip install libarchive-c (uses the system libarchive.so.13 to read the RAR; no unrar needed).
Run:   OMP_NUM_THREADS=1 nice -n 10 python3 -I "sources/fbdsv2024_testonly.py" [--keep]
"""
import argparse
import hashlib
import random
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from common import CropWriter, leak_check  # noqa: E402

SOURCE = "fbdsv2024_testonly"
URL = "https://ndownloader.figshare.com/files/50113731"
MD5 = "8a78846b16329466347be71da10d608a"
SIZE = 1790526712
STEP = 10
RAW = common.RAW / SOURCE


def md5sum(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def download():
    RAW.mkdir(parents=True, exist_ok=True)
    z = RAW / "FBD-SV-2024.zip"
    if not (z.exists() and z.stat().st_size == SIZE):
        subprocess.run(["curl", "-sS", "-L", "--retry", "5", "-C", "-", "-o", str(z), URL], check=True)
    got = md5sum(z)
    assert got == MD5, f"md5 mismatch {got} != {MD5}"
    print("zip md5 ok", got, flush=True)
    return z


def read_labels(zf):
    import libarchive
    labels = {}  # (split, clip, frame) -> list of (x1,y1,x2,y2,difficult)
    with libarchive.memory_reader(zf.read("FBD-SV-2024/labels.rar")) as arc:
        for e in arc:
            m = re.fullmatch(r"labels/(train|val)/(bird_\d+)_(\d+)\.xml", e.pathname)
            if not m:
                continue
            root = ET.fromstring(b"".join(e.get_blocks()))
            boxes = []
            for o in root.iter("object"):
                bb = o.find("bndbox")
                x1, y1, x2, y2 = (float(bb.find(k).text) for k in ("xmin", "ymin", "xmax", "ymax"))
                d = o.find("difficult")
                boxes.append((x1, y1, x2, y2, int(d.text) if d is not None and d.text else 0))
            labels[(m[1], m[2], int(m[3]))] = boxes
    return labels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="keep the raw zip")
    args = ap.parse_args()
    import cv2
    from PIL import Image
    cv2.setNumThreads(1)

    zpath = download()
    zf = zipfile.ZipFile(zpath)
    labels = read_labels(zf)
    print("label files", len(labels), flush=True)
    vids = sorted(n for n in zf.namelist() if re.fullmatch(r"FBD-SV-2024/videos/(train|val)/bird_\d+\.mp4", n))
    random.Random(0).shuffle(vids)  # if the cap is hit, the clips kept are a fair sample
    print("clips", len(vids), flush=True)

    w = CropWriter(SOURCE, "test", cap=6000)
    tmpdir = RAW / "clip"
    tmpdir.mkdir(exist_ok=True)
    st = defaultdict(int)
    for vi, name in enumerate(vids):
        if w.full():
            st["clips_not_used_cap"] += 1
            continue
        split, clip = name.split("/")[2], Path(name).stem
        tmp = tmpdir / "clip.mp4"
        with zf.open(name) as src, open(tmp, "wb") as dst:
            shutil.copyfileobj(src, dst)
        cap = cv2.VideoCapture(str(tmp))
        frames, k = [], 0
        while True:
            ok = cap.grab()
            if not ok:
                break
            if k % STEP == 0:
                ok, bgr = cap.retrieve()
                if ok:
                    if (split, clip, k) in labels:
                        frames.append((k, Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))))
                    else:
                        st["frames_without_label_file"] += 1
            k += 1
        cap.release()
        tmp.unlink()
        n_lab = sum(1 for key in labels if key[0] == split and key[1] == clip)
        if n_lab != k:
            st["clips_frame_count_mismatch"] += 1
        st["frames_decoded"] += k
        bad = set(leak_check([im for _, im in frames]))
        st["frames_leak_dropped"] += len(bad)
        for i, (fk, im) in enumerate(frames):
            if i in bad:
                continue
            bx = labels[(split, clip, fk)]
            W, H = im.size
            boxes = [(max(0, x1), max(0, y1), min(W, x2), min(H, y2), 0) for x1, y1, x2, y2, _ in bx]
            st["frames_used"] += 1
            st["birds_labelled"] += len(boxes)
            st["birds_difficult_gt0"] += sum(b[4] > 0 for b in bx)
            for b in bx:
                st[f"difficult_level_{b[4]}"] += 1
            st["frames_no_bird"] += not boxes
            w.add(im, boxes, f"{split}/{clip}")
        st["clips_used"] += 1
        if vi % 50 == 0:
            print(vi, dict(st), "objects", w.n_obj, flush=True)

    info = w.close(extra_meta={"licence": "CC BY 4.0 on figshare, but 'not for commercial use' (treat as NC)",
                               "test_only": True, "frame_step": STEP, **{k: int(v) for k, v in st.items()}})
    meta = np.load(common.OUT / f"{SOURCE}_test_meta.npz")
    s = meta["size"][meta["y"] == 0]
    print("stats", dict(st))
    print("bird size px p10/p50/p90", np.percentile(s, [10, 50, 90]).round(1).tolist() if len(s) else None)
    zf.close()
    if not args.keep:
        shutil.rmtree(RAW)  # only our own raw folder
        print("removed", RAW)
    return info


if __name__ == "__main__":
    main()
