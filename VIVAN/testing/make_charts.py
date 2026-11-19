"""Charts for the latest detection-engine changes (debris check + mic hum checks), from measured data.

    .venv/bin/python VIVAN/testing/make_charts.py

Inputs (VIVAN/testing/data/):
  engine_compare.json                 old engine (main before the change) vs new engine, same scenes and seeds
  hum_heldout_by_sound.csv            browser hum detector, held-out test audio, "drone heard" rate before/after
  hum_training_threshold_search.csv   the threshold search on training audio that picked the new hum checks
Outputs: VIVAN/testing/charts/*.png (300 dpi) and *.svg
"""

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA, OUT = HERE / "data", HERE / "charts"
OUT.mkdir(exist_ok=True)

BEFORE, AFTER, AQUA, INK, INK2, GRID, SURFACE = "#eb6834", "#2a78d6", "#1baf7a", "#1f1e1c", "#52514e", "#e1e0d9", "#fcfcfb"
plt.rcParams.update({"font.size": 12, "axes.titlesize": 14, "axes.titleweight": "bold", "axes.titlelocation": "left",
                     "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "axes.edgecolor": INK2, "axes.labelcolor": INK2,
                     "xtick.color": INK2, "ytick.color": INK2, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8, "axes.axisbelow": True})

# Scenes where a bird label is wrong (forbidClass 'bird' in VIVAN/detection/src/synthetic.js).
FORBID_BIRD = {"drone", "drone_silent", "bag", "plane", "rock_throw", "debris_shower", "spinning_debris"}
DEBRIS = ["rock_throw", "debris_shower", "spinning_debris"]
BIRDS = ["flock_corridor", "single_bird", "distant_flock", "bird_descending", "bird_circling"]
NICE = {"rock_throw": "Thrown rock", "debris_shower": "Gravel shower (5 pieces)", "spinning_debris": "Spinning debris",
        "flock_corridor": "Flock into corridor", "single_bird": "Single gull", "distant_flock": "Distant flock",
        "bird_descending": "Gull gliding down", "bird_circling": "Gull circling", "drone": "Drone + sound",
        "drone_silent": "Silent drone", "bag": "Plastic bag", "plane": "Plane", "empty": "Empty sky"}


def footer(fig, text):
    fig.text(0.01, 0.005, text, fontsize=9, color=INK2, ha="left", va="bottom")


def save(fig, name):
    fig.savefig(OUT / f"{name}.png", dpi=300, bbox_inches="tight")
    fig.savefig(OUT / f"{name}.svg", bbox_inches="tight")
    plt.close(fig)
    print("wrote", name)


def label_bars(ax, bars, fmt="{:.0f}%"):
    for b in bars:
        w = b.get_width()
        ax.text(w + 1.5, b.get_y() + b.get_height() / 2, fmt.format(w), va="center", fontsize=10, color=INK)


cmp = json.loads((DATA / "engine_compare.json").read_text())
runs = pd.DataFrame(cmp["runs"])
runs["strict_pass"] = runs["pass"] & ~(runs.scene.isin(FORBID_BIRD) & runs.called_bird)
n_seeds = len(cmp["seeds"])
src_engine = f"Source: synthetic scenes, {n_seeds} random seeds each. Before = engine on main ({cmp.get('old_ref', 'main')}); after = {cmp.get('new_ref', 'this branch')}."

# 1. Debris: how often was it called a bird / did it reach red?
fig, axes = plt.subplots(1, 2, figsize=(12, 4.2), sharey=True)
y = np.arange(len(DEBRIS))
for ax, col, title in ((axes[0], "called_bird", "Runs where debris was labelled \"bird\""), (axes[1], "red", "Runs that raised a red alert")):
    for off, ver, color, lab in ((0.2, "old", BEFORE, "Before"), (-0.2, "new", AFTER, "After debris check")):
        vals = [100 * runs[(runs.version == ver) & (runs.scene == s)][col].mean() for s in DEBRIS]
        bars = ax.barh(y + off, vals, height=0.38, color=color, label=lab)
        label_bars(ax, bars)
    ax.set_xlim(0, 115)
    ax.set_xlabel("% of runs")
    ax.set_title(title, fontsize=12)
axes[0].set_yticks(y, [NICE[s] for s in DEBRIS])
axes[0].invert_yaxis()
axes[1].legend(frameon=False, loc="lower right")
fig.suptitle("Debris check: thrown rocks and debris are no longer called birds", x=0.01, ha="left", fontweight="bold", fontsize=14)
footer(fig, src_engine)
fig.tight_layout(rect=(0, 0.04, 1, 1))
save(fig, "01_debris_before_after")

# 2. Every scene: pass rate before vs after (pass = right alert level AND never "bird" where that's wrong)
scenes = [s for s in NICE if s in set(runs.scene)]
fig, ax = plt.subplots(figsize=(10, 7))
y = np.arange(len(scenes))
for off, ver, color, lab in ((0.2, "old", BEFORE, "Before"), (-0.2, "new", AFTER, "After")):
    vals = [100 * runs[(runs.version == ver) & (runs.scene == s)].strict_pass.mean() for s in scenes]
    bars = ax.barh(y + off, vals, height=0.38, color=color, label=lab)
    label_bars(ax, bars)
ax.set_yticks(y, [NICE[s] for s in scenes])
ax.invert_yaxis()
ax.set_xlim(0, 115)
ax.set_xlabel("% of runs passed")
ax.legend(frameon=False, loc="lower right")
tot = {v: runs[runs.version == v].strict_pass.mean() * 100 for v in ("old", "new")}
ax.set_title(f"All scenes, before vs after: {tot['old']:.0f}% → {tot['new']:.0f}% of runs pass\n"
             "Pass = correct alert level and never called a bird when it isn't one", fontsize=13)
footer(fig, src_engine)
fig.tight_layout(rect=(0, 0.03, 1, 1))
save(fig, "02_all_scenes_pass_rate")

# 3. The gravity-arc pull that separates debris from birds
pulls = pd.DataFrame(cmp["pulls"])
groups = [("Debris (rocks, gravel)", ["rock_throw", "debris_shower"], BEFORE), ("Birds (all bird scenes)", BIRDS, AFTER)]
fig, ax = plt.subplots(figsize=(10, 3.6))
rng = np.random.default_rng(0)
for i, (lab, sc, color) in enumerate(groups):
    v = pulls[pulls.scene.isin(sc)].pull.to_numpy()
    ax.scatter(np.clip(v, -20, 200), i + rng.uniform(-0.18, 0.18, len(v)), s=26, color=color, alpha=0.75, edgecolor=SURFACE, linewidth=0.5)
    ax.text(201, i, f" n={len(v)}, median {np.median(v):.0f}" if len(v) else " n=0", va="center", fontsize=10, color=INK2)
ax.axvline(25, color=INK, lw=1.5, ls="--")
ax.text(26, 1.45, "threshold 25: above = falling, not flying", fontsize=10, color=INK)
ax.set_yticks([0, 1], [g[0] for g in groups])
ax.set_ylim(-0.6, 1.7)
ax.set_xlim(-20, 240)
ax.set_xlabel("Strongest downward pull on a clean arc (acceleration ÷ own length, per s²)")
ax.set_title("Why the debris check works: gravity pulls small debris far harder than any bird pulls itself", fontsize=12)
footer(fig, "Source: every confirmed track whose path fitted a clean arc in the scenes above (new engine). Values clipped to -20..200.")
fig.tight_layout(rect=(0, 0.05, 1, 1))
save(fig, "03_gravity_pull_debris_vs_birds")

# 4. Mic hum detector on held-out test audio
hum = pd.read_csv(DATA / "hum_heldout_by_sound.csv")
pick = ["dads_drone", "dads_no_drone", "esc_airplane", "esc_engine", "esc_helicopter", "esc_washing_machine", "esc_car_horn",
        "esc_insects", "esc_cow", "esc_chainsaw", "esc_wind", "esc_door_wood_knock", "esc_church_bells", "esc_rain"]
hum = hum.set_index("source").loc[[p for p in pick if p in set(hum.source)]].reset_index()
names = {"dads_drone": "Drone recordings (want HIGH)", "dads_no_drone": "Ordinary outdoor audio"}
fig, ax = plt.subplots(figsize=(10, 7))
y = np.arange(len(hum))
for off, col, color, lab in ((0.2, "before", BEFORE, "Before"), (-0.2, "after", AFTER, "After 3 drone checks")):
    bars = ax.barh(y + off, 100 * hum[col], height=0.38, color=color, label=lab)
    label_bars(ax, bars)
ax.set_yticks(y, [names.get(s, s.replace("esc_", "").replace("_", " ").capitalize()) + f"  (n={n})" for s, n in zip(hum.source, hum.clips)])
ax.invert_yaxis()
ax.set_xlim(0, 115)
ax.set_xlabel('% of clips where the browser says "drone heard"')
ax.legend(frameon=False, loc="lower right")
drone = hum[hum.source == "dads_drone"].iloc[0]
neg = pd.read_csv(DATA / "hum_heldout_by_sound.csv").query("label == 0")
fa_b = (neg.before * neg.clips).sum() / neg.clips.sum() * 100
fa_a = (neg.after * neg.clips).sum() / neg.clips.sum() * 100
ax.set_title(f"Mic fallback on held-out test audio: false alarms {fa_b:.0f}% → {fa_a:.0f}%, drones {100 * drone.before:.0f}% → {100 * drone.after:.0f}%", fontsize=12)
footer(fig, "Source: held-out test audio only (DADS test files 3 and 36, ESC-50 folds 1-3), never used to choose the thresholds.")
fig.tight_layout(rect=(0, 0.03, 1, 1))
save(fig, "04_hum_heldout_before_after")

# 5. How the hum thresholds were chosen (training audio only)
g = pd.read_csv(DATA / "hum_training_threshold_search.csv")
base = g[(g.min_pitch_hz == 80) & (g.max_overtones == 99) & (g.min_prominence_db == 0)].iloc[0]
chosen = g[(g.min_pitch_hz == 180) & (g.max_overtones == 5) & (g.min_prominence_db == 30)].iloc[0]
fig, ax = plt.subplots(figsize=(9, 5.5))
ax.scatter(100 * g.false_alarm_rate, 100 * g.drone_recall, s=22, color="#b4b2a9", label=f"{len(g)} settings tried")
ax.scatter([100 * base.false_alarm_rate], [100 * base.drone_recall], s=110, color=BEFORE, zorder=3, label="Old detector (no checks)")
ax.scatter([100 * chosen.false_alarm_rate], [100 * chosen.drone_recall], s=110, color=AFTER, zorder=3, label="Chosen: ≥180 Hz, ≤5 overtones, ≥30 dB")
ax.annotate(f"{100 * base.drone_recall:.0f}% drones, {100 * base.false_alarm_rate:.0f}% false alarms", (100 * base.false_alarm_rate, 100 * base.drone_recall),
            xytext=(-10, -28), textcoords="offset points", ha="right", fontsize=10, color=INK)
ax.annotate(f"{100 * chosen.drone_recall:.0f}% drones, {100 * chosen.false_alarm_rate:.1f}% false alarms", (100 * chosen.false_alarm_rate, 100 * chosen.drone_recall),
            xytext=(12, 10), textcoords="offset points", fontsize=10, color=INK)
ax.set_xlabel("False-alarm rate on non-drone clips (%)  ← better")
ax.set_ylabel("Drone recordings detected (%)  better →")
ax.set_xlim(left=0)
ax.set_ylim(0, 102)
ax.legend(frameon=False, loc="lower right")
ax.set_title("Choosing the mic checks on training audio: big cut in false alarms, small cost in drones", fontsize=12)
footer(fig, "Source: training audio only (DADS training files 2, 5, 10; ESC-50 folds 4-5). Each dot = one combination of the three thresholds.")
fig.tight_layout(rect=(0, 0.04, 1, 1))
save(fig, "05_hum_threshold_choice")
