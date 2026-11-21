// Helper for crop_parity.py: cut the same boxes with the JavaScript crop code.
//   node crop_parity.mjs input.json output.json
// input.json: { width, height, rgb_b64, boxes: [{x, y, w, h}] }  (rgb = width*height*3 bytes)
// output.json: { live: [rgb_b64 per box], train: [rgb_b64 per box] }  (64x64x3 bytes each)
import { readFileSync, writeFileSync } from 'node:fs';
import { cropFromRGBA } from './skysentry_classifier.js';

const [inPath, outPath] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(inPath, 'utf8'));
const rgb = Buffer.from(spec.rgb_b64, 'base64');
const rgba = new Uint8ClampedArray(spec.width * spec.height * 4);
for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) { rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255; }

const toRgbB64 = (crop) => {
  const out = Buffer.alloc(64 * 64 * 3);
  for (let i = 0, j = 0; j < crop.length; i += 3, j += 4) { out[i] = crop[j]; out[i + 1] = crop[j + 1]; out[i + 2] = crop[j + 2]; }
  return out.toString('base64');
};
const result = {};
for (const cropMode of ['live', 'train']) {
  result[cropMode] = spec.boxes.map((b) => toRgbB64(cropFromRGBA(rgba, spec.width, spec.height, b, undefined, { cropMode })));
}
writeFileSync(outPath, JSON.stringify(result));
