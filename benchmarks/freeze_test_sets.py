"""Build and FREEZE the test-set manifest (benchmarks/test_sets.json). Each part runs once.

    .venv/bin/python benchmarks/freeze_test_sets.py visual   # Mendeley test split + size/condition tags
    .venv/bin/python benchmarks/freeze_test_sets.py audio    # DADS test shards 3 + 36 -> WAV files
    .venv/bin/python benchmarks/freeze_test_sets.py stress   # ESC-50 noise mixes at 5 SNRs + look-alikes

Re-running a part that is already frozen is refused (protocol section 1: changing a frozen set needs
Vivan's approval and a CHANGELOG entry).
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench.common import DATA, MANIFEST, ROOT, now_utc, sha256_file  # noqa: E402

SEED = 20261010
FROZEN = DATA / "frozen"

# Condition-tag rules (applied once at freeze time; raw stats stored for audit)
EDGE_CLUTTERED = 0.06      # fraction of Canny edge pixels
GLARE_BACKLIT = 0.08       # fraction of near-white, low-saturation pixels (V > 235, S < 30)
SAT_CLOUDY = 55            # mean HSV saturation (0-255) below this = grey/white sky
SNRS = [10, 5, 0, -5, -10]
NOISES = {"wind": 16, "rain": 10, "traffic": 44}      # ESC-50 has no traffic class: engine (44)
LOOKALIKES = {"helicopter": 40, "airplane": 47, "chirping_birds": 14, "crow": 9}
STRESS_FOLDS = {1, 2, 3}   # ESC-50 folds reserved for testing; augmentation may only use folds 4-5


def load_manifest():
    return json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"created_utc": now_utc(), "tiers": {}, "history": []}


def save_manifest(man, note):
    man["history"].append({"utc": now_utc(), "note": note})
    MANIFEST.write_text(json.dumps(man, indent=1))
    print(f"wrote {MANIFEST.relative_to(ROOT)} ({note})")


def refuse_if_frozen(man, tier, group, refreeze_reason=None):
    old = man["tiers"].get(tier, {}).get(group)
    if not old:
        return
    if not refreeze_reason:
        raise SystemExit(f"{tier}/{group} is already frozen. Changing it needs Vivan's approval + a CHANGELOG entry "
                         "(then pass --refreeze-reason).")
    arch = MANIFEST.parent / "test_sets_archive"
    arch.mkdir(exist_ok=True)
    stamp = now_utc().replace(":", "")
    (arch / f"{tier}_{group}_{stamp}.json").write_text(json.dumps(old, indent=1))
    man["history"].append({"utc": now_utc(), "note": f"RE-FROZE {tier}/{group} (old version archived as "
                           f"test_sets_archive/{tier}_{group}_{stamp}.json): {refreeze_reason}"})
    from bench.common import CHANGELOG
    with open(CHANGELOG, "a") as f:
        if CHANGELOG.stat().st_size == 0 if CHANGELOG.exists() else True:
            f.write("# Detection changelog\n\nOne entry per version: hypothesis, decision, reason. Reverted versions stay.\n")
        f.write(f"\n## Test-set change: {tier}/{group} re-frozen ({now_utc()})\n\n{refreeze_reason}\n"
                f"Old version archived: `benchmarks/test_sets_archive/{tier}_{group}_{stamp}.json`.\n")


def rel(p):
    return str(Path(p).resolve().relative_to(ROOT))


# ---------------------------------------------------------------- visual

def condition_tag(path):
    import cv2
    img = cv2.imread(str(path))
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = float((cv2.Canny(gray, 100, 200) > 0).mean())
    glare = float(((hsv[..., 2] > 235) & (hsv[..., 1] < 30)).mean())
    sat = float(hsv[..., 1].mean())
    if edges > EDGE_CLUTTERED:
        tag = "cluttered"
    elif glare > GLARE_BACKLIT:
        tag = "backlit"
    elif sat < SAT_CLOUDY:
        tag = "cloudy"
    else:
        tag = "clear"
    return tag, {"edge_density": round(edges, 4), "glare_fraction": round(glare, 4), "mean_saturation": round(sat, 1)}


def size_tag(area):
    return "small" if area < 0.01 else "medium" if area <= 0.10 else "large"


def read_yolo_labels(path, class_map, prefix_cls=None, dedupe_iou=None):
    boxes = []
    if not path.exists():
        return boxes
    for line in path.read_text().split("\n"):
        parts = line.split()
        if len(parts) < 5:
            continue
        c = int(float(parts[0]))
        if c not in class_map:
            continue
        ours = prefix_cls if prefix_cls is not None else class_map[c]
        nums = list(map(float, parts[1:]))
        if len(nums) == 4:                         # cx cy w h
            cx, cy, w, h = nums
            x1, y1, x2, y2 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
        else:                                      # polygon x1 y1 x2 y2 ... -> bounding box
            xs, ys = nums[0::2], nums[1::2]
            x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
        x1, y1, x2, y2 = (float(np.clip(v, 0, 1)) for v in (x1, y1, x2, y2))
        box = {"cls": ours, "x1": x1, "y1": y1, "x2": x2, "y2": y2, "size_tag": size_tag((x2 - x1) * (y2 - y1))}
        if dedupe_iou and any(b["cls"] == ours and box_iou(b, box) >= dedupe_iou for b in boxes):
            continue  # the same object annotated twice (e.g. once per class id)
        boxes.append(box)
    return boxes


def box_iou(a, b):
    ix = max(0.0, min(a["x2"], b["x2"]) - max(a["x1"], b["x1"]))
    iy = max(0.0, min(a["y2"], b["y2"]) - max(a["y1"], b["y1"]))
    inter = ix * iy
    union = (a["x2"] - a["x1"]) * (a["y2"] - a["y1"]) + (b["x2"] - b["x1"]) * (b["y2"] - b["y1"]) - inter
    return inter / union if union > 0 else 0.0


def near_duplicate_groups(paths, max_hamming=6):
    """Chain images whose perceptual hashes are within max_hamming bits (consecutive video frames)."""
    from leakage_check import phash_array, popcount64
    h = phash_array(paths)
    parent = list(range(len(h)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i in range(len(h)):
        for j in np.where(popcount64(h ^ h[i]) <= max_hamming)[0]:
            if j > i:
                parent[find(i)] = find(int(j))
    roots = {}
    return [roots.setdefault(find(i), len(roots)) for i in range(len(h))]


def freeze_visual(test_dir, class_map, label_by_prefix=False, refreeze_reason=None):
    man = load_manifest()
    refuse_if_frozen(man, "dataset", "visual", refreeze_reason)
    imgs = sorted(p for p in Path(test_dir, "images").iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    items, missing_labels = [], 0
    for p in imgs:
        lab = Path(test_dir, "labels", p.stem + ".txt")
        if not lab.exists():
            missing_labels += 1
        tag, stats = condition_tag(p)
        prefix_cls = {"B": 0, "D": 1}.get(p.name[:1]) if label_by_prefix else None
        items.append({"item_id": p.stem, "path": rel(p), "sha256": sha256_file(p),
                      "label_path": rel(lab) if lab.exists() else None, "label_sha256": sha256_file(lab) if lab.exists() else None,
                      "boxes": read_yolo_labels(lab, class_map, prefix_cls, dedupe_iou=0.5 if label_by_prefix else None),
                      "condition_tag": tag, "condition_stats": stats})
    print("grouping near-duplicate frames (pHash)...", flush=True)
    for it, g in zip(items, near_duplicate_groups(imgs)):
        it["group"] = g
    man["tiers"].setdefault("dataset", {})["visual"] = {
        "source": "Mendeley Data 6ghdz52pd7 v5 Dataset.zip, test split", "class_map": {str(k): v for k, v in class_map.items()},
        "condition_rules": {"cluttered_edge_density_gt": EDGE_CLUTTERED, "backlit_glare_fraction_gt": GLARE_BACKLIT,
                            "cloudy_mean_saturation_lt": SAT_CLOUDY, "else": "clear"},
        "size_rules": "box area / image area: small < 1%, medium 1-10%, large > 10%",
        "images_without_label_file": missing_labels,
        "labels": ("class from file name (B...=bird, D...=drone); duplicate same-object boxes (IoU>=0.5) merged. "
                   "Published Mendeley v5 labels put both classes in one id.") if label_by_prefix else "as published",
        "groups": "near-duplicate frames chained at pHash Hamming <= 6; bootstrap CIs resample groups",
        "n_groups": len({it["group"] for it in items}), "items": items}
    tags = {}
    for it in items:
        tags[it["condition_tag"]] = tags.get(it["condition_tag"], 0) + 1
    nb = sum(len(it["boxes"]) for it in items)
    sizes = {}
    for it in items:
        for b in it["boxes"]:
            sizes[b["size_tag"]] = sizes.get(b["size_tag"], 0) + 1
    print(f"{len(items)} images, {nb} boxes, {missing_labels} without label file; conditions {tags}; sizes {sizes}")
    save_manifest(man, f"froze dataset/visual: {len(items)} images")


# ---------------------------------------------------------------- audio

def freeze_audio(shards):
    import soundfile as sf
    import pyarrow.parquet as pq
    from bench.audio import load_wav_bytes, SR
    man = load_manifest()
    refuse_if_frozen(man, "dataset", "audio")
    out = FROZEN / "dads_test"
    out.mkdir(parents=True, exist_ok=True)
    index = json.loads((DATA / "dads" / "shard_index.json").read_text())
    items = []
    for s in shards:
        path = DATA / "dads" / f"train-{s:05d}-of-00039.parquet"
        t = pq.read_table(path)
        first = next(r["first_row"] for r in index if r["shard"] == s)
        for j, (a, lab) in enumerate(zip(t.column("audio").to_pylist(), t.column("label").to_pylist())):
            y = load_wav_bytes(a["bytes"])
            p = out / f"s{s:02d}_r{first + j:06d}.wav"
            sf.write(p, y, SR, subtype="PCM_16")
            items.append({"item_id": p.stem, "path": rel(p), "sha256": sha256_file(p), "tier": "dads_test", "label": int(lab),
                          "seconds": round(len(y) / SR, 3), "source": "dads" if lab else "dads_no_drone", "shard": s, "row": first + j,
                          "snr_db": None, "noise_type": None})
        print(f"shard {s}: {t.num_rows} clips", flush=True)
    # The long no-drone recordings double as ambient audio for false alarms per hour (same files).
    amb = [{**it, "item_id": "amb_" + it["item_id"], "tier": "ambient"} for it in items if it["label"] == 0]
    man["tiers"].setdefault("dataset", {})["audio"] = {
        "source": "DADS (geronimobasso/drone-audio-detection-samples)", "revision": (DATA / "dads" / "REVISION").read_text().strip(),
        "test_shards": shards, "split_rule": "whole contiguous shards held out from training (label-sorted, recording-ordered data)",
        "shard_sha256": {str(s): sha256_file(DATA / "dads" / f"train-{s:05d}-of-00039.parquet") for s in shards},
        "items": items + amb}
    pos = sum(it["label"] for it in items)
    hrs = sum(it["seconds"] for it in amb) / 3600
    print(f"{len(items)} clips ({pos} drone, {len(items) - pos} no-drone); ambient {hrs:.2f} h")
    save_manifest(man, f"froze dataset/audio: shards {shards}")


# ---------------------------------------------------------------- stress

def esc50_clips(esc_dir, target, folds):
    import csv
    meta = list(csv.DictReader(open(Path(esc_dir) / "meta" / "esc50.csv")))
    return [Path(esc_dir) / "audio" / r["filename"] for r in meta if int(r["target"]) == target and int(r["fold"]) in folds]


def freeze_stress(esc_dir, n_drone=60):
    import soundfile as sf
    from bench.audio import load_audio, mix_at_snr, SR
    man = load_manifest()
    refuse_if_frozen(man, "stress", "audio_mix")
    dads = man["tiers"].get("dataset", {}).get("audio")
    if not dads:
        raise SystemExit("Freeze the DADS audio test set first.")
    rng = np.random.default_rng(SEED)
    # 3 s drone segments: consecutive drone clips from the TEST shards only (never training data)
    drone = [it for it in dads["items"] if it["tier"] == "dads_test" and it["label"] == 1]
    drone.sort(key=lambda it: it["row"])
    segs, cur = [], []
    for it in drone:
        cur.append(it)
        if sum(c["seconds"] for c in cur) >= 3.0:
            segs.append(cur)
            cur = []
    pick = sorted(rng.choice(len(segs), size=min(n_drone, len(segs)), replace=False))
    out = FROZEN / "stress"
    out.mkdir(parents=True, exist_ok=True)
    items = []
    for nt, target in NOISES.items():
        noises = esc50_clips(esc_dir, target, STRESS_FOLDS)
        noise_audio = [load_audio(str(p)) for p in noises]
        for k, si in enumerate(pick):
            sig = np.concatenate([load_audio(str(ROOT / c["path"])) for c in segs[si]])[: 3 * SR]
            ni = int(rng.integers(0, len(noise_audio)))
            for snr in SNRS:
                y = mix_at_snr(sig, noise_audio[ni], snr, rng)
                p = out / f"{nt}_{snr:+d}dB_{k:02d}.wav"
                sf.write(p, y, SR, subtype="PCM_16")
                items.append({"item_id": p.stem, "path": rel(p), "sha256": sha256_file(p), "tier": "stress", "label": 1,
                              "seconds": 3.0, "source": f"dads_test+esc50_{target}", "snr_db": snr, "noise_type": nt,
                              "drone_rows": [c["row"] for c in segs[si]], "noise_file": noises[ni].name})
        print(f"{nt}: {len(pick)} drone segments x {len(SNRS)} SNRs", flush=True)
    look = []
    for name, target in LOOKALIKES.items():
        for p in esc50_clips(esc_dir, target, {1, 2, 3, 4, 5}):
            look.append({"item_id": f"esc_{name}_{p.stem}", "path": rel(p), "sha256": sha256_file(p), "tier": "lookalike", "label": 0,
                         "seconds": 5.0, "source": f"esc50_{name}", "snr_db": None, "noise_type": None})
    man["tiers"].setdefault("stress", {})["audio_mix"] = {
        "seed": SEED, "snrs_db": SNRS, "noise_classes": NOISES, "esc50_folds_used": sorted(STRESS_FOLDS),
        "rule": "v3+ noise augmentation may only use ESC-50 folds 4-5", "items": items}
    man["tiers"]["stress"]["audio_lookalike"] = {"classes": LOOKALIKES, "items": look}
    save_manifest(man, f"froze stress: {len(items)} mixes, {len(look)} look-alikes")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("part", choices=["visual", "audio", "stress"])
    ap.add_argument("--test-dir", help="visual: folder with images/ and labels/ of the test split")
    ap.add_argument("--class-map", default="", help="visual: source class id -> ours, e.g. '0:0,1:1' (0 bird, 1 drone)")
    ap.add_argument("--shards", default="3,36")
    ap.add_argument("--label-by-prefix", action="store_true")
    ap.add_argument("--refreeze-reason", default=None, help="only with Vivan's approval: archives the old freeze")
    ap.add_argument("--esc50", default=str(DATA / "ESC-50-master"))
    a = ap.parse_args()
    if a.part == "visual":
        cmap = {int(k): int(v) for k, v in (x.split(":") for x in a.class_map.split(","))}
        freeze_visual(a.test_dir, cmap, a.label_by_prefix, a.refreeze_reason)
    elif a.part == "audio":
        freeze_audio([int(s) for s in a.shards.split(",")])
    else:
        freeze_stress(a.esc50)


if __name__ == "__main__":
    main()
