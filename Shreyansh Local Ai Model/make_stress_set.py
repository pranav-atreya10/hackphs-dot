"""Build a SYNTHETIC flock stress set: many small pasted birds (and some drones) in one sky.

    python3 make_stress_set.py                 # writes data/stress_flocks/ (about 60 scenes)
    python3 make_stress_set.py --per-type 5    # smaller set for a quick try

What it makes (all at 1280x720, PNG):
  dense           50-60 birds, 10-40 px, in one flock. No drones.
  mixed           30-60 birds in a flock + 1-3 drones somewhere else in the sky.
  drone_in_flock  30-60 birds + 1-2 drones placed INSIDE the flock's area.
  tiny            50-60 birds at 3-8 px (far away); half the scenes also have one 4-10 px drone in the flock.
Some birds get a straight-line motion blur (fast flight); more of them in the tiny scenes.

Where the pieces come from: ONLY the Mendeley VALID split (data/mendeley/Dataset/valid). The test split is
never opened (the script refuses any path with a "test" folder in it). The class comes from the file
name (BV* = bird, DV* = drone), not the YOLO class id. Polygon labels become boxes by min/max, and the
polygon itself is used as the cut-out shape. By default only polygon-labelled objects are pasted
(~430 birds, ~390 drones); --allow-box-labels also uses box-only labels with an ellipse-shaped cut-out.

HOW CRUDE THIS IS (read before trusting any number from it):
  - Each object is cut from its photo with a soft feathered edge and alpha-blended onto another sky.
    Lighting, colour, noise and blur do not match the new background, and the feathered edge (and any
    sloppy polygon) carries a thin rim of the original photo's background with it. A model could learn to spot "pasted" edges.
  - Big objects (median ~50% of a 640 px photo) are shrunk to a few-to-40 px. Real far-away birds look
    different from shrunk close-up photos (atmospheric haze, sensor noise, compression).
  - The motion blur is a simple straight-line smear, not real camera blur.
  - The valid split is NOT independent: prepare_data.py cuts valid.npz from it and train.py picks the
    best epoch on valid.npz, and make_split.py found that most valid images are near-duplicates of FROZEN
    TEST images (valid_excluded.json lists 1,677 of 1,740 within pHash Hamming 12). So the pasted objects
    are close cousins of test objects. NEVER train on data/stress_flocks or crops cut from it (that would
    leak the test set into training). This is a stress test of the crop + classifier pipeline under
    crowding, not independent evidence of accuracy. Frozen-test-split results stay the only honest number.

Output: data/stress_flocks/images/*.png and data/stress_flocks/manifest.json, which lists every pasted
object's box [x1, y1, x2, y2] in pixels, its class, its source photo and box, the cut-out shape, any
motion blur, a rough visible fraction (how much of its box is not covered by objects pasted after it),
the fixed seed, and the sha256 of every generated image.
"""
import argparse
import hashlib
import json
import math
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "data" / "mendeley" / "Dataset" / "valid"
OUT = REPO / "data" / "stress_flocks"
SEED = 20261119
CANVAS = (1280, 720)
TYPES = ["dense", "mixed", "drone_in_flock", "tiny"]


def refuse_test(path):
    parts = [p.lower() for p in Path(path).resolve().parts]
    if "test" in parts:
        raise SystemExit(f"refusing to read from the test split: {path}")


# ---------------------------------------------------------------- source objects (valid split only)

def read_objects(label_path, w, h):
    """[(box(x1,y1,x2,y2) px, polygon [(x,y),...] px or None)], duplicates (IoU >= 0.5) removed."""
    objs = []
    for line in Path(label_path).read_text().split("\n"):
        v = line.split()
        if len(v) < 5:
            continue
        nums = [float(t) for t in v[1:]]
        if len(nums) == 4:
            cx, cy, bw, bh = nums
            x1, y1, x2, y2 = cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2
            poly = None
        else:
            xs, ys = nums[0::2], nums[1::2]
            x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
            poly = [(x * w, y * h) for x, y in zip(xs, ys)]
        box = (max(x1, 0) * w, max(y1, 0) * h, min(x2, 1) * w, min(y2, 1) * h)
        if box[2] - box[0] >= 2 and box[3] - box[1] >= 2:
            objs.append((box, poly))
    kept = []
    for o in sorted(objs, key=lambda o: -(o[0][2] - o[0][0]) * (o[0][3] - o[0][1])):
        if all(iou(o[0], k[0]) < 0.5 for k in kept):
            kept.append(o)
    return kept


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def build_pool(polygons_only=True):
    refuse_test(SRC)
    img_dir, lab_dir = SRC / "images", SRC / "labels"
    pool = {"bird": [], "drone": []}
    images = []
    for p in sorted(img_dir.iterdir()):
        name = p.name
        cls = "bird" if name.startswith("B") else "drone" if name.startswith("D") else None
        lab = lab_dir / (p.stem + ".txt")
        if cls is None or not lab.exists():
            continue
        with Image.open(p) as im:
            w, h = im.size
        objs = read_objects(lab, w, h)
        images.append((p, w, h, [o[0] for o in objs]))
        for box, poly in objs:
            if polygons_only and not poly:
                continue  # box-only labels would need an ellipse cut-out that drags its photo background along
            if min(box[2] - box[0], box[3] - box[1]) >= 12:  # big enough to cut out cleanly
                pool[cls].append({"file": p, "box": box, "poly": poly})
    return pool, images


@lru_cache(maxsize=256)
def load_rgb(path):
    refuse_test(path)
    with Image.open(path) as im:
        return im.convert("RGB")


# ---------------------------------------------------------------- backgrounds

def texture(arr):
    g = arr.astype(np.float32).mean(axis=2)
    return float(np.abs(np.diff(g, axis=0)).mean() + np.abs(np.diff(g, axis=1)).mean())


def empty_regions(images, rng, n_try=500, keep=40):
    """Object-free strips of valid images (above/below/left/right of every labelled box, 12 px margin),
    at least 200 px on the short side, ranked by how smooth they are (sky-like). Regions with any small
    dark/bright spot (an unlabelled bird, a wire, a leaf) are skipped. Returns the smoothest."""
    cands = []
    idx = rng.permutation(len(images))[:n_try]
    for i in idx:
        p, w, h, boxes = images[i]
        if not boxes:
            continue
        m = 30
        ux1 = max(0, min(b[0] for b in boxes) - m); uy1 = max(0, min(b[1] for b in boxes) - m)
        ux2 = min(w, max(b[2] for b in boxes) + m); uy2 = min(h, max(b[3] for b in boxes) + m)
        strips = [(0, 0, w, uy1), (0, uy2, w, h), (0, 0, ux1, h), (ux2, 0, w, h)]
        best = max(strips, key=lambda s: (s[2] - s[0]) * (s[3] - s[1]))
        sw, sh = best[2] - best[0], best[3] - best[1]
        if min(sw, sh) < 200 or max(sw, sh) / max(1, min(sw, sh)) > 3.2:
            continue
        region = tuple(int(round(v)) for v in best)
        crop = load_rgb(p).crop(region)
        arr = np.asarray(crop.resize((160, 90)))
        g = crop.convert("L").resize((320, 180))
        dev = np.abs(np.asarray(g, np.float32) - np.asarray(g.filter(ImageFilter.GaussianBlur(8)), np.float32))
        if dev[4:-4, 4:-4].max() > 30:  # something small sticks out of the smooth sky
            continue
        cands.append((texture(arr), str(p), region))
    cands.sort()
    return cands[:keep]


def cover_resize(img, size):
    W, H = size
    s = max(W / img.width, H / img.height)
    img = img.resize((max(W, int(math.ceil(img.width * s))), max(H, int(math.ceil(img.height * s)))), Image.BICUBIC)
    x0, y0 = (img.width - W) // 2, (img.height - H) // 2
    return img.crop((x0, y0, x0 + W, y0 + H))


def gradient_sky(rng, size):
    W, H = size
    palettes = [((112, 160, 222), (196, 220, 244)), ((150, 178, 210), (222, 230, 238)),
                ((170, 175, 182), (215, 217, 220)), ((92, 140, 210), (176, 206, 238)), ((200, 190, 180), (236, 226, 214))]
    top, bot = palettes[rng.integers(len(palettes))]
    f = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    sky = np.array(top, np.float32) * (1 - f) + np.array(bot, np.float32) * f
    sky = np.broadcast_to(sky, (H, W, 3)).copy()
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    for _ in range(rng.integers(0, 4)):  # a few soft, faint clouds
        cx, cy, r = rng.uniform(0, W), rng.uniform(0, H * 0.8), rng.uniform(80, 260)
        d2 = ((xx - cx) ** 2 + ((yy - cy) * 1.8) ** 2) / (r * r)
        sky += (np.clip(1 - d2, 0, 1) ** 2 * rng.uniform(10, 28))[..., None]
    sky += rng.normal(0, 2.0, sky.shape)
    return Image.fromarray(np.clip(sky, 0, 255).astype(np.uint8))


# ---------------------------------------------------------------- cut-outs

def make_cutout(obj, long_px, blur=None):
    """Cut the object out of its photo, scale its box's long side to long_px, return (rgb float HxWx3,
    alpha float HxW, (ox1, oy1, ox2, oy2) = object box inside the patch, mask kind)."""
    img = load_rgb(obj["file"])
    x1, y1, x2, y2 = obj["box"]
    bw, bh = x2 - x1, y2 - y1
    pad = 0.15 * max(bw, bh) + 2
    px1, py1 = int(math.floor(x1 - pad)), int(math.floor(y1 - pad))
    px2, py2 = int(math.ceil(x2 + pad)), int(math.ceil(y2 + pad))
    patch = img.crop((px1, py1, px2, py2))  # PIL fills outside the photo with black; alpha is 0 there anyway
    mask = Image.new("L", patch.size, 0)
    dr = ImageDraw.Draw(mask)
    if obj["poly"]:
        dr.polygon([(x - px1, y - py1) for x, y in obj["poly"]], fill=255)
        kind = "polygon"
    else:
        ex, ey = bw * 0.05, bh * 0.05
        dr.ellipse((x1 - px1 - ex, y1 - py1 - ey, x2 - px1 + ex, y2 - py1 + ey), fill=255)
        kind = "ellipse"
    feather = max(1.0, 0.04 * max(bw, bh))
    mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(feather))
    s = long_px / max(bw, bh)
    nw, nh = max(1, int(round(patch.width * s))), max(1, int(round(patch.height * s)))
    rgb = np.asarray(patch.resize((nw, nh), Image.LANCZOS), np.float32)
    a = np.asarray(mask.resize((nw, nh), Image.LANCZOS), np.float32) / 255.0
    obox = [(x1 - px1) * s, (y1 - py1) * s, (x2 - px1) * s, (y2 - py1) * s]
    if blur:
        rgb, a, obox = motion_blur(rgb, a, obox, blur["length_px"], blur["angle_deg"])
    return rgb, a, obox, kind


def motion_blur(rgb, a, obox, length, angle_deg):
    """Straight-line smear: average of shifted copies along the flight direction (premultiplied alpha).
    The object box grows by the smear so it covers the whole streak, like a tracker blob would."""
    dx, dy = math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg))
    m = int(math.ceil(length / 2)) + 1
    H, W = a.shape
    big_a = np.zeros((H + 2 * m, W + 2 * m), np.float32)
    big_c = np.zeros((H + 2 * m, W + 2 * m, 3), np.float32)
    k = max(3, int(round(length)) + 1)
    for i in range(k):
        t = (i / (k - 1) - 0.5) * length
        ox, oy = int(round(m + t * dx)), int(round(m + t * dy))
        big_a[oy:oy + H, ox:ox + W] += a / k
        big_c[oy:oy + H, ox:ox + W] += rgb * a[..., None] / k
    rgb_out = big_c / np.maximum(big_a[..., None], 1e-6)
    ex, ey = abs(dx) * length / 2, abs(dy) * length / 2
    obox = [obox[0] + m - ex, obox[1] + m - ey, obox[2] + m + ex, obox[3] + m + ey]
    return rgb_out, big_a, obox


def paste(canvas, rgb, a, x0, y0):
    """Alpha-blend patch onto canvas (float HxWx3) with its top-left at integer (x0, y0); clipped to the canvas."""
    H, W = canvas.shape[:2]
    h, w = a.shape
    cx1, cy1, cx2, cy2 = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    if cx1 >= cx2 or cy1 >= cy2:
        return
    sa = a[cy1 - y0:cy2 - y0, cx1 - x0:cx2 - x0, None]
    canvas[cy1:cy2, cx1:cx2] = canvas[cy1:cy2, cx1:cx2] * (1 - sa) + rgb[cy1 - y0:cy2 - y0, cx1 - x0:cx2 - x0] * sa


# ---------------------------------------------------------------- scene layout

def log_uniform(rng, lo, hi):
    return float(math.exp(rng.uniform(math.log(lo), math.log(hi))))


def place_in_ellipse(rng, n, sizes, cx, cy, rx, ry, min_frac=0.6, avoid=()):
    """Centres inside the ellipse; two objects keep min_frac x their mean size apart (some touching is fine)."""
    pts = []
    for i in range(n):
        for attempt in range(400):
            ang, rad = rng.uniform(0, 2 * math.pi), math.sqrt(rng.uniform(0, 1))
            x, y = cx + rx * rad * math.cos(ang), cy + ry * rad * math.sin(ang)
            relax = 1.0 if attempt < 200 else 0.6
            ok = all(math.hypot(x - px, y - py) >= min_frac * relax * (sizes[i] + ps) / 2 for px, py, ps in pts)
            ok = ok and all(math.hypot(x - ax, y - ay) >= (sizes[i] + asz) / 2 + 2 for ax, ay, asz in avoid)
            if ok:
                break
        pts.append((x, y, sizes[i]))
    return [(x, y) for x, y, _ in pts]


def plan_scene(rng, kind):
    """Returns list of (cls, centre_x, centre_y, long_px, blur or None), in paste order."""
    W, H = CANVAS
    tiny = kind == "tiny"
    n_birds = int(rng.integers(50, 61)) if kind in ("dense", "tiny") else int(rng.integers(30, 61))
    bsizes = [log_uniform(rng, 3, 8) if tiny else log_uniform(rng, 10, 40) for _ in range(n_birds)]
    mean = float(np.mean(bsizes))
    # flock area: a square of 1.6-3 bird-sizes per bird (dense; neighbours often inside each other's crop)
    area = n_birds * (rng.uniform(1.6, 3.0) * mean) ** 2
    aspect = rng.uniform(1.2, 2.6)
    rx, ry = math.sqrt(area * aspect / math.pi), math.sqrt(area / aspect / math.pi)
    rx, ry = min(rx, W * 0.42), min(ry, H * 0.42)
    cx, cy = rng.uniform(rx + 20, W - rx - 20), rng.uniform(ry + 20, H - ry - 20)

    drones = []
    if kind == "mixed":
        for _ in range(int(rng.integers(1, 4))):
            s = log_uniform(rng, 12, 40)
            for _ in range(500):  # outside the flock ellipse (with a margin) and away from other drones
                x, y = rng.uniform(s, W - s), rng.uniform(s, H - s)
                if ((x - cx) / (rx + 2 * s)) ** 2 + ((y - cy) / (ry + 2 * s)) ** 2 > 1 and \
                        all(math.hypot(x - d[1], y - d[2]) > 2 * s for d in drones):
                    break
            drones.append(("drone", x, y, s))
    elif kind == "drone_in_flock" or (tiny and rng.uniform() < 0.5):
        nd = int(rng.integers(1, 3)) if kind == "drone_in_flock" else 1
        for _ in range(nd):
            s = log_uniform(rng, 4, 10) if tiny else log_uniform(rng, 12, 40)
            for _ in range(500):  # inside the inner 60% of the flock ellipse
                ang, rad = rng.uniform(0, 2 * math.pi), 0.6 * math.sqrt(rng.uniform(0, 1))
                x, y = cx + rx * rad * math.cos(ang), cy + ry * rad * math.sin(ang)
                if all(math.hypot(x - d[1], y - d[2]) > 2 * s for d in drones):
                    break
            drones.append(("drone", x, y, s))

    centres = place_in_ellipse(rng, n_birds, bsizes, cx, cy, rx, ry, avoid=[(d[1], d[2], d[3]) for d in drones])
    blur_p = 0.4 if tiny else 0.25
    objs = []
    for (x, y), s in zip(centres, bsizes):
        blur = None
        if rng.uniform() < blur_p:  # fast flight: smear 0.6-1.5x the bird's size, at least 3 px
            blur = {"length_px": round(max(3.0, s * rng.uniform(0.6, 1.5)), 1), "angle_deg": round(float(rng.uniform(0, 180)), 1)}
        objs.append(("bird", x, y, s, blur))
    objs += [(c, x, y, s, None) for c, x, y, s in drones]  # drones last, so no bird covers them
    flock = {"cx": round(cx, 1), "cy": round(cy, 1), "rx": round(rx, 1), "ry": round(ry, 1)}
    return objs, flock


def render_scene(rng, kind, pool, bg_regions):
    W, H = CANVAS
    if rng.uniform() < 0.5 and bg_regions:
        _, path, region = bg_regions[int(rng.integers(len(bg_regions)))]
        bg = cover_resize(load_rgb(Path(path)).crop(region), CANVAS)
        background = {"kind": "valid_image_region", "source_file": Path(path).name, "region": list(region)}
    else:
        bg = gradient_sky(rng, CANVAS)
        background = {"kind": "gradient_sky"}
    canvas = np.asarray(bg, np.float32).copy()
    plan, flock = plan_scene(rng, kind)
    placed = []
    for cls, x, y, s, blur in plan:
        src = pool[cls][int(rng.integers(len(pool[cls])))]
        rgb, a, ob, mkind = make_cutout(src, s, blur)
        ocx, ocy = (ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2
        x0, y0 = int(round(x - ocx)), int(round(y - ocy))
        paste(canvas, rgb, a, x0, y0)
        box = [max(0.0, x0 + ob[0]), max(0.0, y0 + ob[1]), min(float(W), x0 + ob[2]), min(float(H), y0 + ob[3])]
        placed.append({
            "cls": cls,
            "box": [round(v, 1) for v in box],
            "long_side_px": round(s, 1),
            "source_file": src["file"].name,
            "source_box": [round(v, 1) for v in src["box"]],
            "mask": mkind,
            "motion_blur": blur,
        })
    # rough visibility: share of each box not covered by boxes pasted after it (box-level, not pixel-level)
    for i, o in enumerate(placed):
        b = o["box"]
        area = max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
        m = np.zeros((int(math.ceil(b[3] - b[1])) + 1, int(math.ceil(b[2] - b[0])) + 1), bool)
        for later in placed[i + 1:]:
            c = later["box"]
            ix1, iy1 = max(b[0], c[0]), max(b[1], c[1])
            ix2, iy2 = min(b[2], c[2]), min(b[3], c[3])
            if ix2 > ix1 and iy2 > iy1:
                m[int(iy1 - b[1]):int(math.ceil(iy2 - b[1])), int(ix1 - b[0]):int(math.ceil(ix2 - b[0]))] = True
        o["visible_frac"] = round(float(1 - min(1.0, m.sum() / area)), 2)
    for i, o in enumerate(placed):
        o["id"] = i
    img = Image.fromarray(np.clip(canvas + 0.5, 0, 255).astype(np.uint8))
    return img, placed, background, flock


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--per-type", type=int, default=15, help="scenes per type (4 types; default 15 -> 60 scenes)")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--allow-box-labels", action="store_true",
                    help="also use objects that only have a box label (ellipse cut-out; carries more of its photo background)")
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    print(f"reading object pool from {SRC.relative_to(REPO)} (valid split only)")
    pool, images = build_pool(polygons_only=not args.allow_box_labels)
    print(f"  {len(pool['bird'])} bird and {len(pool['drone'])} drone cut-outs from {len(images)} images")
    bg_regions = empty_regions(images, rng)
    print(f"  {len(bg_regions)} object-free sky regions kept for backgrounds")

    near_test = set()
    excl = Path(__file__).resolve().parent / "valid_excluded.json"
    if excl.exists():  # written by the team's split checks: valid images that are near-duplicates of test images
        near_test = set(json.loads(excl.read_text()).get("excluded", []))

    img_dir = args.out / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    for old in img_dir.glob("*.png"):
        old.unlink()
    scenes = []
    for kind in TYPES:
        for k in range(args.per_type):
            img, objs, background, flock = render_scene(rng, kind, pool, bg_regions)
            for o in objs:
                o["source_near_test"] = o["source_file"] in near_test if near_test else None
            name = f"{kind}_{k:02d}.png"
            img.save(img_dir / name, optimize=False)
            sha = hashlib.sha256((img_dir / name).read_bytes()).hexdigest()
            scenes.append({"file": f"images/{name}", "sha256": sha, "type": kind, "width": CANVAS[0], "height": CANVAS[1],
                           "background": background, "flock_ellipse": flock,
                           "n_birds": sum(o["cls"] == "bird" for o in objs), "n_drones": sum(o["cls"] == "drone" for o in objs),
                           "objects": objs})
        print(f"  {kind}: {args.per_type} scenes")

    manifest = {
        "what": "SYNTHETIC flock stress set: Mendeley VALID-split objects pasted onto skies. Not real footage.",
        "warning": ("Crude alpha-blended pastes with feathered edges; shrunk close-up photos; straight-line motion blur. "
                    "The valid split is used for model selection (valid.npz) and most of it is near-duplicate of the frozen "
                    "test split (see valid_excluded.json), so this is NOT independent evidence. NEVER train on these images "
                    "or crops cut from them. Use it to find crowding/crop failures, not to quote accuracy."),
        "near_test_rule": "source_near_test = source photo listed in valid_excluded.json (pHash Hamming <= 12 to a frozen test image); null if that file was missing",
        "source_split": "data/mendeley/Dataset/valid (test split never read)",
        "class_rule": "from file name: BV* = bird, DV* = drone (YOLO class ids ignored); polygons -> min/max boxes",
        "cutouts": "polygon-labelled objects only (polygon = cut-out shape)" if not args.allow_box_labels else "polygon + box-labelled objects (box -> ellipse cut-out)",
        "box_format": "[x1, y1, x2, y2] in pixels of the generated image; blurred birds' boxes include the smear",
        "seed": args.seed,
        "generator": "Shreyansh Local Ai Model/make_stress_set.py",
        "canvas": list(CANVAS),
        "totals": {t: {"scenes": sum(s["type"] == t for s in scenes),
                       "birds": sum(s["n_birds"] for s in scenes if s["type"] == t),
                       "drones": sum(s["n_drones"] for s in scenes if s["type"] == t),
                       "blurred_birds": sum(1 for s in scenes if s["type"] == t for o in s["objects"] if o["motion_blur"])}
                   for t in TYPES},
        "scenes": scenes,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    if near_test:
        allo = [o for s in scenes for o in s["objects"]]
        manifest["near_test_objects"] = sum(bool(o["source_near_test"]) for o in allo)
        (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))
        print(f"  {manifest['near_test_objects']}/{len(allo)} pasted objects come from valid photos that are near-duplicates of test photos")
    tb = sum(s["n_birds"] for s in scenes)
    td = sum(s["n_drones"] for s in scenes)
    print(f"wrote {len(scenes)} scenes, {tb} birds + {td} drones = {tb + td} objects -> {args.out.relative_to(REPO) if args.out.is_relative_to(REPO) else args.out}")


if __name__ == "__main__":
    sys.exit(main())
