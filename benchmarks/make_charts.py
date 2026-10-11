"""Charts from results.csv + each version's saved outputs -> benchmarks/charts/ (PNG 300 dpi + SVG).

    .venv/bin/python benchmarks/make_charts.py

Palette: the dataviz skill's validated categorical slots 1-3 (blue, orange, aqua: CVD-safe as a full
set), so comparisons use at most three series: v0, previous best, current best. Kept vs reverted is
also encoded by marker fill and shape, never colour alone. One y-axis per panel, always.
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench.common import BENCH, read_results  # noqa: E402

import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402

OUT = BENCH / "charts"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]       # v0 / previous best / current best
INK, INK2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"
REVERTED = "#898781"
BLUES = LinearSegmentedColormap.from_list("blues", ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"])

plt.rcParams.update({
    "font.family": "sans-serif", "font.sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
    "font.size": 15, "axes.titlesize": 18, "axes.labelsize": 15, "xtick.labelsize": 13, "ytick.labelsize": 13,
    "legend.fontsize": 13, "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2, "text.color": INK,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.spines.top": False, "axes.spines.right": False,
    "lines.linewidth": 2.2, "axes.titleweight": "semibold", "axes.titlelocation": "left",
})


def save(fig, name):
    OUT.mkdir(exist_ok=True)
    fig.savefig(OUT / f"{name}.png", dpi=300, bbox_inches="tight")
    fig.savefig(OUT / f"{name}.svg", bbox_inches="tight")
    plt.close(fig)
    print("wrote charts/" + name)


def load_versions():
    rows = read_results()
    decisions = {r["version"]: r for r in rows if r["row_type"] == "decision"}
    runs = []
    for r in rows:
        if r["row_type"] != "run":
            continue
        v = r["version"]
        d = decisions.get(v, {}).get("decision", "pending")
        extra_p = BENCH / v / "extra.json"
        runs.append({"version": v, "decision": d, "metrics": json.loads(r["metrics_json"]),
                     "extra": json.loads(extra_p.read_text()) if extra_p.exists() else {},
                     "final": r["final_run"] == "True"})
    kept = [r for r in runs if r["decision"] == "keep"]
    current = kept[-1] if kept else (runs[-1] if runs else None)
    previous = kept[-2] if len(kept) >= 2 else None
    return runs, runs[0] if runs else None, previous, current


def trio(v0, prev, cur):
    """(label, run, colour) for v0 / previous best / current best, without duplicates."""
    out, seen = [], set()
    for label, run, col in (("v0 baseline", v0, SERIES[0]), ("previous best", prev, SERIES[1]), ("current best", cur, SERIES[2])):
        if run and run["version"] not in seen:
            seen.add(run["version"])
            out.append((f"{run['version']} ({label.replace('v0 ', '')})", run, col))
    return out


def get(run, mod, key):
    return run["metrics"].get(mod, {}).get(key)


# 1 -------------------------------------------------------------------------------------------
def chart_progress(runs, cur):
    panels = [("visual", "drone_recall", "Visual drone recall", True), ("visual", "fa_rate", "Visual false-alarm rate\n(drone-free images with a drone alert)", False),
              ("audio", "recall", "Audio drone recall", True), ("audio", "fa_per_hour", "Audio false alarms per hour", False)]
    panels = [p for p in panels if any(get(r, p[0], p[1]) for r in runs)]
    if not panels:
        return
    fig, axes = plt.subplots(1, len(panels), figsize=(5.2 * len(panels), 5.2), squeeze=False)
    xs = np.arange(len(runs))
    for ax, (mod, key, title, higher) in zip(axes[0], panels):
        for i, r in enumerate(runs):
            v = get(r, mod, key)
            if not v:
                continue
            kept = r["decision"] in ("keep", "pending")
            col = SERIES[0] if kept else REVERTED
            ax.errorbar(i, v["value"], yerr=[[v["value"] - v["lo"]], [v["hi"] - v["value"]]], fmt="o" if kept else "s",
                        ms=11, mfc=col if kept else SURFACE, mec=col, ecolor=col, elinewidth=2, capsize=6, mew=2)
            if cur and r["version"] == cur["version"]:
                ax.plot(i, v["value"], "o", ms=22, mfc="none", mec=SERIES[2], mew=3)
                ax.annotate(f"best\n{v['value']:.3f}", (i, v["value"]), textcoords="offset points", xytext=(14, -6), color=INK, fontsize=13)
        ax.set_xticks(xs, [r["version"] for r in runs])
        ax.set_title(title)
        ax.set_ylabel("higher is better" if higher else "lower is better", color=MUTED)
        if mod == "visual" or key == "recall":
            ax.set_ylim(-0.02, 1.02)
        else:
            ax.set_ylim(bottom=0)
    h1 = plt.Line2D([], [], marker="o", ls="", ms=11, color=SERIES[0], label="kept")
    h2 = plt.Line2D([], [], marker="s", ls="", ms=11, mfc=SURFACE, mec=REVERTED, mew=2, label="reverted")
    h3 = plt.Line2D([], [], marker="o", ls="", ms=18, mfc="none", mec=SERIES[2], mew=3, label="current best")
    fig.legend(handles=[h1, h2, h3], loc="upper right", ncol=3, frameon=False, bbox_to_anchor=(1, 1.06))
    fig.suptitle("Headline metrics by version (error bars: 95% bootstrap CI)", x=0.01, ha="left", y=1.08, fontsize=19, fontweight="semibold")
    fig.tight_layout()
    save(fig, "01_progress")


# 2 -------------------------------------------------------------------------------------------
def chart_confusion(v0, cur):
    pairs = [(r, lbl) for r, lbl in ((v0, "v0"), (cur, "current best")) if r and r["extra"].get("visual", {}).get("confusion")]
    if cur and v0 and cur["version"] == v0["version"]:
        pairs = pairs[:1]
    if not pairs:
        return
    fig, axes = plt.subplots(1, len(pairs), figsize=(7.2 * len(pairs), 5.4), squeeze=False)
    for ax, (r, lbl) in zip(axes[0], pairs):
        c = r["extra"]["visual"]["confusion"]
        mat = np.array(c["matrix"], float)
        norm = mat / np.maximum(mat.sum(1, keepdims=True), 1)
        ax.imshow(norm, cmap=BLUES, vmin=0, vmax=1)
        for i in range(mat.shape[0]):
            for j in range(mat.shape[1]):
                ax.text(j, i, f"{norm[i, j]:.0%}\n({int(mat[i, j])})", ha="center", va="center",
                        color="#ffffff" if norm[i, j] > 0.55 else INK, fontsize=15)
        ax.set_xticks(range(3), ["detected\nas bird", "detected\nas drone", "missed"])
        ax.set_yticks(range(2), ["true bird", "true drone"])
        ax.grid(False)
        ax.set_title(f"{r['version']} ({lbl})")
    fig.suptitle("Where each true bird / drone box ends up (rows sum to 100%)", x=0.01, ha="left", fontsize=18, fontweight="semibold")
    fig.tight_layout()
    save(fig, "02_confusion")


# 3 -------------------------------------------------------------------------------------------
def chart_pr_roc(v0, prev, cur):
    t = trio(v0, prev, cur)
    have_v = [x for x in t if x[1]["extra"].get("visual", {}).get("pr_curve")]
    have_a = [x for x in t if x[1]["extra"].get("audio", {}).get("roc")]
    if not have_v and not have_a:
        return
    n = bool(have_v) + bool(have_a)
    fig, axes = plt.subplots(1, n, figsize=(7 * n, 6), squeeze=False)
    k = 0
    if have_v:
        ax = axes[0][k]; k += 1
        for label, r, col in have_v:
            pc = r["extra"]["visual"]["pr_curve"]["drone"]
            ap = get(r, "visual", "mAP50")
            ax.plot(pc["recall"], pc["precision"], color=col, label=f"{label}")
        ax.set(xlabel="Recall", ylabel="Precision", xlim=(0, 1), ylim=(0, 1.02))
        ax.set_title("Visual: drone precision-recall (IoU 0.5)")
        ax.legend(loc="lower left", frameon=False)
    if have_a:
        ax = axes[0][k]
        for label, r, col in have_a:
            roc = r["extra"]["audio"]["roc"]
            auc = get(r, "audio", "roc_auc")
            ax.plot(roc["fpr"], roc["tpr"], color=col, label=f"{label}  AUC {auc['value']:.3f}" if auc else label)
        ax.plot([0, 1], [0, 1], color=MUTED, ls=":", lw=1.5, label="chance")
        ax.set(xlabel="False positive rate", ylabel="True positive rate", xlim=(0, 1), ylim=(0, 1.02))
        ax.set_title("Audio: ROC on DADS test clips")
        ax.legend(loc="lower right", frameon=False)
    fig.tight_layout()
    save(fig, "03_pr_roc")


# 4 -------------------------------------------------------------------------------------------
def chart_threshold(cur):
    if not cur:
        return
    cfg_thr = None
    try:
        import json as _j
        cfg_thr = _j.loads(next(r for r in read_results() if r["row_type"] == "run" and r["version"] == cur["version"])["thresholds_json"])
    except StopIteration:
        pass
    panels = []
    if cur["extra"].get("visual", {}).get("sweep"):
        sw = pd.DataFrame(cur["extra"]["visual"]["sweep"])
        panels.append(("Visual (drone class)", sw[sw["class"] == "drone"], cfg_thr.get("visual_conf") if cfg_thr else None))
    if cur["extra"].get("audio", {}).get("sweep"):
        panels.append(("Audio (DADS test clips)", pd.DataFrame(cur["extra"]["audio"]["sweep"]), cfg_thr.get("audio_threshold") if cfg_thr else None))
    if not panels:
        return
    fig, axes = plt.subplots(1, len(panels), figsize=(7.5 * len(panels), 5.6), squeeze=False)
    for ax, (title, sw, op) in zip(axes[0], panels):
        for col, key, ls in ((SERIES[0], "precision", "-"), (SERIES[1], "recall", "--"), (SERIES[2], "f1", ":")):
            ax.plot(sw.threshold, sw[key], color=col, ls=ls, label=key.upper() if key == "f1" else key.capitalize())
        if op is not None:
            row = sw.iloc[(sw.threshold - op).abs().argsort().iloc[0]]
            ax.axvline(op, color=INK, lw=1.5)
            ax.annotate(f"operating point {op}\nP {row.precision:.2f}  R {row.recall:.2f}  F1 {row.f1:.2f}",
                        (op, 0.04), xytext=(8, 0), textcoords="offset points", fontsize=13, color=INK)
        ax.set(xlabel="Confidence threshold", ylabel="Score", xlim=(0, 1), ylim=(0, 1.02))
        ax.set_title(f"{title} — {cur['version']}")
        ax.legend(loc="center left", frameon=False)
    fig.suptitle("Threshold sweep (thresholds are chosen on the field 'tune' half only)", x=0.01, ha="left", fontsize=17, fontweight="semibold", y=1.03)
    fig.tight_layout()
    save(fig, "04_threshold_sweep")


# 5 / 6 ---------------------------------------------------------------------------------------
def breakdown(run, prefix):
    m = run["metrics"].get("visual", {})
    return {k[len(prefix):]: v for k, v in m.items() if k.startswith(prefix)}


def chart_size(v0, prev, cur):
    t = trio(v0, prev, cur)
    data = [(lbl, breakdown(r, "drone_recall_size_"), col) for lbl, r, col in t]
    sizes = [s for s in ("small", "medium", "large") if any(s in d for _, d, _ in data)]
    if not sizes:
        return
    fig, ax = plt.subplots(figsize=(9.5, 5.6))
    w = 0.8 / len(data)
    for i, (lbl, d, col) in enumerate(data):
        xs = np.arange(len(sizes)) + (i - (len(data) - 1) / 2) * w
        vals = [d.get(s, {}).get("value", np.nan) for s in sizes]
        lo = [d.get(s, {}).get("value", 0) - d.get(s, {}).get("lo", 0) for s in sizes]
        hi = [d.get(s, {}).get("hi", 0) - d.get(s, {}).get("value", 0) for s in sizes]
        ax.bar(xs, vals, w * 0.92, color=col, label=lbl, yerr=[lo, hi], ecolor=INK2, capsize=4, error_kw={"lw": 1.5})
    ax.set_xticks(range(len(sizes)), [f"{s}\n({'<1%' if s == 'small' else '1-10%' if s == 'medium' else '>10%'} of image)" for s in sizes])
    ax.set(ylabel="Drone recall", ylim=(0, 1.05))
    ax.set_title("Drone recall by target size (95% CI)")
    ax.legend(frameon=False, loc="upper left")
    save(fig, "05_recall_by_size")


def chart_condition(runs):
    rows = []
    for r in runs:
        b = breakdown(r, "drone_recall_condition_")
        rows.append({"version": r["version"] + ("" if r["decision"] != "revert" else " (reverted)"), **{k: v["value"] for k, v in b.items()}})
    df = pd.DataFrame(rows).set_index("version")
    if df.empty or df.shape[1] == 0:
        return
    cols = [c for c in ("clear", "cloudy", "backlit", "cluttered") if c in df] + [c for c in df if c not in ("clear", "cloudy", "backlit", "cluttered")]
    df = df[cols]
    fig, ax = plt.subplots(figsize=(2.2 * len(cols) + 3, 1.0 * len(df) + 2.2))
    ax.imshow(df.to_numpy(float), cmap=BLUES, vmin=0, vmax=1, aspect="auto")
    for i in range(df.shape[0]):
        for j in range(df.shape[1]):
            v = df.iat[i, j]
            ax.text(j, i, "—" if pd.isna(v) else f"{v:.2f}", ha="center", va="center", color="#ffffff" if (not pd.isna(v) and v > 0.55) else INK, fontsize=15)
    ax.set_xticks(range(len(cols)), cols)
    ax.set_yticks(range(len(df)), df.index)
    ax.grid(False)
    ax.set_title("Drone recall by sky condition (version × condition)")
    save(fig, "06_recall_by_condition")


# 7 -------------------------------------------------------------------------------------------
def chart_snr(v0, prev, cur):
    t = [(lbl, pd.DataFrame(r["extra"]["audio"]["snr_curve"]), col) for lbl, r, col in trio(v0, prev, cur)
         if r["extra"].get("audio", {}).get("snr_curve")]
    if not t:
        return
    noises = sorted(set().union(*[set(df.noise_type) for _, df, _ in t]))
    fig, axes = plt.subplots(1, len(noises), figsize=(6 * len(noises), 5.2), sharey=True, squeeze=False)
    for ax, nt in zip(axes[0], noises):
        for lbl, df, col in t:
            d = df[df.noise_type == nt].sort_values("snr_db")
            ax.errorbar(d.snr_db, d.value, yerr=[d.value - d.lo, d.hi - d.value], color=col, marker="o", ms=8, capsize=4, label=lbl)
        ax.set(xlabel="SNR (dB): noisier to the right", ylim=(0, 1.05))
        levels = sorted({float(x) for _, df_, _ in t for x in df_.snr_db}, reverse=True)
        ax.set_xticks(levels, [f"{int(x):+d}" for x in levels])
        ax.set_title(f"{nt}")
        ax.invert_xaxis()
    axes[0][0].set_ylabel("Drone recall")
    axes[0][-1].legend(frameon=False, loc="lower left")
    fig.suptitle("Audio drone recall vs noise level (ESC-50 mixes, 95% CI)", x=0.01, ha="left", fontsize=18, fontweight="semibold", y=1.03)
    fig.tight_layout()
    save(fig, "07_audio_snr")


# 8 -------------------------------------------------------------------------------------------
def chart_fa_hour(runs):
    vals = [(r, get(r, "audio", "fa_per_hour")) for r in runs]
    vals = [(r, v) for r, v in vals if v]
    if not vals:
        return
    fig, ax = plt.subplots(figsize=(1.6 * len(vals) + 5, 5.4))
    for i, (r, v) in enumerate(vals):
        kept = r["decision"] != "revert"
        ax.bar(i, v["value"], 0.6, color=SERIES[0] if kept else SURFACE, edgecolor=SERIES[0] if kept else REVERTED,
               hatch=None if kept else "//", lw=2, yerr=[[v["value"] - v["lo"]], [v["hi"] - v["value"]]], ecolor=INK2, capsize=6)
        ax.text(i, v["hi"], f"{v['value']:.1f}", ha="center", va="bottom", fontsize=14, color=INK)
    ax.set_xticks(range(len(vals)), [r["version"] + ("\n(reverted)" if r["decision"] == "revert" else "") for r, _ in vals])
    hrs = vals[-1][1]
    ax.set_ylabel("False alarms per hour (lower is better)")
    ax.set_title("Audio false alarms per hour on ambient + bird + aircraft audio (95% CI)")
    save(fig, "08_fa_per_hour")


# 9 -------------------------------------------------------------------------------------------
def chart_speed(runs):
    pts = []
    for r in runs:
        for sp in r["extra"].get("visual", {}).get("speed", []):
            m = get(r, "visual", "mAP50")
            if m:
                pts.append((r, sp, m))
    if not pts:
        return
    fig, ax = plt.subplots(figsize=(9, 6))
    for r, sp, m in pts:
        kept = r["decision"] != "revert"
        col = SERIES[0] if sp["imgsz"] == 640 else SERIES[1]
        ax.errorbar(sp["p50_ms"], m["value"], yerr=[[m["value"] - m["lo"]], [m["hi"] - m["value"]]], fmt="o" if kept else "s",
                    ms=11, color=col, mfc=col if kept else SURFACE, mew=2, capsize=4)
        ax.annotate(f"{r['version']} @{sp['imgsz']}", (sp["p50_ms"], m["value"]), xytext=(8, 6), textcoords="offset points", fontsize=12, color=INK2)
    ax.axvline(1000 / 15, color=INK, lw=1.5, ls="--")
    ax.text(1000 / 15, ax.get_ylim()[0], "  15 FPS real-time limit", rotation=90, va="bottom", fontsize=12, color=INK2)
    ax.set(xlabel="Latency per image, p50 (ms) — left is faster", ylabel="mAP50 (95% CI)")
    ax.set_xscale("log")
    h = [plt.Line2D([], [], marker="o", ls="", ms=10, color=SERIES[0], label="imgsz 640"),
         plt.Line2D([], [], marker="o", ls="", ms=10, color=SERIES[1], label="imgsz 1280")]
    ax.legend(handles=h, frameon=False, loc="lower right")
    ax.set_title("Speed vs accuracy (each point: one version at one image size)")
    save(fig, "09_speed_vs_accuracy")


# 10 ------------------------------------------------------------------------------------------
def chart_gallery(v0, cur):
    """8 fixed hard images (chosen once from v0's errors, then never changed), v0 vs current best."""
    import cv2
    if not v0 or not (BENCH / v0["version"] / "predictions.parquet").exists():
        return
    fixed = BENCH / "gallery_items.json"
    p0 = pd.read_parquet(BENCH / v0["version"] / "predictions.parquet")
    p0 = p0[p0.modality == "visual"]
    if not fixed.exists():
        idx = json.loads((BENCH / v0["version"] / "errors" / "index.json").read_text())["visual"]
        ids = list(dict.fromkeys([e["item_id"] for e in idx if e["kind"] == "fn"] + [e["item_id"] for e in idx if e["kind"] == "fp"]))[:8]
        fixed.write_text(json.dumps({"chosen_from": v0["version"], "items": ids}, indent=1))
    ids = json.loads(fixed.read_text())["items"]
    pc = pd.read_parquet(BENCH / cur["version"] / "predictions.parquet") if cur else p0
    pc = pc[pc.modality == "visual"]
    from bench import manifest
    paths = {it["item_id"]: it["path"] for it in manifest.visual_items(manifest.load())[0].to_dict("records")}
    conf0 = json.loads(next(r for r in read_results() if r["row_type"] == "run" and r["version"] == v0["version"])["thresholds_json"])["visual_conf"]
    confc = json.loads(next(r for r in read_results() if r["row_type"] == "run" and r["version"] == cur["version"])["thresholds_json"])["visual_conf"]
    fig, axes = plt.subplots(2, len(ids), figsize=(3.2 * len(ids), 7.2), squeeze=False)
    for j, iid in enumerate(ids):
        for i, (pred, conf, lbl) in enumerate(((p0, conf0, v0["version"]), (pc, confc, cur["version"]))):
            img = cv2.cvtColor(cv2.imread(paths[iid]), cv2.COLOR_BGR2RGB)
            h, w = img.shape[:2]
            ax = axes[i][j]
            ax.imshow(img)
            rows = pred[pred.item_id == iid]
            for _, g in rows[rows.kind == "gt"].iterrows():
                ax.add_patch(plt.Rectangle((g.x1 * w, g.y1 * h), (g.x2 - g.x1) * w, (g.y2 - g.y1) * h, fill=False, ec="#1baf7a", lw=2.5))
            for _, d in rows[(rows.kind == "det") & (rows.score >= conf)].iterrows():
                ax.add_patch(plt.Rectangle((d.x1 * w, d.y1 * h), (d.x2 - d.x1) * w, (d.y2 - d.y1) * h, fill=False,
                                           ec="#eb6834" if d.cls == 1 else "#2a78d6", lw=2, ls="--"))
                ax.text(d.x1 * w, d.y1 * h - 4, f"{'drone' if d.cls == 1 else 'bird'} {d.score:.2f}", fontsize=9, color="#ffffff",
                        bbox={"facecolor": INK, "alpha": 0.7, "pad": 1, "lw": 0})
            ax.set_xticks([]); ax.set_yticks([]); ax.grid(False)
            if j == 0:
                ax.set_ylabel(lbl, fontsize=16)
    fig.suptitle("Same 8 hard images: v0 (top) vs current best (bottom). Solid green = truth; dashed = detections "
                 "(blue bird, orange drone)", x=0.01, ha="left", fontsize=15, fontweight="semibold")
    fig.tight_layout()
    save(fig, "10_gallery")


# 11 ------------------------------------------------------------------------------------------
def chart_fusion(cur):
    if not cur or "fusion" not in cur["metrics"]:
        return
    m = cur["metrics"]["fusion"]
    modes = [("audio_only", "Audio only"), ("visual_only", "Visual only"), ("fused", "Fused")]
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.4))
    for ax, key, title in ((axes[0], "drone_recall", "Drone recall"), (axes[1], "fa_rate", "False-alarm rate")):
        for i, (mk, lbl) in enumerate(modes):
            v = m.get(mk, {}).get(key)
            if v:
                ax.bar(i, v["value"], 0.6, color=SERIES[i], yerr=[[v["value"] - v["lo"]], [v["hi"] - v["value"]]], ecolor=INK2, capsize=6)
        ax.set_xticks(range(3), [l for _, l in modes])
        ax.set_title(f"{title} on matched clips")
    save(fig, "11_fusion")


def main():
    runs, v0, prev, cur = load_versions()
    if not runs:
        raise SystemExit("results.csv has no runs yet.")
    chart_progress(runs, cur)
    chart_confusion(v0, cur)
    chart_pr_roc(v0, prev, cur)
    chart_threshold(cur)
    chart_size(v0, prev, cur)
    chart_condition(runs)
    chart_snr(v0, prev, cur)
    chart_fa_hour(runs)
    chart_speed(runs)
    chart_gallery(v0, cur)
    chart_fusion(cur)


if __name__ == "__main__":
    main()
