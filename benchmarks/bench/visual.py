"""Visual benchmark: YOLO inference -> raw predictions -> metrics with bootstrap CIs.

Matching (COCO-style): per image and class, detections sorted by score greedily take the
unmatched ground-truth box with the highest IoU >= t. Matching is done once per image at all
IoU thresholds; bootstrap resamples then only concatenate per-image arrays.
"""

import time

import numpy as np
import pandas as pd

from .stats import bootstrap, ratio_ci, metric

CLASSES = {0: "bird", 1: "drone"}
IOU_THRS = np.round(np.arange(0.5, 0.96, 0.05), 2)
SWEEP_THRS = np.round(np.arange(0.05, 0.96, 0.05), 2)


# ---------------------------------------------------------------- inference

def run_yolo(weights, items, imgsz, device, conf=0.001, batch=16):
    """items: list of dicts {item_id, path}. Returns detection rows (normalized xyxy)."""
    from ultralytics import YOLO
    model = YOLO(weights)
    rows = []
    for i in range(0, len(items), batch):
        chunk = items[i:i + batch]
        results = model.predict([it["path"] for it in chunk], imgsz=imgsz, conf=conf, device=device,
                                max_det=100, verbose=False)
        for it, r in zip(chunk, results):
            if r.boxes is None:
                continue
            xyxyn = r.boxes.xyxyn.cpu().numpy()
            for (x1, y1, x2, y2), c, s in zip(xyxyn, r.boxes.cls.cpu().numpy(), r.boxes.conf.cpu().numpy()):
                rows.append({"item_id": it["item_id"], "kind": "det", "cls": int(c), "score": float(s),
                             "x1": float(x1), "y1": float(y1), "x2": float(x2), "y2": float(y2)})
    return rows


def speed_test(weights, paths, imgsz, device, n_warmup=10, n_runs=100):
    """Latency per image (batch 1, end to end incl. pre/post-processing). Returns ms list."""
    from ultralytics import YOLO
    model = YOLO(weights)
    paths = list(paths)
    for p in paths[:n_warmup]:
        model.predict(p, imgsz=imgsz, device=device, verbose=False)
    lat = []
    for p in (paths * (n_runs // max(1, len(paths)) + 1))[:n_runs]:
        t0 = time.perf_counter()
        model.predict(p, imgsz=imgsz, device=device, verbose=False)
        lat.append((time.perf_counter() - t0) * 1000)
    lat = np.array(lat)
    return {"imgsz": imgsz, "p50_ms": float(np.percentile(lat, 50)), "p95_ms": float(np.percentile(lat, 95)),
            "fps": float(1000 / lat.mean()), "n": int(len(lat))}


# ---------------------------------------------------------------- matching

def iou_matrix(a, b):
    """a: (n,4), b: (m,4) xyxy -> (n,m)."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    ix1 = np.maximum(a[:, None, 0], b[None, :, 0])
    iy1 = np.maximum(a[:, None, 1], b[None, :, 1])
    ix2 = np.minimum(a[:, None, 2], b[None, :, 2])
    iy2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(ix2 - ix1, 0, None) * np.clip(iy2 - iy1, 0, None)
    area_a = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / np.maximum(area_a[:, None] + area_b[None, :] - inter, 1e-12)


def match_image(gts, dets):
    """gts/dets: DataFrames for one image. Returns per-class dicts:
    det_scores, det_tp (n_det x n_thr), det_iou (matched IoU at 0.5 or 0), gt_best_score (score of
    the det matched at IoU 0.5, -1 if none), plus cross-class info for bird->drone confusion."""
    out = {}
    for c in CLASSES:
        g = gts[gts.cls == c]
        d = dets[dets.cls == c].sort_values("score", ascending=False)
        gb = g[["x1", "y1", "x2", "y2"]].to_numpy()
        db = d[["x1", "y1", "x2", "y2"]].to_numpy()
        ious = iou_matrix(db, gb)
        tp = np.zeros((len(d), len(IOU_THRS)), bool)
        det_iou = np.zeros(len(d))
        gt_best = np.full(len(g), -1.0)
        for ti, t in enumerate(IOU_THRS):
            taken = np.zeros(len(g), bool)
            for di in range(len(d)):
                if len(g) == 0:
                    break
                cand = np.where(~taken & (ious[di] >= t))[0]
                if len(cand) == 0:
                    continue
                j = cand[np.argmax(ious[di, cand])]
                taken[j] = True
                tp[di, ti] = True
                if ti == 0:
                    det_iou[di] = ious[di, j]
                    gt_best[j] = d.score.iloc[di]
        out[c] = {"scores": d.score.to_numpy(), "tp": tp, "det_iou": det_iou, "gt_best": gt_best,
                  "gt_rows": g.index.to_numpy()}
    # Cross-class confusion: best score of a wrong-class detection covering each GT box (IoU >= 0.5).
    #   bird_as_drone: a bird box claimed by a drone detection (false drone alarm)
    #   drone_as_bird: a drone box claimed by a bird detection (the dangerous miss)
    def cross(gt_cls, det_cls):
        g = gts[gts.cls == gt_cls]
        d = dets[dets.cls == det_cls]
        ious = iou_matrix(g[["x1", "y1", "x2", "y2"]].to_numpy(), d[["x1", "y1", "x2", "y2"]].to_numpy())
        sc = d.score.to_numpy()
        return np.array([sc[ious[i] >= 0.5].max() if (ious[i] >= 0.5).any() else -1.0 for i in range(len(g))])
    out["bird_as_drone"] = cross(0, 1)
    out["drone_as_bird"] = cross(1, 0)
    d = dets[dets.cls == 1]
    out["max_drone_score"] = float(d.score.max()) if len(d) else -1.0
    return out


def average_precision(scores, tp, n_gt):
    """COCO 101-point interpolated AP."""
    if n_gt == 0:
        return np.nan
    if len(scores) == 0:
        return 0.0
    order = np.argsort(-scores, kind="mergesort")
    tp = tp[order].astype(float)
    ctp = np.cumsum(tp)
    cfp = np.cumsum(1 - tp)
    rec = ctp / n_gt
    prec = ctp / np.maximum(ctp + cfp, 1e-12)
    prec = np.maximum.accumulate(prec[::-1])[::-1]
    rs = np.linspace(0, 1, 101)
    idx = np.searchsorted(rec, rs, side="left")
    return float(np.mean(np.where(idx < len(prec), prec[np.minimum(idx, len(prec) - 1)], 0.0)))


# ---------------------------------------------------------------- metrics

def compute_metrics(pred, items, op_conf, n_boot=1000):
    """pred: DataFrame of gt + det rows (modality == 'visual'); items: DataFrame of test items
    (item_id, size/condition tags per GT are in pred). op_conf: operating-point confidence threshold."""
    item_ids = items.item_id.tolist()
    per = []
    for iid in item_ids:
        rows = pred[pred.item_id == iid]
        per.append(match_image(rows[rows.kind == "gt"], rows[rows.kind == "det"]))
    n = len(per)
    m = {}

    # mAP over resampled images
    def map_fn(idx, thr_slice):
        aps = []
        for c in CLASSES:
            sc = np.concatenate([per[i][c]["scores"] for i in idx]) if len(idx) else np.array([])
            tp = np.concatenate([per[i][c]["tp"] for i in idx]) if len(idx) else np.zeros((0, len(IOU_THRS)), bool)
            ngt = sum(len(per[i][c]["gt_best"]) for i in idx)
            for ti in thr_slice:
                aps.append(average_precision(sc, tp[:, ti], ngt))
        return np.nanmean(aps) if not np.all(np.isnan(aps)) else np.nan

    m["mAP50"] = metric(*bootstrap(lambda idx: map_fn(idx, [0]), n, n_boot=n_boot))
    m["mAP50_95"] = metric(*bootstrap(lambda idx: map_fn(idx, range(len(IOU_THRS))), n, n_boot=n_boot))

    # Per-class precision / recall / F1 at the operating point
    for c, name in CLASSES.items():
        tp_i = np.array([((p[c]["scores"] >= op_conf) & p[c]["tp"][:, 0]).sum() for p in per])
        det_i = np.array([(p[c]["scores"] >= op_conf).sum() for p in per])
        gt_i = np.array([len(p[c]["gt_best"]) for p in per])
        hit_i = np.array([(p[c]["gt_best"] >= op_conf).sum() for p in per])
        m[f"{name}_precision"] = metric(*ratio_ci(tp_i, det_i, n_boot=n_boot))
        m[f"{name}_recall"] = metric(*ratio_ci(hit_i, gt_i, n_boot=n_boot))

        def f1(idx, tp_i=tp_i, det_i=det_i, gt_i=gt_i, hit_i=hit_i):
            p = tp_i[idx].sum() / max(det_i[idx].sum(), 1)
            r = hit_i[idx].sum() / max(gt_i[idx].sum(), 1)
            return 2 * p * r / (p + r) if p + r > 0 else 0.0
        m[f"{name}_f1"] = metric(*bootstrap(f1, n, n_boot=n_boot))

    # Bird boxes claimed by a drone detection
    bad = np.array([(p["bird_as_drone"] >= op_conf).sum() for p in per])
    birds = np.array([len(p["bird_as_drone"]) for p in per])
    m["bird_as_drone_rate"] = metric(*ratio_ci(bad, birds, n_boot=n_boot))
    bad = np.array([(p["drone_as_bird"] >= op_conf).sum() for p in per])
    drones = np.array([len(p["drone_as_bird"]) for p in per])
    m["drone_as_bird_rate"] = metric(*ratio_ci(bad, drones, n_boot=n_boot))

    # False alarms: drone detections on images with no drone in them
    no_drone = np.array([len(p[1]["gt_best"]) == 0 for p in per])
    fa_dets = np.array([(p[1]["scores"] >= op_conf).sum() for p in per])
    fa_img = np.array([p["max_drone_score"] >= op_conf for p in per])
    m["fa_rate"] = metric(*ratio_ci(fa_img[no_drone], np.ones(no_drone.sum()), n_boot=n_boot))
    bird_only = np.array([len(p[1]["gt_best"]) == 0 and len(p[0]["gt_best"]) > 0 for p in per])
    m["fa_per_bird_image"] = metric(*ratio_ci(fa_dets[bird_only], np.ones(bird_only.sum()), n_boot=n_boot))

    # Localization: mean IoU of correct detections (IoU >= 0.5) at the operating point
    ious = [np.concatenate([p[c]["det_iou"][(p[c]["scores"] >= op_conf) & p[c]["tp"][:, 0]] for c in CLASSES]) for p in per]
    sums = np.array([x.sum() for x in ious])
    cnts = np.array([len(x) for x in ious])
    m["mean_iou_tp"] = metric(*ratio_ci(sums, cnts, n_boot=n_boot))

    # Recall broken down by target size and condition (tags live on GT rows)
    gts = pred[(pred.kind == "gt")]
    breakdown = {}
    for tag_col in ("size_tag", "condition_tag"):
        for tag in sorted(gts[tag_col].dropna().unique()):
            for c, name in CLASSES.items():
                hit, tot = [], []
                for p in per:
                    rows = gts.loc[p[c]["gt_rows"]] if len(p[c]["gt_rows"]) else gts.iloc[0:0]
                    mask = (rows[tag_col] == tag).to_numpy()
                    tot.append(mask.sum())
                    hit.append((p[c]["gt_best"][mask] >= op_conf).sum() if mask.any() else 0)
                if sum(tot):
                    breakdown[f"{name}_recall_{tag_col.split('_')[0]}_{tag}"] = metric(*ratio_ci(hit, tot, n_boot=n_boot))
    m.update(breakdown)

    # Threshold sweep (point estimates; the operating point is marked on the chart)
    sweep = []
    for t in SWEEP_THRS:
        for c, name in CLASSES.items():
            tp = sum(((p[c]["scores"] >= t) & p[c]["tp"][:, 0]).sum() for p in per)
            dets = sum((p[c]["scores"] >= t).sum() for p in per)
            gt = sum(len(p[c]["gt_best"]) for p in per)
            hit = sum((p[c]["gt_best"] >= t).sum() for p in per)
            prec = tp / dets if dets else 1.0
            rec = hit / gt if gt else np.nan
            sweep.append({"threshold": float(t), "class": name, "precision": prec, "recall": rec,
                          "f1": 2 * prec * rec / (prec + rec) if prec + rec > 0 else 0.0})
    return m, sweep, per


def confusion(per, op_conf):
    """Image-level confusion over {bird, drone, none}: truth = classes present, prediction = classes
    detected at the operating point. Counted per GT box: each bird/drone box -> what covers it."""
    labels = ["bird", "drone", "missed"]
    mat = np.zeros((2, 3), int)
    for p in per:
        for g_score, as_drone in zip(p[0]["gt_best"], p["bird_as_drone"]):
            if g_score >= op_conf:
                mat[0, 0] += 1
            elif as_drone >= op_conf:
                mat[0, 1] += 1
            else:
                mat[0, 2] += 1
        for g_score, as_bird in zip(p[1]["gt_best"], p["drone_as_bird"]):
            if g_score >= op_conf:
                mat[1, 1] += 1
            elif as_bird >= op_conf:
                mat[1, 0] += 1
            else:
                mat[1, 2] += 1
    return {"rows": ["bird", "drone"], "cols": labels, "matrix": mat.tolist()}
