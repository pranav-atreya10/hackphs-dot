"""Gemini vs our model on the SAME crops (the crops our model is tested on; never trained on).

    GEMINI_API_KEY=... python3 gemini_compare.py --models gemini-3.5-flash gemini-3.6-flash --ours runs/v3/best.pt

The key is read from the environment only and never written anywhere.
Sample (fixed seed 0): Svanström test clips at real size (60 birds, 60 drones, 60 other: planes, helicopters,
sky), Svanström shrunk to 7 px and 13 px (30 birds + 30 drones each), FBD-SV-2024 (never-seen source; 40 birds,
40 background), Svanström YouTube planes/helicopters (40). Each crop is the 64x64 live crop, upscaled to 256 px
for Gemini (bicubic), with the prompt below; temperature 0. Gemini is forced to answer one of bird / drone / other (enum output).
Results: results/gemini_compare.json and .md. Small samples: the CIs are wide (shown).
"""
import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_svanstrom import predict  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
PROMPT = ("This is a small crop from an airport sky camera, centred on a moving object found by a motion tracker. "
          "Is the object in the centre a bird, a drone (any unmanned aircraft: quadcopter, multirotor or small "
          "fixed-wing drone), or other (airplane, helicopter, insect, kite, balloon, cloud, tree, building, empty sky, "
          "or nothing)? Answer with exactly one word: bird, drone, or other.")
CLS = ["bird", "drone", "other"]


def sample():
    rng = np.random.default_rng(0)
    v3, v4 = DATA / "shreyansh_crops_v3", DATA / "shreyansh_crops_v4"
    out = []

    def take(name, X, idx, y, k):
        idx = np.array(idx)
        for i in rng.permutation(idx)[:k]:
            out.append((name, X, int(i), int(y[i])))

    m = np.load(v3 / "svan_test_meta.npz"); X = np.load(v3 / "svan_test_X.npy", mmap_mode="r")
    yt = m["youtube"][m["clip"]]; y = m["y"]
    take("svanstrom real size", X, np.nonzero(~yt & (y == 0))[0], y, 60)
    take("svanstrom real size", X, np.nonzero(~yt & (y == 1))[0], y, 60)
    take("svanstrom real size", X, np.nonzero(~yt & (y == 2))[0], y, 60)
    take("youtube planes/helicopters", X, np.nonzero(yt & (y == 2))[0], y, 40)
    m = np.load(v3 / "svan_shrunk_meta.npz"); X = np.load(v3 / "svan_shrunk_X.npy", mmap_mode="r")
    yt = m["youtube"][m["clip"]]; y, s = m["y"], m["size"]
    for px in (7, 13):
        for c in (0, 1):
            take(f"svanstrom shrunk {px} px", X, np.nonzero(~yt & (y == c) & (s == px))[0], y, 30)
    if (v4 / "fbdsv2024_testonly_test_meta.npz").exists():
        m = np.load(v4 / "fbdsv2024_testonly_test_meta.npz"); X = np.load(v4 / "fbdsv2024_testonly_test_X.npy", mmap_mode="r"); y = m["y"]
        take("FBD-SV (never-seen source)", X, np.nonzero(y == 0)[0], y, 40)
        take("FBD-SV (never-seen source)", X, np.nonzero(y == 2)[0], y, 40)
    return out


def ask(model, key, crop):
    buf = io.BytesIO()
    Image.fromarray(crop).resize((256, 256), Image.BICUBIC).save(buf, "PNG")
    body = {"contents": [{"parts": [{"text": PROMPT}, {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(buf.getvalue()).decode()}}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "text/x.enum",
                                 "responseSchema": {"type": "STRING", "enum": CLS}}}
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": key})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read())
            text = "".join(p.get("text", "") for c in d.get("candidates", []) for p in c.get("content", {}).get("parts", [])).strip().lower()
            return (CLS.index(text), text) if text in CLS else (2, text[:40])
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503):
                time.sleep(2 ** attempt); continue
            return -1, f"HTTP {e.code}"
        except Exception as e:  # noqa: BLE001
            time.sleep(2 ** attempt); last = str(e)[:40]
    return -1, "failed"


def ci(hits, rng=np.random.default_rng(1)):
    hits = np.array(hits, float)
    if not len(hits):
        return None
    b = [hits[rng.integers(0, len(hits), len(hits))].mean() for _ in range(1000)]
    return [float(hits.mean()), float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5)), int(len(hits))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["gemini-3.5-flash"])
    ap.add_argument("--ours", nargs="*", default=[str(HERE / "runs" / "v3" / "best.pt")])
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    key = os.environ["GEMINI_API_KEY"]
    items = sample()
    crops = [np.ascontiguousarray(X[i, 0]) for _, X, i, _ in items]
    truth = np.array([y for *_, y in items])
    groups = [n for n, *_ in items]
    preds, raw, timing = {}, {}, {}
    for ck in a.ours:
        t = time.time()
        preds[Path(ck).parent.name] = predict(ck, np.stack(crops)[:, None])
        timing[Path(ck).parent.name] = (time.time() - t) / len(crops)
    for model in a.models:
        t = time.time()
        with ThreadPoolExecutor(a.workers) as ex:
            res = list(ex.map(lambda c: ask(model, key, c), crops))
        preds[model] = np.array([r[0] for r in res]); raw[model] = [r[1] for r in res]
        timing[model] = (time.time() - t) / len(crops) * a.workers
        print(model, "done; failed calls:", int((preds[model] < 0).sum()), flush=True)
    report = {"n": len(items), "timing_sec_per_crop": timing, "by_set": {}}
    names = list(dict.fromkeys(groups))
    lines = ["| Test set | Class | " + " | ".join(preds) + " |", "|---|---|" + "---|" * len(preds)]
    for g in names:
        for c, cname in enumerate(CLS):
            m = np.array([gg == g for gg in groups]) & (truth == c)
            if not m.any():
                continue
            row = {}
            for k, p in preds.items():
                ok = p[m] >= 0
                row[k] = ci((p[m][ok] == c).tolist())
            report["by_set"][f"{g} | {cname}"] = row
            label = "correct" if c < 2 else "correctly 'other' (no false alarm)"
            cells = " | ".join("n/a" if not r else f"{100 * r[0]:.0f}% ({100 * r[1]:.0f}-{100 * r[2]:.0f})" for r in row.values())
            lines.append(f"| {g} | {cname} ({label}), n={int(m.sum())} | {cells} |")
    overall = {k: ci((p[p >= 0] == truth[p >= 0]).tolist()) for k, p in preds.items()}
    report["overall"] = overall
    lines.append("| **all** | | " + " | ".join(f"**{100 * r[0]:.0f}%**" for r in overall.values()) + " |")
    lines.append("\nSeconds per crop: " + ", ".join(f"{k} {v:.3f}" for k, v in timing.items()))
    report["raw_answers_sample"] = {k: v[:20] for k, v in raw.items()}
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "gemini_compare.json").write_text(json.dumps(report, indent=1))
    (HERE / "results" / "gemini_compare.md").write_text("# Gemini vs our model, same crops\n\n" + "\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
