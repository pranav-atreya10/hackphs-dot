"""Train/test leakage check (protocol section 6). Run before reporting any suspiciously good result,
and once when the test sets are frozen.

    .venv/bin/python benchmarks/leakage_check.py --images  data/mendeley/train/images  --test-manifest
    .venv/bin/python benchmarks/leakage_check.py --audio-train-shards 2,5,10,19,24,30

Images: perceptual hash (pHash, 64-bit); pairs at Hamming distance <= 6 are near-duplicates.
Exact duplicates are found by SHA-256. Writes benchmarks/leakage_report.json.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench.common import BENCH, ROOT, sha256_file  # noqa: E402
from bench import manifest  # noqa: E402

HAMMING_NEAR = 6


def phash_array(paths):
    import imagehash
    from PIL import Image
    out = np.zeros(len(paths), dtype=np.uint64)
    for i, p in enumerate(paths):
        with Image.open(p) as im:
            out[i] = np.uint64(int(str(imagehash.phash(im)), 16))
        if i and i % 2000 == 0:
            print(f"  hashed {i}/{len(paths)}", flush=True)
    return out


def popcount64(x):
    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
    x = (x & np.uint64(0x3333333333333333)) + ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
    return ((x * np.uint64(0x0101010101010101)) >> np.uint64(56)).astype(np.int64)


def image_leakage(train_dir, test_paths):
    train = sorted(Path(train_dir).rglob("*.jpg")) + sorted(Path(train_dir).rglob("*.png"))
    print(f"pHash: {len(train)} train vs {len(test_paths)} test images", flush=True)
    th = phash_array(train)
    sh = phash_array(test_paths)
    near, closest = [], []
    for i, h in enumerate(sh):
        d = popcount64(th ^ h)
        j = int(d.argmin())
        closest.append(int(d[j]))
        for k in np.where(d <= HAMMING_NEAR)[0][:5]:
            near.append({"test": str(test_paths[i]), "train": str(train[k]), "hamming": int(d[k])})
    test_sha = {sha256_file(p) for p in test_paths}
    exact = sum(1 for p in train if sha256_file(p) in test_sha)
    closest = np.array(closest)
    return {"n_train": len(train), "n_test": len(test_paths), "exact_duplicates": exact,
            "test_images_with_near_duplicate": int((closest <= HAMMING_NEAR).sum()),
            "fraction_with_near_duplicate": float((closest <= HAMMING_NEAR).mean()),
            "closest_hamming_histogram": {str(k): int((closest == k).sum()) for k in range(0, 17)},
            "examples": near[:50]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", help="training image directory to compare against the frozen visual test set")
    ap.add_argument("--test-dir", help="instead of the manifest, compare against this test image directory")
    args = ap.parse_args()
    report = {}
    if args.images:
        if args.test_dir:
            test_paths = sorted(Path(args.test_dir).rglob("*.jpg"))
        else:
            items, _ = manifest.visual_items(manifest.load())
            test_paths = [Path(p) for p in items.path]
        report["images"] = image_leakage(args.images, test_paths)
        r = report["images"]
        print(f"exact duplicates: {r['exact_duplicates']}; test images with a near-duplicate in train "
              f"(Hamming <= {HAMMING_NEAR}): {r['test_images_with_near_duplicate']} / {r['n_test']} "
              f"({r['fraction_with_near_duplicate']:.1%})")
    out = BENCH / "leakage_report.json"
    prev = json.loads(out.read_text()) if out.exists() else {}
    prev.update(report)
    out.write_text(json.dumps(prev, indent=1))
    print("wrote benchmarks/leakage_report.json")


if __name__ == "__main__":
    main()
