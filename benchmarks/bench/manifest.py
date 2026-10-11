"""Frozen test-set manifest (benchmarks/test_sets.json): verification and item listing.

Every file in the manifest carries a SHA-256. verify() checks all of them and refuses to continue
if anything is missing or changed (protocol section 1)."""

import json

import pandas as pd

from .common import MANIFEST, ROOT, sha256_file


def load():
    if not MANIFEST.exists():
        raise SystemExit("benchmarks/test_sets.json not found: freeze the test sets first (benchmarks/freeze_test_sets.py).")
    return json.loads(MANIFEST.read_text())


def all_files(man):
    for tier in man["tiers"].values():
        for group in tier.values():
            if isinstance(group, dict) and "items" in group:
                for it in group["items"]:
                    if "path" in it:
                        yield it
            if isinstance(group, dict) and "splits" in group:
                for split in group["splits"].values():
                    for it in split:
                        yield it


def verify(man, include_holdout=False):
    problems, n = [], 0
    for it in all_files(man):
        if it.get("split") == "holdout" and not include_holdout:
            continue
        p = ROOT / it["path"]
        n += 1
        if not p.exists():
            problems.append(f"MISSING {it['path']}")
        elif sha256_file(p) != it["sha256"]:
            problems.append(f"CHANGED {it['path']}")
    if problems:
        print("\n".join(problems[:20]))
        raise SystemExit(f"Test-set verification FAILED ({len(problems)} of {n} files). Refusing to run. "
                         "Do not fix or replace test files: ask Vivan (protocol section 1).")
    return n


def visual_items(man, final=False):
    """Returns (items DataFrame, gt rows list) for every frozen visual tier in play."""
    items, gts = [], []
    tiers = man["tiers"]
    groups = [("dataset", tiers.get("dataset", {}).get("visual"))]
    field = tiers.get("field", {}).get("visual")
    if field and field.get("frozen"):
        groups.append(("field", {"items": [it for s, lst in field["splits"].items() if s == "tune" or (final and s == "holdout") for it in lst]}))
    for tier, g in groups:
        if not g:
            continue
        for it in g["items"]:
            items.append({"item_id": it["item_id"], "path": str(ROOT / it["path"]), "tier": tier,
                          "condition_tag": it.get("condition_tag"), "split": it.get("split")})
            for b in it.get("boxes", []):
                gts.append({"item_id": it["item_id"], "kind": "gt", "cls": b["cls"], "score": float("nan"),
                            "x1": b["x1"], "y1": b["y1"], "x2": b["x2"], "y2": b["y2"],
                            "size_tag": b["size_tag"], "condition_tag": it.get("condition_tag")})
    return pd.DataFrame(items), gts


def audio_items(man, final=False):
    rows = []
    tiers = man["tiers"]
    for tier_key, group in (("dataset", "audio"), ("stress", "audio_mix"), ("stress", "audio_lookalike")):
        g = tiers.get(tier_key, {}).get(group)
        if not g:
            continue
        for it in g["items"]:
            rows.append({**it, "path": str(ROOT / it["path"])})
    field = tiers.get("field", {}).get("audio")
    if field and field.get("frozen"):
        for s, lst in field["splits"].items():
            if s == "tune" or (final and s == "holdout"):
                rows += [{**it, "path": str(ROOT / it["path"])} for it in lst]
    return pd.DataFrame(rows)
