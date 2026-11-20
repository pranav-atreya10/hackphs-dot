"""Run the bird / drone / other classifier on every pasted object of the SYNTHETIC flock stress set.

    python3 make_stress_set.py                                   # once: builds data/stress_flocks/
    python3 eval_stress.py --checkpoint models/skynetlite.pt     # any SkyNetLite checkpoint
    python3 eval_stress.py --checkpoint X.pt --json out.json     # also save every number

Each ground-truth box in data/stress_flocks/manifest.json is cut with the SAME rule the live app uses
(crops.square_for_box + crops.cut: a square 1.4x the box's long side, at least 32 px, resized to 64x64),
so in a crowded flock the crop around one bird often shows its neighbours too, exactly like it would live.

Reported per scene type:
  bird recall           birds labelled bird
  drone recall          drones labelled drone
  birds-called-drones   birds labelled drone (false drone alarms)
  drones-called-birds   drones labelled bird (the dangerous miss)
  and per scene: "every drone flagged AND no bird called a drone", and the stricter
  "every drone flagged AND every bird stayed bird".
Plus the time to classify 60 crops in one batch (a 60-bird flock in one frame).

The stress set is made of crude pastes from the valid split, which is used for model selection and is
mostly near-duplicates of the frozen test images. Treat the numbers as a crowding / crop stress check,
not as accuracy evidence, and never train on it (see FLOCKS.md).
"""
import argparse
import hashlib
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from crops import CLASSES, INPUT, cut, square_for_box  # noqa: E402
from model import MEAN, STD, SkyNetLite  # noqa: E402

REPO = HERE.parent
DEFAULT_MANIFEST = REPO / "data" / "stress_flocks" / "manifest.json"


def load_model(path):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    sd = ck
    if isinstance(ck, dict):
        for key in ("model", "state_dict", "model_state_dict"):
            if key in ck and isinstance(ck[key], dict):
                sd = ck[key]
                break
    if not isinstance(sd, dict):
        raise SystemExit(f"{path}: expected a state_dict or {{'model': state_dict}}, got {type(ck).__name__}")
    sd = {k[7:] if k.startswith("module.") else k: v for k, v in sd.items()}
    n_classes = sd["fc.weight"].shape[0] if "fc.weight" in sd else len(CLASSES)
    model = SkyNetLite(n_classes)
    model.load_state_dict(sd)
    model.eval()
    return model


def to_tensor(crops):
    x = torch.from_numpy(np.stack(crops)).float().div_(255.0).permute(0, 3, 1, 2)
    mean = torch.tensor(MEAN).view(1, 3, 1, 1)
    std = torch.tensor(STD).view(1, 3, 1, 1)
    return (x - mean) / std


def crop_objects(img, objects):
    out = []
    for o in objects:
        x1, y1, x2, y2 = o["box"]
        cx, cy, side = square_for_box((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1)
        out.append(cut(img, cx, cy, side, INPUT))
    return out


def main():
    ap = argparse.ArgumentParser(description="Classifier stress test on synthetic dense-flock scenes")
    ap.add_argument("--checkpoint", required=True, type=Path)
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--json", type=Path, help="write all results here")
    ap.add_argument("--min-visible", type=float, default=0.0,
                    help="only score objects whose box is at least this visible (0..1; default all)")
    ap.add_argument("--no-hash-check", action="store_true", help="skip the sha256 check of each scene image")
    args = ap.parse_args()

    if not args.manifest.exists():
        raise SystemExit(f"{args.manifest} not found: run make_stress_set.py first")
    man = json.loads(args.manifest.read_text())
    root = args.manifest.parent
    model = load_model(args.checkpoint)
    torch.set_grad_enabled(False)
    print(f"checkpoint {args.checkpoint}  |  stress set {args.manifest} (seed {man.get('seed')})")
    print("NOTE: synthetic pastes from the valid split (used for model selection, mostly near-duplicates of test images)"
          " -> a stress check, not accuracy evidence. Never train on it.")

    # counts[type][true][pred]
    counts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    blur_counts = defaultdict(lambda: defaultdict(int))   # bird motion blur: blurred/sharp -> pred
    per_scene = []
    bad_hash = 0
    t_crop = 0.0
    n_crops = 0
    for sc in man["scenes"]:
        path = root / sc["file"]
        data = path.read_bytes()
        if not args.no_hash_check and hashlib.sha256(data).hexdigest() != sc["sha256"]:
            bad_hash += 1
        img = Image.open(path).convert("RGB")
        objs = [o for o in sc["objects"] if o.get("visible_frac", 1.0) >= args.min_visible]
        if not objs:
            continue
        t0 = time.perf_counter()
        crops = crop_objects(img, objs)
        t_crop += time.perf_counter() - t0
        n_crops += len(crops)
        preds = []
        for i in range(0, len(crops), 256):
            preds += model(to_tensor(crops[i:i + 256])).argmax(1).tolist()
        preds = [CLASSES[p] if p < len(CLASSES) else str(p) for p in preds]
        for o, p in zip(objs, preds):
            counts[sc["type"]][o["cls"]][p] += 1
            if o["cls"] == "bird":
                blur_counts["blurred" if o.get("motion_blur") else "sharp"][p] += 1
        birds = [p for o, p in zip(objs, preds) if o["cls"] == "bird"]
        drones = [p for o, p in zip(objs, preds) if o["cls"] == "drone"]
        row = {
            "file": sc["file"], "type": sc["type"], "birds": len(birds), "drones": len(drones),
            "drones_flagged": sum(p == "drone" for p in drones),
            "birds_called_drone": sum(p == "drone" for p in birds),
            "birds_called_other": sum(p == "other" for p in birds),
            "drone_preds": drones,
        }
        row["all_drones_flagged_no_false_drone"] = row["drones_flagged"] == len(drones) and row["birds_called_drone"] == 0
        row["all_drones_flagged_all_birds_bird"] = row["drones_flagged"] == len(drones) and all(p == "bird" for p in birds)
        per_scene.append(row)

    def frac(a, b):
        return a / b if b else None

    def fmt(x):
        return "  n/a " if x is None else f"{100 * x:5.1f}%"

    summary = {}
    types = [t for t in ["dense", "mixed", "drone_in_flock", "tiny"] if t in counts] + [t for t in counts if t not in ("dense", "mixed", "drone_in_flock", "tiny")]
    print()
    print(f"{'scene type':<16}{'birds':>6}{'drones':>7}  {'bird rec':>8}  {'drone rec':>9}  {'birds->drone':>13}  {'drones->bird':>13}  {'birds->other':>13}  {'scenes ok*':>10}  {'strict**':>8}")
    for t in types + ["ALL"]:
        ts = types if t == "ALL" else [t]
        nb = sum(sum(counts[x]["bird"].values()) for x in ts)
        nd = sum(sum(counts[x]["drone"].values()) for x in ts)
        bb = sum(counts[x]["bird"]["bird"] for x in ts)
        bd = sum(counts[x]["bird"]["drone"] for x in ts)
        bo = sum(counts[x]["bird"]["other"] for x in ts)
        dd = sum(counts[x]["drone"]["drone"] for x in ts)
        db = sum(counts[x]["drone"]["bird"] for x in ts)
        rows = [r for r in per_scene if r["type"] in ts]
        ok = sum(r["all_drones_flagged_no_false_drone"] for r in rows)
        strict = sum(r["all_drones_flagged_all_birds_bird"] for r in rows)
        summary[t] = {"birds": nb, "drones": nd, "bird_recall": frac(bb, nb), "drone_recall": frac(dd, nd),
                      "birds_called_drones": bd, "birds_called_drones_rate": frac(bd, nb),
                      "drones_called_birds": db, "drones_called_birds_rate": frac(db, nd),
                      "birds_called_other": bo, "scenes": len(rows), "scenes_ok": ok, "scenes_strict_ok": strict}
        print(f"{t:<16}{nb:>6}{nd:>7}  {fmt(frac(bb, nb)):>8}  {fmt(frac(dd, nd)):>9}  {bd:>5} ({fmt(frac(bd, nb))})  {db:>5} ({fmt(frac(db, nd))})  {bo:>5} ({fmt(frac(bo, nb))})  {ok:>4}/{len(rows):<5}  {strict:>3}/{len(rows)}")
    print(" * every drone labelled drone AND no bird labelled drone")
    print(" ** every drone labelled drone AND every bird labelled bird")
    # balanced accuracy over bird/drone only, a quick "is this better than chance?" number (chance = 1/3 for 3 outputs)
    allb, alld = summary["ALL"]["bird_recall"], summary["ALL"]["drone_recall"]
    if allb is not None and alld is not None:
        print(f"balanced recall (bird, drone) = {100 * (allb + alld) / 2:.1f}%  (a model guessing among 3 classes averages ~33%;")
        print("  an untrained model often puts everything in one class, giving 50% here with one recall at 100% and one at 0%)")
    for k in ("sharp", "blurred"):
        n = sum(blur_counts[k].values())
        if n:
            print(f"birds {k:<8}: {n:5d}, labelled bird {fmt(frac(blur_counts[k]['bird'], n))}, drone {fmt(frac(blur_counts[k]['drone'], n))}, other {fmt(frac(blur_counts[k]['other'], n))}")

    print()
    print("per scene with drones (drones flagged / drones, birds called drone, birds called other):")
    for r in per_scene:
        if r["drones"]:
            mark = "OK  " if r["all_drones_flagged_no_false_drone"] else "MISS"
            print(f"  {mark} {r['file']:<34} drones {r['drones_flagged']}/{r['drones']} {r['drone_preds']}, birds->drone {r['birds_called_drone']}/{r['birds']}, birds->other {r['birds_called_other']}")
    noflag = [r for r in per_scene if not r["drones"]]
    if noflag:
        fa = sum(r["birds_called_drone"] > 0 for r in noflag)
        print(f"  scenes with no drone: {len(noflag)}, of which {fa} have at least one bird called a drone (false drone alert)")

    # speed: one batch of 60 crops (a 60-bird flock in one frame), crop + model separately
    sc = max(man["scenes"], key=lambda s: len(s["objects"]))
    img = Image.open(root / sc["file"]).convert("RGB")
    objs = (sc["objects"] * 2)[:60]
    t0 = time.perf_counter()
    for _ in range(5):
        crops = crop_objects(img, objs)
        x = to_tensor(crops)
    crop_ms = (time.perf_counter() - t0) / 5 * 1000
    model(x)  # warm-up
    times = []
    for _ in range(10):
        t0 = time.perf_counter()
        model(x)
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    print()
    print(f"timing (CPU, {torch.get_num_threads()} threads): 60 crops cut + normalised in {crop_ms:.1f} ms; "
          f"one batch of 60 through SkyNetLite: median {times[len(times) // 2]:.1f} ms (min {times[0]:.1f}, max {times[-1]:.1f})")
    if bad_hash:
        print(f"WARNING: {bad_hash} scene images do not match their manifest sha256 (regenerated or edited?)")

    if args.json:
        out = {"checkpoint": str(args.checkpoint), "manifest": str(args.manifest), "seed": man.get("seed"),
               "min_visible": args.min_visible, "summary": summary,
               "blur": {k: dict(v) for k, v in blur_counts.items()}, "per_scene": per_scene,
               "timing_ms": {"crop_60": crop_ms, "model_batch_60_median": times[len(times) // 2]},
               "hash_mismatches": bad_hash,
               "note": "synthetic pastes from the valid split; stress check, not accuracy evidence"}
        args.json.write_text(json.dumps(out, indent=1))
        print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
