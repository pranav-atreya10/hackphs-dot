"""Export the drone-audio CNN to ONNX (open standard; runs in onnxruntime on servers, phones and browsers).

    .venv/bin/python benchmarks/export_audio_onnx.py --json VIVAN/detection/models/drone_audio_v1.json

Source of truth is the portable JSON written by export_audio_web.py (batch-norm already folded in), so the ONNX
file and the browser model are the same numbers. Writes next to the JSON:
  <name>.onnx        input "logmel" float32 [batch, 1, 64, frames] (already normalised), output "prob" [batch]
  <name>.card.json   everything needed to feed it: the log-mel front end settings, normalisation, threshold,
                     the SHA-256 of both files, and reference outputs to check a new runtime against
The log-mel step stays outside the network (it's 15 lines in any language; tests.js and audio_model.js do it in JS).
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench.audio import MelFrontend, windows  # noqa: E402
from bench.common import ROOT  # noqa: E402
from eval_audio_holdout import load_model  # noqa: E402  (also verifies the JSON against its reference outputs)
from export_audio_web import reference_signals  # noqa: E402


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def main():
    import torch
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", required=True)
    a = ap.parse_args()
    src = ROOT / a.json
    d = json.loads(src.read_text())
    load_model(src)  # asserts the JSON reproduces its stored reference outputs

    # Rebuild the folded network as a torch module (same code path as the loader) and trace it.
    import base64
    import torch.nn as nn
    f = lambda s: np.frombuffer(base64.b64decode(s), dtype="<f4")  # noqa: E731
    layers = []
    for c in d["conv"]:
        conv = nn.Conv2d(c["in"], c["out"], 3, padding=1)
        conv.weight.data = torch.tensor(f(c["w"]).reshape(c["out"], c["in"], 3, 3).copy())
        conv.bias.data = torch.tensor(f(c["b"]).copy())
        layers += [conv, nn.ReLU(), nn.MaxPool2d(2)]
    lin = nn.Linear(64, 1)
    lin.weight.data = torch.tensor(f(d["linear"]["w"]).reshape(1, 64).copy())
    lin.bias.data = torch.tensor([float(d["linear"]["b"])])

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.body = nn.Sequential(*layers, nn.AdaptiveAvgPool2d(1), nn.Flatten(), lin)

        def forward(self, logmel):
            return torch.sigmoid(self.body(logmel)).reshape(-1)

    net = Net().eval()
    front = MelFrontend("cpu")
    norm = (d["frontend"]["norm_mean"], d["frontend"]["norm_std"])
    feats = {name: ((front(torch.tensor(windows(y.astype(np.float32))[0][:1])) - norm[0]) / norm[1]) for name, y in reference_signals().items()}
    example = next(iter(feats.values()))
    onnx_path = src.with_suffix(".onnx")
    torch.onnx.export(net, (example,), str(onnx_path), input_names=["logmel"], output_names=["prob"],
                      dynamic_axes={"logmel": {0: "batch", 3: "frames"}, "prob": {0: "batch"}}, opset_version=17, dynamo=False)

    import onnxruntime as ort
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    refs = {}
    for name, x in feats.items():
        got = float(sess.run(None, {"logmel": x.numpy()})[0][0])
        want = d["reference"][name]["prob"]
        assert abs(got - want) < 1e-3, f"ONNX mismatch on {name}: {got} vs {want}"
        refs[name] = {"prob": round(got, 6)}

    card = {
        "name": d["name"], "format": "onnx", "opset": 17,
        "files": {"onnx": onnx_path.name, "onnx_sha256": sha(onnx_path), "json": src.name, "json_sha256": sha(src)},
        "task": "Is there a drone sound in this 1 s of audio? Output: probability 0..1.",
        "input": {"name": "logmel", "shape": ["batch", 1, d["frontend"]["n_mels"], "frames (101 for 1 s)"], "dtype": "float32",
                  "how_to_make_it": ("mono audio at sr Hz, 1 s window; STFT with n_fft, hop, periodic Hann window, centred (reflect pad); "
                                     "power spectrum; multiply by the mel filterbank (in the JSON, 'mel_fb'); natural log of (mel + log_eps); "
                                     "then (x - norm_mean) / norm_std"),
                  "frontend": {k: v for k, v in d["frontend"].items() if k != "mel_fb"}},
        "output": {"name": "prob", "threshold": 0.5, "decision": "a clip is 'drone' if any 1 s window (0.5 s hop) reaches the threshold"},
        "trained_from": d.get("weights_file"), "trained_weights_sha256": d.get("weights_sha256"),
        "reference_outputs": refs,
        "license_note": "Trained on DADS (Hugging Face geronimobasso/drone-audio-detection-samples); check its license before redistributing.",
    }
    card_path = src.with_name(src.stem + ".card.json")
    card_path.write_text(json.dumps(card, indent=1))
    print(f"wrote {onnx_path.relative_to(ROOT)} ({onnx_path.stat().st_size // 1024} KB) and {card_path.relative_to(ROOT)}; ONNX matches the JSON on all reference signals")


if __name__ == "__main__":
    main()
