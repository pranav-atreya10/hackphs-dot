"""Audio: log-mel features, a small CNN drone detector, windowed inference, and metrics.

Windows are 1.0 s with 0.5 s hop. Clips shorter than a window are LOOPED to length (never
zero-padded): DADS drone clips average 0.6 s, so zero padding would make "trailing silence"
a drone-only feature and the model could learn that shortcut.
"""

import io
import time

import numpy as np

SR = 16000
WIN_S = 1.0
HOP_S = 0.5
N_MELS = 64
N_FFT = 1024
HOP = 160


def load_wav_bytes(b):
    import soundfile as sf
    y, sr = sf.read(io.BytesIO(b), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y.astype(np.float32)


def load_audio(path):
    import librosa
    y, _ = librosa.load(path, sr=SR, mono=True)
    return y.astype(np.float32)


def loop_to(y, n):
    if len(y) == 0:
        return np.zeros(n, np.float32)
    if len(y) >= n:
        return y[:n]
    return np.tile(y, int(np.ceil(n / len(y))))[:n]


def windows(y):
    """Split a waveform into 1 s windows (0.5 s hop). Short clips are looped to one window."""
    w, h = int(SR * WIN_S), int(SR * HOP_S)
    if len(y) <= w:
        return np.stack([loop_to(y, w)]), np.array([0.0])
    starts = np.arange(0, len(y) - w + 1, h)
    if starts[-1] + w < len(y):
        starts = np.append(starts, len(y) - w)
    return np.stack([y[s:s + w] for s in starts]), starts / SR


def mix_at_snr(signal, noise, snr_db, rng):
    """Mix noise into signal at a target SNR (power ratio over the signal's length)."""
    start = rng.integers(0, max(1, len(noise) - len(signal) + 1))
    n = loop_to(noise[start:], len(signal))
    ps = np.mean(signal ** 2) + 1e-12
    pn = np.mean(n ** 2) + 1e-12
    n = n * np.sqrt(ps / (pn * 10 ** (snr_db / 10)))
    out = signal + n
    peak = np.abs(out).max()
    return (out / peak * 0.9 if peak > 1 else out).astype(np.float32)


# ---------------------------------------------------------------- model

def build_model():
    import torch.nn as nn

    class DroneCNN(nn.Module):
        def __init__(self):
            super().__init__()

            def block(i, o):
                return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.ReLU(), nn.MaxPool2d(2))
            self.features = nn.Sequential(block(1, 16), block(16, 32), block(32, 64), block(64, 64))
            self.head = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Dropout(0.2), nn.Linear(64, 1))

        def forward(self, x):
            return self.head(self.features(x)).squeeze(1)
    return DroneCNN()


class MelFrontend:
    """Log-mel spectrogram on the accelerator (torch STFT + librosa mel filterbank)."""

    def __init__(self, device):
        import librosa
        import torch
        self.torch = torch
        self.device = device
        self.fb = torch.tensor(librosa.filters.mel(sr=SR, n_fft=N_FFT, n_mels=N_MELS), device=device)
        self.window = torch.hann_window(N_FFT, device=device)

    def __call__(self, wave):  # wave: (B, samples) float tensor on device
        t = self.torch
        spec = t.stft(wave, N_FFT, HOP, window=self.window, return_complex=True).abs() ** 2
        mel = t.matmul(self.fb, spec)
        return t.log(mel + 1e-6).unsqueeze(1)  # (B, 1, mels, frames)


class AudioDetector:
    def __init__(self, weights, device):
        import torch
        self.torch = torch
        self.device = device
        self.model = build_model().to(device)
        state = torch.load(weights, map_location=device)
        self.model.load_state_dict(state["model"])
        self.model.eval()
        self.front = MelFrontend(device)
        self.norm = state.get("norm", {"mean": 0.0, "std": 1.0})

    def window_probs(self, y, batch=256):
        wins, starts = windows(y)
        probs = []
        with self.torch.no_grad():
            for i in range(0, len(wins), batch):
                x = self.torch.tensor(wins[i:i + batch], device=self.device)
                f = (self.front(x) - self.norm["mean"]) / self.norm["std"]
                probs.append(self.torch.sigmoid(self.model(f)).float().cpu().numpy())
        return np.concatenate(probs), starts


# ---------------------------------------------------------------- decisions

def detect_events(probs, thr, k):
    """Alarm events = runs of >= k consecutive windows at/above thr. Returns number of events."""
    above = probs >= thr
    events, run, fired = 0, 0, False
    for a in above:
        run = run + 1 if a else 0
        if run >= k and not fired:
            events += 1
            fired = True
        if not a:
            fired = False
    return events


def clip_detected(probs, thr, k):
    return detect_events(probs, thr, k) > 0


# ---------------------------------------------------------------- metrics

def compute_metrics(pred, thr, k_default=1, n_boot=1000):
    """pred: window rows with item_id, tier, label, prob, seconds (item duration), snr_db, noise_type."""
    from sklearn.metrics import roc_auc_score, average_precision_score
    from .stats import bootstrap, ratio_ci, metric

    m, extra = {}, {}

    def grp(df):
        """Clips cut from one recording share a group id; CIs resample whole groups."""
        return df["group"].to_numpy() if "group" in df and df["group"].notna().all() else None
    by_item = {iid: g.prob.to_numpy() for iid, g in pred.groupby("item_id", sort=False)}
    items = pred.drop_duplicates("item_id").set_index("item_id")

    # 1) DADS test clips: clip score = max window probability
    dads = items[items.tier == "dads_test"]
    if len(dads):
        y = dads.label.to_numpy().astype(int)
        s = np.array([by_item[i].max() for i in dads.index])
        det = np.array([clip_detected(by_item[i], thr, k_default) for i in dads.index])
        pos = y == 1
        G = grp(dads)
        m["recall"] = metric(*ratio_ci(det & pos, pos, n_boot=n_boot, groups=G))
        m["precision"] = metric(*ratio_ci(det & pos, det, n_boot=n_boot, groups=G))

        def f1(idx):
            tp = (det[idx] & pos[idx]).sum()
            p = tp / max(det[idx].sum(), 1)
            r = tp / max(pos[idx].sum(), 1)
            return 2 * p * r / (p + r) if p + r else 0.0
        m["f1"] = metric(*bootstrap(f1, len(y), n_boot=n_boot, groups=G))

        def auc(fn):
            def g(idx):
                yy = y[idx]
                return fn(yy, s[idx]) if 0 < yy.sum() < len(yy) else np.nan
            return g
        m["roc_auc"] = metric(*bootstrap(auc(roc_auc_score), len(y), n_boot=n_boot, groups=G))
        m["pr_auc"] = metric(*bootstrap(auc(average_precision_score), len(y), n_boot=n_boot, groups=G))
        extra["sweep"] = []
        for t in np.round(np.arange(0.05, 0.96, 0.05), 2):
            d = s >= t
            tp = (d & pos).sum()
            p = tp / d.sum() if d.sum() else 1.0
            r = tp / pos.sum() if pos.sum() else np.nan
            extra["sweep"].append({"threshold": float(t), "precision": p, "recall": r,
                                   "f1": 2 * p * r / (p + r) if p + r else 0.0})
        from sklearn.metrics import roc_curve
        fpr, tpr, _ = roc_curve(y, s)
        extra["roc"] = {"fpr": fpr[::max(1, len(fpr) // 300)].tolist(), "tpr": tpr[::max(1, len(tpr) // 300)].tolist()}
        extra["clip_scores"] = {"y": y.tolist(), "s": s.round(4).tolist()}

    # 2) Stress mixes: recall per SNR and noise type, for k = 1, 2, 3 consecutive windows
    stress = items[(items.tier == "stress") & (items.label == 1)]
    if len(stress):
        for k in (1, 2, 3):
            for (nt, snr), g in stress.groupby(["noise_type", "snr_db"]):
                det = np.array([clip_detected(by_item[i], thr, k) for i in g.index])
                m[f"stress_recall_k{k}_{nt}_{int(snr):+d}dB"] = metric(*ratio_ci(det, np.ones(len(det)), n_boot=n_boot, groups=grp(g)))
        snr_rows = []
        for nt in sorted(stress.noise_type.unique()):
            for snr in sorted(stress.snr_db.unique(), reverse=True):
                key = f"stress_recall_k{k_default}_{nt}_{int(snr):+d}dB"
                if key in m:
                    snr_rows.append({"noise_type": nt, "snr_db": float(snr), **m[key]})
        extra["snr_curve"] = snr_rows

    # 3) False alarms per hour on long ambient / bird-only / aircraft audio (resample recordings)
    amb = items[items.tier.isin(["ambient", "lookalike"])]
    if len(amb):
        hours = amb.seconds.to_numpy() / 3600
        for k in (1, 2, 3):
            ev = np.array([detect_events(by_item[i], thr, k) for i in amb.index])
            m[f"fa_per_hour_k{k}"] = metric(*ratio_ci(ev, hours, n_boot=n_boot, groups=grp(amb)))
            for tier_name, g in amb.groupby("source"):
                evs = np.array([detect_events(by_item[i], thr, k) for i in g.index])
                m[f"fa_per_hour_k{k}_{tier_name}"] = metric(*ratio_ci(evs, g.seconds.to_numpy() / 3600, n_boot=n_boot, groups=grp(g)))
        m["fa_per_hour"] = m[f"fa_per_hour_k{k_default}"]
        m["ambient_hours"] = {"value": float(hours.sum()), "lo": float(hours.sum()), "hi": float(hours.sum())}
    return m, extra


def latency(detector, clips, n=200):
    """ms of compute per second of audio, p50/p95 over clips."""
    vals = []
    for y in clips[:n]:
        t0 = time.perf_counter()
        detector.window_probs(y)
        vals.append((time.perf_counter() - t0) * 1000 / max(len(y) / SR, WIN_S))
    vals = np.array(vals)
    return {"p50_ms_per_s": float(np.percentile(vals, 50)), "p95_ms_per_s": float(np.percentile(vals, 95)), "n": len(vals)}
