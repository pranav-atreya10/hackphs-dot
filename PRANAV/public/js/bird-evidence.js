import { COCO_DEFAULTS, cropRect } from '../detection/adapters/coco.js';

export const MAX_FRAME_AGE = 2500;
const CHECK_COOLDOWN = 3000;
const FRAME_LIMIT = 4;
const STATE_LIMIT = 8;
const FRAME_PIXEL_BUDGET = 8_000_000;
const MAX_CROP_SIDE = 600;

export function validBox(box) {
  return !!box && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(box[k])) &&
    box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 &&
    box.x + box.w <= 1.001 && box.y + box.h <= 1.001;
}

function validIdentity({ streamId, frameId }) {
  return typeof streamId === 'string' && streamId.length > 0 &&
    Number.isSafeInteger(frameId) && frameId >= 0;
}

function trackKey(t, evidence, id) {
  return JSON.stringify([t.cameraId, evidence.source, evidence.frame.streamId, evidence.generation, id]);
}

// Owns decoded server frames only. Both messages can lead; neither is evidence by itself.
export class BirdFramePairs {
  frames = new Map();
  states = new Map();
  latest = null;
  pixels = 0;

  addFrame(frame) {
    if (!validIdentity(frame) || !Number.isFinite(frame.frameT) || !Number.isFinite(frame.frameReceivedAt)) {
      frame.bitmap.close();
      return;
    }
    if (this.latest && frame.frameReceivedAt - this.latest.frame.frameReceivedAt > MAX_FRAME_AGE) this.latest = null;
    const area = frame.bitmap.width * frame.bitmap.height;
    if (area > FRAME_PIXEL_BUDGET) { frame.bitmap.close(); return; }
    const key = this.key(frame);
    if (this.frames.has(key)) { frame.bitmap.close(); return; }
    this.frames.set(key, frame);
    this.pixels += area;
    this.match(key);
    for (const [id, evicted] of this.frames) {
      if (this.frames.size <= FRAME_LIMIT && this.pixels <= FRAME_PIXEL_BUDGET) break;
      if (evicted === this.latest?.frame) continue;
      this.frames.delete(id);
      this.pixels -= evicted.bitmap.width * evicted.bitmap.height;
      evicted.bitmap.close();
    }
  }

  addState(message) {
    if (!validIdentity(message) || !Number.isFinite(message.state?.t)) return;
    const key = this.key(message);
    this.states.set(key, message);
    this.match(key);
    if (this.states.size > STATE_LIMIT) this.states.delete(this.states.keys().next().value);
  }

  key({ streamId, frameId }) { return JSON.stringify([streamId, frameId]); }

  match(key) {
    const frame = this.frames.get(key), { state, generation = state?.generation } = this.states.get(key) || {};
    if (!frame || frame.frameT !== state?.t ||
        (this.latest && this.latest.frame.frameId >= frame.frameId)) return;
    this.latest = { source: 'server', state, frame, generation };
  }

  clear({ keepStates = false } = {}) {
    for (const frame of this.frames.values()) frame.bitmap.close();
    this.frames.clear();
    this.pixels = 0;
    if (!keepStates) this.states.clear();
    this.latest = null;
  }
}

export function pruneBirdAttempts(feeds, checked, cameraAttempts, now = Date.now()) {
  const activeCameras = new Set(), activeTracks = new Set(), awaitingEvidence = new Set();
  for (const t of feeds.values()) {
    if (t.offline || now - t.lastFrameAt > MAX_FRAME_AGE) continue;
    activeCameras.add(t.cameraId);
    const evidence = t.birdEvidence;
    if (!evidence) { awaitingEvidence.add(t.cameraId); continue; }
    for (const tr of evidence.state.tracks || []) activeTracks.add(trackKey(t, evidence, tr.id));
  }
  for (const key of checked.keys()) {
    if (!activeTracks.has(key) && !awaitingEvidence.has(JSON.parse(key)[0])) checked.delete(key);
  }
  for (const cameraId of cameraAttempts.keys()) {
    if (!activeCameras.has(cameraId)) cameraAttempts.delete(cameraId);
  }
}

export function chooseBirdCandidate(feeds, checked, now = Date.now(), cameraAttempts = new Map()) {
  let best = null;
  for (const t of feeds.values()) {
    const evidence = t.birdEvidence;
    if (!evidence || t.offline) continue;
    const { frame, source, state, generation } = evidence;
    const bitmap = frame.bitmap;
    const { streamId, frameId, frameT, frameReceivedAt } = frame;
    if (!validIdentity(frame) || !Number.isFinite(frameT) || frameT !== state?.t ||
      !Number.isFinite(frameReceivedAt) || now - frameReceivedAt > MAX_FRAME_AGE ||
      !bitmap?.width || !bitmap.height || state.shake || state.learning ||
      state.motion?.shake || (state.motion && !state.motion.ready)) continue;
    const cameraAt = cameraAttempts.get(t.cameraId) ?? -Infinity;
    for (const tr of state.tracks || []) {
      if (!Number.isSafeInteger(tr.id) || !validBox(tr.bbox) || tr.missed || tr.dense ||
          tr.classification === 'rejected' || tr.classification === 'debris') continue;
      const key = trackKey(t, evidence, tr.id);
      const trackAt = checked.get(key) ?? -Infinity;
      if (now - trackAt < CHECK_COOLDOWN) continue;
      const nativeWidth = tr.bbox.w * bitmap.width, nativeHeight = tr.bbox.h * bitmap.height;
      const px = Math.max(nativeWidth, nativeHeight);
      if (px < 24) continue; // Measured before resizing; enlargement does not add source detail.
      const priority = (tr.classification === 'unknown' ? 1000 : 0) + Math.min(px, 400);
      if (best && (cameraAt > best.cameraAt || (cameraAt === best.cameraAt &&
        (trackAt > best.trackAt || (trackAt === best.trackAt && priority <= best.priority))))) continue;
      best = { t, tr: { ...tr, bbox: { ...tr.bbox } }, key, streamId, frameId, frameT, frameReceivedAt,
        source, generation, nativeWidth, nativeHeight, evidence, cameraAt, trackAt, priority };
    }
  }
  return best;
}

export function captureBirdEvidence(candidate, options = COCO_DEFAULTS, createCanvas = () => document.createElement('canvas')) {
  const { t, evidence, tr, nativeWidth, nativeHeight } = candidate;
  if (t.birdEvidence !== evidence || t.offline) return null;
  const bitmap = evidence.frame.bitmap;
  const crop = cropRect(tr.bbox, bitmap, options.pad ?? COCO_DEFAULTS.pad, options.minCropPx ?? COCO_DEFAULTS.minCropPx);
  const canvas = createCanvas();
  // Keep source pixels where possible, but bound the detached evidence and never upscale here.
  canvas.width = canvas.height = Math.min(Math.floor(crop.side), MAX_CROP_SIDE);
  if (!canvas.width) return null;
  canvas.getContext('2d').drawImage(bitmap, crop.sx, crop.sy, crop.side, crop.side, 0, 0, canvas.width, canvas.height);
  return { canvas, bbox: crop.obj, nativeWidth, nativeHeight };
}

export function snapshotClassifierFrame(pair, createCanvas = () => document.createElement('canvas')) {
  const { frame, state } = pair || {};
  const bitmap = frame?.bitmap, { width, height } = bitmap || {};
  if (!Number.isFinite(frame?.frameT) || frame.frameT !== state?.t ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width * height > FRAME_PIXEL_BUDGET) return null;
  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not read the matched frame');
    // getImageData creates independent pixels, so transferring them cannot detach the feed's bitmap.
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    return { data, width, height };
  } finally {
    canvas.width = canvas.height = 0;
  }
}
