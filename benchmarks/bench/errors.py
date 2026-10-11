"""Error galleries: the 20 worst false positives and 20 worst false negatives per model,
each saved with a short tag (size, condition, SNR, noise) so failure patterns are visible."""

import json

import numpy as np

N_WORST = 20


def visual_errors(per, pred, items, outdir, op_conf):
    """Worst FP = highest-confidence detections that match nothing; worst FN = GT boxes the model
    scored lowest (missed at the operating point)."""
    import cv2
    from .visual import CLASSES
    paths = items.set_index("item_id").path.to_dict()
    conds = items.set_index("item_id").get("condition_tag", {}).to_dict() if "condition_tag" in items else {}
    fps, fns = [], []
    item_ids = items.item_id.tolist()
    gts = pred[pred.kind == "gt"]
    dets = pred[pred.kind == "det"]
    for iid, p in zip(item_ids, per):
        d_img = dets[dets.item_id == iid]
        for c, name in CLASSES.items():
            d = d_img[d_img.cls == c].sort_values("score", ascending=False)
            for k, (_, row) in enumerate(d.iterrows()):
                if row.score >= op_conf and not p[c]["tp"][k, 0]:
                    fps.append((row.score, iid, name, row))
            g = gts.loc[p[c]["gt_rows"]] if len(p[c]["gt_rows"]) else gts.iloc[0:0]
            for (_, row), best in zip(g.iterrows(), p[c]["gt_best"]):
                if best < op_conf:
                    fns.append((best, iid, name, row))
    fps.sort(key=lambda x: -x[0])
    fns.sort(key=lambda x: x[0])
    index = []
    for kind, lst in (("fp", fps[:N_WORST]), ("fn", fns[:N_WORST])):
        for rank, (score, iid, name, row) in enumerate(lst, 1):
            img = cv2.imread(str(paths[iid]))
            if img is None:
                continue
            h, w = img.shape[:2]
            for _, g in gts[gts.item_id == iid].iterrows():
                cv2.rectangle(img, (int(g.x1 * w), int(g.y1 * h)), (int(g.x2 * w), int(g.y2 * h)), (0, 200, 0), 2)
            color = (0, 0, 255) if kind == "fp" else (0, 165, 255)
            cv2.rectangle(img, (int(row.x1 * w), int(row.y1 * h)), (int(row.x2 * w), int(row.y2 * h)), color, 2)
            tag = {"kind": kind, "class": name, "score": round(float(score), 3), "item_id": iid,
                   "size": row.get("size_tag") if kind == "fn" else None,
                   "condition": conds.get(iid)}
            label = f"{kind.upper()} {name} {score:.2f} {tag['size'] or ''} {tag['condition'] or ''}".strip()
            cv2.putText(img, label, (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 3)
            cv2.putText(img, label, (6, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)
            fname = f"visual_{kind}_{rank:02d}.jpg"
            cv2.imwrite(str(outdir / fname), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
            index.append({**tag, "file": fname})
    return index


def audio_errors(pred, outdir, thr):
    """Worst FP = negative items with the highest max probability; worst FN = positives with the lowest.
    Each saved as a mel spectrogram with the per-window probability and threshold drawn under it."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from .audio import SR, load_audio
    import librosa
    import librosa.display
    items = pred.groupby("item_id", sort=False).agg(prob=("prob", "max"), label=("label", "first"), path=("path", "first"),
                                                    tier=("tier", "first"), snr_db=("snr_db", "first"), noise_type=("noise_type", "first"),
                                                    source=("source", "first"))
    fps = items[(items.label == 0) & (items.prob >= thr)].sort_values("prob", ascending=False).head(N_WORST)
    fns = items[(items.label == 1) & (items.prob < thr)].sort_values("prob").head(N_WORST)
    index = []
    for kind, df in (("fp", fps), ("fn", fns)):
        for rank, (iid, r) in enumerate(df.iterrows(), 1):
            y = load_audio(r.path)[: SR * 20]
            win = pred[pred.item_id == iid]
            fig, (a1, a2) = plt.subplots(2, 1, figsize=(8, 4.5), sharex=True, gridspec_kw={"height_ratios": [3, 1]})
            S = librosa.power_to_db(librosa.feature.melspectrogram(y=y, sr=SR, n_mels=64), ref=np.max)
            librosa.display.specshow(S, sr=SR, x_axis="time", y_axis="mel", ax=a1)
            snr = "" if pd_isnull(r.snr_db) else f" {int(r.snr_db):+d} dB"
            noise = "" if pd_isnull(r.noise_type) else f" {r.noise_type}"
            title = f"{kind.upper()} {r.tier}{noise}{snr} max p={r.prob:.2f}"
            a1.set_title(title, fontsize=11)
            a2.step(win.t0 + 0.5, win.prob, where="mid", color="#0072B2")
            a2.axhline(thr, color="#D55E00", ls="--", lw=1)
            a2.set_ylim(0, 1)
            a2.set_ylabel("p(drone)")
            fig.tight_layout()
            fname = f"audio_{kind}_{rank:02d}.png"
            fig.savefig(outdir / fname, dpi=110)
            plt.close(fig)
            index.append({"kind": kind, "item_id": iid, "tier": r.tier, "source": r.source, "prob": round(float(r.prob), 3),
                          "snr_db": None if pd_isnull(r.snr_db) else float(r.snr_db),
                          "noise_type": None if pd_isnull(r.noise_type) else r.noise_type, "file": fname})
    return index


def pd_isnull(v):
    return v is None or (isinstance(v, float) and np.isnan(v))


def write_index(outdir, visual, audio):
    (outdir / "index.json").write_text(json.dumps({"visual": visual, "audio": audio}, indent=1, default=str))
