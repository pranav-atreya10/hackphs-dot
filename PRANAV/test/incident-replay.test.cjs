'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RING_BUFFER_URL = pathToFileURL(
  path.join(__dirname, '../public/js/incident-ring-buffer.mjs'),
).href;
const REPLAY_UI_URL = pathToFileURL(
  path.join(__dirname, '../public/js/incident-replay-ui.mjs'),
).href;

let modulePromise = null;
function loadModules() {
  if (!modulePromise) {
    modulePromise = Promise.all([import(RING_BUFFER_URL), import(REPLAY_UI_URL)]).then(
      ([ringMod, uiMod]) => ({ ringMod, uiMod }),
    );
  }
  return modulePromise;
}

/* ---------- Lightweight mock DOM + canvas spy harness ---------- */

function createMockDomHarness() {
  const rafQueue = new Map();
  let nextRafId = 1;
  let nowValue = 1000;

  function createCanvasContextSpy(canvas) {
    const ops = [];
    return {
      ops,
      canvas,
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      font: '11px monospace',
      save() { ops.push({ type: 'save' }); },
      restore() { ops.push({ type: 'restore' }); },
      clearRect(x, y, w, h) { ops.push({ type: 'clearRect', x, y, w, h }); },
      fillRect(x, y, w, h) {
        ops.push({ type: 'fillRect', x, y, w, h, fillStyle: this.fillStyle });
      },
      strokeRect(x, y, w, h) {
        ops.push({
          type: 'strokeRect',
          x,
          y,
          w,
          h,
          strokeStyle: this.strokeStyle,
          lineWidth: this.lineWidth,
        });
      },
      fillText(text, x, y) {
        ops.push({ type: 'fillText', text: String(text), x, y, fillStyle: this.fillStyle });
      },
      putImageData(imgData, x, y) {
        ops.push({
          type: 'putImageData',
          width: imgData.width,
          height: imgData.height,
          byteLength: imgData.data.byteLength,
          firstPixel: Array.from(imgData.data.slice(0, 4)),
          x,
          y,
        });
      },
      createImageData(w, h) {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      },
      drawImage(src, x, y, w, h) {
        ops.push({ type: 'drawImage', src, x, y, w, h });
      },
      measureText(text) {
        return { width: String(text).length * 7 };
      },
    };
  }

  function createElement(tagName) {
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    let ctxSpy = null;

    const el = {
      nodeType: 1,
      tagName: String(tagName).toUpperCase(),
      ownerDocument: null,
      parentNode: null,
      className: '',
      textContent: '',
      value: '',
      type: '',
      min: '',
      max: '',
      step: '',
      hidden: false,
      disabled: false,
      width: 320,
      height: 240,
      dataset: {},
      style: {},
      children: [],
      classList: {
        get values() { return [...classes]; },
        add(...names) { for (const n of names) if (n) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); },
      },
      setAttribute(name, val) {
        const key = String(name).toLowerCase();
        const str = String(val);
        attrs.set(key, str);
        if (key === 'class') {
          classes.clear();
          for (const part of str.split(/\s+/).filter(Boolean)) classes.add(part);
          this.className = str;
        }
      },
      getAttribute(name) {
        return attrs.get(String(name).toLowerCase()) ?? null;
      },
      hasAttribute(name) {
        return attrs.has(String(name).toLowerCase());
      },
      removeAttribute(name) {
        attrs.delete(String(name).toLowerCase());
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      listenerCount(type) {
        return listeners.get(type)?.size ?? 0;
      },
      dispatch(type, eventInit = {}) {
        const set = listeners.get(type);
        let prevented = false;
        const evt = {
          type,
          target: this,
          ...eventInit,
          preventDefault() { prevented = true; },
          get defaultPrevented() { return prevented; },
        };
        if (set) {
          for (const fn of [...set]) fn(evt);
        }
        return evt;
      },
      append(...nodes) {
        for (const n of nodes) {
          if (n && typeof n === 'object') {
            n.parentNode = this;
            this.children.push(n);
          }
        }
      },
      appendChild(node) {
        if (node && typeof node === 'object') {
          node.parentNode = this;
          this.children.push(node);
        }
        return node;
      },
      remove() {
        if (this.parentNode && Array.isArray(this.parentNode.children)) {
          const idx = this.parentNode.children.indexOf(this);
          if (idx !== -1) this.parentNode.children.splice(idx, 1);
        }
        this.parentNode = null;
      },
      getContext(kind) {
        if (kind !== '2d') return null;
        if (!ctxSpy) ctxSpy = createCanvasContextSpy(this);
        return ctxSpy;
      },
    };
    return el;
  }

  const doc = {
    createElement(tag) {
      const el = createElement(tag);
      el.ownerDocument = doc;
      return el;
    },
  };

  function createWindow({ reducedMotion = false } = {}) {
    return {
      document: doc,
      matchMedia(query) {
        return {
          media: query,
          matches: /prefers-reduced-motion\s*:\s*reduce/i.test(query)
            ? Boolean(reducedMotion)
            : false,
        };
      },
      requestAnimationFrame(cb) {
        const id = nextRafId++;
        rafQueue.set(id, cb);
        return id;
      },
      cancelAnimationFrame(id) {
        rafQueue.delete(id);
      },
    };
  }

  function stepRaf(deltaMs) {
    nowValue += deltaMs;
    const pending = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of pending) {
      cb(nowValue);
    }
  }

  return {
    doc,
    rafQueue,
    now: () => nowValue,
    stepRaf,
    createWindow,
  };
}

/* ========================================================================== *
 *  1. incident-ring-buffer.mjs Suite                                         *
 * ========================================================================== */

describe('incident-ring-buffer.mjs', () => {
  test('validates options strictly and ignores DOM elements passed as options', async () => {
    const { ringMod } = await loadModules();
    const { createIncidentRingBuffer, DEFAULT_PRE_ALERT_MS, DEFAULT_POST_ALERT_MS, DEFAULT_WINDOW_MS } = ringMod;

    assert.equal(DEFAULT_PRE_ALERT_MS, 8000);
    assert.equal(DEFAULT_POST_ALERT_MS, 2000);
    assert.equal(DEFAULT_WINDOW_MS, 10000);

    assert.throws(() => createIncidentRingBuffer({ maxFramesPerCamera: 0 }), RangeError);
    assert.throws(() => createIncidentRingBuffer({ maxCameras: '6' }), TypeError);
    assert.throws(() => createIncidentRingBuffer({ maxIncidents: -1 }), RangeError);
    assert.throws(() => createIncidentRingBuffer({ minSampleGapMs: -5 }), RangeError);
    assert.throws(() => createIncidentRingBuffer({ windowMs: 0 }), RangeError);
    assert.throws(() => createIncidentRingBuffer({ createSnapshot: 'bad' }), TypeError);

    // Passing a DOM-like node with nodeType falls back to default options cleanly.
    const buf = createIncidentRingBuffer({ nodeType: 1, tagName: 'DIV' });
    assert.deepEqual(buf.stats(), {
      cameraCount: 0,
      frameCount: 0,
      incidentCount: 0,
      pendingCount: 0,
      estimatedBytes: 0,
    });
  });

  test('enforces sample validation, minSampleGapMs throttling, monotonic timestamps, and maxFramesPerCamera cap', async () => {
    const { ringMod } = await loadModules();
    const buf = ringMod.createIncidentRingBuffer({
      maxFramesPerCamera: 3,
      minSampleGapMs: 500,
      windowMs: 10000,
    });

    assert.deepEqual(buf.pushFrame(null), { accepted: false, reason: 'invalid-sample' });
    assert.deepEqual(buf.pushFrame({ airport: 'KJFK', cameraId: 'cam-1', streamId: 's1', generation: 'g1', atMs: NaN }), {
      accepted: false,
      reason: 'invalid-sample',
    });

    const base = { airport: 'KJFK', cameraId: 'cam-1', streamId: 's1', generation: 'g1' };
    assert.deepEqual(buf.pushFrame({ ...base, atMs: 1000, frameId: 'f1' }), { accepted: true, frameCount: 1 });

    // Throttled within 500ms gap
    assert.deepEqual(buf.pushFrame({ ...base, atMs: 1300, frameId: 'f-throttled' }), {
      accepted: false,
      reason: 'throttled',
    });

    // Non-monotonic (< lastAtMs 1300) rejected
    assert.deepEqual(buf.pushFrame({ ...base, atMs: 1200, frameId: 'f-backwards' }), {
      accepted: false,
      reason: 'nonmonotonic-time',
    });

    assert.deepEqual(buf.pushFrame({ ...base, atMs: 1600, frameId: 'f2' }), { accepted: true, frameCount: 2 });
    assert.deepEqual(buf.pushFrame({ ...base, atMs: 2200, frameId: 'f3' }), { accepted: true, frameCount: 3 });
    assert.deepEqual(buf.pushFrame({ ...base, atMs: 2800, frameId: 'f4' }), { accepted: true, frameCount: 3 });

    const clip = buf.captureIncidentClip('inc-cap', { airport: 'KJFK', cameraId: 'cam-1', atMs: 2800, seal: true });
    assert.deepEqual(clip.frames.map(f => f.frameId), ['f2', 'f3', 'f4']);
  });

  test('enforces maxCameras LRU eviction (sealing evicted pending clips) and maxIncidents cap', async () => {
    const { ringMod } = await loadModules();
    const buf = ringMod.createIncidentRingBuffer({
      maxCameras: 2,
      maxIncidents: 2,
      minSampleGapMs: 100,
    });

    buf.pushFrame({ airport: 'KJFK', cameraId: 'cam-a', streamId: 's1', generation: 'g1', atMs: 1000 });
    buf.pushFrame({ airport: 'KJFK', cameraId: 'cam-b', streamId: 's2', generation: 'g1', atMs: 1000 });

    const pendA = buf.captureIncidentClip('inc-1', { airport: 'KJFK', cameraId: 'cam-a', atMs: 1000 });
    assert.equal(pendA.sealed, false);
    assert.equal(buf.stats().pendingCount, 1);

    // Pushing a 3rd camera evicts oldest slot (cam-a) and seals its pending clip inc-1.
    buf.pushFrame({ airport: 'KJFK', cameraId: 'cam-c', streamId: 's3', generation: 'g1', atMs: 1200 });
    assert.equal(buf.stats().cameraCount, 2);
    assert.equal(buf.getIncidentClip('inc-1').sealed, true);
    assert.equal(buf.stats().pendingCount, 0);

    // Exceeding maxIncidents (2) evicts oldest incident (inc-1).
    buf.captureIncidentClip('inc-2', { airport: 'KJFK', cameraId: 'cam-b', atMs: 1000, seal: true });
    buf.captureIncidentClip('inc-3', { airport: 'KJFK', cameraId: 'cam-c', atMs: 1200, seal: true });
    assert.equal(buf.hasIncidentClip('inc-1'), false);
    assert.equal(buf.hasIncidentClip('inc-2'), true);
    assert.equal(buf.hasIncidentClip('inc-3'), true);
  });

  test('captures -8s pre-alert + +2s post-alert window, seals automatically or manually, and resets on stream/generation change', async () => {
    const { ringMod } = await loadModules();
    const buf = ringMod.createIncidentRingBuffer({
      preMs: 8000,
      postMs: 2000,
      windowMs: 10000,
      minSampleGapMs: 500,
    });

    const cam = { airport: 'KEWR', cameraId: 'north-rwy', streamId: 'stream-1', generation: 'gen-1' };
    // Push frames at t = 1000 (outside -8s of 10000), 2000 (-8s), 6000 (-4s), 10000 (0s alert)
    buf.pushFrame({ ...cam, atMs: 1000, frameId: 'too-early' });
    buf.pushFrame({ ...cam, atMs: 2000, frameId: 'pre-8s' });
    buf.pushFrame({ ...cam, atMs: 6000, frameId: 'pre-4s' });
    buf.pushFrame({ ...cam, atMs: 10000, frameId: 'alert-0s' });

    const initialClip = buf.captureIncidentClip('inc-window', {
      airport: 'KEWR',
      cameraId: 'north-rwy',
      atMs: 10000,
    });
    assert.equal(initialClip.sealed, false);
    assert.equal(initialClip.complete, false);
    assert.deepEqual(initialClip.frames.map(f => f.frameId), ['pre-8s', 'pre-4s', 'alert-0s']);
    assert.deepEqual(initialClip.frames.map(f => f.offsetMs), [-8000, -4000, 0]);
    assert.equal(initialClip.alertFrameIndex, 2);
    assert.equal(initialClip.frames[2].isAlertFrame, true);

    // Append +1.0s frame (still unsealed) and +2.0s frame (reaches windowEndMs = 12000 -> seals!)
    buf.pushFrame({ ...cam, atMs: 11000, frameId: 'post-1s' });
    assert.equal(buf.getIncidentClip('inc-window').sealed, false);
    assert.equal(buf.getIncidentClip('inc-window').frames.length, 4);

    buf.pushFrame({ ...cam, atMs: 12000, frameId: 'post-2s' });
    const sealedClip = buf.getIncidentClip('inc-window');
    assert.equal(sealedClip.sealed, true);
    assert.equal(sealedClip.complete, true);
    assert.deepEqual(
      sealedClip.frames.map(f => f.frameId),
      ['pre-8s', 'pre-4s', 'alert-0s', 'post-1s', 'post-2s'],
    );

    // Open a second pending clip, then verify manual sealIncidentClip & generation change reset
    const pend2 = buf.captureIncidentClip('inc-manual', {
      airport: 'KEWR',
      cameraId: 'north-rwy',
      atMs: 12000,
    });
    assert.equal(pend2.sealed, false);
    const manuallySealed = buf.sealIncidentClip('inc-manual');
    assert.equal(manuallySealed.sealed, true);

    const pendGen = buf.captureIncidentClip('inc-gen-reset', {
      airport: 'KEWR',
      cameraId: 'north-rwy',
      atMs: 12000,
    });
    assert.equal(pendGen.sealed, false);

    // Generation bump resets camera buffer and seals inc-gen-reset
    const afterReset = buf.pushFrame({
      airport: 'KEWR',
      cameraId: 'north-rwy',
      streamId: 'stream-1',
      generation: 'gen-2',
      atMs: 500,
      frameId: 'fresh-gen-frame',
    });
    assert.deepEqual(afterReset, { accepted: true, frameCount: 1 });
    assert.equal(buf.getIncidentClip('inc-gen-reset').sealed, true);
  });

  test('supports clearAirport, clearCamera, disconnect, downsampled RGBA snapshots, and deep track immutability', async () => {
    const { ringMod } = await loadModules();
    const buf = ringMod.createIncidentRingBuffer({
      maxWidth: 4,
      maxHeight: 2,
      minSampleGapMs: 100,
    });

    const callerBox = { x: 0.2, y: 0.3, w: 0.4, h: 0.5 };
    const callerTracks = [
      { id: 7, classification: 'drone', bbox: callerBox },
      { id: 8, classification: 'bird', bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, flap_hz: 7.2 },
      { id: 9, classification: 'rejected', bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
      { id: 10, classification: 'bird', missed: true, bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
    ];

    const srcPixels = new Uint8Array(8 * 4 * 4).fill(200);
    buf.pushFrame({
      airport: 'KJFK',
      cameraId: 'cam-1',
      streamId: 's1',
      generation: 'g1',
      atMs: 5000,
      width: 8,
      height: 4,
      frame: { width: 8, height: 4, data: srcPixels },
      tracks: callerTracks,
    });

    // Mutate caller inputs after pushFrame — stored snapshot & tracks must remain untouched!
    callerBox.x = 0.99;
    callerTracks[0].classification = 'bird';
    callerTracks.push({ id: 99, classification: 'drone', bbox: { x: 0, y: 0, w: 1, h: 1 } });
    srcPixels.fill(0);

    buf.pushFrame({
      airport: 'KBOS',
      cameraId: 'cam-2',
      streamId: 's2',
      generation: 'g1',
      atMs: 5000,
    });

    const jfkClip = buf.captureIncidentClip('inc-jfk', { airport: 'KJFK', cameraId: 'cam-1', atMs: 5000 });
    buf.captureIncidentClip('inc-bos', { airport: 'KBOS', cameraId: 'cam-2', atMs: 5000 });

    assert.equal(Object.isFrozen(jfkClip), true);
    assert.equal(Object.isFrozen(jfkClip.frames), true);
    assert.equal(jfkClip.frames[0].snapshot.kind, 'rgba');
    assert.equal(jfkClip.frames[0].snapshot.width, 4);
    assert.equal(jfkClip.frames[0].snapshot.height, 2);
    assert.equal(jfkClip.frames[0].snapshot.data[0], 200);
    assert.equal(jfkClip.frames[0].tracks.length, 2);
    assert.equal(jfkClip.frames[0].tracks[0].classification, 'drone');
    assert.equal(jfkClip.frames[0].tracks[0].bbox.x, 0.2);
    assert.equal(jfkClip.frames[0].tracks[1].flap_hz, 7.2);

    // clearCamera with includeIncidents: false seals pending clip for that camera without deleting it
    assert.deepEqual(buf.clearCamera('cam-1', { airport: 'KJFK', includeIncidents: false }), {
      clearedCameras: 1,
      clearedIncidents: 0,
    });
    assert.equal(buf.getIncidentClip('inc-jfk').sealed, true);

    // clearAirport('KBOS') removes KBOS camera + incident while preserving KJFK incident
    assert.deepEqual(buf.clearAirport('KBOS'), { clearedCameras: 1, clearedIncidents: 1 });
    assert.equal(buf.hasIncidentClip('inc-bos'), false);
    assert.equal(buf.hasIncidentClip('inc-jfk'), true);

    assert.deepEqual(buf.destroy(), { clearedCameras: 0, clearedIncidents: 1 });
    assert.equal(buf.stats().incidentCount, 0);
  });
});

/* ========================================================================== *
 *  2. incident-replay-ui.mjs Suite                                           *
 * ========================================================================== */

describe('incident-replay-ui.mjs', () => {
  test('formatRelativeOffsetMs formats negative, alert-zero, and positive offsets cleanly', async () => {
    const { uiMod } = await loadModules();
    const { formatRelativeOffsetMs } = uiMod;

    assert.equal(formatRelativeOffsetMs(-3200), '-3.2s');
    assert.equal(formatRelativeOffsetMs(0), 'ALERT 0.0s');
    assert.equal(formatRelativeOffsetMs(-20), 'ALERT 0.0s');
    assert.equal(formatRelativeOffsetMs(30, { includeAlertPrefix: false }), '0.0s');
    assert.equal(formatRelativeOffsetMs(1800), '+1.8s');
    assert.equal(formatRelativeOffsetMs(-140, { isAlert: true }), 'ALERT -0.1s');
    assert.equal(formatRelativeOffsetMs(NaN), 'ALERT 0.0s');
  });

  test('mounts exact incident-replay.css classes, renders tracks without mutation, scrubs, steps, loops, and cycles speeds', async () => {
    const { ringMod, uiMod } = await loadModules();
    const dom = createMockDomHarness();
    const win = dom.createWindow({ reducedMotion: false });
    const detailEl = dom.doc.createElement('div');

    const buf = ringMod.createIncidentRingBuffer({ minSampleGapMs: 400 });
    const cam = { airport: 'KJFK', cameraId: 'rwy-04l', streamId: 's1', generation: 'g1' };

    const pixelData = new Uint8ClampedArray(16 * 12 * 4);
    for (let i = 0; i < pixelData.length; i += 4) {
      pixelData[i] = 32;
      pixelData[i + 1] = 64;
      pixelData[i + 2] = 96;
      pixelData[i + 3] = 255;
    }

    buf.pushFrame({
      ...cam,
      atMs: 6800,
      frameId: 'f0',
      frame: { width: 16, height: 12, data: pixelData },
      tracks: [{ id: 3, classification: 'bird', bbox: { x: 0.1, y: 0.2, w: 0.25, h: 0.2 }, flap_hz: 6.5 }],
    });
    buf.pushFrame({
      ...cam,
      atMs: 10000,
      frameId: 'f1',
      frame: { label: 'alert-frame', color: '#141414' },
      tracks: [{ id: 7, classification: 'drone', bbox: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 } }],
    });
    buf.pushFrame({
      ...cam,
      atMs: 11800,
      frameId: 'f2',
      frame: { label: 'post-frame', color: '#181818' },
      tracks: [],
    });

    const rawClip = buf.captureIncidentClip('inc-ui-1', {
      airport: 'KJFK',
      cameraId: 'rwy-04l',
      atMs: 10000,
      seal: true,
    });

    // Wrap frame tracks in a mutation-detecting Proxy to prove strict read-only overlay behavior
    const mutations = [];
    const guardedClip = {
      ...rawClip,
      frames: rawClip.frames.map(f => ({
        ...f,
        tracks: f.tracks.map(tr => new Proxy(tr, {
          set(_t, prop) {
            mutations.push(String(prop));
            return true;
          },
        })),
      })),
    };

    const replay = uiMod.mountIncidentReplay(detailEl, {
      clip: guardedClip,
      doc: dom.doc,
      win,
      now: dom.now,
    });

    // Exact CSS class contract from PRANAV/public/css/incident-replay.css
    assert.equal(detailEl.children.length, 1);
    assert.equal(replay.element.classList.contains('incident-replay'), true);
    assert.equal(replay.canvas.classList.contains('incident-replay-canvas'), true);
    assert.equal(replay.badge.classList.contains('incident-replay-badge'), true);
    assert.equal(replay.playButton.classList.contains('incident-replay-play'), true);
    assert.equal(replay.prevButton.classList.contains('incident-replay-prev'), true);
    assert.equal(replay.nextButton.classList.contains('incident-replay-next'), true);
    assert.equal(replay.speedButton.classList.contains('incident-replay-speed'), true);
    assert.equal(replay.scrubber.classList.contains('incident-replay-scrubber'), true);
    assert.equal(replay.emptyEl.classList.contains('incident-replay-empty'), true);
    assert.equal(replay.emptyEl.hidden, true);

    // Normal motion starts playing at frame 0 (-3.2s, data-alert="false")
    assert.equal(replay.getState().playing, true);
    assert.equal(replay.playButton.getAttribute('aria-pressed'), 'true');
    assert.equal(replay.getState().frameIndex, 0);
    assert.equal(replay.badge.textContent, '-3.2s');
    assert.equal(replay.badge.getAttribute('data-alert'), 'false');

    const ctxOps = replay.canvas.getContext('2d').ops;
    assert.ok(ctxOps.some(op => op.type === 'putImageData' && op.width === 16 && op.height === 12));
    assert.ok(ctxOps.some(op => op.type === 'strokeRect'));
    assert.ok(ctxOps.some(op => op.type === 'fillText' && op.text.includes('BIRD #3 6.5Hz')));

    // Scrubbing to frame 1 pauses playback and activates data-alert="true" + ALERT 0.0s
    replay.scrubber.value = '1';
    replay.scrubber.dispatch('input');
    assert.equal(replay.getState().playing, false);
    assert.equal(replay.playButton.getAttribute('aria-pressed'), 'false');
    assert.equal(replay.getState().frameIndex, 1);
    assert.equal(replay.badge.textContent, 'ALERT 0.0s');
    assert.equal(replay.badge.getAttribute('data-alert'), 'true');
    assert.ok(ctxOps.some(op => op.type === 'fillText' && op.text.includes('DRONE #7')));

    // Next button & keyboard ArrowLeft / ArrowRight step frames cleanly
    replay.nextButton.dispatch('click');
    assert.equal(replay.getState().frameIndex, 2);
    assert.equal(replay.badge.textContent, '+1.8s');
    assert.equal(replay.badge.getAttribute('data-alert'), 'false');

    const leftEvt = replay.element.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(leftEvt.defaultPrevented, true);
    assert.equal(replay.getState().frameIndex, 1);
    assert.equal(replay.badge.getAttribute('data-alert'), 'true');

    replay.prevButton.dispatch('click');
    assert.equal(replay.getState().frameIndex, 0);

    // Speed cycling: 1x -> 0.5x -> 0.25x -> 1x
    assert.equal(replay.speedButton.textContent, '1x');
    replay.speedButton.dispatch('click');
    assert.equal(replay.speedButton.textContent, '0.5x');
    assert.equal(replay.getState().speed, 0.5);
    replay.speedButton.dispatch('click');
    assert.equal(replay.speedButton.textContent, '0.25x');
    assert.equal(replay.getState().speed, 0.25);
    replay.speedButton.dispatch('click');
    assert.equal(replay.speedButton.textContent, '1x');
    assert.equal(replay.getState().speed, 1);

    // Play loop advances frames over rAF ticks and wraps back to 0
    replay.seekFrame(1); // frame 1 -> frame 2 delta is 1800ms
    replay.playButton.dispatch('click');
    assert.equal(replay.getState().playing, true);
    dom.stepRaf(1850);
    assert.equal(replay.getState().frameIndex, 2);
    dom.stepRaf(700); // wrap hold -> wraps back to frame 0
    assert.equal(replay.getState().frameIndex, 0);

    assert.deepEqual(mutations, []);

    // destroy() cancels rAF, removes listeners, and detaches element
    assert.ok(dom.rafQueue.size > 0);
    replay.destroy();
    assert.equal(dom.rafQueue.size, 0);
    assert.equal(detailEl.children.length, 0);
    assert.equal(replay.playButton.listenerCount('click'), 0);
    assert.equal(replay.scrubber.listenerCount('input'), 0);
    assert.equal(replay.element.listenerCount('keydown'), 0);
  });

  test('respects prefers-reduced-motion: reduce, shows empty fallback, and preserves scrub/speed across updateClip()', async () => {
    const { ringMod, uiMod } = await loadModules();
    const dom = createMockDomHarness();
    const reducedWin = dom.createWindow({ reducedMotion: true });
    const detailEl = dom.doc.createElement('div');

    // 1. Empty clip fallback (historical incident before page load)
    const replay = uiMod.mountIncidentReplay(detailEl, {
      clip: null,
      doc: dom.doc,
      win: reducedWin,
      now: dom.now,
    });
    assert.equal(replay.getState().hasFrames, false);
    assert.equal(replay.emptyEl.hidden, false);
    assert.match(replay.emptyEl.textContent, /No live 10-second replay clip/i);
    assert.equal(replay.scrubber.disabled, true);
    assert.equal(dom.rafQueue.size, 0);

    // 2. Populate unsealed clip under prefers-reduced-motion: reduce -> starts paused at alert frame
    const buf = ringMod.createIncidentRingBuffer({ minSampleGapMs: 400, postMs: 2000 });
    const cam = { airport: 'KLGA', cameraId: 'cam-rwy', streamId: 's1', generation: 'g1' };
    buf.pushFrame({ ...cam, atMs: 8000, frameId: 'pre-2s' });
    buf.pushFrame({ ...cam, atMs: 9000, frameId: 'pre-1s' });
    buf.pushFrame({ ...cam, atMs: 10000, frameId: 'alert-0s' });

    const pendingClip = buf.captureIncidentClip('inc-live', {
      airport: 'KLGA',
      cameraId: 'cam-rwy',
      atMs: 10000,
    });
    assert.equal(pendingClip.sealed, false);

    replay.updateClip(pendingClip);
    assert.equal(replay.emptyEl.hidden, true);
    assert.equal(replay.getState().reducedMotion, true);
    assert.equal(replay.getState().playing, false);
    assert.equal(replay.getState().sealed, false);
    assert.equal(replay.getState().frameIndex, 2); // alert-0s frame
    assert.equal(replay.badge.getAttribute('data-alert'), 'true');
    assert.equal(replay.statusEl.getAttribute('data-state'), 'capturing');
    assert.equal(dom.rafQueue.size, 0);

    // Operator scrubs to frame 1 (pre-1s) and sets speed to 0.5x while post-alert window is still capturing
    replay.seekFrame(1);
    replay.setSpeed(0.5);
    assert.equal(replay.getState().frameIndex, 1);
    assert.equal(replay.scrubber.max, '2');

    // Post-alert frames arrive (+1s and +2s) and seal the clip -> scrubber grows without losing frameIndex or speed!
    buf.pushFrame({ ...cam, atMs: 11000, frameId: 'post-1s' });
    buf.pushFrame({ ...cam, atMs: 12000, frameId: 'post-2s' });
    const sealedClip = buf.getIncidentClip('inc-live');
    assert.equal(sealedClip.sealed, true);

    replay.updateClip(sealedClip);
    assert.equal(replay.getState().sealed, true);
    assert.equal(replay.getState().frameCount, 5);
    assert.equal(replay.scrubber.max, '4');
    assert.equal(replay.getState().frameIndex, 1);
    assert.equal(replay.getState().speed, 0.5);
    assert.equal(replay.statusEl.getAttribute('data-state'), 'sealed');

    replay.destroy();
  });
});
