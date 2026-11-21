"""Shared crop rules for the SkySentry bird / drone / other classifier.

The same rule is used in three places so training matches what the live app sees:
  - prepare_data.py (cutting training crops from the Mendeley images)
  - evaluate.py     (cutting test crops)
  - skysentry_classifier.js (cutting crops from live camera frames around a tracker box)

Rule: a square centred on the box, side = max(CONTEXT * longest box side, MIN_SIDE) pixels,
resized to INPUT x INPUT. Parts of the square outside the frame are filled with the edge pixels.
"""
import numpy as np
from PIL import Image

INPUT = 64          # model input size (pixels)
CONTEXT = 1.4       # square side = 1.4 x the longest side of the box (a little sky around the object)
MIN_SIDE = 32       # tiny objects still get a 32 px square, so the model sees some context
STORE = 80          # training crops are stored larger (more context) so they can be jittered
STORE_SCALE = 1.6   # stored square = STORE_SCALE x the live square; the centre 1/1.6 is the live crop
CLASSES = ["bird", "drone", "other"]


def square_for_box(cx, cy, bw, bh, scale=1.0):
    """Centre and side (pixels) of the live crop square for a box, optionally scaled."""
    side = max(CONTEXT * max(bw, bh), MIN_SIDE) * scale
    return cx, cy, side


def cut(img, cx, cy, side, out):
    """Cut a square from a PIL image (edge-padded) and resize it to out x out. Returns uint8 HxWx3."""
    w, h = img.size
    x0, y0 = int(round(cx - side / 2)), int(round(cy - side / 2))
    s = max(int(round(side)), 1)
    pad = max(0, -x0, -y0, x0 + s - w, y0 + s - h)
    if pad:
        arr = np.pad(np.asarray(img), ((pad, pad), (pad, pad), (0, 0)), mode="edge")
        img = Image.fromarray(arr)
        x0, y0 = x0 + pad, y0 + pad
    return np.asarray(img.crop((x0, y0, x0 + s, y0 + s)).resize((out, out), Image.BILINEAR), dtype=np.uint8)
