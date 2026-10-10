// Motion detection: find pixels that differ from a slowly learned background.
//
// Why a background model instead of "this frame minus last frame":
//  - Frame differencing only lights up the leading and trailing edges of a moving
//    object, so its size jumps around. Background subtraction gives the object's
//    whole silhouette, so the blob really grows and shrinks as the wings beat.
//  - Slow birds don't disappear, and slow cloud drift gets learned into the background.
//
// All buffers are allocated once per resolution and reused every frame.

import { rasterizePolygon } from './geometry.js';

export class MotionDetector {
  constructor(cfg) {
    this.cfg = cfg;
    this.w = 0;
    this.h = 0;
    this.frames = 0;
    this.cooldown = 0;
    this.noise = 0;          // running estimate of average |frame - background| in the sky
    this.maskPoly = [];
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    const n = w * h;
    this.gray = new Uint8Array(n);
    this.bg = new Float32Array(n);
    this.diff = new Uint8Array(n);   // |gray - bg|, kept for blob "contrast mass"
    this.fg = new Uint8Array(n);     // raw changed pixels (0/1)
    this.dil = new Uint8Array(n);    // fg grown by `dilate` (joins wing fragments)
    this.tmp = new Uint8Array(n);
    this.mask = new Uint8Array(n);   // 1 = sky we care about
    rasterizePolygon(this.maskPoly, w, h, this.mask);
    this.maskCount = countOnes(this.mask);
    this.frames = 0;
  }

  setSkyMask(polyNorm) {
    this.maskPoly = polyNorm || [];
    if (this.w) {
      rasterizePolygon(this.maskPoly, this.w, this.h, this.mask);
      this.maskCount = countOnes(this.mask);
    }
  }

  reset() {
    this.frames = 0;
    this.cooldown = 0;
  }

  // rgba: Uint8ClampedArray (w*h*4). Returns a summary; pixel buffers stay on `this`.
  process(rgba, w, h) {
    this.resize(w, h);
    const { gray, bg, diff, fg, mask } = this;
    const c = this.cfg;
    const n = w * h;

    for (let i = 0, j = 0; i < n; i++, j += 4) {
      gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    }

    if (this.frames === 0) {
      for (let i = 0; i < n; i++) bg[i] = gray[i];
      this.frames = 1;
      fg.fill(0);
      this.dil.fill(0);
      return { ready: false, shake: false, fgCount: 0, fgFraction: 0, threshold: c.threshold };
    }
    this.frames++;

    // Warm-up: fast, non-selective learning so anything sitting in the first frame
    // (a bird that then flies off) doesn't leave a ghost in the background.
    if (this.frames <= c.warmupFrames) {
      const wa = c.warmupAlpha;
      for (let i = 0; i < n; i++) bg[i] += wa * (gray[i] - bg[i]);
      fg.fill(0);
      this.dil.fill(0);
      return { ready: false, shake: false, fgCount: 0, fgFraction: 0, threshold: c.threshold };
    }

    const thr = Math.max(c.threshold, c.noiseK * this.noise);
    const a = c.bgAlpha;
    const aFg = c.bgAlphaFg;
    let fgCount = 0;
    let diffSum = 0;
    for (let i = 0; i < n; i++) {
      const g = gray[i];
      const b = bg[i];
      const d = g > b ? g - b : b - g;
      const di = d > 255 ? 255 : d | 0;
      diff[i] = di;
      const on = mask[i] && di > thr ? 1 : 0;
      fg[i] = on;
      if (mask[i]) {
        fgCount += on;
        if (!on) diffSum += di;
      }
      bg[i] = b + (on ? aFg : a) * (g - b);
    }

    const skyPixels = Math.max(1, this.maskCount);
    const fgFraction = fgCount / skyPixels;
    const meanNoise = diffSum / Math.max(1, skyPixels - fgCount);
    this.noise = this.noise === 0 ? meanNoise : this.noise * 0.95 + meanNoise * 0.05;

    // Camera shake or a sudden exposure change: relearn the background from this frame.
    if (fgFraction > c.shakeFraction) {
      bg.set(gray);
      fg.fill(0);
      this.dil.fill(0);
      this.cooldown = c.shakeCooldown;
      return { ready: false, shake: true, fgCount, fgFraction, threshold: thr };
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      fg.fill(0);
      this.dil.fill(0);
      return { ready: false, shake: true, fgCount: 0, fgFraction, threshold: thr };
    }

    dilate(fg, this.dil, this.tmp, w, h, c.dilate);
    return { ready: true, shake: false, fgCount, fgFraction, threshold: thr };
  }
}

// Ghost check. A real object looks different from the sky right next to it in the
// *current* picture. A ghost (sky the background wrongly remembers as dark, e.g. where
// a bird sat in the first frames) looks just like its surroundings now; it only
// differs from the stale background. Compare the blob with a ring of nearby sky.
// Returns { ghost, ratio }: ratio ~1 for real objects, ~0 for ghosts.
MotionDetector.prototype.checkGhost = function (blob, labels, cfg) {
  const { w, h, gray, diff, fg, dil, mask } = this;
  let inSum = 0, inN = 0, dSum = 0;
  for (let y = blob.minY; y < blob.maxY; y++) {
    for (let x = blob.minX; x < blob.maxX; x++) {
      const p = y * w + x;
      if (fg[p] && blob.parts.includes(labels[p])) { inSum += gray[p]; dSum += diff[p]; inN++; }
    }
  }
  const r = cfg.ringPx;
  const x0 = Math.max(0, blob.minX - r), x1 = Math.min(w, blob.maxX + r);
  const y0 = Math.max(0, blob.minY - r), y1 = Math.min(h, blob.maxY + r);
  let ringSum = 0, ringN = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * w + x;
      if (!dil[p] && mask[p]) { ringSum += gray[p]; ringN++; }
    }
  }
  if (!inN || ringN < cfg.minRingPixels) return { ghost: false, ratio: null };
  const contrastNow = Math.abs(inSum / inN - ringSum / ringN);
  const contrastToBg = dSum / inN;
  const ratio = contrastNow / Math.max(1, contrastToBg);
  return { ghost: ratio < cfg.ratio, ratio };
};

// Repair the background under a ghost so it disappears immediately.
MotionDetector.prototype.absorb = function (blob, labels) {
  const { w, gray, bg } = this;
  for (let y = blob.minY; y < blob.maxY; y++) {
    for (let x = blob.minX; x < blob.maxX; x++) {
      const p = y * w + x;
      if (blob.parts.includes(labels[p])) bg[p] = gray[p];
    }
  }
};

function countOnes(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

// Binary dilation with a (2r+1)x(2r+1) square, done as a horizontal then a vertical
// max-filter so the cost is O(pixels * r) instead of O(pixels * r^2).
export function dilate(src, dst, tmp, w, h, r) {
  if (r <= 0) {
    dst.set(src);
    return;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r >= w ? w - 1 : x + r;
      for (let k = x0; k <= x1 && !v; k++) v = src[row + k];
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r >= h ? h - 1 : y + r;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = y0; k <= y1 && !v; k++) v = tmp[k * w + x];
      dst[y * w + x] = v;
    }
  }
}
