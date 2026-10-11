"""Development-stage charts from REAL data (dataset audit, training runs, shortcut test).
Writes benchmarks/charts/stages/ (PNG 300 dpi + SVG). Every title names its stage.

    .venv/bin/python benchmarks/stage_charts.py
"""

import collections
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench.common import BENCH, DATA, MODELS, ROOT  # noqa: E402

import matplotlib  # noqa: E402
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

OUT = BENCH / "charts" / "stages"
BLUE, ORANGE, AQUA, INK, INK2, MUTED, SURFACE = "#2a78d6", "#eb6834", "#1baf7a", "#0b0b0b", "#52514e", "#898781", "#fcfcfb"
plt.rcParams.update({"font.size": 14, "axes.titlesize": 16, "figure.facecolor": SURFACE, "axes.facecolor": SURFACE,
                     "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": "#e1e0d9",
                     "axes.titlelocation": "left", "axes.titleweight": "semibold", "axes.labelcolor": INK2,
                     "xtick.color": INK2, "ytick.color": INK2, "axes.edgecolor": "#c3c2b7"})


def save(fig, name, stage, source):
    fig.text(0.01, -0.02, f"{stage} · source: {source}", fontsize=11, color=MUTED, ha="left", va="top")
    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / f"{name}.png", dpi=300, bbox_inches="tight")
    fig.savefig(OUT / f"{name}.svg", bbox_inches="tight")
    plt.close(fig)
    print("wrote charts/stages/" + name)


def bar_labels(ax, bars, fmt="{:,.0f}"):
    for b in bars:
        ax.text(b.get_x() + b.get_width() / 2, b.get_height(), fmt.format(b.get_height()), ha="center", va="bottom", fontsize=12, color=INK)


# Stage 1a: the Mendeley label bug ------------------------------------------------------------
def label_bug():
    root = DATA / "mendeley" / "Dataset"
    if not root.exists():
        return
    counts = collections.Counter()
    for split in ("train", "valid", "test"):
        for f in (root / split / "labels").glob("*.txt"):
            for line in f.read_text().splitlines():
                if line.strip():
                    counts[(f.name[0], line.split()[0])] += 1
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.2), sharey=True)
    for ax, title, data in ((axes[0], "As published", [(counts[("B", "0")], counts[("B", "1")]), (counts[("D", "0")], counts[("D", "1")])]),
                            (axes[1], "After fix (class from file name)", [(0, counts[("B", "0")] + counts[("B", "1")]), (counts[("D", "0")] + counts[("D", "1")], 0)])):
        x = np.arange(2)
        a = ax.bar(x - 0.2, [d[0] for d in data], 0.38, color=ORANGE, label='labelled "drone"')
        b = ax.bar(x + 0.2, [d[1] for d in data], 0.38, color=BLUE, label='labelled "bird"')
        bar_labels(ax, list(a) + list(b))
        ax.set_xticks(x, ["bird images (B…)", "drone images (D…)"])
        ax.set_title(title)
    axes[0].set_ylabel("annotated boxes")
    axes[0].legend(frameon=False, loc="upper left")
    fig.suptitle("Stage 1 — Dataset audit: Mendeley labels put birds and drones in one class", x=0.01, ha="left", fontsize=17, fontweight="semibold", y=1.03)
    fig.tight_layout()
    save(fig, "stage1a_label_bug", "Stage 1 dataset audit", "Mendeley v5 label files, all splits")


# Stage 1b: test-set independence -------------------------------------------------------------
def groups_chart():
    man = json.loads((BENCH / "test_sets.json").read_text())
    items = man["tiers"]["dataset"]["visual"]["items"]
    sizes = sorted(collections.Counter(it["group"] for it in items).values(), reverse=True)
    fig, axes = plt.subplots(1, 2, figsize=(13, 5), gridspec_kw={"width_ratios": [1, 2]})
    bars = axes[0].bar([0, 1], [len(items), len(sizes)], color=[MUTED, BLUE], width=0.6)
    bar_labels(axes[0], bars)
    axes[0].set_xticks([0, 1], ["test images", "independent\nvideo groups"])
    axes[0].set_title("What the CIs count")
    axes[1].bar(range(len(sizes)), sizes, color=BLUE, width=1.0)
    axes[1].set(xlabel="group (sorted by size)", ylabel="frames in group")
    axes[1].set_title("Group sizes: many near-identical consecutive frames")
    fig.suptitle(f"Stage 1 — Dataset audit: {len(items)} test images are {len(sizes)} independent groups", x=0.01, ha="left",
                 fontsize=17, fontweight="semibold", y=1.03)
    fig.tight_layout()
    save(fig, "stage1b_test_groups", "Stage 1 dataset audit", "benchmarks/test_sets.json (pHash, Hamming ≤ 6)")


# Stage 1c: leakage check ---------------------------------------------------------------------
def leakage_chart():
    p = BENCH / "leakage_report.json"
    if not p.exists():
        return
    r = json.loads(p.read_text())["images"]
    hist = {int(k): v for k, v in r["closest_hamming_histogram"].items()}
    over = r["n_test"] - sum(hist.values())
    xs = list(range(17)) + [17]
    ys = [hist.get(k, 0) for k in range(17)] + [over]
    fig, ax = plt.subplots(figsize=(11, 5))
    ax.bar(xs, ys, color=[ORANGE if x <= 6 else BLUE for x in xs], width=0.8)
    ax.axvline(6.5, color=INK, ls="--", lw=1.5)
    ax.text(6.3, max(ys) * 0.9, "near-duplicate\nthreshold (≤ 6)", ha="right", fontsize=12, color=INK)
    ax.set_xticks(xs, [str(x) for x in range(17)] + [">16"])
    ax.set(xlabel="distance from each test image to its closest training image (pHash bits)", ylabel="test images")
    ax.set_title(f"Stage 1 — Leakage check: {r['test_images_with_near_duplicate']} of {r['n_test']} test images have a near-duplicate in training", fontsize=15)
    save(fig, "stage1c_leakage", "Stage 1 dataset audit", "benchmarks/leakage_report.json")


# Stage 1d: test-set composition --------------------------------------------------------------
def composition_chart():
    man = json.loads((BENCH / "test_sets.json").read_text())
    items = man["tiers"]["dataset"]["visual"]["items"]
    sz = collections.Counter((b["cls"], b["size_tag"]) for it in items for b in it["boxes"])
    cond = collections.Counter(it["condition_tag"] for it in items)
    fig, axes = plt.subplots(1, 2, figsize=(13, 5))
    x = np.arange(3)
    sizes = ["small", "medium", "large"]
    a = axes[0].bar(x - 0.2, [sz[(0, s)] for s in sizes], 0.38, color=BLUE, label="bird")
    b = axes[0].bar(x + 0.2, [sz[(1, s)] for s in sizes], 0.38, color=ORANGE, label="drone")
    bar_labels(axes[0], list(a) + list(b))
    axes[0].set_xticks(x, ["small (<1%)", "medium (1–10%)", "large (>10%)"])
    axes[0].set(ylabel="boxes")
    axes[0].set_title("Boxes by target size")
    axes[0].legend(frameon=False)
    order = ["clear", "cloudy", "backlit", "cluttered"]
    c = axes[1].bar(order, [cond[k] for k in order], color=BLUE, width=0.6)
    bar_labels(axes[1], c)
    axes[1].set(ylabel="images")
    axes[1].set_title("Images by sky condition")
    fig.suptitle("Stage 1 — Frozen visual test set: few small targets (only 8 small birds)", x=0.01, ha="left", fontsize=17, fontweight="semibold", y=1.03)
    fig.tight_layout()
    save(fig, "stage1d_test_composition", "Stage 1 dataset audit", "benchmarks/test_sets.json")


# Stage 2a: audio model training --------------------------------------------------------------
def audio_training():
    p = MODELS / "audio" / "v0_audio.pt.json"
    if not p.exists():
        return
    h = json.loads(p.read_text())["history"]
    ep = [r["epoch"] for r in h]
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8))
    axes[0].plot(ep, [r["loss"] for r in h], "o-", color=BLUE)
    axes[0].set(xlabel="epoch", ylabel="training loss")
    axes[0].set_title("Training loss")
    axes[1].plot(ep, [r["val_auc"] for r in h], "o-", color=BLUE, label="ROC-AUC")
    axes[1].plot(ep, [r["val_acc"] for r in h], "s--", color=ORANGE, label="accuracy")
    axes[1].set(xlabel="epoch", ylabel="validation score", ylim=(0.98, 1.001))
    axes[1].set_title("Validation (within-dataset: an upper bound)")
    axes[1].legend(frameon=False, loc="lower right")
    fig.suptitle("Stage 2 — v0 audio model training (log-mel CNN, DADS training shards)", x=0.01, ha="left", fontsize=17, fontweight="semibold", y=1.04)
    fig.tight_layout()
    save(fig, "stage2a_audio_training", "Stage 2 model training", "models/audio/v0_audio.pt.json")


# Stage 2b: audio shortcut test ---------------------------------------------------------------
def shortcut_test():
    w = MODELS / "audio" / "v0_audio.pt"
    shard = DATA / "dads" / "train-00002-of-00039.parquet"
    if not (w.exists() and shard.exists()):
        return
    import pyarrow.parquet as pq
    from bench.audio import AudioDetector, load_wav_bytes, loop_to, SR
    from bench.common import pick_device
    det = AudioDetector(str(w), pick_device())
    clips = [load_wav_bytes(a["bytes"]) for a in pq.read_table(shard).column("audio").to_pylist()[-300:]]
    clips = [c for c in clips if len(c) >= 2 * SR][:200]
    rng = np.random.default_rng(0)
    full, looped = [], []
    for c in clips:
        s = rng.integers(0, len(c) - SR)
        full.append(det.window_probs(c[s:s + SR])[0].max())
        looped.append(det.window_probs(loop_to(c[s:s + int(0.6 * SR)], SR))[0].max())
    fig, ax = plt.subplots(figsize=(9, 5))
    vals = [np.mean(np.array(full) >= 0.5) * 100, np.mean(np.array(looped) >= 0.5) * 100]
    bars = ax.bar([0, 1], vals, color=[BLUE, ORANGE], width=0.55)
    bar_labels(ax, bars, "{:.1f}%")
    ax.set_xticks([0, 1], ["no-drone audio,\ncontinuous 1 s", "same audio,\n0.6 s looped to 1 s"])
    ax.set(ylabel="% called drone", ylim=(0, 100))
    ax.set_title(f"Stage 2 — Shortcut test: looping does not fool the audio model (n = {len(full)} clips)", fontsize=15)
    save(fig, "stage2b_audio_shortcut_test", "Stage 2 model training", "DADS validation tail of shard 2 + models/audio/v0_audio.pt")


# Stage 2c: visual model training (so far) ----------------------------------------------------
def yolo_training():
    p = ROOT / "runs" / "v0_yolo11n" / "results.csv"
    if not p.exists():
        return
    rows = list(csv.DictReader(open(p)))
    rows = [{k.strip(): v for k, v in r.items()} for r in rows]
    if not rows:
        return
    ep = [int(float(r["epoch"])) for r in rows]
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8))
    axes[0].plot(ep, [float(r["train/box_loss"]) for r in rows], "o-", color=BLUE, label="box loss")
    axes[0].plot(ep, [float(r["train/cls_loss"]) for r in rows], "s--", color=ORANGE, label="class loss")
    axes[0].set(xlabel="epoch", ylabel="training loss")
    axes[0].set_title("Training loss")
    axes[0].legend(frameon=False)
    axes[1].plot(ep, [float(r["metrics/mAP50(B)"]) for r in rows], "o-", color=BLUE, label="mAP50")
    axes[1].plot(ep, [float(r["metrics/mAP50-95(B)"]) for r in rows], "s--", color=AQUA, label="mAP50-95")
    axes[1].set(xlabel="epoch", ylabel="validation mAP", ylim=(0, 1))
    axes[1].set_title("Validation split (not the frozen test set)")
    axes[1].legend(frameon=False, loc="upper left")
    for ax in axes:
        ax.set_xticks(ep)
    fig.suptitle(f"Stage 2 — v0 visual model training (YOLO11n, corrected labels): {len(ep)} epoch(s) completed so far",
                 x=0.01, ha="left", fontsize=17, fontweight="semibold", y=1.04)
    fig.tight_layout()
    save(fig, "stage2c_yolo_training", "Stage 2 model training", "runs/v0_yolo11n/results.csv")


if __name__ == "__main__":
    for fn in (label_bug, groups_chart, leakage_chart, composition_chart, audio_training, shortcut_test, yolo_training):
        fn()
