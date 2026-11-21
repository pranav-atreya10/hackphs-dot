# Running SkyNetLite in the browser

The trained bird / drone / other model runs in plain JavaScript in the browser. It needs no ML
library and no server, and camera pixels never leave the page.

## The files

| File | What it does |
|---|---|
| `export_web.py` | Turns a trained checkpoint (`.pt`) into one JSON file the browser can load. It folds each BatchNorm into the conv before it (same answer, less work), stores the weights as base64 float32, and saves 3 test crops with PyTorch's answers so the JS can prove it matches. |
| `skysentry_classifier.js` | The browser model. It cuts the crop around a tracker box, runs the 7 conv layers, and returns `{ label, score, probs: { bird, drone, other } }`. |
| `make_test_model.py` | Makes a random (untrained) model at `/tmp/skynet_test.pt` with scrambled BatchNorm numbers, only for testing. |
| `test_parity.mjs` | Node test: the JS answers must match PyTorch to within 0.001. It also times the model. |
| `crop_parity.py` + `crop_parity.mjs` | Cuts the same boxes in Python (`crops.cut`) and in JS (`cropFromRGBA`) and compares the pixels. |

## Export a trained model

```bash
cd "Shreyansh Local Ai Model"
python3 export_web.py --checkpoint runs/<name>/best.pt --out skysentry_classifier.json
```

The output is about 2.5 MB (and smaller if the web server gzips it). Copy `skysentry_classifier.js`
and the JSON into `PRANAV/public/` (for example `public/js/` and `public/ai-models/`) so the app can
serve them. The folder name has spaces and is not served.

## Test it

```bash
python3 make_test_model.py
python3 export_web.py --checkpoint /tmp/skynet_test.pt --out /tmp/skynet_test.json
node test_parity.mjs /tmp/skynet_test.json     # logits must match PyTorch within 1e-3
python3 crop_parity.py                         # JS crop must equal crops.cut pixel for pixel
```

## Validate a v5 MobileNet ONNX candidate offline

From this directory, in a Python environment with compatible `torch`, `torchvision`, `onnx`,
`onnxruntime`, NumPy and Pillow, export a local checkpoint with `train_v5_mobilenet.py --export`
and its matching `--arch`. Then check the exact file produced, not the parameter count:

```powershell
python validate_v5_onnx.py runs\v5_large\best.pt runs\v5_large\best.onnx
python -B -m unittest -v test_v5_onnx
```

The validator requires one self-contained ONNX file at most 20,000,000 bytes and reports its
SHA-256 and max logit error for CPU ONNX Runtime vs PyTorch at batch sizes 1 and 3
(`rtol=1e-4`, `atol=1e-5`). The input `crop96_normalised` is float32 `[batch, 3, 96, 96]` in
RGB channel order: use the shared `crops.square_for_box` and edge-padded `crops.cut` at 64x64,
divide by 255, bilinearly resize to 96x96 with `align_corners=False`, then apply the ImageNet
RGB mean `(0.485, 0.456, 0.406)` and std `(0.229, 0.224, 0.225)`.
The output `logits` is float32 `[batch, 3]`, ordered `bird`, `drone`, `other`. Both batch axes must
be dynamic. The synthetic smoke test uses temporary untrained checkpoints without downloads.
The trainer's `dynamic_axes` export targets the legacy exporter; PyTorch 2.9+ defaults to Dynamo.

This is export validation, not an accuracy or browser test. The browser asset manifest in
`PRANAV/public/ai-models/README.md` documents the Apache-2.0 TensorFlow.js assets, not v5 rights.
Torchvision's BSD-3-Clause and ONNX Runtime's MIT software licenses do not settle the
ImageNet-pretrained weight terms or the training-source attribution obligations in `DATASETS.md`.

## Using it from visual-ai.js

`classifyBox` takes the same video and normalised `{x, y, w, h}` box that `chooseBirdCandidate`
already gives, and it returns `label`, `score` and `ms` like the COCO verifier:

```js
import { loadClassifier } from './skysentry_classifier.js';
const sky = await loadClassifier('/ai-models/skysentry_classifier.json');   // once, in enable()

// in tick(), where the COCO check runs now:
const r = sky.classifyBox(c.t.video, { ...c.tr.bbox });
// r = { label: 'bird' | 'drone' | 'other', score: 0.91, probs: { bird, drone, other }, ms: 18.4 }
if (r.label === 'bird' && r.score >= 0.6) { /* confident bird */ }

// A whole flock in one call (the frame is read once, and buffers are reused):
const results = sky.classifyBoxes(c.t.video, state.tracks.map(t => t.bbox));
```

`source` can be a `<video>`, a canvas, an `OffscreenCanvas`, an `ImageBitmap`, or a plain
`{ data, width, height }` RGBA image. The calls are synchronous. For big flocks, run the classifier
in a Web Worker and send it an `ImageBitmap` of the frame, or check only a few tracks per tick.
`sky.cropBuffer` holds the last 64x64 RGBA crop if you want to show it on screen.

## Speed (measured with `node test_parity.mjs`)

I measured this on a slow 2-core 2.1 GHz cloud VM (Node 22). A normal laptop should be faster.

- One crop: **about 15-24 ms** (the VM is shared, so it varies from run to run).
- 60 crops (a flock), including cutting the crops from a 1280x720 frame: **about 0.9-1.4 s**.

Two tricks make it fast. The layers store "channels last" with a zero border, so the inner loops run
straight through memory. The stride-1 layers also use the Winograd trick, which needs 2.25x fewer
multiplications (explained in the code). A plain loop version took about 46 ms per crop.

## Crop matching (important for accuracy)

**Antialiasing: handled.** When Pillow shrinks an image with `BILINEAR`, it averages groups of
pixels ("antialiasing"). Most browser and graphics code does not. If the browser did the resizing,
big boxes would come out different from the training crops. With plain bilinear, a 420 px square
shrunk to 64 differs by **8.75 levels on average (up to 32)**. So `skysentry_classifier.js` copies
the browser frame at 1:1 and does the resize itself with Pillow's exact whole-number maths. Its
crops are **identical to `crops.cut`**: 0 difference on all 5 test boxes and 300 random boxes.
That includes edge padding, upscaling, and Python's round-half-to-even.

**Note for the crop rule in crops.py: training does not use the plain `crops.cut` crop.**
The app (default `cropMode: 'live'`), `evaluate.py` and `eval_stress.py` all use the one-step
`crops.cut` crop, so the test scores describe what the app really does. Training is different.
`prepare_data.py` stores a 1.6x bigger square at 80x80. Then `train.py` (`centre_view` and the jitter
in `augment`) cuts the middle out with `grid_sample` and enlarges it to 64. So the model trains, and
is scored on VALID, with crops that were resized twice. They are a bit blurrier than the one-step
crops it is tested on and will see in the app. On the test frame that mismatch averages
**1.8-5.2 levels (up to 42)**. That is bigger than the antialiasing error the exact Pillow copy
avoids. It may cost some accuracy, and VALID scores may not predict test scores well. Options:

1. **Recommended (training side):** make training see one-step crops. For example, add a note to
   crops.py that the live crop is always `cut(img, *square_for_box(...), INPUT)`, and have
   `prepare_data.py` / `train.py` cut the jittered live square with `crops.cut` at 64 instead of
   resizing the 80 px stored crop. Keep the app on `cropMode: 'live'`. Just making `STORE` bigger
   is not enough: I measured 102 px and 128 px, and both still average 1.4-1.7 levels off, with the
   worst box at about 5.
2. **App side, no retraining:** `loadClassifier(url, { cropMode: 'train' })`. The JS then copies the
   training path exactly (80 px stored crop, then centre view). Measured against `train.py`'s own
   pipeline: at most 1 level off (rounding). If you use it, also make `evaluate.py` crop this way, or
   the test scores will no longer describe the app.
