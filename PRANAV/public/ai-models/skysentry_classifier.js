// SkyNetLite bird / drone / other classifier, running in plain JavaScript (no ML library, no server).
//
// This is the small network from "Shreyansh Local Ai Model/model.py", exported by export_web.py into a
// JSON file. Give it a tracker box on a video frame and it says how likely the object is a bird, a
// drone, or something else (cloud edge, plane, insect, sky noise).
//
// How it looks at an object, step by step:
//   1. Crop: a square centred on the tracker box, 1.4x the box's longest side (at least 32 px), with
//      the frame's edge pixels repeated if the square sticks out of the frame. It is shrunk or enlarged
//      to 64x64 with exactly the same maths Pillow (PIL) uses in crops.py, so the browser sees the same
//      pixels the training script saw.
//   2. Normalise: each colour value v becomes (v/255 - 0.5) / 0.25, like training.
//   3. Seven filter layers (3x3 convolution + ReLU, with batch-norm already folded into the weights);
//      the image is halved in size after layers 2, 4 and 6.
//   4. Average each of the 160 filter outputs over the image, then one linear layer gives 3 scores.
//   5. Softmax turns the 3 scores into probabilities that add up to 1.
//
// Usage (browser or Node):
//   const clf = await loadClassifier('/models/skysentry_classifier.json');
//   const r = clf.classifyBox(video, { x: 0.4, y: 0.2, w: 0.03, h: 0.02 });   // box normalised 0..1
//   // r = { label: 'bird', score: 0.91, probs: { bird: 0.91, drone: 0.06, other: 0.03 }, logits, ms }
//   const many = clf.classifyBoxes(video, flock.map(t => t.bbox));          // one frame read for all
//
// All calls are synchronous (they just do maths). The heavy buffers are made once and reused, so
// checking a flock of 60 birds does not create garbage for every bird.

const SIZE = 64;           // model input: 64x64 RGB
const STORE = 80;          // 'train' crop mode only: training crops were stored at 80x80 ...
const STORE_SCALE = 1.6;   // ... with 1.6x more context, then the centre was resized to 64 (train.py)
const PREC = 22;           // Pillow's fixed-point precision for 8-bit images (32 - 8 - 2 bits)
const HALF = 1 << (PREC - 1);
const ONE = 1 << PREC;

function decodeF32(b64) {
  const bytes = decodeBytes(b64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
}

function decodeBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------

// urlOrJson: a URL/path to the exported JSON (fetched), or the already-parsed JSON object.
// options.cropMode: 'live' (default, the crops.py rule) or 'train' (copies train.py's two-step crop;
// see WEB_RUNTIME.md for why you might want it).
export async function loadClassifier(urlOrJson, options = {}) {
  let spec = urlOrJson;
  if (typeof urlOrJson === 'string' || urlOrJson instanceof URL) {
    const res = await fetch(urlOrJson);
    if (!res.ok) throw new Error(`skysentry classifier: HTTP ${res.status} for ${urlOrJson}`);
    spec = await res.json();
  }
  return new SkySentryClassifier(spec, options);
}

export class SkySentryClassifier {
  constructor(spec, { cropMode = 'live' } = {}) {
    if (spec.version !== 1) throw new Error(`skysentry classifier: unsupported export version ${spec.version}`);
    if (spec.input !== SIZE) throw new Error(`skysentry classifier: expected ${SIZE}px input, got ${spec.input}`);
    if (cropMode !== 'live' && cropMode !== 'train') throw new Error(`unknown cropMode ${cropMode}`);
    this.classes = spec.classes;
    this.cropMode = cropMode;
    this.crop = { context: spec.crop.context, minSide: spec.crop.min_side };
    this.reference = spec.reference;
    // Normalisation folded into one multiply-add per channel: (v/255 - mean)/std = v*a + b.
    this.normA = spec.std.map((s) => 1 / (255 * s));
    this.normB = spec.mean.map((m, i) => -m / spec.std[i]);

    // Each layer gets a zero-bordered input buffer (one pixel of padding all round), stored
    // "channels last" (for every pixel, all its channels sit next to each other). The border stays
    // zero forever, which is exactly the conv's zero padding, so the inner loop needs no edge checks.
    let h = SIZE, vSize = 0, mSize = 0;
    this.layers = spec.layers.map((L) => {
      const inH = h, outH = L.stride === 2 ? h >> 1 : h;
      const w = decodeF32(L.weight_b64);
      const layer = {
        name: L.name, cin: L.cin, cout: L.cout, stride: L.stride, pool: L.pool, inH, outH, b: decodeF32(L.bias_b64),
        // Stride-1 layers use the Winograd trick (see winogradConv); the stride-2 stem uses plain conv.
        w: L.stride === 1 ? winogradWeights(w, L.cin, L.cout) : packWeights(w, L.cin, L.cout),
        input: new Float32Array((inH + 2) * (inH + 2) * L.cin),
        // Without pooling the conv writes straight into the next layer's padded input (set below).
        output: L.pool || L === spec.layers[spec.layers.length - 1] ? new Float32Array(outH * outH * L.cout) : null,
      };
      if (L.cout % 4 || outH % 4 || (L.stride !== 1 && L.stride !== 2)) throw new Error(`layer ${L.name}: shape not supported`);
      const tiles = (outH >> 1) * (outH >> 1);
      if (L.stride === 1) { vSize = Math.max(vSize, 16 * tiles * L.cin); mSize = Math.max(mSize, 16 * tiles * L.cout); }
      h = L.pool ? outH >> 1 : outH;
      return layer;
    });
    this.wv = new Float32Array(vSize);   // Winograd working memory, shared by all layers
    this.wm = new Float32Array(mSize);
    this.fcW = decodeF32(spec.fc.weight_b64);
    this.fcB = decodeF32(spec.fc.bias_b64);
    this.features = new Float32Array(this.layers[this.layers.length - 1].cout);
    this.logits = new Float64Array(this.classes.length);

    // Reused crop buffers.
    this.cropBuffer = new Uint8ClampedArray(SIZE * SIZE * 4);   // last crop, RGBA (handy for showing it)
    this.scratch = new CropScratch();
    this.reader = null;                                         // canvas used to read video pixels
  }

  // rgba: Uint8ClampedArray (or Uint8Array) of a 64x64 RGBA image. Returns { label, score, probs, logits }.
  classifyCrop(rgba) {
    if (rgba.length !== SIZE * SIZE * 4) throw new Error('classifyCrop needs a 64x64 RGBA image');
    this.forward(rgba);
    return this.result();
  }

  // source: HTMLVideoElement, HTMLCanvasElement, OffscreenCanvas, ImageBitmap, HTMLImageElement,
  // or anything shaped like ImageData ({ data, width, height }, e.g. in Node or a worker).
  // box: { x, y, w, h } normalised 0..1 to the source size (what the tracker gives).
  classifyBox(source, box) {
    return this.classifyBoxes(source, [box])[0];
  }

  // Many boxes on the same frame: the frame is read once, then every box is cropped and classified.
  // Returns one result per box (same order); a box with no area gives null.
  classifyBoxes(source, boxes) {
    const t0 = now();
    const frame = this.readFrame(source, boxes);
    const tRead = now() - t0;
    const results = new Array(boxes.length).fill(null);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b || !(b.w > 0 && b.h > 0)) continue;
      const t1 = now();
      cutBox(frame, b, this.crop, this.cropMode, this.cropBuffer, this.scratch);
      this.forward(this.cropBuffer);
      results[i] = this.result();
      results[i].ms = Math.round((now() - t1 + tRead / boxes.length) * 10) / 10;
    }
    return results;
  }

  // Run the network on a 64x64 RGBA crop; leaves the 3 scores in this.logits.
  forward(rgba) {
    // 1. Normalise into the stem's padded, channels-last input.
    const L0 = this.layers[0], inp = L0.input, PW = SIZE + 2;
    const [a0, a1, a2] = this.normA, [b0, b1, b2] = this.normB;
    for (let y = 0; y < SIZE; y++) {
      let s = y * SIZE * 4, d = ((y + 1) * PW + 1) * 3;
      for (let x = 0; x < SIZE; x++, s += 4, d += 3) {
        inp[d] = rgba[s] * a0 + b0;
        inp[d + 1] = rgba[s + 1] * a1 + b1;
        inp[d + 2] = rgba[s + 2] * a2 + b2;
      }
    }
    // 2. Conv layers (ReLU built in), with 2x2 max pooling where the model has it.
    for (let i = 0; i < this.layers.length; i++) {
      const L = this.layers[i], next = this.layers[i + 1];
      // Where the result goes: the layer's own buffer (if it is pooled or last), else straight into
      // the middle of the next layer's padded input.
      const dst = L.output || next.input, dstW = L.output ? L.outH : next.inH + 2, dstPad = L.output ? 0 : 1;
      if (L.stride === 1) winogradConv(L, dst, dstW, dstPad, this.wv, this.wm);
      else conv3x3(L, dst, dstW, dstPad);
      if (L.pool) maxPool2(L.output, L.outH, L.cout, next.input, next.inH + 2);
    }
    // 3. Global average pool, then the linear layer.
    const last = this.layers[this.layers.length - 1], C = last.cout, area = last.outH * last.outH;
    const f = this.features;
    f.fill(0);
    for (let p = 0, i = 0; p < area; p++) for (let c = 0; c < C; c++, i++) f[c] += last.output[i];
    for (let c = 0; c < C; c++) f[c] /= area;
    for (let k = 0; k < this.logits.length; k++) {
      let s = this.fcB[k];
      for (let c = 0, w = k * C; c < C; c++, w++) s += this.fcW[w] * f[c];
      this.logits[k] = s;
    }
  }

  // Softmax over this.logits -> { label, score, probs: {bird, drone, other}, logits }.
  result() {
    const z = this.logits;
    let max = -Infinity, best = 0, sum = 0;
    for (let k = 0; k < z.length; k++) if (z[k] > max) { max = z[k]; best = k; }
    const e = Array.from(z, (v) => { const x = Math.exp(v - max); sum += x; return x; });
    const probs = {};
    this.classes.forEach((name, k) => { probs[name] = e[k] / sum; });
    return { label: this.classes[best], score: e[best] / sum, probs, logits: Array.from(z) };
  }

  // Get RGBA pixels for the part of the frame the boxes need (one read for all boxes).
  readFrame(source, boxes) {
    if (source && source.data && Number.isFinite(source.width)) {   // ImageData-like: use as-is
      return { data: source.data, stride: source.width, ox: 0, oy: 0, width: source.width, height: source.height };
    }
    const width = source.videoWidth || source.naturalWidth || source.width;
    const height = source.videoHeight || source.naturalHeight || source.height;
    if (!width || !height) throw new Error('classifyBox: source has no pixels yet');
    // Smallest rectangle (inside the frame) that covers every crop square.
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    const scale = this.cropMode === 'train' ? STORE_SCALE : 1;
    for (const b of boxes) {
      if (!b || !(b.w > 0 && b.h > 0)) continue;
      const q = squareForBox(b, width, height, this.crop, scale);
      // Clamp both ends into the frame, matching the edge padding in resizeSquare.
      const clampX = (v) => Math.min(Math.max(v, 0), width - 1), clampY = (v) => Math.min(Math.max(v, 0), height - 1);
      x0 = Math.min(x0, clampX(q.x0)); y0 = Math.min(y0, clampY(q.y0));
      x1 = Math.max(x1, clampX(q.x0 + q.s - 1) + 1); y1 = Math.max(y1, clampY(q.y0 + q.s - 1) + 1);
    }
    if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }   // all boxes empty: read 1 pixel
    const rw = x1 - x0, rh = y1 - y0;
    if (!this.reader) {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(rw, rh) : document.createElement('canvas');
      this.reader = { canvas, ctx: null };
    }
    const r = this.reader;
    if (r.canvas.width < rw || r.canvas.height < rh || !r.ctx) {   // grow only; never shrink
      r.canvas.width = Math.max(r.canvas.width, rw);
      r.canvas.height = Math.max(r.canvas.height, rh);
      r.ctx = r.canvas.getContext('2d', { willReadFrequently: true });
    }
    // Copy at 1:1 scale (no browser resizing), so the only resize is our Pillow-exact one.
    r.ctx.drawImage(source, x0, y0, rw, rh, 0, 0, rw, rh);
    const img = r.ctx.getImageData(0, 0, rw, rh);
    return { data: img.data, stride: rw, ox: x0, oy: y0, width, height };
  }
}

// ---------------------------------------------------------------------------------------------------
// Network maths
// ---------------------------------------------------------------------------------------------------

// Reorder PyTorch weights [cout][cin][ky][kx] so the conv reads them in one straight line:
// groups of 4 output channels, and inside a group, for each (ky, kx, cin) the 4 weights side by side.
function packWeights(w, cin, cout) {
  const K = 9 * cin, out = new Float32Array(cout * K);
  for (let o = 0; o < cout; o++) {
    for (let c = 0; c < cin; c++) {
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const k = ky * 3 * cin + kx * cin + c;
          out[((o >> 2) * K + k) * 4 + (o & 3)] = w[((o * cin + c) * 3 + ky) * 3 + kx];
        }
      }
    }
  }
  return out;
}

// 3x3 convolution (padding 1, stride 1 or 2) + bias + ReLU, channels-last.
// L.input is the zero-padded input. The result goes to dst, whose rows are dstW pixels wide with
// dstPad pixels of border (1 when writing straight into the next layer's padded input, else 0).
//
// Speed trick: because the input is channels-last and padded, the 3x3 patch under an output pixel is
// three straight runs of 3*cin numbers. We work out 2 neighbouring pixels x 4 output channels at
// once (8 running sums), so every number loaded from memory is used 4 or 2 times.
function conv3x3(L, dst, dstW, dstPad) {
  const { cin, cout, stride, outH, w: W, b: B, input: inp } = L;
  const PW = L.inH + 2, rowStride = PW * cin, K = 9 * cin, K3 = 3 * cin, step = stride * cin;
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outH; ox += 2) {
      const p0 = (oy * stride * PW + ox * stride) * cin;          // patch top-left, pixel ox
      const d0 = ((oy + dstPad) * dstW + ox + dstPad) * cout, d1 = d0 + cout;
      for (let ob = 0; ob < cout; ob += 4) {
        let a0 = B[ob], a1 = B[ob + 1], a2 = B[ob + 2], a3 = B[ob + 3];
        let c0 = a0, c1 = a1, c2 = a2, c3 = a3;
        let wi = ob * K;                                            // (ob/4) * K * 4
        for (let ky = 0; ky < 3; ky++) {
          let i0 = p0 + ky * rowStride;
          const end = i0 + K3;
          for (; i0 < end; i0++, wi += 4) {
            const x0 = inp[i0], x1 = inp[i0 + step];
            const w0 = W[wi], w1 = W[wi + 1], w2 = W[wi + 2], w3 = W[wi + 3];
            a0 += x0 * w0; a1 += x0 * w1; a2 += x0 * w2; a3 += x0 * w3;
            c0 += x1 * w0; c1 += x1 * w1; c2 += x1 * w2; c3 += x1 * w3;
          }
        }
        dst[d0 + ob] = a0 > 0 ? a0 : 0; dst[d0 + ob + 1] = a1 > 0 ? a1 : 0;
        dst[d0 + ob + 2] = a2 > 0 ? a2 : 0; dst[d0 + ob + 3] = a3 > 0 ? a3 : 0;
        dst[d1 + ob] = c0 > 0 ? c0 : 0; dst[d1 + ob + 1] = c1 > 0 ? c1 : 0;
        dst[d1 + ob + 2] = c2 > 0 ? c2 : 0; dst[d1 + ob + 3] = c3 > 0 ? c3 : 0;
      }
    }
  }
}

// Winograd convolution, F(2x2, 3x3): a well-known shortcut (Winograd 1980; Lavin & Gray 2015) for
// 3x3 filters. A plain conv needs 4 x 9 = 36 multiplications to make a 2x2 block of outputs from one
// input channel. Winograd first mixes the 4x4 input patch with a few additions/subtractions ("input
// transform"), multiplies by pre-mixed weights (only 16 multiplications), then un-mixes with more
// additions ("output transform"). Same answer (up to float rounding, ~1e-6), 2.25x fewer
// multiplications, and the multiplications are what take the time.
//
// Pre-mixed weights: U = G g G^T for every (out channel, in channel) 3x3 filter g, with
//   G = [[1, 0, 0], [1/2, 1/2, 1/2], [1/2, -1/2, 1/2], [0, 0, 1]].
// Stored as 16 "positions" x (groups of 4 out channels) x cin x 4, the order the multiply loop reads.
function winogradWeights(w, cin, cout) {
  const U = new Float32Array(16 * cin * cout);
  const Gg = new Float64Array(12);                              // G g, 4 rows x 3 columns
  for (let o = 0; o < cout; o++) {
    for (let c = 0; c < cin; c++) {
      const g = (o * cin + c) * 9;
      for (let k = 0; k < 3; k++) {
        const g0 = w[g + k], g1 = w[g + 3 + k], g2 = w[g + 6 + k];
        Gg[k] = g0; Gg[3 + k] = (g0 + g1 + g2) / 2; Gg[6 + k] = (g0 - g1 + g2) / 2; Gg[9 + k] = g2;
      }
      for (let i = 0; i < 4; i++) {
        const a = Gg[3 * i], b = Gg[3 * i + 1], d = Gg[3 * i + 2];
        const row = [a, (a + b + d) / 2, (a - b + d) / 2, d];   // (G g) G^T, row i
        for (let j = 0; j < 4; j++) U[(((i * 4 + j) * (cout >> 2) + (o >> 2)) * cin + c) * 4 + (o & 3)] = row[j];
      }
    }
  }
  return U;
}

// Stride-1 3x3 conv + bias + ReLU using Winograd. V and M are shared scratch buffers.
function winogradConv(L, dst, dstW, dstPad, V, M) {
  const { cin, cout, outH: H, w: U, b: B, input: inp } = L;
  const PW = H + 2, T = H >> 1, nt = T * T, rs = PW * cin, vp = nt * cin, mp = nt * cout;
  const C1 = cin, C2 = 2 * cin, C3 = 3 * cin;
  // 1. Input transform: every 4x4 patch d (patches overlap by 2) becomes B^T d B, with
  //    B^T = [[1, 0, -1, 0], [0, 1, 1, 0], [0, -1, 1, 0], [0, 1, 0, -1]]. Only + and -.
  for (let ty = 0; ty < T; ty++) {
    for (let tx = 0; tx < T; tx++) {
      let p = (2 * ty * PW + 2 * tx) * cin, v = (ty * T + tx) * cin;
      for (let c = 0; c < cin; c++, p++, v++) {
        const q0 = p, q1 = p + rs, q2 = p + 2 * rs, q3 = p + 3 * rs;
        // Down each of the 4 columns: rows (d0 - d2, d1 + d2, d2 - d1, d1 - d3).
        const a0 = inp[q0] - inp[q2], b0 = inp[q1] + inp[q2], c0 = inp[q2] - inp[q1], e0 = inp[q1] - inp[q3];
        const a1 = inp[q0 + C1] - inp[q2 + C1], b1 = inp[q1 + C1] + inp[q2 + C1], c1 = inp[q2 + C1] - inp[q1 + C1], e1 = inp[q1 + C1] - inp[q3 + C1];
        const a2 = inp[q0 + C2] - inp[q2 + C2], b2 = inp[q1 + C2] + inp[q2 + C2], c2 = inp[q2 + C2] - inp[q1 + C2], e2 = inp[q1 + C2] - inp[q3 + C2];
        const a3 = inp[q0 + C3] - inp[q2 + C3], b3 = inp[q1 + C3] + inp[q2 + C3], c3 = inp[q2 + C3] - inp[q1 + C3], e3 = inp[q1 + C3] - inp[q3 + C3];
        // Then the same along each row; result goes to the 16 positions.
        V[v] = a0 - a2; V[v + vp] = a1 + a2; V[v + 2 * vp] = a2 - a1; V[v + 3 * vp] = a1 - a3;
        V[v + 4 * vp] = b0 - b2; V[v + 5 * vp] = b1 + b2; V[v + 6 * vp] = b2 - b1; V[v + 7 * vp] = b1 - b3;
        V[v + 8 * vp] = c0 - c2; V[v + 9 * vp] = c1 + c2; V[v + 10 * vp] = c2 - c1; V[v + 11 * vp] = c1 - c3;
        V[v + 12 * vp] = e0 - e2; V[v + 13 * vp] = e1 + e2; V[v + 14 * vp] = e2 - e1; V[v + 15 * vp] = e1 - e3;
      }
    }
  }
  // 2. The multiplications: for each of the 16 positions, every patch x every out channel is a sum
  //    over in channels. Same "2 patches x 4 channels at once" trick as conv3x3.
  for (let pos = 0; pos < 16; pos++) {
    const vb = pos * vp, ub = pos * cout * cin, mb = pos * mp;
    for (let t = 0; t < nt; t += 2) {
      const v0 = vb + t * cin, v1 = v0 + cin;
      for (let ob = 0; ob < cout; ob += 4) {
        let a0 = 0, a1 = 0, a2 = 0, a3 = 0, c0 = 0, c1 = 0, c2 = 0, c3 = 0;
        let wi = ub + ob * cin;
        for (let c = 0; c < cin; c++, wi += 4) {
          const x0 = V[v0 + c], x1 = V[v1 + c];
          const w0 = U[wi], w1 = U[wi + 1], w2 = U[wi + 2], w3 = U[wi + 3];
          a0 += x0 * w0; a1 += x0 * w1; a2 += x0 * w2; a3 += x0 * w3;
          c0 += x1 * w0; c1 += x1 * w1; c2 += x1 * w2; c3 += x1 * w3;
        }
        const m0 = mb + t * cout + ob, m1 = m0 + cout;
        M[m0] = a0; M[m0 + 1] = a1; M[m0 + 2] = a2; M[m0 + 3] = a3;
        M[m1] = c0; M[m1 + 1] = c1; M[m1 + 2] = c2; M[m1 + 3] = c3;
      }
    }
  }
  // 3. Output transform: A^T m A with A^T = [[1, 1, 1, 0], [0, 1, -1, -1]] gives the 2x2 outputs.
  //    Add the bias, apply ReLU, write into dst.
  for (let ty = 0; ty < T; ty++) {
    for (let tx = 0; tx < T; tx++) {
      let m = (ty * T + tx) * cout;
      const d00 = ((2 * ty + dstPad) * dstW + 2 * tx + dstPad) * cout, d10 = d00 + dstW * cout;
      for (let o = 0; o < cout; o++, m++) {
        const s0 = M[m] + M[m + 4 * mp] + M[m + 8 * mp], s1 = M[m + mp] + M[m + 5 * mp] + M[m + 9 * mp];
        const s2 = M[m + 2 * mp] + M[m + 6 * mp] + M[m + 10 * mp], s3 = M[m + 3 * mp] + M[m + 7 * mp] + M[m + 11 * mp];
        const t0 = M[m + 4 * mp] - M[m + 8 * mp] - M[m + 12 * mp], t1 = M[m + 5 * mp] - M[m + 9 * mp] - M[m + 13 * mp];
        const t2 = M[m + 6 * mp] - M[m + 10 * mp] - M[m + 14 * mp], t3 = M[m + 7 * mp] - M[m + 11 * mp] - M[m + 15 * mp];
        const b = B[o];
        const y00 = b + s0 + s1 + s2, y01 = b + s1 - s2 - s3, y10 = b + t0 + t1 + t2, y11 = b + t1 - t2 - t3;
        dst[d00 + o] = y00 > 0 ? y00 : 0; dst[d00 + cout + o] = y01 > 0 ? y01 : 0;
        dst[d10 + o] = y10 > 0 ? y10 : 0; dst[d10 + cout + o] = y11 > 0 ? y11 : 0;
      }
    }
  }
}

// 2x2 max pooling (channels-last) from an h x h x C image into the interior of a padded buffer.
function maxPool2(src, h, C, dst, dstW) {
  const h2 = h >> 1, row = h * C;
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < h2; x++) {
      const s = (2 * y * h + 2 * x) * C, d = ((y + 1) * dstW + x + 1) * C;
      for (let c = 0; c < C; c++) {
        const i = s + c;
        const m1 = src[i] > src[i + C] ? src[i] : src[i + C];
        const m2 = src[i + row] > src[i + row + C] ? src[i + row] : src[i + row + C];
        dst[d + c] = m1 > m2 ? m1 : m2;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Cropping (the crops.py rule, Pillow-exact)
// ---------------------------------------------------------------------------------------------------

// Python's round() sends .5 to the nearest even number (round(2.5) == 2); Math.round sends it up.
// crops.py uses Python's round, so we copy it to land on the same pixel.
function roundHalfEven(v) {
  const f = Math.floor(v), d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// The crop square for a normalised box, in frame pixels (crops.square_for_box + the rounding in crops.cut).
export function squareForBox(box, width, height, crop = { context: 1.4, minSide: 32 }, scale = 1) {
  const bw = box.w * width, bh = box.h * height;
  const cx = (box.x + box.w / 2) * width, cy = (box.y + box.h / 2) * height;
  const side = Math.max(crop.context * Math.max(bw, bh), crop.minSide) * scale;
  return { x0: roundHalfEven(cx - side / 2), y0: roundHalfEven(cy - side / 2), s: Math.max(roundHalfEven(side), 1) };
}

// Pure function: cut the crop for `box` (normalised 0..1) out of an RGBA image and return a 64x64
// RGBA Uint8ClampedArray. Pass `out` to reuse a buffer. options.cropMode: 'live' (default) or 'train'.
export function cropFromRGBA(rgba, width, height, box, out = new Uint8ClampedArray(SIZE * SIZE * 4), options = {}) {
  const crop = { context: options.context ?? 1.4, minSide: options.minSide ?? 32 };
  cutBox({ data: rgba, stride: width, ox: 0, oy: 0, width, height }, box, crop, options.cropMode || 'live', out, new CropScratch());
  return out;
}

// Reusable working memory for cropping (grows when needed, never shrinks).
class CropScratch {
  constructor() { this.cols = new Int32Array(0); this.tmp = new Int32Array(0); this.store = new Uint8ClampedArray(STORE * STORE * 4); this.coeffs = new Map(); }
  colBuffer(n) { if (this.cols.length < n) this.cols = new Int32Array(n); return this.cols; }
  tmpBuffer(n) { if (this.tmp.length < n) this.tmp = new Int32Array(n); return this.tmp; }
  coeffsFor(inSize, outSize) {
    const key = inSize * 1024 + outSize;
    let c = this.coeffs.get(key);
    if (!c) {
      if (this.coeffs.size > 256) this.coeffs.clear();             // boxes vary; keep the cache small
      c = pilCoeffs(inSize, outSize);
      this.coeffs.set(key, c);
    }
    return c;
  }
}

// frame: { data (RGBA), stride (pixels per row of data), ox, oy (where data starts in the frame),
//          width, height (full frame size) }.
function cutBox(frame, box, crop, mode, out, scratch) {
  if (mode === 'train') {
    // What train.py actually feeds the model: prepare_data.py cuts a 1.6x bigger square at 80x80 ...
    const q = squareForBox(box, frame.width, frame.height, crop, STORE_SCALE);
    resizeSquare(frame, q.x0, q.y0, q.s, STORE, scratch.store, scratch);
    // ... then centre_view() takes the middle 1/1.6 of it and resizes to 64 (torch grid_sample, bilinear).
    centreView(scratch.store, out);
  } else {
    const q = squareForBox(box, frame.width, frame.height, crop, 1);
    resizeSquare(frame, q.x0, q.y0, q.s, SIZE, out, scratch);
  }
}

// Pillow's resize weights for a "bilinear" (triangle) filter. When shrinking, Pillow stretches the
// triangle over several source pixels (that averaging is "antialiasing": it stops fine detail from
// turning into noise). Weights are stored as whole numbers scaled by 2^22, exactly like Pillow.
function pilCoeffs(inSize, outSize) {
  const scale = inSize / outSize, filterscale = Math.max(scale, 1), support = filterscale;
  const ksize = Math.ceil(support) * 2 + 1, ss = 1 / filterscale;
  const bounds = new Int32Array(outSize * 2), kk = new Int32Array(outSize * ksize), tmp = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5); if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5); if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const t = Math.abs((x + xmin - center + 0.5) * ss);
      tmp[x] = t < 1 ? 1 - t : 0;
      ww += tmp[x];
    }
    for (let x = 0; x < xmax; x++) {
      const v = ww !== 0 ? tmp[x] / ww : tmp[x];
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * ONE) : Math.trunc(0.5 + v * ONE);
    }
    bounds[2 * xx] = xmin; bounds[2 * xx + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

function clip8(v) { v >>= PREC; return v < 0 ? 0 : v > 255 ? 255 : v; }

// Cut the s x s square at (x0, y0) of the frame (edge pixels repeated outside it) and resize it to
// n x n RGBA, copying Pillow's Image.resize(BILINEAR): first along rows, rounding to 0..255, then
// along columns. Same order, same whole-number maths, so the result is identical to crops.cut.
function resizeSquare(frame, x0, y0, s, n, out, scratch) {
  const { data, stride, ox, oy, width, height } = frame;
  // Where each column of the square comes from in `data` (edge padding = clamping to the frame).
  const cols = scratch.colBuffer(s);
  for (let i = 0; i < s; i++) cols[i] = (Math.min(Math.max(x0 + i, 0), width - 1) - ox) * 4;
  const rowAt = (j) => (Math.min(Math.max(y0 + j, 0), height - 1) - oy) * stride * 4;
  if (s === n) {                                     // Pillow does not resize at all: plain copy
    for (let j = 0, d = 0; j < n; j++) {
      const r = rowAt(j);
      for (let i = 0; i < n; i++, d += 4) {
        const p = r + cols[i];
        out[d] = data[p]; out[d + 1] = data[p + 1]; out[d + 2] = data[p + 2]; out[d + 3] = 255;
      }
    }
    return;
  }
  const H = scratch.coeffsFor(s, n);                 // same weights for rows and columns (square)
  const { ksize, bounds, kk } = H;
  const yFirst = bounds[0], yLast = bounds[2 * n - 2] + bounds[2 * n - 1];
  // Pass 1 (horizontal): only the source rows the vertical pass will use.
  const tmp = scratch.tmpBuffer((yLast - yFirst) * n * 3);
  for (let j = yFirst, t = 0; j < yLast; j++) {
    const r = rowAt(j);
    for (let xx = 0; xx < n; xx++, t += 3) {
      const xmin = bounds[2 * xx], xmax = bounds[2 * xx + 1], kb = xx * ksize;
      let s0 = HALF, s1 = HALF, s2 = HALF;
      for (let x = 0; x < xmax; x++) {
        const p = r + cols[xmin + x], k = kk[kb + x];
        s0 += data[p] * k; s1 += data[p + 1] * k; s2 += data[p + 2] * k;
      }
      tmp[t] = clip8(s0); tmp[t + 1] = clip8(s1); tmp[t + 2] = clip8(s2);
    }
  }
  // Pass 2 (vertical).
  for (let yy = 0, d = 0; yy < n; yy++) {
    const ymin = bounds[2 * yy] - yFirst, ymax = bounds[2 * yy + 1], kb = yy * ksize;
    for (let xx = 0; xx < n; xx++, d += 4) {
      let s0 = HALF, s1 = HALF, s2 = HALF;
      for (let y = 0; y < ymax; y++) {
        const t = ((ymin + y) * n + xx) * 3, k = kk[kb + y];
        s0 += tmp[t] * k; s1 += tmp[t + 1] * k; s2 += tmp[t + 2] * k;
      }
      out[d] = clip8(s0); out[d + 1] = clip8(s1); out[d + 2] = clip8(s2); out[d + 3] = 255;
    }
  }
}

// train.py's centre_view(): torch grid_sample (bilinear, align_corners=False, border) that maps the
// middle 1/1.6 of an 80x80 crop onto 64x64. Torch keeps floats; we round to whole numbers (<= 0.5 off).
function centreView(src, out) {
  for (let yy = 0, d = 0; yy < SIZE; yy++) {
    const fy = sampleAt(yy);
    const y0 = Math.floor(fy), wy = fy - y0, y1 = Math.min(y0 + 1, STORE - 1);
    for (let xx = 0; xx < SIZE; xx++, d += 4) {
      const fx = sampleAt(xx);
      const x0 = Math.floor(fx), wx = fx - x0, x1 = Math.min(x0 + 1, STORE - 1);
      const p00 = (y0 * STORE + x0) * 4, p01 = (y0 * STORE + x1) * 4, p10 = (y1 * STORE + x0) * 4, p11 = (y1 * STORE + x1) * 4;
      for (let c = 0; c < 3; c++) {
        out[d + c] = (src[p00 + c] * (1 - wx) + src[p01 + c] * wx) * (1 - wy) + (src[p10 + c] * (1 - wx) + src[p11 + c] * wx) * wy;
      }
      out[d + 3] = 255;
    }
  }
}

function sampleAt(i) {
  const g = ((2 * i + 1) / SIZE - 1) / STORE_SCALE;            // normalised -1..1 position in the 80 px crop
  return Math.min(Math.max(((g + 1) * STORE - 1) / 2, 0), STORE - 1);
}

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
