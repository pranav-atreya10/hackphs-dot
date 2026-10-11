"""Export the trained drone-audio CNN for the browser engine (pure JavaScript, no ML runtime).

    .venv/bin/python benchmarks/export_audio_web.py [--weights models/audio/v0_audio.pt]

Writes VIVAN/detection/models/drone_audio_v0.json:
  - the log-mel front end settings and the exact mel filterbank (librosa, 64 x 513)
  - conv weights with batch-norm folded in (conv -> BN -> ReLU -> maxpool becomes conv' -> ReLU -> maxpool)
  - reference outputs on fixed test signals, so the JS port can prove it matches Python
"""

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench import audio  # noqa: E402
from bench.common import ROOT, sha256_file  # noqa: E402


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()


def reference_signals():
    """Deterministic test signals (no RNG), rebuilt identically in tests.js."""
    n = audio.SR
    t = np.arange(n) / audio.SR
    tone = sum(np.sin(2 * np.pi * 260 * h * t) / h for h in (1, 2, 3)) * 0.1
    chirp = 0.1 * np.sin(2 * np.pi * (300 * t + 1500 * t * t))
    lcg = np.empty(n)
    s = 12345
    for i in range(n):  # tiny linear congruential noise, same formula in JS
        s = (1103515245 * s + 12345) % 2147483648
        lcg[i] = (s / 2147483648 - 0.5) * 0.2
    return {"tone_260hz": tone, "chirp": chirp, "lcg_noise": lcg}


def main():
    import torch
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default="models/audio/v0_audio.pt")
    ap.add_argument("--out", default="VIVAN/detection/models/drone_audio_v0.json")
    a = ap.parse_args()
    wpath = ROOT / a.weights
    det = audio.AudioDetector(str(wpath), "cpu")
    model = det.model.eval()

    layers = []
    for block in model.features:
        conv, bn = block[0], block[1]
        scale = (bn.weight / torch.sqrt(bn.running_var + bn.eps)).detach()
        w = conv.weight.detach() * scale[:, None, None, None]
        b = (conv.bias.detach() - bn.running_mean) * scale + bn.bias.detach()
        layers.append({"out": w.shape[0], "in": w.shape[1], "w": b64(w.numpy()), "b": b64(b.numpy())})
    lin = model.head[-1]

    import librosa
    fb = librosa.filters.mel(sr=audio.SR, n_fft=audio.N_FFT, n_mels=audio.N_MELS)
    refs = {}
    for name, y in reference_signals().items():
        p, _ = det.window_probs(y.astype(np.float32))
        x = torch.tensor(y[None].astype(np.float32))
        feat = det.front(x)
        logmel = feat[0, 0].numpy()
        with torch.no_grad():
            logit = float(model((feat - det.norm["mean"]) / det.norm["std"])[0])
        refs[name] = {"prob": float(p[0]), "logit": logit, "logmel_mean": float(logmel.mean()), "logmel_std": float(logmel.std()), "frames": int(logmel.shape[1])}

    out = {
        "name": "drone_audio_v0",
        "about": "Log-mel CNN drone detector trained on DADS (benchmarks/train/train_audio.py). Input: 1 s of 16 kHz mono audio.",
        "weights_file": a.weights, "weights_sha256": sha256_file(wpath),
        "frontend": {"sr": audio.SR, "n_fft": audio.N_FFT, "hop": audio.HOP, "n_mels": audio.N_MELS, "window_s": audio.WIN_S,
                     "log_eps": 1e-6, "norm_mean": float(det.norm["mean"]), "norm_std": float(det.norm["std"]),
                     "mel_fb": b64(fb.astype(np.float32)), "mel_fb_shape": list(fb.shape)},
        "conv": layers,
        "linear": {"w": b64(lin.weight.detach().numpy()[0]), "b": float(lin.bias.detach().numpy()[0])},
        "reference": refs,
    }
    dest = ROOT / a.out
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out))
    print(f"wrote {dest.relative_to(ROOT)} ({dest.stat().st_size // 1024} KB)")
    for k, v in refs.items():
        print(f"  reference {k:10s} p={v['prob']:.4f} logmel mean {v['logmel_mean']:.3f}")


if __name__ == "__main__":
    main()
