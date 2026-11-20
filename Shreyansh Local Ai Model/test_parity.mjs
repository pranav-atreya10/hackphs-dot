// Proves the JavaScript classifier gives the same answers as PyTorch, and measures its speed.
//
//   python3 make_test_model.py                                                    # random test model
//   python3 export_web.py --checkpoint /tmp/skynet_test.pt --out /tmp/skynet_test.json
//   node test_parity.mjs [/tmp/skynet_test.json]
//
// Checks:
//   1. The 3 reference crops stored in the JSON: JS logits must be within 1e-3 of PyTorch's.
//   2. classifyBoxes on a fake 1280x720 frame gives the same answers as cropFromRGBA + classifyCrop.
// Then prints milliseconds per crop and for a flock of 60 crops.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { loadClassifier, cropFromRGBA } from './skysentry_classifier.js';

const path = process.argv[2] || '/tmp/skynet_test.json';
const clf = await loadClassifier(JSON.parse(readFileSync(path, 'utf8')));

// --- 1. Parity with PyTorch -------------------------------------------------------------------
function rgbToRgba(b64) {
  const rgb = Buffer.from(b64, 'base64');
  const out = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { out[j] = rgb[i]; out[j + 1] = rgb[i + 1]; out[j + 2] = rgb[i + 2]; out[j + 3] = 255; }
  return out;
}
const crops = clf.reference.inputs.map(rgbToRgba);
let maxDiff = 0;
crops.forEach((crop, i) => {
  const r = clf.classifyCrop(crop);
  const ref = clf.reference.logits[i];
  const d = Math.max(...r.logits.map((v, k) => Math.abs(v - ref[k])));
  maxDiff = Math.max(maxDiff, d);
  console.log(`reference ${i}: JS [${r.logits.map((v) => v.toFixed(4)).join(', ')}]  PyTorch [${ref.map((v) => v.toFixed(4)).join(', ')}]  -> ${r.label} ${(r.score * 100).toFixed(1)}%`);
});
console.log(`max |logit difference| = ${maxDiff.toExponential(2)}`);
assert.ok(maxDiff < 1e-3, `logits differ by ${maxDiff}`);

// --- 2. Many boxes on one frame ------------------------------------------------------------------
const W = 1280, H = 720;
const frame = new Uint8ClampedArray(W * H * 4);
let seed = 7;
const rand = () => ((seed = (Math.imul(1103515245, seed) + 12345) & 0x7fffffff) / 2147483648);
for (let y = 0, i = 0; y < H; y++) {
  for (let x = 0; x < W; x++, i += 4) {
    frame[i] = 120 + 40 * Math.sin(x / 37) + 20 * rand(); frame[i + 1] = 150 + 30 * Math.cos(y / 23) + 20 * rand();
    frame[i + 2] = 200 - y / 8 + 20 * rand(); frame[i + 3] = 255;
  }
}
const image = { data: frame, width: W, height: H };
const flock = Array.from({ length: 60 }, (_, i) => {
  const w = (4 + (i % 7) * 6) / W, h = (3 + (i % 5) * 5) / H;           // 4..40 px birds
  return { x: Math.min(rand(), 1 - w), y: Math.min(rand(), 1 - h), w, h };
});
flock.push({ x: 0, y: 0, w: 0.2, h: 0.25 }, { x: 0.97, y: 0.95, w: 0.03, h: 0.05 });  // big box, corner box
const many = clf.classifyBoxes(image, flock);
const one = new Uint8ClampedArray(64 * 64 * 4);
flock.forEach((b, i) => {
  const r = clf.classifyCrop(cropFromRGBA(frame, W, H, b, one));
  assert.deepEqual(many[i].logits, r.logits, `box ${i}: classifyBoxes differs from cropFromRGBA + classifyCrop`);
});
console.log(`classifyBoxes matches cropFromRGBA + classifyCrop on ${flock.length} boxes`);

// --- Speed ---------------------------------------------------------------------------------------
for (let i = 0; i < 20; i++) clf.classifyCrop(crops[i % 3]);          // warm up the JIT
const N = 200;
let t = performance.now();
for (let i = 0; i < N; i++) clf.classifyCrop(crops[i % 3]);
const perCrop = (performance.now() - t) / N;
const flock60 = flock.slice(0, 60);
const runs = 10, times = [];
for (let r = 0; r < runs; r++) {
  t = performance.now();
  clf.classifyBoxes(image, flock60);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(`speed: ${perCrop.toFixed(2)} ms per crop (network only, mean of ${N}); ` +
  `60 crops incl. cropping: ${times[runs >> 1].toFixed(1)} ms median (best ${times[0].toFixed(1)} ms)`);
console.log('PASS');
