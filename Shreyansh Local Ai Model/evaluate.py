#!/usr/bin/env python3
"""Evaluate a SkyNetLite crop classifier (bird / drone / other) on the frozen Tier 1 test set.

    python3 evaluate.py --checkpoint path/to/model.pt --out results/<name>
    python3 evaluate.py --checkpoint new.pt --out results/new --compare results/old/metrics.json

What it does (rules: benchmarks/BENCHMARK_PROTOCOL.md, sections 1, 5 and 6):
  1. Checks the SHA-256 of every visual test image AND label file in benchmarks/test_sets.json, and that no
     unlisted file was added to the test folders. Anything missing, changed or added -> refuses to run.
  2. Cuts test crops with the shared crop rule (crops.square_for_box + crops.cut, INPUT px):
       - one crop per manifest box; label from the box class (0 = bird, 1 = drone), which must agree with
         the file name (BT... = bird image, DT... = drone image);
       - up to OTHER_PER_IMAGE "other" crops per image: sky / background squares that stay clear of every box,
         with side lengths drawn from the real box squares (fixed seed OTHER_SEED).
  3. Runs the model in eval mode (batch inference, CPU).
  4. Computes accuracy, per-class recall / precision, confusion matrix, false-alarm rate and bird<->drone
     confusion, overall and by size_tag and condition_tag. Every number has a 95% bootstrap CI from
     N_BOOT resamples of manifest GROUPS (near-duplicate frames move together), percentile method, seed BOOT_SEED.
  5. Optional --compare: marks each headline metric significant / not significant (protocol: overlapping CIs
     = not significant).
  6. Writes <out>/metrics.json and <out>/report.md. No image or crop is ever written to disk.
"""
import argparse
import json
import os
import platform
import subprocess
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import PIL
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MANIFEST = REPO / "benchmarks" / "test_sets.json"
LEAKAGE_REPORT = REPO / "benchmarks" / "leakage_report.json"

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "benchmarks"))
import torch  # noqa: E402

from bench import stats as bstats  # noqa: E402  (team's bootstrap / significance helpers)
from bench.common import sha256_file  # noqa: E402
from crops import CLASSES, CONTEXT, INPUT, MIN_SIDE, cut, square_for_box  # noqa: E402
from model import MEAN, STD, SkyNetLite  # noqa: E402

BIRD, DRONE, OTHER = 0, 1, 2
PREFIX_CLASS = {"BT": BIRD, "DT": DRONE}       # item ids: BT... = bird image, DT... = drone image
SIZES = ["small", "medium", "large"]
CONDITIONS = ["clear", "cloudy", "backlit", "cluttered"]

OTHER_SEED = 1234         # numpy default_rng, one stream over the images in manifest order
OTHER_PER_IMAGE = 3
OTHER_MAX_TRIES = 200     # side lengths drawn per image before giving up ...
OTHER_POSITIONS = 20      # ... and random positions tried for each drawn side
OTHER_MAX_IOU = 0.05      # square vs every box: IoU must be below this ...
OTHER_MAX_COVER = 0.05    # ... AND the box may cover at most 5% of the square (see note in other_crops)
BOOT_SEED = 0
N_BOOT = 1000
BATCH = 256

# Headline metrics for --compare: (key, higher_is_better). Protocol headline = drone recall + false-alarm rate.
HEADLINE = [("drone_recall", True), ("false_alarm_rate", False), ("accuracy", True), ("bird_recall", True),
            ("bird_called_drone", False), ("drone_called_bird", False)]
NAMES = {
    "accuracy": "Overall accuracy", "balanced_accuracy": "Balanced accuracy (mean of the 3 recalls)",
    "drone_recall": "Drone recall", "bird_recall": "Bird recall", "other_recall": "Other recall",
    "drone_precision": "Drone precision", "bird_precision": "Bird precision", "other_precision": "Other precision",
    "false_alarm_rate": "False-alarm rate", "bird_called_drone": "Birds called drones",
    "drone_called_bird": "Drones called birds",
}


def die(msg):
    print(f"\nERROR: {msg}", file=sys.stderr)
    sys.exit(2)


# ----------------------------------------------------------------------------- 1. verify the frozen test set
def load_manifest():
    if not MANIFEST.exists():
        die(f"{MANIFEST} not found.")
    man = json.loads(MANIFEST.read_text())
    try:
        vis = man["tiers"]["dataset"]["visual"]
        items = vis["items"]
    except KeyError:
        die("test_sets.json has no tiers.dataset.visual.items. Refusing to run (ask Vivan).")
    return man, vis, items


def verify(vis, items):
    """Protocol section 1: every listed image and label file must exist with the listed SHA-256, and nothing
    unlisted may sit in the test folders. Any problem -> refuse to run."""
    problems, listed, n_checked = [], set(), 0
    for it in items:
        for key, hkey in (("path", "sha256"), ("label_path", "label_sha256")):
            rel, want = it.get(key), it.get(hkey)
            if not rel or not want:
                problems.append(f"NO CHECKSUM IN MANIFEST  {it.get('item_id')} ({key})")
                continue
            p = REPO / rel
            listed.add(p.resolve())
            n_checked += 1
            if not p.is_file():
                problems.append(f"MISSING  {rel}")
            elif sha256_file(p) != want:
                problems.append(f"CHANGED  {rel}")
    # "added" files: anything in the folders that hold the test images / labels that the manifest doesn't list
    folders = {(REPO / it[k]).parent for it in items for k in ("path", "label_path") if it.get(k)}
    for d in sorted(folders):
        if d.is_dir():
            for p in sorted(d.iterdir()):
                if p.is_file() and not p.name.startswith(".") and p.resolve() not in listed:
                    problems.append(f"ADDED (not in manifest)  {p.relative_to(REPO)}")
    n_groups_declared = vis.get("n_groups")
    n_groups_found = len({it.get("group") for it in items})
    if n_groups_declared is not None and int(n_groups_declared) != n_groups_found:
        problems.append(f"MANIFEST INCONSISTENT  n_groups says {n_groups_declared}, items carry {n_groups_found}")
    if any("group" not in it for it in items):
        problems.append("MANIFEST INCONSISTENT  some items have no group id")
    if problems:
        for line in problems[:30]:
            print("  " + line, file=sys.stderr)
        if len(problems) > 30:
            print(f"  ... and {len(problems) - 30} more", file=sys.stderr)
        die(f"Test-set verification FAILED ({len(problems)} problem(s), {n_checked} files checked). Refusing to run. "
            "Do not fix, replace or skip test files: ask Vivan (BENCHMARK_PROTOCOL.md section 1).")
    return n_checked, len(folders)


# ----------------------------------------------------------------------------- 2. test crops
def box_px(b, w, h):
    return (b["x1"] * w, b["y1"] * h, b["x2"] * w, b["y2"] * h)


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def cover(sq, b):
    """Fraction of the square sq covered by box b."""
    ix = max(0.0, min(sq[2], b[2]) - max(sq[0], b[0]))
    iy = max(0.0, min(sq[3], b[3]) - max(sq[1], b[1]))
    return ix * iy / ((sq[2] - sq[0]) * (sq[3] - sq[1]))


def open_rgb(path, item_id):
    try:
        with Image.open(path) as im:
            return im.convert("RGB")
    except Exception as e:  # protocol: a broken test file means stop and ask, never skip
        die(f"Test image {item_id} could not be read ({e}). Do not fix or skip it: ask Vivan (protocol section 1).")


def side_pool(items):
    """Every real box's live-crop square, as a fraction of its image's shorter side, with its size_tag."""
    pool = []
    for it in items:
        with Image.open(REPO / it["path"]) as im:
            w, h = im.size
        for b in it["boxes"]:
            x1, y1, x2, y2 = box_px(b, w, h)
            _, _, side = square_for_box(0, 0, x2 - x1, y2 - y1)
            pool.append((side / min(w, h), b["size_tag"]))
    if not pool:
        die("The manifest has no boxes at all. Refusing to run.")
    return pool


def other_crops(img, boxes, pool, rng):
    """Up to OTHER_PER_IMAGE sky / background squares from one image.

    Each try: pick a real box square at random from the pool (its side and its size_tag), then try up to
    OTHER_POSITIONS random positions for a square of that side fully inside the image, and accept the first one
    that, for EVERY box, has:
      - IoU(square, box) < OTHER_MAX_IOU, and
      - the box centre is not inside the square, and
      - the box covers < OTHER_MAX_COVER of the square.
    The third rule is extra: with only the first two, a small square sitting inside a large drone box has a tiny
    IoU and passes, so an "other" crop could show part of a drone. The square must be fully inside the image so
    distractors never get edge-padding streaks (real object crops near the border can still be padded).
    Trying several positions per side keeps big sides from being thrown away too easily, but big object squares
    (often > 400 px of a 640 px image) still rarely fit beside the object, so 'other' squares end up smaller on
    average than object squares."""
    w, h = img.size
    out, tries = [], 0
    while len(out) < OTHER_PER_IMAGE and tries < OTHER_MAX_TRIES:
        tries += 1
        frac, tag = pool[int(rng.integers(len(pool)))]
        side = frac * min(w, h)
        if side > min(w, h):
            continue  # a square this big can't fit inside the image
        for _ in range(OTHER_POSITIONS):
            x0, y0 = rng.uniform(0, w - side), rng.uniform(0, h - side)
            sq = (x0, y0, x0 + side, y0 + side)
            if all(iou(sq, b) < OTHER_MAX_IOU and not (sq[0] <= (b[0] + b[2]) / 2 <= sq[2]
                                                        and sq[1] <= (b[1] + b[3]) / 2 <= sq[3])
                   and cover(sq, b) < OTHER_MAX_COVER for b in boxes):
                out.append((x0 + side / 2, y0 + side / 2, side, tag))
                break
    return out, tries


def build_crops(items):
    pool = side_pool(items)
    rng = np.random.default_rng(OTHER_SEED)
    X, meta = [], []
    short = []
    for i, it in enumerate(items):
        iid = it["item_id"]
        if it.get("condition_tag") not in CONDITIONS:
            die(f"{iid} has unknown condition_tag {it.get('condition_tag')!r}.")
        common = {"item": i, "item_id": iid, "condition_tag": it["condition_tag"], "group": it["group"]}
        expect = PREFIX_CLASS.get(iid[:2])
        if expect is None:
            die(f"Item id {iid!r} does not start with BT or DT, so its class can't be checked. Refusing to run.")
        img = open_rgb(REPO / it["path"], iid)
        w, h = img.size
        boxes = []
        for j, b in enumerate(it["boxes"]):
            if b.get("cls") != expect:
                die(f"{iid} box {j} has cls={b.get('cls')} but the file name says {CLASSES[expect]} "
                    f"(cls {expect}). Manifest and file name disagree: refusing to run (ask Vivan).")
            if b.get("size_tag") not in SIZES:
                die(f"{iid} box {j} has unknown size_tag {b.get('size_tag')!r}.")
            x1, y1, x2, y2 = box_px(b, w, h)
            boxes.append((x1, y1, x2, y2))
            cx, cy, side = square_for_box((x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1)
            X.append(cut(img, cx, cy, side, INPUT))
            meta.append({**common, "kind": "object", "box": j, "true": expect,
                         "size_tag": b["size_tag"], "side_px": round(side, 1)})
        found, tries = other_crops(img, boxes, pool, rng)
        if len(found) < OTHER_PER_IMAGE:
            short.append({"item_id": iid, "found": len(found), "tries": tries})
        for k, (cx, cy, side, tag) in enumerate(found):
            X.append(cut(img, cx, cy, side, INPUT))
            meta.append({**common, "kind": "other", "box": k, "true": OTHER,
                         "size_tag": tag, "side_px": round(side, 1)})
    X = np.stack(X)
    if X.shape[1:] != (INPUT, INPUT, 3):
        die(f"crop shape {X.shape[1:]} is not ({INPUT}, {INPUT}, 3)")
    return X, meta, pool, short


# ----------------------------------------------------------------------------- 3. model
def load_model(path):
    try:
        ck = torch.load(path, map_location="cpu", weights_only=True)
    except Exception as e:
        die(f"Could not load checkpoint {path} with torch.load(weights_only=True): {e}\n"
            "Save it as a plain state_dict, or as a dict {'model': state_dict, ...} of tensors / numbers / strings.")
    sd = ck["model"] if isinstance(ck, dict) and isinstance(ck.get("model"), dict) else ck
    if not isinstance(sd, dict):
        die("Checkpoint is neither a state_dict nor a dict with key 'model' holding one.")
    sd = {k.removeprefix("module.").removeprefix("_orig_mod."): v for k, v in sd.items()}
    model = SkyNetLite(n_classes=len(CLASSES))
    try:
        model.load_state_dict(sd, strict=True)
    except RuntimeError as e:
        die(f"Checkpoint does not match SkyNetLite in model.py:\n{e}")
    model.eval()
    extra = {k: v for k, v in ck.items() if k != "model" and isinstance(v, (int, float, str, bool))} \
        if isinstance(ck, dict) and "model" in ck else {}
    return model, extra


@torch.no_grad()
def predict(model, X):
    mean = torch.tensor(MEAN).view(1, 3, 1, 1)
    std = torch.tensor(STD).view(1, 3, 1, 1)
    probs = []
    for s in range(0, len(X), BATCH):
        x = torch.from_numpy(X[s:s + BATCH]).permute(0, 3, 1, 2).float().div_(255.0)
        x = (x - mean) / std
        probs.append(torch.softmax(model(x), dim=1).numpy())
    return np.concatenate(probs)


# ----------------------------------------------------------------------------- 4. metrics + bootstrap
def _div(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(b > 0, a / np.where(b > 0, b, 1), np.nan)


def metrics_from_cm(cm):
    """cm: [..., true, pred] confusion counts (3x3 in the last two dims). Returns name -> array[...]."""
    rows, cols = cm.sum(-1), cm.sum(-2)
    diag = np.diagonal(cm, axis1=-2, axis2=-1)
    rec, prec = _div(diag, rows), _div(diag, cols)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)   # cells with no crops of any class -> nan
        bal = np.nanmean(rec, axis=-1)
    out = {
        "accuracy": _div(diag.sum(-1), cm.sum((-1, -2))),
        "balanced_accuracy": bal,
        "drone_recall": rec[..., DRONE], "bird_recall": rec[..., BIRD], "other_recall": rec[..., OTHER],
        "drone_precision": prec[..., DRONE], "bird_precision": prec[..., BIRD], "other_precision": prec[..., OTHER],
        "false_alarm_rate": _div(cm[..., OTHER, BIRD] + cm[..., OTHER, DRONE], rows[..., OTHER]),
        "bird_called_drone": _div(cm[..., BIRD, DRONE], rows[..., BIRD]),
        "drone_called_bird": _div(cm[..., DRONE, BIRD], rows[..., DRONE]),
    }
    for t in range(3):
        for p in range(3):
            out[f"rate_true_{CLASSES[t]}_pred_{CLASSES[p]}"] = _div(cm[..., t, p], rows[..., t])
    return out


def denominators(cm):
    rows, cols = cm.sum(-1), cm.sum(-2)
    d = {"accuracy": cm.sum(), "balanced_accuracy": cm.sum(),
         "drone_recall": rows[DRONE], "bird_recall": rows[BIRD], "other_recall": rows[OTHER],
         "drone_precision": cols[DRONE], "bird_precision": cols[BIRD], "other_precision": cols[OTHER],
         "false_alarm_rate": rows[OTHER], "bird_called_drone": rows[BIRD], "drone_called_bird": rows[DRONE]}
    for t in range(3):
        for p in range(3):
            d[f"rate_true_{CLASSES[t]}_pred_{CLASSES[p]}"] = rows[t]
    return {k: int(v) for k, v in d.items()}


def group_resample_weights(group_ids):
    """Bootstrap weights [N_BOOT, G]: how often each group is drawn in each resample. Draws are made exactly as
    bench.stats.bootstrap(groups=..., seed=BOOT_SEED) makes them (groups in np.unique order, one
    rng.integers(0, G, G) per resample), so the CIs match the team's helper."""
    uniq, inv = np.unique(np.asarray(group_ids), return_inverse=True)
    G = len(uniq)
    rng = np.random.default_rng(BOOT_SEED)
    W = np.zeros((N_BOOT, G))
    for b in range(N_BOOT):
        W[b] = np.bincount(rng.integers(0, G, G), minlength=G)
    return W, inv, G


def compute_metrics(meta, pred):
    true = np.array([m["true"] for m in meta])
    W, ginv, G = group_resample_weights([m["group"] for m in meta])
    cells = [("overall", np.ones(len(meta), bool))]
    cells += [(f"size:{s}", np.array([m["size_tag"] == s for m in meta])) for s in SIZES]
    cells += [(f"condition:{c}", np.array([m["condition_tag"] == c for m in meta])) for c in CONDITIONS]
    # counts[g, cell, true, pred]: every crop of an image lands in its image's group
    counts = np.zeros((G, len(cells), 3, 3))
    for ci, (_, mask) in enumerate(cells):
        np.add.at(counts, (ginv[mask], ci, true[mask], pred[mask]), 1)
    boot_cm = np.einsum("bg,gctp->bctp", W, counts)          # [N_BOOT, cell, 3, 3]
    point_cm = counts.sum(0)                                  # [cell, 3, 3]
    point, boot = metrics_from_cm(point_cm), metrics_from_cm(boot_cm)
    out = {}
    for ci, (name, mask) in enumerate(cells):
        cm = point_cm[ci]
        dens = denominators(cm)
        mets, rates = {}, {}
        for key in point:
            vals = boot[key][:, ci]
            vals = vals[~np.isnan(vals)]
            v = float(point[key][ci])
            if np.isnan(v) or len(vals) == 0:
                entry = {"value": None, "lo": None, "hi": None}
            else:
                lo, hi = np.percentile(vals, [2.5, 97.5])
                entry = bstats.metric(v, float(lo), float(hi))
            entry["n"] = dens[key]
            entry["n_valid_resamples"] = int(len(vals))   # resamples where the denominator was > 0
            (rates if key.startswith("rate_") else mets)[key] = entry
        idx = np.where(mask)[0]
        out[name] = {
            "n_crops": int(mask.sum()),
            "n_by_class": {CLASSES[c]: int((true[mask] == c).sum()) for c in range(3)},
            "n_images": len({meta[i]["item"] for i in idx}),
            "n_groups": len({meta[i]["group"] for i in idx}),
            "metrics": mets,
            "confusion_matrix": {"rows_true": CLASSES, "cols_pred": CLASSES, "counts": cm.astype(int).tolist()},
            "confusion_rates": rates,
        }
    return out, G


# ----------------------------------------------------------------------------- 5. comparison
def eval_settings():
    return {"input": INPUT, "context": CONTEXT, "min_side": MIN_SIDE, "other_seed": OTHER_SEED,
            "other_per_image": OTHER_PER_IMAGE, "other_max_tries": OTHER_MAX_TRIES, "other_positions": OTHER_POSITIONS, "other_max_iou": OTHER_MAX_IOU,
            "other_max_cover": OTHER_MAX_COVER, "boot_seed": BOOT_SEED, "n_boot": N_BOOT,
            "bootstrap_unit": "manifest group"}


def compare(this, other_path):
    try:
        other = json.loads(Path(other_path).read_text())
    except Exception as e:
        die(f"Could not read --compare file {other_path}: {e}")
    res = {"against": str(Path(other_path).resolve()),
           "against_checkpoint_sha256": other.get("reproducibility", {}).get("checkpoint_sha256"),
           "rule": "protocol section 5: overlapping 95% CIs = not significant", "metrics": {}}
    reasons = []
    if other.get("test_set", {}).get("manifest_sha256") != this["test_set"]["manifest_sha256"]:
        reasons.append("the frozen test-set manifest changed between the two runs (protocol section 1)")
    if other.get("eval_settings") != this["eval_settings"]:
        reasons.append("the evaluation settings (crop rule / other-crop sampling / bootstrap) differ")
    res["comparable"] = not reasons
    res["not_comparable_because"] = reasons
    for key, higher_better in HEADLINE:
        a = this["results"]["overall"]["metrics"][key]
        b = other.get("results", {}).get("overall", {}).get("metrics", {}).get(key)
        row = {"this": a, "other": b, "higher_is_better": higher_better}
        if reasons:
            row["verdict"] = "not comparable"
        elif not b or a["value"] is None or b.get("value") is None or a["lo"] is None or b.get("lo") is None:
            row["verdict"] = "not significant"
            row["note"] = "missing value or CI"
        else:
            s = bstats.significant(a, b)          # 'higher' / 'lower' / 'not significant'
            if s == "not significant":
                row["verdict"] = "not significant"
            else:
                row["verdict"] = "significant"
                row["direction"] = s
                row["better_or_worse"] = "better" if (s == "higher") == higher_better else "worse"
        res["metrics"][key] = row
    return res


# ----------------------------------------------------------------------------- 7. reproducibility
def git(*args):
    try:
        return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return ""


def cpu_info():
    info = {"platform": platform.platform(), "machine": platform.machine(), "processor": platform.processor(),
            "os_cpu_count": os.cpu_count(), "torch_threads": torch.get_num_threads()}
    try:
        info["cpus_available"] = len(os.sched_getaffinity(0))
    except AttributeError:
        pass
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                info["cpu_model"] = line.split(":", 1)[1].strip()
                break
    except OSError:
        if sys.platform == "darwin":
            info["cpu_model"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                                               capture_output=True, text=True).stdout.strip()
    return info


def leakage_summary():
    if not LEAKAGE_REPORT.exists():
        return {"available": False}
    try:
        r = json.loads(LEAKAGE_REPORT.read_text()).get("images", {})
    except Exception:
        return {"available": False}
    return {"available": True, "file": str(LEAKAGE_REPORT.relative_to(REPO)), "sha256": sha256_file(LEAKAGE_REPORT),
            "n_train": r.get("n_train"), "n_test": r.get("n_test"), "exact_duplicates": r.get("exact_duplicates"),
            "test_images_with_near_duplicate": r.get("test_images_with_near_duplicate"),
            "scope": "pHash (Hamming <= 6) of Mendeley TRAIN images vs the frozen test images; the VALID split was "
                     "not part of this check"}


# ----------------------------------------------------------------------------- 6. report
def fmt(m, pct=True):
    if not m or m.get("value") is None:
        return "n/a"
    f = (lambda v: f"{100 * v:.1f}%") if pct else (lambda v: f"{v:.3f}")
    return f"{f(m['value'])} ({f(m['lo'])} to {f(m['hi'])})"


def suspicious(res):
    m = res["overall"]["metrics"]
    v = lambda k: m[k]["value"]  # noqa: E731
    return (v("accuracy") is not None and v("accuracy") >= 0.98) or (
        v("drone_recall") is not None and v("false_alarm_rate") is not None
        and v("drone_recall") >= 0.98 and v("false_alarm_rate") <= 0.02)


def breakdown_table(res, prefix, values):
    head = ("| " + ("Size" if prefix == "size" else "Condition") + " | crops (bird / drone / other) | groups | Accuracy "
            "| Drone recall | Bird recall | False-alarm rate | Birds called drones | Drones called birds |")
    lines = [head, "|" + "---|" * 9]
    for v in values:
        c = res[f"{prefix}:{v}"]
        m = c["metrics"]
        n = c["n_by_class"]
        lines.append(f"| {v} | {c['n_crops']} ({n['bird']} / {n['drone']} / {n['other']}) | {c['n_groups']} | "
                     f"{fmt(m['accuracy'])} | {fmt(m['drone_recall'])} | {fmt(m['bird_recall'])} | "
                     f"{fmt(m['false_alarm_rate'])} | {fmt(m['bird_called_drone'])} | {fmt(m['drone_called_bird'])} |")
    return "\n".join(lines)


def write_report(path, doc):
    res = doc["results"]
    o = res["overall"]
    m = o["metrics"]
    n = o["n_by_class"]
    acc = m["accuracy"]
    L = []
    L.append(f"# SkyNetLite evaluation: {doc['run_name']}\n")
    L.append(f"Checkpoint `{doc['checkpoint']['path']}` (SHA-256 `{doc['reproducibility']['checkpoint_sha256'][:16]}...`), "
             f"run {doc['created_utc']}.\n")
    L.append("Every number below comes with a **95% confidence interval** in brackets: the range the true value "
             "probably lies in, given how many test pictures we have. Wide brackets mean \"we don't know this "
             f"precisely yet\". The {o['n_images']} test images are mostly frames from a few videos, so they were "
             f"grouped into {doc['test_set']['n_groups']} groups of near-identical frames, and the brackets are "
             "computed by resampling whole groups (protocol section 5). That makes them honest but wide.\n")
    L.append("## Headline numbers\n")
    L.append(f"- **Drone recall: {fmt(m['drone_recall'])}**: of {n['drone']} real drones, the share the model called \"drone\".")
    L.append(f"- **False-alarm rate: {fmt(m['false_alarm_rate'])}**: of {n['other']} empty sky / background squares, "
             "the share the model called \"bird\" or \"drone\".")
    L.append(f"- Overall accuracy: {fmt(acc)} over all {o['n_crops']} crops.")
    L.append(f"- Bird recall: {fmt(m['bird_recall'])} of {n['bird']} real birds called \"bird\".")
    L.append(f"- Birds called drones: {fmt(m['bird_called_drone'])}. Drones called birds: {fmt(m['drone_called_bird'])}.")
    L.append(f"- Balanced accuracy (average of bird, drone and other recall): {fmt(m['balanced_accuracy'])}.\n")
    L.append(f"Note: {n['other']} of the {o['n_crops']} crops ({100 * n['other'] / o['n_crops']:.0f}%) are \"other\" "
             "squares, so overall accuracy leans heavily on how well the model recognises empty sky. Read drone "
             "recall and false-alarm rate first.\n")

    cmp_ = doc.get("comparison")
    if cmp_:
        L.append("## Compared with another run\n")
        L.append(f"Against `{cmp_['against']}`. Rule: if the two 95% brackets overlap, the difference is "
                 "**not significant** (it could be luck).\n")
        if not cmp_["comparable"]:
            L.append("**These runs are NOT comparable** because " + "; ".join(cmp_["not_comparable_because"]) + ".\n")
        L.append("| Metric | This run | Other run | Verdict |")
        L.append("|---|---|---|---|")
        for key, row in cmp_["metrics"].items():
            verdict = row["verdict"]
            if verdict == "significant":
                verdict = f"significant ({row['direction']}, {row['better_or_worse']})"
            L.append(f"| {NAMES[key]} | {fmt(row['this'])} | {fmt(row['other'])} | {verdict} |")
        L.append("")

    L.append("## All overall numbers\n")
    L.append("| Metric | Value (95% CI) | n (denominator) |")
    L.append("|---|---|---|")
    for key in ["accuracy", "balanced_accuracy", "drone_recall", "bird_recall", "other_recall", "drone_precision",
                "bird_precision", "other_precision", "false_alarm_rate", "bird_called_drone", "drone_called_bird"]:
        L.append(f"| {NAMES[key]} | {fmt(m[key])} | {m[key]['n']} |")
    L.append("\nRecall = of the real X's, how many were called X. Precision = of everything called X, how many "
             "really were X.\n")
    L.append("### Confusion matrix (counts; rows = truth, columns = what the model said)\n")
    L.append("| truth \\ model said | bird | drone | other | total |")
    L.append("|---|---|---|---|---|")
    for t, row in zip(CLASSES, o["confusion_matrix"]["counts"]):
        L.append(f"| **{t}** | " + " | ".join(str(v) for v in row) + f" | {sum(row)} |")
    L.append("")
    L.append("## By object size\n")
    L.append("Size = box area / image area: small < 1%, medium 1-10%, large > 10% (tags stored in the manifest). "
             "\"Other\" squares carry the size tag of the real box whose square size they copied.\n")
    L.append(breakdown_table(res, "size", SIZES))
    L.append("")
    L.append("## By sky condition\n")
    L.append("Condition tags (clear, cloudy, backlit, cluttered) are stored per image in the manifest.\n")
    L.append(breakdown_table(res, "condition", CONDITIONS))
    L.append("")
    thin = [f"{k} ({key}: {res[k]['metrics'][key]['n']} crops)" for k in res for key in ("drone_recall", "bird_recall")
            if 0 < res[k]["metrics"][key]["n"] < 30]
    if thin:
        L.append("Cells with fewer than 30 crops have very wide brackets; don't read much into them: "
                 + ", ".join(thin) + ".\n")

    L.append("## What this test does and does not show\n")
    L.append("- This is **Tier 1 only**: the Mendeley dataset's own test split (pre-cut boxes around objects in "
             "640x640 images). It is **not field footage**. The real app sees crops around tracker boxes from our "
             "own cameras, which can be blurrier, smaller and messier. Tier 2 (our own footage) is not run here.")
    L.append("- The model only sorts crops someone already found. It does not test finding the object in the first "
             "place.")
    oc = doc["other_crops"]
    L.append("- \"Other\" crops are random sky / background squares from the same test images, with no bird or "
             "drone in them. Real distractors (planes, helicopters, insects, kites) are not in this test.")
    L.append(f"- \"Other\" squares are smaller than object squares (median side {oc['side_px_percentiles']['50']:.0f} px "
             f"vs {oc['object_square_side_px_percentiles']['50']:.0f} px), because a big empty square rarely fits "
             "beside a big object. Compare sizes using the size table above, not just the overall numbers.\n")
    lo = acc.get("lo")
    if lo is not None and lo > 0.99:
        verdict = (f"**Yes.** The lower end of the overall-accuracy bracket is {100 * lo:.1f}%, above 99%, so on this "
                   "Tier 1 test we can say overall accuracy is above 99% (with 95% confidence).")
    else:
        verdict = (f"**No.** The lower end of the overall-accuracy bracket is "
                   f"{'n/a' if lo is None else f'{100 * lo:.1f}%'}, not above 99%, so this run does **not** show the "
                   "99% target is met, even on Tier 1.")
    L.append("### 99% target\n")
    L.append(verdict + " Meeting 99% on Tier 1 would still not show 99% in the field.\n")
    L.append("### Leakage check (protocol section 6)\n")
    lk = doc["leakage"]
    if lk.get("available"):
        L.append(f"Existing image check `{lk['file']}`: {lk['exact_duplicates']} exact duplicates and "
                 f"{lk['test_images_with_near_duplicate']} test images with a near-duplicate among {lk['n_train']} "
                 "Mendeley train images. The valid split was not part of that check.")
    else:
        L.append("No leakage report found (benchmarks/leakage_report.json).")
    if doc["suspiciously_good"]:
        L.append("\n**These results look near-perfect. Before reporting them, confirm the model was trained only on "
                 "Mendeley train/valid images (never test) and that the leakage check above covers the training "
                 "data actually used (protocol section 6). If leakage is found, stop and ask Vivan.**")
    L.append("")
    L.append("## Reproducibility\n")
    r = doc["reproducibility"]
    L.append(f"- git commit `{r['git_commit']}` (working tree dirty: {r['git_dirty']}; this folder tracked by git: "
             f"{r['model_folder_tracked']})")
    L.append(f"- torch {r['torch']}, numpy {r['numpy']}, Pillow {r['pillow']}, Python {r['python']}")
    L.append(f"- CPU: {r['cpu'].get('cpu_model', r['cpu'].get('processor'))}, {r['cpu'].get('cpus_available')} cores "
             f"available, {r['cpu']['torch_threads']} torch threads")
    L.append(f"- seeds: other crops {OTHER_SEED}, bootstrap {BOOT_SEED} ({N_BOOT} group resamples)")
    L.append(f"- runtime {doc['timing_s']['total']:.1f} s; all {doc['test_set']['n_files_verified']} test files "
             "passed SHA-256 verification")
    Path(path).write_text("\n".join(L) + "\n")


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", required=True, help="model .pt (state_dict, or dict with key 'model')")
    ap.add_argument("--out", required=True, help="output folder, e.g. results/<name> (relative to the current folder)")
    ap.add_argument("--compare", help="results/<other>/metrics.json to compare the headline metrics against")
    args = ap.parse_args()

    t0 = time.time()
    ckpt = Path(args.checkpoint)
    if not ckpt.is_file():
        die(f"checkpoint {ckpt} not found")
    out = Path(args.out)
    if (out / "metrics.json").exists():
        die(f"{out}/metrics.json already exists. Results are never overwritten: choose a new --out name.")
    if args.compare and not Path(args.compare).is_file():
        die(f"--compare file {args.compare} not found")

    print("1/5 verifying the frozen test set (SHA-256 of every image and label) ...", flush=True)
    man, vis, items = load_manifest()
    n_files, _ = verify(vis, items)
    t_verify = time.time()
    print(f"    OK: {n_files} files ({len(items)} images + labels) match test_sets.json", flush=True)

    print("2/5 loading model ...", flush=True)
    model, ck_extra = load_model(ckpt)

    print("3/5 cutting test crops ...", flush=True)
    X, meta, pool, short = build_crops(items)
    t_crops = time.time()
    true = np.array([m["true"] for m in meta])
    print(f"    {len(meta)} crops: " + ", ".join(f"{CLASSES[c]} {int((true == c).sum())}" for c in range(3)), flush=True)

    print("4/5 running the model ...", flush=True)
    probs = predict(model, X)
    pred = probs.argmax(1)
    t_infer = time.time()

    print(f"5/5 metrics with {N_BOOT} group-bootstrap resamples ...", flush=True)
    results, G = compute_metrics(meta, pred)
    t_metrics = time.time()

    other_sides = np.array([m["side_px"] for m in meta if m["kind"] == "other"])
    obj_sides = np.array([m["side_px"] for m in meta if m["kind"] == "object"])
    q = [0, 10, 25, 50, 75, 90, 100]
    porcelain = git("status", "--porcelain")
    doc = {
        "run_name": out.name,
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tier": "Tier 1 only: Mendeley Data 6ghdz52pd7 v5 test split (not field footage)",
        "checkpoint": {"path": str(ckpt.resolve()), "extra_fields": ck_extra},
        "classes": CLASSES,
        "test_set": {
            "manifest": str(MANIFEST.relative_to(REPO)), "manifest_sha256": sha256_file(MANIFEST),
            "n_images": len(items), "n_groups": G, "n_files_verified": n_files,
            "n_boxes": int(sum(len(it["boxes"]) for it in items)),
            "images_without_boxes": [it["item_id"] for it in items if not it["boxes"]],
        },
        "eval_settings": eval_settings(),
        "other_crops": {
            "rule": other_crops.__doc__.strip(),
            "n": int(len(other_sides)),
            "images_with_fewer_than_max": short,
            "side_px_percentiles": dict(zip(map(str, q), np.percentile(other_sides, q).round(1).tolist()))
            if len(other_sides) else {},
            "object_square_side_px_percentiles": dict(zip(map(str, q), np.percentile(obj_sides, q).round(1).tolist())),
            "note": "Large squares rarely fit next to a large object, so 'other' squares are smaller on average "
                    "than object squares; compare the two percentile lists.",
        },
        "results": results,
        "suspiciously_good": None,
        "leakage": leakage_summary(),
        "reproducibility": {
            "checkpoint_sha256": sha256_file(ckpt),
            "git_commit": git("rev-parse", "HEAD"),
            "git_dirty": bool(porcelain),
            "model_folder_tracked": bool(git("ls-files", "--", HERE.name)),
            "code_sha256": {f: sha256_file(HERE / f) for f in ("evaluate.py", "model.py", "crops.py")},
            "torch": torch.__version__, "numpy": np.__version__, "pillow": PIL.__version__,
            "python": sys.version.split()[0], "cpu": cpu_info(),
            "seeds": {"other_crops_numpy_default_rng": OTHER_SEED, "bootstrap_numpy_default_rng": BOOT_SEED,
                      "torch": "not used (inference is deterministic)"},
            "command": " ".join(sys.argv),
        },
        "predictions": [
            {"item_id": m["item_id"], "kind": m["kind"], "box": m["box"], "true": CLASSES[m["true"]],
             "pred": CLASSES[int(p)], "p": [round(float(v), 4) for v in pr], "size_tag": m["size_tag"],
             "condition_tag": m["condition_tag"], "group": m["group"], "side_px": m["side_px"]}
            for m, p, pr in zip(meta, pred, probs)],
    }
    doc["suspiciously_good"] = bool(suspicious(results))
    if args.compare:
        doc["comparison"] = compare(doc, args.compare)
    doc["timing_s"] = {"verify": round(t_verify - t0, 2), "crops": round(t_crops - t_verify, 2),
                       "inference": round(t_infer - t_crops, 2), "metrics": round(t_metrics - t_infer, 2)}
    doc["timing_s"]["total"] = round(time.time() - t0, 2)

    out.mkdir(parents=True, exist_ok=True)
    (out / "metrics.json").write_text(json.dumps(doc, indent=1))
    write_report(out / "report.md", doc)

    m = results["overall"]["metrics"]
    print(f"\nDrone recall      {fmt(m['drone_recall'])}")
    print(f"False-alarm rate  {fmt(m['false_alarm_rate'])}")
    print(f"Overall accuracy  {fmt(m['accuracy'])}")
    print(f"Bird recall       {fmt(m['bird_recall'])}")
    if doc["suspiciously_good"]:
        print("WARNING: near-perfect results. Protocol section 6: check for test-set leakage before reporting.")
    if args.compare:
        for k, row in doc["comparison"]["metrics"].items():
            print(f"  vs other: {NAMES[k]:<22} {row['verdict']}"
                  + (f" ({row['direction']}, {row['better_or_worse']})" if row["verdict"] == "significant" else ""))
    print(f"\nWrote {out.resolve()}/metrics.json and report.md ({doc['timing_s']['total']:.1f} s)")


if __name__ == "__main__":
    main()
