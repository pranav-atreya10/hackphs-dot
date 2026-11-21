"""DCSkyCam Helicopter Classification -> v4 crops (source "dcskycam").

Dataset: https://huggingface.co/datasets/dcskycam/helicopter-classification  (CC BY 4.0,
"DCSkyCam contributors"). Ready-made JPEG crops cut around SSD-MobileNet boxes from a fixed
Raspberry Pi sky camera in Washington DC. Only the helicopter crops are used, as cls 2 (other);
the "not_helicopter-*" crops mix birds, planes and clouds with no label, so they are not downloaded.

Download: huggingface_hub.snapshot_download of train/metadata.csv + every train/<type>-<hash>.jpeg
whose type is not "not_helicopter", into data/v4raw/dcskycam/. Every JPEG is checked against the
SHA-256 Hugging Face publishes for its LFS object; metadata.csv (a plain git blob) against its git
blob SHA-1. A file that fails is dropped and counted.

Group rule: the files carry no capture time (names are <type>-<random 8 hex>, no EXIF date), so a
"pass" is rebuilt from the pixels. Crops of one pass of one helicopter share the helicopter type,
the sky behind it and the airframe's look, so: within one helicopter type, two crops are linked when
their 64-bit pHash differs by <= GROUP_HAMMING bits OR their colour hash (8x8 mean-colour thumbnail)
is within COLOUR_DIST; groups are the connected components (union-find). Group id =
"dcskycam/<type>/<smallest file name in the component>". This is deliberately loose (it would rather
merge two passes than split one), so near-identical frames never land on two sides of the split.

Leakage: common.leak_check on every used crop (batches of 256); hits are skipped and counted.
Crops are not square; they are edge-padded to a square here before CropWriter.add_crop (see
pad_square) because add_crop pastes non-square crops on a black canvas, and black bars never
appear in live camera crops.

Run:  OMP_NUM_THREADS=1 nice -n 10 python3 -I dcskycam.py [--keep-raw]
"""
import hashlib
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

SOURCE = "dcskycam"
REPO_ID = "dcskycam/helicopter-classification"
RAW = common.RAW / SOURCE
GROUP_HAMMING = 10
COLOUR_DIST = 6.0  # mean abs difference (0-255) of 8x8 RGB thumbnails


def download():
    from huggingface_hub import HfApi, snapshot_download
    RAW.mkdir(parents=True, exist_ok=True)
    api = HfApi()
    tree = {f.path: f for f in api.list_repo_tree(REPO_ID, repo_type="dataset", path_in_repo="train", recursive=True)}
    snapshot_download(REPO_ID, repo_type="dataset", local_dir=RAW, allow_patterns=["train/*"],
                      ignore_patterns=["train/not_helicopter-*"], max_workers=8)
    ok, bad = [], []
    for path, f in tree.items():
        if path.split("/")[-1].startswith("not_helicopter"):
            continue
        p = RAW / path
        if not p.exists():
            bad.append(path); continue
        data = p.read_bytes()
        if f.lfs is not None:
            good = hashlib.sha256(data).hexdigest() == f.lfs.sha256
        else:
            good = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() == f.blob_id
        (ok if good else bad).append(path)
    print(f"downloaded {len(ok)} files, checksum OK; {len(bad)} failed: {bad[:5]}", flush=True)
    return [RAW / p for p in ok if p.endswith(".jpeg")], len(bad)


def pad_square(img):
    """Edge-replicate a crop to a square (no black bars)."""
    w, h = img.size
    if w == h:
        return img
    s = max(w, h)
    a = np.asarray(img)
    py, px = s - h, s - w
    a = np.pad(a, ((py // 2, py - py // 2), (px // 2, px - px // 2), (0, 0)), mode="edge")
    return Image.fromarray(a)


class UF:
    def __init__(self, n): self.p = list(range(n))
    def find(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]; i = self.p[i]
        return i
    def union(self, a, b): self.p[self.find(a)] = self.find(b)


def make_groups(files):
    import imagehash
    by_type = defaultdict(list)
    for f in files:
        by_type[f.name.split("-")[0]].append(f)
    group = {}
    for t, fs in by_type.items():
        fs = sorted(fs)
        ph, col = [], []
        for f in fs:
            with Image.open(f) as im:
                im = im.convert("RGB")
                ph.append(int(str(imagehash.phash(im)), 16))
                col.append(np.asarray(im.resize((8, 8), Image.BOX), np.float32).ravel())
        ph = np.array(ph, np.uint64); col = np.stack(col)
        uf = UF(len(fs))
        for i in range(len(fs)):
            near = (np.bitwise_count(ph[i + 1:] ^ ph[i]) <= GROUP_HAMMING) | \
                   (np.abs(col[i + 1:] - col[i]).mean(1) <= COLOUR_DIST)
            for j in np.nonzero(near)[0]:
                uf.union(i, i + 1 + j)
        roots = defaultdict(list)
        for i in range(len(fs)):
            roots[uf.find(i)].append(fs[i].name)
        for names in roots.values():
            gid = f"{SOURCE}/{t}/{min(names)}"
            for n in names:
                group[n] = gid
    return group


def main():
    files, n_bad = download()
    files = sorted(files)
    group = make_groups(files)
    sizes = Counter(group.values())
    print(f"{len(files)} helicopter crops in {len(sizes)} groups (largest {max(sizes.values())}, "
          f"singletons {sum(v == 1 for v in sizes.values())})", flush=True)
    writers = {p: common.CropWriter(SOURCE, p) for p in ("train", "select", "test")}
    used, leaked, capped = Counter(), 0, 0
    for b in range(0, len(files), 256):
        batch = files[b:b + 256]
        imgs = []
        for f in batch:
            with Image.open(f) as im:
                imgs.append(im.convert("RGB"))
        bad = set(common.leak_check(imgs))
        leaked += len(bad)
        for i, (f, im) in enumerate(zip(batch, imgs)):
            if i in bad:
                continue
            g = group[f.name]
            w = writers[common.split_part(g)]
            if w.full():
                capped += 1; continue
            w.add_crop(pad_square(im), 2, g)
            used[common.split_part(g)] += 1
    print(f"used {sum(used.values())} {dict(used)}, leak-check skipped {leaked}, skipped by cap {capped}, "
          f"checksum failures {n_bad}", flush=True)
    for p, w in writers.items():
        w.close({"leak_skipped": leaked, "licence": "CC BY 4.0", "url": f"https://huggingface.co/datasets/{REPO_ID}"})
    if "--keep-raw" not in sys.argv:
        shutil.rmtree(RAW)
        print("deleted", RAW, flush=True)


if __name__ == "__main__":
    main()
