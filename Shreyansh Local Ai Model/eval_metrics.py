"""NumPy-only group bootstrap used by the local classifier reports."""

import numpy as np

N_BOOT = 1000
BOOT_SEED = 0


def rate(mask_num, mask_den, clip, n_boot=N_BOOT, seed=BOOT_SEED):
    """Point value and clip-bootstrap 95% CI of sum(num)/sum(den)."""
    if mask_den.sum() == 0:
        return None
    clips = np.unique(clip[mask_den])
    num = np.array([mask_num[(clip == c) & mask_den].sum() for c in clips], float)
    den = np.array([mask_den[clip == c].sum() for c in clips], float)
    rng = np.random.default_rng(seed)
    boots = []
    for _ in range(n_boot):
        i = rng.integers(0, len(clips), len(clips))
        boots.append(num[i].sum() / max(den[i].sum(), 1))
    return {"value": float(num.sum() / den.sum()), "ci95": [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))],
            "n": int(den.sum()), "clips": int(len(clips))}
