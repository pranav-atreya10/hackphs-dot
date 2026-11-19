"""Score a checkpoint on EVERY test set we have, one table (never used for any training decision).

    python3 eval_v4.py --checkpoint runs/v4/best.pt --out results/v4

Rows:
  - each v4 source's own TEST part (groups never trained on)            -> data/shreyansh_crops_v4/<source>_test_*
  - FBD-SV-2024: a source the model NEVER trained on at all               -> fbdsv2024_testonly
  - Svanström test clips at real size and shrunk to 7 / 10 / 13 px        -> data/shreyansh_crops_v3
  - Mendeley frozen test: run evaluate.py separately (it checks checksums and makes the official report)
Columns: bird recall, drone recall, false alarms (other called bird or drone), each with a 95% CI from
1,000 bootstrap resamples of whole groups (videos / clips / images). Size rows for birds: 7-15 px, over 15 px.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_svanstrom import predict, rate  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"


def rows():
    v4 = DATA / "shreyansh_crops_v4"
    for f in sorted(v4.glob("*_test_X.npy")):
        name = f.name[:-len("_test_X.npy")]
        m = np.load(v4 / f"{name}_test_meta.npz")
        yield name, f, m["y"], m["size"], np.unique(m["group"], return_inverse=True)[1]
    v3 = DATA / "shreyansh_crops_v3"
    for part, label in (("test", "svanstrom (real size)"), ("shrunk", "svanstrom shrunk 7/10/13 px")):
        m = np.load(v3 / f"svan_{part}_meta.npz")
        keep = ~m["youtube"][m["clip"]]
        yield label, v3 / f"svan_{part}_X.npy", m["y"], m["size"], m["clip"], keep
        yt = m["youtube"][m["clip"]]
        if part == "test":
            yield "svanstrom YouTube planes/helicopters", v3 / f"svan_{part}_X.npy", m["y"], m["size"], m["clip"], yt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = {}
    lines = ["| Test set | Bird recall | Drone recall | False alarms | Birds 7-15 px | Birds+drones 7-15 px | Birds+drones over 15 px |",
             "|---|---|---|---|---|---|---|"]
    f = lambda r: "n/a" if not r else f"{100 * r['value']:.1f}% ({100 * r['ci95'][0]:.0f}-{100 * r['ci95'][1]:.0f}) n={r['n']}"  # noqa: E731
    for item in rows():
        name, path, y, size, grp = item[:5]
        keep = item[5] if len(item) > 5 else np.ones(len(y), bool)
        X = np.load(path, mmap_mode="r")
        idx = np.nonzero(keep)[0]
        if not len(idx):
            continue
        p = np.full(len(y), -1)
        p[idx] = predict(a.checkpoint, X[idx])
        k = keep
        small, big = k & (size >= 7) & (size < 15), k & (size >= 15)
        r = {
            "bird_recall": rate(k & (y == 0) & (p == 0), k & (y == 0), grp),
            "drone_recall": rate(k & (y == 1) & (p == 1), k & (y == 1), grp),
            "false_alarm": rate(k & (y == 2) & (p < 2) & (p >= 0), k & (y == 2), grp),
            "bird_7_15": rate(small & (y == 0) & (p == 0), small & (y == 0), grp),
            "obj_7_15": rate(small & (y < 2) & (p == y), small & (y < 2), grp),
            "obj_over_15": rate(big & (y < 2) & (p == y), big & (y < 2), grp),
        }
        out[name] = r
        lines.append(f"| {name} | {f(r['bird_recall'])} | {f(r['drone_recall'])} | {f(r['false_alarm'])} | {f(r['bird_7_15'])} | {f(r['obj_7_15'])} | {f(r['obj_over_15'])} |")
        print(lines[-1], flush=True)
    d = Path(a.out); d.mkdir(parents=True, exist_ok=True)
    (d / "all_tests.json").write_text(json.dumps(out, indent=1))
    (d / "all_tests.md").write_text("# All test sets (groups never trained on; FBD-SV never trained on at all)\n\n" + "\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
