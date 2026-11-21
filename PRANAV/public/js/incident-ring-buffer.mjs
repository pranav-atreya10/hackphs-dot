// Bounded per-camera 10s incident frame ring-buffer and post-alert clip capture.
// Advisory/read-only replay store: never mutates caller inputs or detector authority state.

export const DEFAULT_PRE_ALERT_MS = 8000;
export const DEFAULT_POST_ALERT_MS = 2000;
export const DEFAULT_WINDOW_MS = 10000;

const DEFAULT_MAX_FRAMES_PER_CAMERA = 20;
const DEFAULT_MAX_CAMERAS = 6;
const DEFAULT_MAX_INCIDENTS = 24;
const DEFAULT_MIN_SAMPLE_GAP_MS = 450;
const DEFAULT_MAX_WIDTH = 320;
const DEFAULT_MAX_HEIGHT = 240;

const EMPTY_ARRAY = Object.freeze([]);
const REJECT_INVALID_SAMPLE = Object.freeze({ accepted: false, reason: 'invalid-sample' });
const REJECT_NONMONOTONIC = Object.freeze({ accepted: false, reason: 'nonmonotonic-time' });
const REJECT_THROTTLED = Object.freeze({ accepted: false, reason: 'throttled' });

function normalizeId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPositiveIntOption(raw, name, fallback) {
  const value = raw[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number`);
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer >= 1`);
  }
  return value;
}

function readPositiveFiniteOption(raw, name, fallback) {
  const value = raw[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number`);
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function readNonNegativeFiniteOption(raw, name, fallback) {
  const value = raw[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0`);
  }
  return value;
}

function resolveOptions(options) {
  const raw = options &&
    typeof options === 'object' &&
    !Array.isArray(options) &&
    typeof options.nodeType !== 'number'
    ? options
    : {};

  const maxFramesPerCamera = readPositiveIntOption(raw, 'maxFramesPerCamera', DEFAULT_MAX_FRAMES_PER_CAMERA);
  const maxCameras = readPositiveIntOption(raw, 'maxCameras', DEFAULT_MAX_CAMERAS);
  const maxIncidents = readPositiveIntOption(raw, 'maxIncidents', DEFAULT_MAX_INCIDENTS);
  const minSampleGapMs = readNonNegativeFiniteOption(raw, 'minSampleGapMs', DEFAULT_MIN_SAMPLE_GAP_MS);
  const windowMs = readPositiveFiniteOption(raw, 'windowMs', DEFAULT_WINDOW_MS);
  const preMs = readNonNegativeFiniteOption(raw, 'preMs', DEFAULT_PRE_ALERT_MS);
  const postMs = readNonNegativeFiniteOption(raw, 'postMs', DEFAULT_POST_ALERT_MS);
  const maxWidth = readPositiveIntOption(raw, 'maxWidth', DEFAULT_MAX_WIDTH);
  const maxHeight = readPositiveIntOption(raw, 'maxHeight', DEFAULT_MAX_HEIGHT);

  const createSnapshot = raw.createSnapshot === undefined ? null : raw.createSnapshot;
  if (createSnapshot !== null && typeof createSnapshot !== 'function') {
    throw new TypeError('createSnapshot must be a function or null');
  }

  return {
    maxFramesPerCamera,
    maxCameras,
    maxIncidents,
    minSampleGapMs,
    windowMs,
    preMs,
    postMs,
    maxWidth,
    maxHeight,
    createSnapshot,
  };
}

function positiveDimension(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : 0;
}

function inferSourceDimensions(sample, maxWidth, maxHeight) {
  const frame = sample.frame;
  const frameObj = frame && typeof frame === 'object' ? frame : null;

  const srcW = positiveDimension(sample.width) ||
    positiveDimension(frameObj?.videoWidth) ||
    positiveDimension(frameObj?.naturalWidth) ||
    positiveDimension(frameObj?.displayWidth) ||
    positiveDimension(frameObj?.width) ||
    maxWidth;

  const srcH = positiveDimension(sample.height) ||
    positiveDimension(frameObj?.videoHeight) ||
    positiveDimension(frameObj?.naturalHeight) ||
    positiveDimension(frameObj?.displayHeight) ||
    positiveDimension(frameObj?.height) ||
    maxHeight;

  return { srcW, srcH };
}

function fitDimensions(srcW, srcH, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth / srcW, maxHeight / srcH);
  const targetW = Math.max(1, Math.min(maxWidth, Math.round(srcW * scale)));
  const targetH = Math.max(1, Math.min(maxHeight, Math.round(srcH * scale)));
  return { targetW, targetH };
}

function downsampleRgba(frame, maxWidth, maxHeight, fallbackW, fallbackH) {
  const inW = positiveDimension(frame.width) || fallbackW;
  const inH = positiveDimension(frame.height) || fallbackH;
  const { targetW, targetH } = fitDimensions(inW, inH, maxWidth, maxHeight);
  const view = frame.data;
  const srcBytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const copy = new Uint8ClampedArray(targetW * targetH * 4);

  if (targetW === inW && targetH === inH) {
    copy.set(srcBytes.subarray(0, Math.min(copy.length, srcBytes.length)));
  } else {
    for (let y = 0; y < targetH; y++) {
      const sy = Math.min(inH - 1, Math.floor((y * inH) / targetH));
      const srcRow = sy * inW * 4;
      const dstRow = y * targetW * 4;
      for (let x = 0; x < targetW; x++) {
        const sx = Math.min(inW - 1, Math.floor((x * inW) / targetW));
        const si = srcRow + sx * 4;
        const di = dstRow + x * 4;
        copy[di] = srcBytes[si] ?? 0;
        copy[di + 1] = srcBytes[si + 1] ?? 0;
        copy[di + 2] = srcBytes[si + 2] ?? 0;
        copy[di + 3] = srcBytes[si + 3] ?? 0;
      }
    }
  }

  return Object.freeze({
    kind: 'rgba',
    width: targetW,
    height: targetH,
    byteLength: copy.byteLength,
    data: copy,
  });
}

function isBrowserDrawableSource(frame) {
  if (!frame || typeof frame !== 'object') return false;
  if (typeof HTMLVideoElement !== 'undefined' && frame instanceof HTMLVideoElement) return true;
  if (typeof HTMLCanvasElement !== 'undefined' && frame instanceof HTMLCanvasElement) return true;
  if (typeof HTMLImageElement !== 'undefined' && frame instanceof HTMLImageElement) return true;
  if (typeof OffscreenCanvas !== 'undefined' && frame instanceof OffscreenCanvas) return true;
  if (typeof ImageBitmap !== 'undefined' && frame instanceof ImageBitmap) return true;
  if (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame) return true;
  if (frame.nodeType === 1 && typeof frame.tagName === 'string' && /^(?:VIDEO|CANVAS|IMG)$/i.test(frame.tagName)) {
    return true;
  }
  if (typeof frame.getContext === 'function') return true;
  if (
    typeof frame.close === 'function' &&
    typeof frame.width === 'number' &&
    typeof frame.height === 'number' &&
    !('tag' in frame) &&
    !('label' in frame)
  ) {
    return true;
  }
  return false;
}

function createCompactCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    if (canvas && typeof canvas === 'object') {
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
  }
  return null;
}

function tryDrawableSnapshot(frame, targetW, targetH) {
  if (!isBrowserDrawableSource(frame)) return null;
  try {
    const surface = createCompactCanvas(targetW, targetH);
    if (!surface || typeof surface.getContext !== 'function') return null;
    const ctx = surface.getContext('2d');
    if (!ctx || typeof ctx.drawImage !== 'function') return null;
    ctx.drawImage(frame, 0, 0, targetW, targetH);
    return Object.freeze({
      kind: 'canvas',
      width: targetW,
      height: targetH,
      byteLength: targetW * targetH * 4,
      canvas: surface,
    });
  } catch {
    return null;
  }
}

function createDescriptorSnapshot(frame, targetW, targetH) {
  const frameObj = frame && typeof frame === 'object' ? frame : null;
  const rawTag = frameObj?.tag ?? frameObj?.id ?? frameObj?.label ?? (typeof frame === 'string' ? frame : null);
  const tag = typeof rawTag === 'string' || typeof rawTag === 'number' ? rawTag : null;
  const descriptor = {
    kind: 'descriptor',
    width: targetW,
    height: targetH,
    byteLength: 64,
    tag,
  };
  if (typeof frameObj?.label === 'string') descriptor.label = frameObj.label;
  if (typeof frameObj?.color === 'string') descriptor.color = frameObj.color;
  return Object.freeze(descriptor);
}

function normalizeCustomSnapshot(result, targetW, targetH) {
  if (!result || typeof result !== 'object') {
    return Object.freeze({
      kind: 'custom',
      width: targetW,
      height: targetH,
      byteLength: 64,
      value: result ?? null,
    });
  }
  if (ArrayBuffer.isView(result)) {
    const copy = new Uint8ClampedArray(result.byteLength);
    copy.set(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
    return Object.freeze({
      kind: 'rgba',
      width: targetW,
      height: targetH,
      byteLength: copy.byteLength,
      data: copy,
    });
  }
  const proto = Object.getPrototypeOf(result);
  if (proto === Object.prototype || proto === null) {
    const width = positiveDimension(result.width) || targetW;
    const height = positiveDimension(result.height) || targetH;
    const inferredBytes = Number.isFinite(result.byteLength) && result.byteLength >= 0
      ? Math.round(result.byteLength)
      : (ArrayBuffer.isView(result.data) ? result.data.byteLength : 64);
    return Object.freeze({
      ...result,
      width,
      height,
      byteLength: inferredBytes,
    });
  }
  return result;
}

function buildSnapshot(sample, config) {
  const { maxWidth, maxHeight, createSnapshot } = config;
  const { srcW, srcH } = inferSourceDimensions(sample, maxWidth, maxHeight);
  const { targetW, targetH } = fitDimensions(srcW, srcH, maxWidth, maxHeight);
  const frame = sample.frame ?? null;

  if (typeof createSnapshot === 'function') {
    const meta = Object.freeze({
      width: targetW,
      height: targetH,
      maxWidth,
      maxHeight,
      sourceWidth: srcW,
      sourceHeight: srcH,
    });
    return normalizeCustomSnapshot(createSnapshot(frame, meta), targetW, targetH);
  }

  if (frame && typeof frame === 'object' && ArrayBuffer.isView(frame.data)) {
    return downsampleRgba(frame, maxWidth, maxHeight, srcW, srcH);
  }

  const drawn = tryDrawableSnapshot(frame, targetW, targetH);
  if (drawn) return drawn;

  return createDescriptorSnapshot(frame, targetW, targetH);
}

function sanitizeTracks(rawTracks) {
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) {
    return EMPTY_ARRAY;
  }
  const clean = [];
  for (let i = 0; i < rawTracks.length; i++) {
    const item = rawTracks[i];
    if (!item || typeof item !== 'object') continue;
    if (item.missed || item.classification === 'rejected') continue;
    const box = item.bbox;
    if (!box || typeof box !== 'object') continue;
    if (
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !Number.isFinite(box.w) ||
      !Number.isFinite(box.h)
    ) {
      continue;
    }
    const cls = typeof item.classification === 'string' ? item.classification : 'unknown';
    const bbox = Object.freeze({
      x: Number(box.x),
      y: Number(box.y),
      w: Number(box.w),
      h: Number(box.h),
    });
    const entry = Number.isFinite(item.flap_hz)
      ? Object.freeze({
          id: item.id ?? null,
          classification: cls,
          bbox,
          flap_hz: Number(item.flap_hz),
        })
      : Object.freeze({
          id: item.id ?? null,
          classification: cls,
          bbox,
        });
    clean.push(entry);
  }
  return clean.length === 0 ? EMPTY_ARRAY : Object.freeze(clean);
}

function snapshotByteLength(snapshot) {
  if (snapshot && typeof snapshot === 'object') {
    if (Number.isFinite(snapshot.byteLength) && snapshot.byteLength >= 0) {
      return Math.round(snapshot.byteLength);
    }
    if (ArrayBuffer.isView(snapshot.data)) {
      return snapshot.data.byteLength;
    }
  }
  return 64;
}

function createFrozenClip(spec, rawFrames, sealed) {
  const {
    incidentId,
    airport,
    cameraId,
    streamId,
    generation,
    atMs,
    windowStartMs,
    windowEndMs,
  } = spec;

  let alertFrameIndex = -1;
  let bestAbsOffset = Infinity;
  for (let i = 0; i < rawFrames.length; i++) {
    const absOffset = Math.abs(rawFrames[i].atMs - atMs);
    if (absOffset < bestAbsOffset) {
      bestAbsOffset = absOffset;
      alertFrameIndex = i;
    }
  }

  const frames = rawFrames.length === 0
    ? EMPTY_ARRAY
    : Object.freeze(rawFrames.map((frame, index) => Object.freeze({
        index,
        frameId: frame.frameId,
        atMs: frame.atMs,
        offsetMs: frame.atMs - atMs,
        isAlertFrame: index === alertFrameIndex,
        width: frame.width,
        height: frame.height,
        snapshot: frame.snapshot,
        tracks: frame.tracks,
      })));

  const isSealed = Boolean(sealed);
  return Object.freeze({
    incidentId,
    airport,
    cameraId,
    streamId,
    generation,
    atMs,
    windowStartMs,
    windowEndMs,
    alertFrameIndex,
    complete: isSealed,
    sealed: isSealed,
    frames,
  });
}

export function createIncidentRingBuffer(options = {}) {
  const config = resolveOptions(options);
  const {
    maxFramesPerCamera,
    maxCameras,
    maxIncidents,
    minSampleGapMs,
    windowMs,
    preMs,
    postMs,
  } = config;

  const retentionMs = Math.max(windowMs, preMs);
  const cameras = new Map();
  const incidents = new Map();
  const pending = new Map();

  function cameraSlotKey(airport, cameraId) {
    return `${airport}\u0000${cameraId}`;
  }

  function finalizePendingEntry(pend) {
    pending.delete(pend.incidentId);
    if (incidents.has(pend.incidentId)) {
      const finalized = createFrozenClip(pend, pend.rawFrames, true);
      incidents.set(pend.incidentId, finalized);
      return finalized;
    }
    return null;
  }

  function sealPendingForSlot(airport, cameraId, streamId = null, generation = null) {
    for (const pend of [...pending.values()]) {
      if (pend.airport !== airport || pend.cameraId !== cameraId) continue;
      if (streamId !== null && pend.streamId !== streamId) continue;
      if (generation !== null && pend.generation !== generation) continue;
      finalizePendingEntry(pend);
    }
  }

  function advancePendingClock(airport, cameraId, streamId, generation, currentAtMs) {
    for (const pend of [...pending.values()]) {
      if (
        pend.airport !== airport ||
        pend.cameraId !== cameraId ||
        pend.streamId !== streamId ||
        pend.generation !== generation
      ) {
        continue;
      }
      if (currentAtMs >= pend.windowEndMs) {
        finalizePendingEntry(pend);
      }
    }
  }

  function appendFrameToPending(airport, cameraId, streamId, generation, storedFrame) {
    for (const pend of [...pending.values()]) {
      if (
        pend.airport !== airport ||
        pend.cameraId !== cameraId ||
        pend.streamId !== streamId ||
        pend.generation !== generation
      ) {
        continue;
      }
      if (storedFrame.atMs >= pend.windowStartMs && storedFrame.atMs <= pend.windowEndMs) {
        pend.rawFrames.push(storedFrame);
        if (pend.rawFrames.length > 1 && pend.rawFrames[pend.rawFrames.length - 2].atMs > storedFrame.atMs) {
          pend.rawFrames.sort((a, b) => a.atMs - b.atMs);
        }
        const reachedEnd = storedFrame.atMs >= pend.windowEndMs;
        const updatedClip = createFrozenClip(pend, pend.rawFrames, reachedEnd);
        incidents.set(pend.incidentId, updatedClip);
        if (reachedEnd) {
          pending.delete(pend.incidentId);
        }
      } else if (storedFrame.atMs >= pend.windowEndMs) {
        finalizePendingEntry(pend);
      }
    }
  }

  function enforceIncidentCap() {
    while (incidents.size > maxIncidents) {
      const oldestId = incidents.keys().next().value;
      if (oldestId === undefined) break;
      incidents.delete(oldestId);
      pending.delete(oldestId);
    }
  }

  function pushFrame(sample) {
    if (!sample || typeof sample !== 'object') {
      return REJECT_INVALID_SAMPLE;
    }

    const airport = normalizeId(sample.airport);
    const cameraId = normalizeId(sample.cameraId);
    const streamId = normalizeId(sample.streamId);
    const generation = normalizeId(sample.generation);
    const atMs = sample.atMs;

    if (!airport || !cameraId || !streamId || !generation || !Number.isFinite(atMs)) {
      return REJECT_INVALID_SAMPLE;
    }

    const slotKey = cameraSlotKey(airport, cameraId);
    let slot = cameras.get(slotKey);

    if (slot && (slot.streamId !== streamId || slot.generation !== generation)) {
      sealPendingForSlot(airport, cameraId, slot.streamId, slot.generation);
      slot.streamId = streamId;
      slot.generation = generation;
      slot.frames = [];
      slot.lastAtMs = -Infinity;
      slot.lastAcceptedAtMs = -Infinity;
    }

    if (slot) {
      if (atMs < slot.lastAtMs) {
        return REJECT_NONMONOTONIC;
      }
      if (slot.frames.length > 0 && atMs - slot.lastAcceptedAtMs < minSampleGapMs) {
        slot.lastAtMs = atMs;
        cameras.delete(slotKey);
        cameras.set(slotKey, slot);
        advancePendingClock(airport, cameraId, streamId, generation, atMs);
        return REJECT_THROTTLED;
      }
      cameras.delete(slotKey);
    } else {
      while (cameras.size >= maxCameras) {
        const oldestKey = cameras.keys().next().value;
        if (oldestKey === undefined) break;
        const evicted = cameras.get(oldestKey);
        cameras.delete(oldestKey);
        if (evicted) {
          sealPendingForSlot(evicted.airport, evicted.cameraId);
        }
      }
      slot = {
        airport,
        cameraId,
        streamId,
        generation,
        frames: [],
        lastAtMs: -Infinity,
        lastAcceptedAtMs: -Infinity,
      };
    }

    const rawFrameId = sample.frameId;
    const frameId = typeof rawFrameId === 'string' || (typeof rawFrameId === 'number' && Number.isFinite(rawFrameId))
      ? rawFrameId
      : null;

    const snapshot = buildSnapshot(sample, config);
    const tracks = sanitizeTracks(sample.tracks);
    const width = positiveDimension(snapshot?.width) || config.maxWidth;
    const height = positiveDimension(snapshot?.height) || config.maxHeight;

    const storedFrame = Object.freeze({
      frameId,
      atMs,
      width,
      height,
      snapshot,
      tracks,
    });

    const cutoffMs = atMs - retentionMs;
    while (slot.frames.length > 0 && slot.frames[0].atMs < cutoffMs) {
      slot.frames.shift();
    }

    slot.frames.push(storedFrame);
    while (slot.frames.length > maxFramesPerCamera) {
      slot.frames.shift();
    }

    slot.lastAtMs = atMs;
    slot.lastAcceptedAtMs = atMs;
    cameras.set(slotKey, slot);

    appendFrameToPending(airport, cameraId, streamId, generation, storedFrame);

    return Object.freeze({
      accepted: true,
      frameCount: slot.frames.length,
    });
  }

  function captureIncidentClip(incidentId, captureOptions = {}) {
    const normIncidentId = normalizeId(incidentId);
    if (!normIncidentId || !captureOptions || typeof captureOptions !== 'object') {
      return null;
    }

    const airport = normalizeId(captureOptions.airport);
    const cameraId = normalizeId(captureOptions.cameraId);
    const atMs = captureOptions.atMs;
    if (!airport || !cameraId || !Number.isFinite(atMs)) {
      return null;
    }

    const hasStreamFilter = captureOptions.streamId !== null && captureOptions.streamId !== undefined;
    const reqStreamId = hasStreamFilter ? normalizeId(captureOptions.streamId) : null;
    const hasGenFilter = captureOptions.generation !== null && captureOptions.generation !== undefined;
    const reqGeneration = hasGenFilter ? normalizeId(captureOptions.generation) : null;

    const slot = cameras.get(cameraSlotKey(airport, cameraId)) ?? null;
    const streamMatches = !hasStreamFilter || (reqStreamId !== null && slot?.streamId === reqStreamId);
    const generationMatches = !hasGenFilter || (reqGeneration !== null && slot?.generation === reqGeneration);
    const slotMatches = Boolean(slot && streamMatches && generationMatches);

    const matchedStreamId = slotMatches ? slot.streamId : reqStreamId;
    const matchedGeneration = slotMatches ? slot.generation : reqGeneration;
    const windowStartMs = atMs - preMs;
    const windowEndMs = atMs + postMs;

    const rawFrames = slotMatches
      ? slot.frames
          .filter(frame => frame.atMs >= windowStartMs && frame.atMs <= windowEndMs)
          .sort((a, b) => a.atMs - b.atMs)
      : [];

    const sealed = Boolean(captureOptions.seal) || !slotMatches || slot.lastAtMs >= windowEndMs;

    pending.delete(normIncidentId);
    incidents.delete(normIncidentId);

    const spec = {
      incidentId: normIncidentId,
      airport,
      cameraId,
      streamId: matchedStreamId,
      generation: matchedGeneration,
      atMs,
      windowStartMs,
      windowEndMs,
    };

    const clip = createFrozenClip(spec, rawFrames, sealed);
    incidents.set(normIncidentId, clip);

    if (!sealed) {
      pending.set(normIncidentId, {
        ...spec,
        rawFrames,
      });
    }

    enforceIncidentCap();
    return clip;
  }

  function getIncidentClip(incidentId) {
    const id = normalizeId(incidentId);
    if (!id) return null;
    return incidents.get(id) ?? null;
  }

  function hasIncidentClip(incidentId) {
    const id = normalizeId(incidentId);
    if (!id) return false;
    return incidents.has(id);
  }

  function sealIncidentClip(incidentId) {
    const id = normalizeId(incidentId);
    if (!id) return null;
    const existing = incidents.get(id) ?? null;
    if (!existing) {
      pending.delete(id);
      return null;
    }
    const pend = pending.get(id);
    if (pend) {
      return finalizePendingEntry(pend);
    }
    if (existing.sealed && existing.complete) {
      return existing;
    }
    const sealedClip = Object.freeze({
      ...existing,
      complete: true,
      sealed: true,
    });
    incidents.set(id, sealedClip);
    return sealedClip;
  }

  function clearAirport(airport) {
    const normAirport = normalizeId(airport);
    if (!normAirport) {
      return Object.freeze({ clearedCameras: 0, clearedIncidents: 0 });
    }

    let clearedCameras = 0;
    for (const [key, slot] of [...cameras.entries()]) {
      if (slot.airport === normAirport) {
        cameras.delete(key);
        clearedCameras++;
      }
    }

    for (const [incId, pend] of [...pending.entries()]) {
      if (pend.airport === normAirport) {
        pending.delete(incId);
      }
    }

    let clearedIncidents = 0;
    for (const [incId, clip] of [...incidents.entries()]) {
      if (clip.airport === normAirport) {
        incidents.delete(incId);
        clearedIncidents++;
      }
    }

    return Object.freeze({ clearedCameras, clearedIncidents });
  }

  function clearCamera(cameraId, clearOptions = {}) {
    const normCameraId = normalizeId(cameraId);
    if (!normCameraId) {
      return Object.freeze({ clearedCameras: 0, clearedIncidents: 0 });
    }

    const opts = clearOptions && typeof clearOptions === 'object' ? clearOptions : {};
    const hasAirportFilter = opts.airport !== null && opts.airport !== undefined;
    const normAirport = hasAirportFilter ? normalizeId(opts.airport) : null;
    if (hasAirportFilter && !normAirport) {
      return Object.freeze({ clearedCameras: 0, clearedIncidents: 0 });
    }

    const includeIncidents = opts.includeIncidents === undefined ? true : Boolean(opts.includeIncidents);
    const matchesCamera = (airportVal, camVal) =>
      camVal === normCameraId && (!hasAirportFilter || airportVal === normAirport);

    let clearedCameras = 0;
    for (const [key, slot] of [...cameras.entries()]) {
      if (matchesCamera(slot.airport, slot.cameraId)) {
        cameras.delete(key);
        clearedCameras++;
      }
    }

    for (const [incId, pend] of [...pending.entries()]) {
      if (!matchesCamera(pend.airport, pend.cameraId)) continue;
      if (includeIncidents) {
        pending.delete(incId);
      } else {
        finalizePendingEntry(pend);
      }
    }

    let clearedIncidents = 0;
    if (includeIncidents) {
      for (const [incId, clip] of [...incidents.entries()]) {
        if (matchesCamera(clip.airport, clip.cameraId)) {
          incidents.delete(incId);
          clearedIncidents++;
        }
      }
    }

    return Object.freeze({ clearedCameras, clearedIncidents });
  }

  function disconnect(disconnectOptions = {}) {
    const opts = disconnectOptions && typeof disconnectOptions === 'object' ? disconnectOptions : {};
    const keepIncidents = opts.keepIncidents === true;

    const clearedCameras = cameras.size;
    cameras.clear();

    if (keepIncidents) {
      for (const pend of [...pending.values()]) {
        finalizePendingEntry(pend);
      }
      return Object.freeze({ clearedCameras, clearedIncidents: 0 });
    }

    const clearedIncidents = incidents.size;
    pending.clear();
    incidents.clear();
    return Object.freeze({ clearedCameras, clearedIncidents });
  }

  function clear() {
    return disconnect({ keepIncidents: false });
  }

  function destroy() {
    return disconnect({ keepIncidents: false });
  }

  function stats() {
    let frameCount = 0;
    let estimatedBytes = 0;
    const countedSnapshots = new Set();

    for (const slot of cameras.values()) {
      frameCount += slot.frames.length;
      for (let i = 0; i < slot.frames.length; i++) {
        const frame = slot.frames[i];
        if (!countedSnapshots.has(frame.snapshot)) {
          countedSnapshots.add(frame.snapshot);
          estimatedBytes += snapshotByteLength(frame.snapshot);
        }
        estimatedBytes += 64 + frame.tracks.length * 64;
      }
    }

    for (const clip of incidents.values()) {
      for (let i = 0; i < clip.frames.length; i++) {
        const frame = clip.frames[i];
        if (!countedSnapshots.has(frame.snapshot)) {
          countedSnapshots.add(frame.snapshot);
          estimatedBytes += snapshotByteLength(frame.snapshot);
        }
        estimatedBytes += 64;
      }
    }

    return Object.freeze({
      cameraCount: cameras.size,
      frameCount,
      incidentCount: incidents.size,
      pendingCount: pending.size,
      estimatedBytes,
    });
  }

  return Object.freeze({
    pushFrame,
    record: pushFrame,
    captureIncidentClip,
    getIncidentClip,
    hasIncidentClip,
    sealIncidentClip,
    clearAirport,
    clearCamera,
    disconnect,
    clear,
    destroy,
    stats,
  });
}
