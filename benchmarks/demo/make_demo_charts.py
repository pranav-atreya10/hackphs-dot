"""ILLUSTRATIVE EXAMPLE CHARTS: simulated numbers showing what the benchmark charts look like.
They are NOT measured results and never touch results.csv. Every title says so.

    .venv/bin/python benchmarks/demo/make_demo_charts.py
"""

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

OUT = Path(__file__).resolve().parent
BLUE, ORANGE, AQUA, INK2, SURFACE = "#2a78d6", "#eb6834", "#1baf7a", "#52514e", "#fcfcfb"
LABEL = "Illustrative example (simulated data, not measured results)"
plt.rcParams.update({"font.size": 15, "axes.titlesize": 17, "figure.facecolor": SURFACE, "axes.facecolor": SURFACE,
                     "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": "#e1e0d9",
                     "axes.titlelocation": "left"})


def save(fig, name):
    fig.savefig(OUT / f"demo_{name}.png", dpi=200, bbox_inches="tight")
    plt.close(fig)


versions = ["v0", "v1", "v2", "v3", "v4"]
recall = np.array([0.62, 0.68, 0.74, 0.73, 0.81])
fa = np.array([0.21, 0.17, 0.15, 0.16, 0.11])
fig, axes = plt.subplots(1, 2, figsize=(12, 5))
for ax, vals, title in ((axes[0], recall, "Drone recall (higher is better)"), (axes[1], fa, "False-alarm rate (lower is better)")):
    ax.errorbar(range(5), vals, yerr=0.05, fmt="o", ms=10, color=BLUE, capsize=5)
    ax.set_xticks(range(5), versions)
    ax.set_title(title)
    ax.set_ylim(0, 1 if vals is recall else 0.35)
fig.suptitle(f"Progress by version: {LABEL}", x=0.01, ha="left", fontsize=15, color=INK2)
fig.tight_layout()
save(fig, "progress")

snr = [10, 5, 0, -5, -10]
fig, ax = plt.subplots(figsize=(8, 5))
for vals, col, lab in (([0.95, 0.9, 0.78, 0.55, 0.3], BLUE, "v0"), ([0.96, 0.94, 0.88, 0.74, 0.52], AQUA, "v3 (noise-augmented)")):
    ax.plot(snr, vals, "o-", color=col, ms=8, label=lab)
ax.invert_xaxis()
ax.set(xlabel="SNR (dB): noisier to the right", ylabel="Drone recall", ylim=(0, 1.05))
ax.legend(frameon=False)
ax.set_title(f"Audio recall vs noise\n{LABEL}", fontsize=14)
save(fig, "audio_snr")

print("wrote", sorted(p.name for p in OUT.glob("demo_*.png")))
