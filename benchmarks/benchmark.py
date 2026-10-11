"""Benchmark one version of the detection system on every frozen tier.

    .venv/bin/python benchmarks/benchmark.py --version v1 --hypothesis "..." [--final]

Rules (benchmarks/BENCHMARK_PROTOCOL.md): checksums verified first; one change per version;
outputs in benchmarks/vN/ are never overwritten; one row appended to results.csv.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench import manifest  # noqa: E402
from bench.common import (ROOT, append_result, dumps, git_info, hardware_info, load_version_config,  # noqa: E402
                          now_utc, pick_device, read_results, sha256_file, version_dir, weight_hashes, MANIFEST)

HEADLINE = [  # (results.csv column prefix, metric key in metrics.json, higher is better)
    ("visual_drone_recall", ("visual", "drone_recall"), True),
    ("visual_fa_rate", ("visual", "fa_rate"), False),
    ("audio_drone_recall", ("audio", "recall"), True),
    ("audio_fa_per_hour", ("audio", "fa_per_hour"), False),
]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def current_best():
    """Most recent KEPT version's metrics (decisions are separate rows in results.csv)."""
    rows = read_results()
    decisions = {r["version"]: r["decision"] for r in rows if r["row_type"] == "decision"}
    runs = [r for r in rows if r["row_type"] == "run" and decisions.get(r["version"]) == "keep"]
    if not runs:
        return None, None
    best = runs[-1]
    return best["version"], json.loads(best["metrics_json"])


def run_visual(cfg, man, final, device, out, n_boot):
    from bench import visual
    items, gt_rows = manifest.visual_items(man, final)
    if items.empty:
        return None, None
    log(f"visual: {len(items)} images, imgsz {cfg['imgsz']}, conf>= {cfg['visual_conf']}")
    det_rows = visual.run_yolo(str(ROOT / cfg["visual_weights"]), items.to_dict("records"), cfg["imgsz"], device)
    pred = pd.DataFrame(gt_rows + det_rows)
    pred["modality"] = "visual"
    pred = pred.reset_index(drop=True)
    log("visual: computing metrics with bootstrap CIs")
    m, sweep, per = visual.compute_metrics(pred, items, cfg["visual_conf"], n_boot=n_boot)
    extra = {"sweep": sweep, "confusion": visual.confusion(per, cfg["visual_conf"]), "pr_curve": pr_curves(per)}
    log("visual: speed test at imgsz 640 and 1280")
    paths = items.path.tolist()[:40]
    extra["speed"] = [visual.speed_test(str(ROOT / cfg["visual_weights"]), paths, s, device) for s in (640, 1280)]
    from bench.errors import visual_errors
    errs = visual_errors(per, pred, items, out / "errors", cfg["visual_conf"])
    return {"metrics": m, "extra": extra, "errors": errs}, pred


def pr_curves(per):
    from bench.visual import CLASSES
    curves = {}
    for c, name in CLASSES.items():
        sc = np.concatenate([p[c]["scores"] for p in per])
        tp = np.concatenate([p[c]["tp"][:, 0] for p in per])
        ngt = sum(len(p[c]["gt_best"]) for p in per)
        order = np.argsort(-sc)
        ctp = np.cumsum(tp[order])
        prec = ctp / np.arange(1, len(ctp) + 1)
        rec = ctp / max(ngt, 1)
        step = max(1, len(rec) // 300)
        curves[name] = {"recall": rec[::step].tolist(), "precision": prec[::step].tolist()}
    return curves


def run_audio(cfg, man, final, device, out, n_boot):
    from bench import audio
    items = manifest.audio_items(man, final)
    if items.empty:
        return None, None
    det = audio.AudioDetector(str(ROOT / cfg["audio_weights"]), device)
    log(f"audio: {len(items)} items ({items.path.nunique()} unique recordings)")
    cache, rows, clips_for_latency = {}, [], []
    for n, it in enumerate(items.itertuples(index=False)):
        if it.path not in cache:
            y = audio.load_audio(it.path)
            cache[it.path] = det.window_probs(y)
            if len(clips_for_latency) < 200 and len(y) >= audio.SR:
                clips_for_latency.append(y)
        probs, starts = cache[it.path]
        base = it._asdict()
        for p, s in zip(probs, starts):
            rows.append({**base, "prob": float(p), "t0": float(s)})
        if n % 2000 == 0:
            log(f"audio: {n}/{len(items)}")
    pred = pd.DataFrame(rows)
    pred["modality"] = "audio"
    log("audio: computing metrics with bootstrap CIs")
    m, extra = audio.compute_metrics(pred, cfg["audio_threshold"], cfg.get("audio_min_consecutive", 1), n_boot=n_boot)
    extra["latency"] = audio.latency(det, clips_for_latency)
    from bench.errors import audio_errors
    errs = audio_errors(pred, out / "errors", cfg["audio_threshold"])
    return {"metrics": m, "extra": extra, "errors": errs}, pred


def suspicious(new, best):
    """Flag jumps too large to be plausible for one change; leakage must be checked before reporting."""
    flags = []
    if not best:
        for mod, key in (("visual", "mAP50"), ("audio", "roc_auc")):
            v = new.get(mod, {}).get(key, {}).get("value")
            if v is not None and v > 0.99:
                flags.append(f"{mod} {key} = {v:.3f} (near perfect)")
        return flags
    for col, (mod, key), higher in HEADLINE:
        a = new.get(mod, {}).get(key, {}).get("value")
        b = best.get(mod, {}).get(key, {}).get("value")
        if a is None or b is None:
            continue
        if higher and a - b > 0.15:
            flags.append(f"{col} jumped {b:.3f} -> {a:.3f}")
        if not higher and b > 0 and a < 0.5 * b:
            flags.append(f"{col} fell {b:.3f} -> {a:.3f}")
    return flags


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--hypothesis", required=True, help="written BEFORE running: what should change and why")
    ap.add_argument("--final", action="store_true", help="include the field-set holdout half (only on 'final run')")
    ap.add_argument("--n_boot", type=int, default=1000)
    ap.add_argument("--skip", default="", help="comma list: visual,audio (only while a model doesn't exist yet)")
    args = ap.parse_args()

    if args.n_boot != 1000:
        print("WARNING: protocol requires 1,000 bootstrap resamples; this run is not reportable.")
    git = git_info()
    if git["dirty"] and args.version != "v0":
        raise SystemExit("Uncommitted changes: commit first so the result is reproducible (only v0 may run dirty).")
    cfg = load_version_config(args.version)
    man = manifest.load()
    log("verifying test-set checksums")
    n_files = manifest.verify(man, include_holdout=args.final)
    log(f"all {n_files} frozen test files verified")
    out = version_dir(args.version)
    device = pick_device()
    skip = set(filter(None, args.skip.split(",")))

    results, preds = {}, []
    t0 = time.time()
    if "visual" not in skip and cfg.get("visual_weights"):
        r, p = run_visual(cfg, man, args.final, device, out, args.n_boot)
        if r:
            results["visual"] = r
            preds.append(p)
    if "audio" not in skip and cfg.get("audio_weights"):
        r, p = run_audio(cfg, man, args.final, device, out, args.n_boot)
        if r:
            results["audio"] = r
            preds.append(p)

    pd.concat(preds, ignore_index=True).to_parquet(out / "predictions.parquet", index=False)
    metrics = {mod: r["metrics"] for mod, r in results.items()}
    best_v, best_m = current_best()
    flags = suspicious(metrics, best_m)
    run = {
        "version": args.version, "hypothesis": args.hypothesis, "timestamp_utc": now_utc(), "final_run": args.final,
        "git": git, "config": cfg, "weights": weight_hashes(cfg), "hardware": hardware_info(),
        "manifest_sha256": sha256_file(MANIFEST), "n_test_files_verified": n_files, "n_boot": args.n_boot,
        "seeds": {"bootstrap": 20261010}, "compared_to": best_v, "suspicious": flags,
        "tiers_run": sorted(results), "runtime_s": round(time.time() - t0, 1),
    }
    (out / "run.json").write_text(json.dumps(run, indent=1, default=str))
    (out / "metrics.json").write_text(json.dumps(metrics, indent=1, default=float))
    (out / "extra.json").write_text(json.dumps({m: r["extra"] for m, r in results.items()}, default=float))
    from bench.errors import write_index
    write_index(out / "errors", results.get("visual", {}).get("errors", []), results.get("audio", {}).get("errors", []))

    row = {"row_type": "run", "version": args.version, "timestamp_utc": run["timestamp_utc"], "hypothesis": args.hypothesis,
           "final_run": args.final, "git_commit": git["commit"], "git_dirty": git["dirty"],
           "manifest_sha256": run["manifest_sha256"], "weights_json": dumps(run["weights"]),
           "thresholds_json": dumps({k: v for k, v in cfg.items() if not k.startswith("_")}),
           "hardware_json": dumps(run["hardware"]), "metrics_json": dumps(metrics)}
    for col, (mod, key), _ in HEADLINE:
        v = metrics.get(mod, {}).get(key)
        if v:
            row[col], row[col + "_lo"], row[col + "_hi"] = v["value"], v["lo"], v["hi"]
    append_result(row)

    log(f"done in {time.time() - t0:.0f}s -> benchmarks/{args.version}/")
    for col, (mod, key), higher in HEADLINE:
        v = metrics.get(mod, {}).get(key)
        if v:
            print(f"  {col:22s} {v['value']:.4f}  95% CI [{v['lo']:.4f}, {v['hi']:.4f}]")
    if flags:
        print("\n!! SUSPICIOUSLY GOOD: " + "; ".join(flags))
        print("!! Run benchmarks/leakage_check.py before reporting these numbers (protocol section 6).")


if __name__ == "__main__":
    main()
