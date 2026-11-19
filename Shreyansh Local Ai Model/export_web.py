"""Export a trained SkyNetLite (bird / drone / other) for the browser (pure JavaScript, no ML library).

    python3 export_web.py --checkpoint runs/best.pt --out skysentry_classifier.json

Writes one JSON file that skysentry_classifier.js loads:
  - the crop rule and input normalisation, read straight from crops.py and model.py so they cannot drift
  - the 7 conv layers with batch-norm folded in (conv -> BN -> ReLU becomes conv' + bias -> ReLU)
  - the final linear layer
  - reference outputs on 3 fixed test crops, so the JS port can prove it gives the same answers as PyTorch

All numbers are float32, little-endian, base64-encoded (the same style as benchmarks/export_audio_web.py).
Conv weights keep PyTorch's order: [out channel][in channel][ky][kx].
"""

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from crops import CLASSES, CONTEXT, INPUT, MIN_SIDE  # noqa: E402
from model import LAYERS, MEAN, STD, SkyNetLite  # noqa: E402

VERSION = 1
REFERENCE_SEED = 20261119


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype="<f4").tobytes()).decode()


def load_model(path):
    """Accept either {"model": state_dict, ...} (a training checkpoint) or a bare state_dict."""
    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    state = ckpt["model"] if isinstance(ckpt, dict) and "model" in ckpt else ckpt
    model = SkyNetLite(n_classes=len(CLASSES))
    model.load_state_dict(state)
    return model.eval()


def fold_layers(model):
    """Fold each BatchNorm into the conv before it.

    In inference mode BN does y = (x - running_mean) / sqrt(running_var + eps) * gamma + beta for each
    channel. That is just "multiply by a number, then add a number", so we can multiply the conv's weights
    by scale = gamma / sqrt(var + eps) and give the conv a bias of beta - mean * scale. Same answer, less work.
    """
    convs = [m for m in model.features if isinstance(m, nn.Conv2d)]
    bns = [m for m in model.features if isinstance(m, nn.BatchNorm2d)]
    assert len(convs) == len(bns) == len(LAYERS)
    folded = []
    for (name, cin, cout, stride, pool), conv, bn in zip(LAYERS, convs, bns):
        scale = bn.weight.detach() / torch.sqrt(bn.running_var + bn.eps)
        w = conv.weight.detach() * scale[:, None, None, None]
        b = bn.bias.detach() - bn.running_mean * scale
        assert tuple(w.shape) == (cout, cin, 3, 3) and conv.stride == (stride, stride)
        folded.append({"name": name, "cin": cin, "cout": cout, "stride": stride, "pool": pool, "w": w, "b": b})
    return folded


def folded_forward(folded, fc, x):
    """The network written the way the JS runs it (folded conv -> ReLU -> maybe pool), used as a self-check."""
    for L in folded:
        x = F.relu(F.conv2d(x, L["w"], L["b"], stride=L["stride"], padding=1))
        if L["pool"]:
            x = F.max_pool2d(x, 2)
    return fc(x.mean(dim=(2, 3)))


def reference_crops():
    """Three fixed 64x64 RGB test crops (seeded, so they are the same every export).

    Not pure noise: a smooth sky-like gradient, a dark blob (object) in the middle, plus some noise,
    so the network's activations look a bit like real inputs.
    """
    rng = np.random.default_rng(REFERENCE_SEED)
    yy, xx = np.mgrid[0:INPUT, 0:INPUT].astype(np.float32)
    crops = []
    for i in range(3):
        sky = rng.uniform(90, 220, size=3)[None, None, :] + (yy[..., None] - 32) * rng.uniform(-1.5, 1.5, size=3)
        r = rng.uniform(4, 14)
        cx, cy = 32 + rng.uniform(-6, 6), 32 + rng.uniform(-6, 6)
        blob = np.exp(-(((xx - cx) ** 2 + ((yy - cy) * rng.uniform(0.5, 2)) ** 2) / (2 * r * r)))[..., None]
        img = sky * (1 - blob) + rng.uniform(10, 90, size=3) * blob + rng.normal(0, 8 + 6 * i, size=(INPUT, INPUT, 3))
        crops.append(np.clip(np.round(img), 0, 255).astype(np.uint8))
    return crops


def to_tensor(crops):
    """uint8 HxWx3 crops -> normalised float tensor N x 3 x 64 x 64, exactly like training (value/255, then MEAN/STD)."""
    x = torch.tensor(np.stack(crops), dtype=torch.float32).permute(0, 3, 1, 2) / 255.0
    return (x - torch.tensor(MEAN)[None, :, None, None]) / torch.tensor(STD)[None, :, None, None]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--checkpoint", required=True, help="SkyNetLite .pt (state_dict, or a dict with key 'model')")
    ap.add_argument("--out", default="skysentry_classifier.json")
    a = ap.parse_args()

    model = load_model(a.checkpoint)
    folded = fold_layers(model)

    # Reference answers come from the ORIGINAL PyTorch model (BN not folded), so the JS test checks
    # both the folding and the JS maths in one go.
    crops = reference_crops()
    x = to_tensor(crops)
    with torch.no_grad():
        logits = model(x)
        check = folded_forward(folded, model.fc, x)
    fold_err = float((logits - check).abs().max())
    if fold_err > 1e-4:
        raise SystemExit(f"BN folding self-check failed: max logit difference {fold_err:.2e}")

    out = {
        "version": VERSION,
        "about": "SkyNetLite bird/drone/other crop classifier, exported by export_web.py for skysentry_classifier.js.",
        "checkpoint": Path(a.checkpoint).name,
        "checkpoint_sha256": hashlib.sha256(Path(a.checkpoint).read_bytes()).hexdigest(),
        "classes": CLASSES,
        "input": INPUT,
        "mean": MEAN,
        "std": STD,
        "crop": {"context": CONTEXT, "min_side": MIN_SIDE},
        "weight_layout": "cout,cin,ky,kx (float32 little-endian, base64)",
        "layers": [{"name": L["name"], "cin": L["cin"], "cout": L["cout"], "stride": L["stride"], "pool": L["pool"],
                    "weight_b64": b64(L["w"].numpy()), "bias_b64": b64(L["b"].numpy())} for L in folded],
        "fc": {"weight_b64": b64(model.fc.weight.detach().numpy()), "bias_b64": b64(model.fc.bias.detach().numpy())},
        "reference": {
            "about": "64x64 RGB uint8 crops (row-major, 3 bytes per pixel) and the PyTorch logits for each.",
            "inputs": [base64.b64encode(c.tobytes()).decode() for c in crops],
            "logits": [[float(v) for v in row] for row in logits.numpy()],
        },
    }
    dest = Path(a.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out))
    print(f"wrote {dest} ({dest.stat().st_size // 1024} KB), BN folding self-check max diff {fold_err:.1e}")
    for i, row in enumerate(logits.numpy()):
        print(f"  reference {i}: logits {np.array2string(row, precision=4)}")


if __name__ == "__main__":
    main()
