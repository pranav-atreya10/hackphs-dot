"""Bootstrap confidence intervals and the significance rule (protocol section 5).

Resampling unit = the test ITEM (image, clip, recording), never individual boxes or windows,
so correlated predictions from one item aren't counted as independent evidence.
"""

import numpy as np

N_BOOT = 1000
SEED = 20261010


def bootstrap(stat_fn, n_items, n_boot=N_BOOT, seed=SEED, alpha=0.05):
    """stat_fn(idx) -> float, where idx is an array of item indices (with repeats).
    Returns (point, lo, hi) using the percentile method."""
    point = float(stat_fn(np.arange(n_items)))
    if n_items == 0:
        return point, float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    vals = np.empty(n_boot)
    for b in range(n_boot):
        vals[b] = stat_fn(rng.integers(0, n_items, n_items))
    vals = vals[~np.isnan(vals)]
    if len(vals) == 0:
        return point, float("nan"), float("nan")
    lo, hi = np.percentile(vals, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return point, float(lo), float(hi)


def ratio_ci(numer, denom, **kw):
    """CI for sum(numer)/sum(denom) with per-item numerators/denominators (e.g. recall per image)."""
    numer = np.asarray(numer, float)
    denom = np.asarray(denom, float)

    def fn(idx):
        d = denom[idx].sum()
        return numer[idx].sum() / d if d > 0 else np.nan
    return bootstrap(fn, len(numer), **kw)


def mean_ci(values, **kw):
    values = np.asarray(values, float)
    return bootstrap(lambda idx: values[idx].mean() if len(idx) else np.nan, len(values), **kw)


def metric(point, lo, hi):
    return {"value": point, "lo": lo, "hi": hi}


def significant(new, best):
    """Protocol rule: overlapping 95% CIs = not significant. Returns 'better', 'worse' or 'not significant'.
    new/best: dicts with value/lo/hi. Direction (higher = better) is decided by the caller."""
    if not new or not best or any(np.isnan([new["lo"], new["hi"], best["lo"], best["hi"]])):
        return "not significant"
    if new["lo"] > best["hi"]:
        return "higher"
    if new["hi"] < best["lo"]:
        return "lower"
    return "not significant"
