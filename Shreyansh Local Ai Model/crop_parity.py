"""Check that the browser crop (skysentry_classifier.js) gives the same pixels as crops.cut (PIL).

    python3 crop_parity.py          # needs node; runs crop_parity.mjs for the JS side

Cuts the same boxes from the same synthetic camera frame in Python and in JavaScript and prints the
mean absolute pixel difference (0..255 scale) for each box. Also prints two comparisons that explain
WHY the JS copies Pillow exactly instead of letting the browser resize:
  - "plain bilinear": the resize most graphics code does (no antialiasing when shrinking)
  - "train.py view":  what train.py actually feeds the model (80 px stored crop -> centre_view)
"""
import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from crops import INPUT, STORE, STORE_SCALE, cut, square_for_box  # noqa: E402

W, H = 640, 480
BOXES = {  # normalised x, y, w, h (like the tracker gives)
    "big box (420 px square -> 64, downscale)": (0.30, 0.25, 0.4688, 0.40),
    "tiny box (32 px square -> 64, upscale)": (0.52, 0.41, 0.0125, 0.0146),
    "big box at frame edge (edge padding)": (0.80, 0.70, 0.20, 0.30),
    "tiny box in corner (edge padding)": (0.0, 0.0, 0.01, 0.0125),
    "medium box (64 px square, no resize)": (0.20, 0.60, 0.0714, 0.06),
}


def random_boxes(n=300):
    """Random boxes on whole pixels; odd sizes put the square's corner on exactly .5, which tests that
    the JS rounds like Python (round half to even) and lands on the same pixel."""
    rng = np.random.default_rng(7)
    out = []
    for _ in range(n):
        w, h = int(rng.integers(1, 400)), int(rng.integers(1, 300))
        x, y = int(rng.integers(0, W - min(w, W - 1))), int(rng.integers(0, H - min(h, H - 1)))
        out.append((x / W, y / H, min(w, W - x) / W, min(h, H - y) / H))
    return out


def synthetic_frame():
    """A sky gradient with fine stripes (worst case for aliasing), a few dark 'birds' and noise."""
    rng = np.random.default_rng(42)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    img = np.stack([120 + yy / 6, 160 + yy / 8, 230 - yy / 10], -1)
    img += 25 * (np.sin(xx / 1.7 + yy / 3.1) > 0)[..., None]       # stripes ~2-5 px wide
    for _ in range(12):
        cx, cy, r = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(2, 30)
        img *= 1 - 0.7 * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))[..., None]
    img += rng.normal(0, 6, img.shape)
    return np.clip(np.round(img), 0, 255).astype(np.uint8)


def square(box, scale=1.0):
    x, y, w, h = box
    return square_for_box((x + w / 2) * W, (y + h / 2) * H, w * W, h * H, scale)  # same maths as the JS


def plain_bilinear(img, cx, cy, side):
    """Edge-padded square resized with ordinary bilinear (no antialias), for comparison only."""
    x0, y0, s = int(round(cx - side / 2)), int(round(cy - side / 2)), max(int(round(side)), 1)
    ys = np.clip(np.arange(y0, y0 + s), 0, H - 1)
    xs = np.clip(np.arange(x0, x0 + s), 0, W - 1)
    sq = torch.tensor(img[ys][:, xs], dtype=torch.float32).permute(2, 0, 1)[None]
    out = F.interpolate(sq, size=(INPUT, INPUT), mode="bilinear", align_corners=False, antialias=False)
    return out[0].permute(1, 2, 0).round().clamp(0, 255).numpy()


def train_view(img_pil, box):
    """What train.py feeds the model: prepare_data.py's 80 px stored crop, then train.py's centre_view()."""
    stored = cut(img_pil, *square(box, STORE_SCALE), STORE)
    x = torch.tensor(stored, dtype=torch.float32).permute(2, 0, 1)[None] / 255
    theta = torch.zeros(1, 2, 3)
    theta[:, 0, 0] = theta[:, 1, 1] = 1 / STORE_SCALE
    grid = F.affine_grid(theta, (1, 3, INPUT, INPUT), align_corners=False)
    y = F.grid_sample(x, grid, mode="bilinear", padding_mode="border", align_corners=False)
    return (y[0].permute(1, 2, 0) * 255).numpy()


def main():
    img = synthetic_frame()
    pil = Image.fromarray(img)
    with tempfile.TemporaryDirectory() as tmp:
        inp, out = Path(tmp) / "in.json", Path(tmp) / "out.json"
        boxes = [dict(zip("xywh", b)) for b in list(BOXES.values()) + random_boxes()]
        inp.write_text(json.dumps({"width": W, "height": H, "rgb_b64": base64.b64encode(img.tobytes()).decode(), "boxes": boxes}))
        subprocess.run(["node", str(HERE / "crop_parity.mjs"), str(inp), str(out)], check=True)
        js = json.loads(out.read_text())

    def dec(b64):
        return np.frombuffer(base64.b64decode(b64), np.uint8).reshape(INPUT, INPUT, 3).astype(np.float64)

    print("Mean |difference| in pixel values (0..255); max in brackets.")
    print(f"{'box':44s} {'JS vs crops.cut':>16s} {'plain bilinear':>16s} {'JS train vs train.py':>21s} {'train.py vs crops.cut':>22s}")
    worst = 0.0
    for i, (name, box) in enumerate(BOXES.items()):
        ref = cut(pil, *square(box), INPUT).astype(np.float64)
        live = dec(js["live"][i])
        tv = train_view(pil, box)
        cols = [(live, ref), (plain_bilinear(img, *square(box)), ref), (dec(js["train"][i]), tv), (tv, ref)]
        cells = [f"{np.abs(a - b).mean():6.2f} [{np.abs(a - b).max():3.0f}]" for a, b in cols]
        worst = max(worst, np.abs(live - ref).max())
        print(f"{name:44s} {cells[0]:>16s} {cells[1]:>16s} {cells[2]:>21s} {cells[3]:>22s}")
    rand = random_boxes()
    diffs = [np.abs(dec(js["live"][len(BOXES) + i]) - cut(pil, *square(b), INPUT)).max() for i, b in enumerate(rand)]
    print(f"{len(rand)} random boxes (1..400 px): JS vs crops.cut max |difference| {max(diffs):.0f}, "
          f"{sum(d > 0 for d in diffs)} boxes differ")
    worst = max(worst, max(diffs))
    print("PASS: JS crop is pixel-identical to crops.cut" if worst == 0 else f"FAIL: JS crop differs from crops.cut (max {worst:.0f})")
    sys.exit(0 if worst == 0 else 1)


if __name__ == "__main__":
    main()
