// COCO-SSD second opinion for tracked objects.
//
// The detection engine finds and follows objects with pure pixel math (<1 ms/frame).
// This adapter occasionally crops one tracked object from the FULL-resolution camera
// image, enlarges it, and asks COCO-SSD (a pretrained TensorFlow.js object detector)
// what it is. The answer goes back into the engine via engine.applyLabel(), where it
// is fused with the wingbeat verdict (see classifyTrack in engine.js).
//
// Why crops and not the whole frame: COCO-SSD shrinks its input to ~300 px. A 10 px
// bird in a 1920 px frame would shrink to ~1.5 px and vanish. A crop around the bird,
// enlarged to 300 px, gives the model a fair look.
//
// Usage:
//   const coco = new CocoVerifier(engine);
//   await coco.load();          // ~1-5 s the first time (downloads TF.js + weights)
//   coco.start(videoElement);   // checks one object every ~0.7 s
//   coco.stats                  // load/inference timings for the UI

import { loadScript, loadTensorFlow, sourceSize, CDN } from './tf.js';

// COCO classes that make sense in the sky. COCO has no "drone" class; small drones
// usually come back as airplane, kite or bird, which is why sound fusion matters.
export const SKY_CLASSES = ['bird', 'airplane', 'kite'];

export const COCO_DEFAULTS = {
  base: 'lite_mobilenet_v2', // 'lite_mobilenet_v2' (fast, phone) | 'mobilenet_v1' | 'mobilenet_v2' (accurate, laptop)
  backend: undefined,        // 'webgl' | 'wasm' | 'cpu'; undefined = TF.js picks the best available
  intervalMs: 700,           // how often to check one object
  cropSize: 300,             // crops are resized to this (COCO-SSD's native input is ~300 px)
  pad: 0.6,                  // context around the object, as a fraction of its size on each side
  minCropPx: 48,             // never crop smaller than this (too little context)
  minScore: 0.2,             // ask COCO for boxes at least this confident (engine applies its own thresholds)
  maxBoxes: 6,
  centerTolerance: 0.75,     // a COCO box counts as "our object" if its centre is within the object box grown by 75%
  budgetMs: 150,             // if an inference takes longer than this, slow the check rate down
  maxIntervalMs: 4000,
};

export class CocoVerifier {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.opts = { ...COCO_DEFAULTS, ...opts };
    this.model = null;
    this.source = null;
    this.timer = null;
    this.busy = false;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.opts.cropSize;
    this.ctx = this.canvas.getContext('2d');
    this.stats = {
      state: 'idle', backend: null, tfVersion: null, loadMs: null, warmupMs: null,
      inferences: 0, lastMs: null, avgMs: null, intervalMs: this.opts.intervalMs, errors: 0, lastResult: null,
    };
  }

  async load() {
    if (this.model) return this.stats;
    this.stats.state = 'loading';
    const t0 = performance.now();
    try {
      const { backend, version } = await loadTensorFlow({ backend: this.opts.backend });
      if (!window.cocoSsd) await loadScript(CDN.cocoSsd);
      this.model = await window.cocoSsd.load({ base: this.opts.base });
      this.stats.loadMs = Math.round(performance.now() - t0);
      this.stats.backend = backend;
      this.stats.tfVersion = version;

      // The first inference compiles GPU shaders and can take seconds. Do it now on a
      // blank image so the first real check (maybe during the demo) is fast.
      const t1 = performance.now();
      this.ctx.fillStyle = '#87b5e6';
      this.ctx.fillRect(0, 0, this.opts.cropSize, this.opts.cropSize);
      await this.model.detect(this.canvas, 1, 0.99);
      this.stats.warmupMs = Math.round(performance.now() - t1);
      this.stats.state = 'ready';
    } catch (e) {
      this.stats.state = 'failed';
      this.stats.error = e.message;
      throw e;
    }
    return this.stats;
  }

  // source: the <video> (or canvas/img) the engine's frames come from, at full resolution.
  start(source) {
    this.source = source;
    if (this.timer) return;
    const loop = async () => {
      await this.tick();
      this.timer = setTimeout(loop, this.stats.intervalMs);
    };
    this.timer = setTimeout(loop, this.stats.intervalMs);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // One check: pick the best candidate, classify its crop, report back to the engine.
  async tick() {
    if (!this.model || this.busy || !this.source) return null;
    if (typeof document !== 'undefined' && document.hidden) return null; // tab in background
    const dims = sourceSize(this.source);
    if (!dims) return null;
    const [cand] = this.engine.cocoCandidates({ sourceWidth: dims.width, sourceHeight: dims.height, max: 1 });
    if (!cand) return null;
    this.busy = true;
    try {
      const r = await this.classifyBox(this.source, cand.bbox, dims);
      this.engine.applyLabel(cand.id, r.label, r.score, 'coco', { top: r.relevant.slice(0, 3), ms: r.ms });
      this.stats.lastResult = { track_id: cand.id, label: r.label, score: r.score, ms: r.ms, crop: r.crop };
      this.adapt(r.ms);
      return this.stats.lastResult;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = e.message;
      return null;
    } finally {
      this.busy = false;
    }
  }

  // Classify a normalized box {x, y, w, h} of `source`. Usable on its own (e.g. a test image).
  async classifyBox(source, bbox, dims = sourceSize(source)) {
    const o = this.opts;
    const crop = cropRect(bbox, dims, o.pad, o.minCropPx);
    this.ctx.drawImage(source, crop.sx, crop.sy, crop.side, crop.side, 0, 0, o.cropSize, o.cropSize);
    const t0 = performance.now();
    const preds = await this.model.detect(this.canvas, o.maxBoxes, o.minScore);
    const ms = performance.now() - t0;
    const r = interpretPredictions(preds, crop.obj, o.cropSize, o.centerTolerance);
    return { ...r, ms: Math.round(ms), crop };
  }

  // Keep the checks inside the time budget so COCO never starves the main loop.
  adapt(ms) {
    const s = this.stats;
    s.inferences++;
    s.lastMs = ms;
    s.avgMs = s.avgMs === null ? ms : Math.round(s.avgMs * 0.8 + ms * 0.2);
    const o = this.opts;
    if (s.avgMs > o.budgetMs) s.intervalMs = Math.min(o.maxIntervalMs, Math.round(s.intervalMs * 1.5));
    else if (s.intervalMs > o.intervalMs) s.intervalMs = Math.max(o.intervalMs, Math.round(s.intervalMs / 1.2));
  }
}

// Square crop around a normalized box, padded for context, clamped inside the frame.
// Returns source-pixel crop + where the object sits inside the crop (normalized 0..1).
export function cropRect(b, { width, height }, pad, minCropPx) {
  const bw = b.w * width, bh = b.h * height;
  const cx = (b.x + b.w / 2) * width, cy = (b.y + b.h / 2) * height;
  let side = Math.max(bw, bh) * (1 + 2 * pad);
  side = Math.min(Math.max(side, minCropPx), width, height);
  const sx = Math.min(Math.max(0, cx - side / 2), width - side);
  const sy = Math.min(Math.max(0, cy - side / 2), height - side);
  return {
    sx, sy, side,
    obj: { x: (b.x * width - sx) / side, y: (b.y * height - sy) / side, w: bw / side, h: bh / side },
  };
}

// Keep only COCO boxes centred on our object, prefer sky classes, return the best.
export function interpretPredictions(preds, obj, cropSize, tolerance) {
  const gx = obj.w * tolerance, gy = obj.h * tolerance;
  const minPad = 0.05; // tiny objects: allow at least 5% of the crop
  const x0 = obj.x - Math.max(gx, minPad), x1 = obj.x + obj.w + Math.max(gx, minPad);
  const y0 = obj.y - Math.max(gy, minPad), y1 = obj.y + obj.h + Math.max(gy, minPad);
  const relevant = [];
  for (const p of preds || []) {
    const [bx, by, bw, bh] = p.bbox;
    const cx = (bx + bw / 2) / cropSize, cy = (by + bh / 2) / cropSize;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) relevant.push({ label: p.class, score: +p.score.toFixed(3) });
  }
  relevant.sort((a, b) => b.score - a.score);
  const sky = relevant.find((p) => SKY_CLASSES.includes(p.label));
  const best = sky || relevant[0] || null;
  return { label: best ? best.label : null, score: best ? best.score : 0, relevant, ignored: (preds || []).length - relevant.length };
}
