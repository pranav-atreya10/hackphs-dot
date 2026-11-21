const { test } = require('node:test');
const assert = require('node:assert/strict');

function createMockCanvasContext() {
  const ops = [];
  const state = {
    strokeStyle: '#000',
    fillStyle: '#000',
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textBaseline: 'alphabetic',
    textAlign: 'start',
  };
  const stack = [];
  let currentPath = [];

  return {
    ops,
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v) { state.fillStyle = v; },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v) { state.globalAlpha = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v) { state.lineWidth = v; },
    get lineCap() { return state.lineCap; },
    set lineCap(v) { state.lineCap = v; },
    get lineJoin() { return state.lineJoin; },
    set lineJoin(v) { state.lineJoin = v; },
    get font() { return state.font; },
    set font(v) { state.font = v; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(v) { state.textBaseline = v; },
    get textAlign() { return state.textAlign; },
    set textAlign(v) { state.textAlign = v; },
    save() {
      stack.push({ ...state });
      ops.push({ type: 'save' });
    },
    restore() {
      const prev = stack.pop();
      if (prev) Object.assign(state, prev);
      ops.push({ type: 'restore' });
    },
    beginPath() {
      currentPath = [];
    },
    moveTo(x, y) {
      currentPath.push({ cmd: 'moveTo', x, y });
    },
    lineTo(x, y) {
      currentPath.push({ cmd: 'lineTo', x, y });
    },
    roundRect(x, y, w, h, r) {
      currentPath.push({ cmd: 'roundRect', x, y, w, h, r });
    },
    quadraticCurveTo(cpx, cpy, x, y) {
      currentPath.push({ cmd: 'quadraticCurveTo', cpx, cpy, x, y });
    },
    closePath() {
      currentPath.push({ cmd: 'closePath' });
    },
    strokeRect(x, y, w, h) {
      ops.push({
        type: 'strokeRect',
        x, y, w, h,
        strokeStyle: state.strokeStyle,
        globalAlpha: state.globalAlpha,
        lineWidth: state.lineWidth,
      });
    },
    stroke() {
      ops.push({
        type: 'stroke',
        path: [...currentPath],
        strokeStyle: state.strokeStyle,
        globalAlpha: state.globalAlpha,
        lineWidth: state.lineWidth,
      });
    },
    fill() {
      ops.push({
        type: 'fill',
        path: [...currentPath],
        fillStyle: state.fillStyle,
        globalAlpha: state.globalAlpha,
      });
    },
    measureText(text) {
      return { width: String(text).length * 6.5 };
    },
    fillText(text, x, y) {
      ops.push({
        type: 'fillText',
        text, x, y,
        fillStyle: state.fillStyle,
        font: state.font,
        globalAlpha: state.globalAlpha,
      });
    },
  };
}

test('exponential interpolation converges smoothly across 60 fps frames and ignores missed/invalid tracks', async () => {
  const { createReticleInterpolator, hasActiveReticleMotion } = await import('../public/js/hud-reticles.mjs');
  const interp = createReticleInterpolator({ smoothing: 0.32, lockDurationMs: 260 });

  assert.equal(hasActiveReticleMotion(interp, 0), false);

  // Frame 0: spawns at initial bbox with id=0 supported; missed & bbox-less tracks are ignored.
  const initial = interp.step([
    { id: 0, bbox: { x: 0.2, y: 0.3, w: 0.1, h: 0.08 }, classification: 'bird', flap_hz: 4.4 },
    { id: 1, bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, missed: true },
    { id: 2, bbox: null },
  ], 0);

  assert.equal(initial.length, 1);
  assert.equal(initial[0].id, 0);
  assert.deepEqual(initial[0].bbox, { x: 0.2, y: 0.3, w: 0.1, h: 0.08 });
  assert.equal(initial[0].lockProgress, 0);
  assert.ok(Math.abs(initial[0].scale - 1.22) < 1e-9);
  assert.equal(hasActiveReticleMotion(interp, 0), true);

  // Move target at 60 fps (dt = 1000/60 ms) -> advances by exact smoothing factor (0.32).
  const frameMs = 1000 / 60;
  const movedTarget = { x: 0.4, y: 0.5, w: 0.15, h: 0.12 };
  const step1 = interp.step([{ id: 0, bbox: movedTarget, classification: 'bird', flap_hz: 4.4 }], frameMs);
  assert.ok(Math.abs(step1[0].bbox.x - (0.2 + 0.2 * 0.32)) < 1e-6);
  assert.ok(Math.abs(step1[0].bbox.y - (0.3 + 0.2 * 0.32)) < 1e-6);
  assert.equal(hasActiveReticleMotion(interp, frameMs), true);

  // Step 60 fps frames until settled (> 260ms and delta <= 0.0005).
  let t = frameMs;
  let latest = step1;
  for (let i = 0; i < 30; i++) {
    t += frameMs;
    latest = interp.step([{ id: 0, bbox: movedTarget, classification: 'bird', flap_hz: 4.4 }], t);
  }
  assert.ok(Math.abs(latest[0].bbox.x - movedTarget.x) <= 0.0005);
  assert.ok(Math.abs(latest[0].bbox.y - movedTarget.y) <= 0.0005);
  assert.equal(latest[0].lockProgress, 1);
  assert.equal(latest[0].scale, 1);
  assert.equal(hasActiveReticleMotion(interp, t), false);
  assert.equal(hasActiveReticleMotion(latest, t), false);
});

test('lockProgress follows ease-out curve from 1.22x to 1.0x and reducedMotion snaps immediately', async () => {
  const { createReticleInterpolator, hasActiveReticleMotion } = await import('../public/js/hud-reticles.mjs');
  const interp = createReticleInterpolator({ smoothing: 0.32, lockDurationMs: 260 });
  const track = { id: 'drone-7', bbox: { x: 0.4, y: 0.4, w: 0.08, h: 0.06 }, classification: 'drone' };

  const atStart = interp.step([track], 1000)[0];
  assert.equal(atStart.lockProgress, 0);
  assert.ok(Math.abs(atStart.scale - 1.22) < 1e-9);

  // Halfway through lockDurationMs (130ms): ease-out progress must exceed linear 0.5.
  const atMid = interp.step([track], 1130)[0];
  assert.ok(atMid.lockProgress > 0.7 && atMid.lockProgress < 1, `expected ease-out > 0.7, got ${atMid.lockProgress}`);
  assert.ok(atMid.scale > 1 && atMid.scale < 1.11);
  assert.equal(hasActiveReticleMotion(interp, 1130), true);

  // At 260ms: lock complete.
  const atEnd = interp.step([track], 1260)[0];
  assert.equal(atEnd.lockProgress, 1);
  assert.equal(atEnd.scale, 1);
  assert.equal(hasActiveReticleMotion(interp, 1260), false);

  // reducedMotion: true snaps both position and lockProgress immediately with zero idle RAF spin.
  const snapped = interp.step(
    [{ id: 'new-reduced', bbox: { x: 0.7, y: 0.2, w: 0.1, h: 0.1 }, classification: 'bird' }],
    2000,
    { reducedMotion: true },
  );
  assert.equal(snapped[0].lockProgress, 1);
  assert.equal(snapped[0].scale, 1);
  assert.deepEqual(snapped[0].bbox, { x: 0.7, y: 0.2, w: 0.1, h: 0.1 });

  const snappedMove = interp.step(
    [{ id: 'new-reduced', bbox: { x: 0.1, y: 0.8, w: 0.2, h: 0.15 }, classification: 'bird' }],
    2016,
    { reducedMotion: true },
  );
  assert.deepEqual(snappedMove[0].bbox, { x: 0.1, y: 0.8, w: 0.2, h: 0.15 });
  assert.equal(hasActiveReticleMotion(interp, 2016), false);
});

test('disappeared tracks survive brief flicker within grace window, prune afterwards, and clear() resets state', async () => {
  const { createReticleInterpolator, hasActiveReticleMotion } = await import('../public/js/hud-reticles.mjs');
  const interp = createReticleInterpolator({ smoothing: 0.32, lockDurationMs: 260, graceMs: 180 });
  const baseTrack = { id: 42, bbox: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }, classification: 'bird' };

  interp.step([baseTrack], 0);
  interp.step([baseTrack], 300); // lock completed
  assert.equal(interp.size, 1);

  // Brief 1-frame detector miss (66ms < 180ms grace): not emitted while missed, but retained in state.
  const duringMiss = interp.step([{ ...baseTrack, missed: true }], 366);
  assert.equal(duringMiss.length, 0);
  assert.equal(interp.size, 1);
  assert.equal(hasActiveReticleMotion(interp, 366), false);

  // Reappears within grace window (120ms < 180ms): preserves lockProgress = 1 and lerps smoothly.
  const resumed = interp.step([{ ...baseTrack, bbox: { x: 0.4, y: 0.3, w: 0.1, h: 0.1 } }], 420);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].lockProgress, 1);
  assert.ok(resumed[0].bbox.x > 0.3 && resumed[0].bbox.x < 0.4);
  assert.equal(hasActiveReticleMotion(interp, 420), true);

  // Disappears beyond grace window (> 180ms): pruned from state; re-appearing later gets fresh lock-on.
  interp.step([], 700);
  assert.equal(interp.size, 0);
  const freshAgain = interp.step([baseTrack], 750);
  assert.equal(freshAgain[0].lockProgress, 0);

  interp.clear();
  assert.equal(interp.size, 0);
  assert.equal(hasActiveReticleMotion(interp, 750), false);
});

test('waking from idle converged state lerps smoothly instead of teleporting across idle gap', async () => {
  const { createReticleInterpolator, hasActiveReticleMotion } = await import('../public/js/hud-reticles.mjs');
  const interp = createReticleInterpolator({ smoothing: 0.32, lockDurationMs: 200 });
  interp.step([{ id: 9, bbox: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } }], 0);
  interp.step([{ id: 9, bbox: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } }], 250);
  assert.equal(hasActiveReticleMotion(interp, 250), false);

  // 1 second later while RAF was paused, socket delivers a new position.
  const woke = interp.step([{ id: 9, bbox: { x: 0.6, y: 0.2, w: 0.1, h: 0.1 } }], 1250);
  assert.ok(Math.abs(woke[0].bbox.x - (0.2 + 0.4 * 0.32)) < 1e-6);
  assert.equal(hasActiveReticleMotion(interp, 1250), true);
});

test('drawCornerReticle clamps bracket length to 5*dpr..16*dpr, draws inner hairline + center tick + label pill, and skips flock labels', async () => {
  const { drawCornerReticle } = await import('../public/js/hud-reticles.mjs');

  // 1. Small box clamps bracket arm up to 5 * dpr (14 * 0.24 = 3.36 -> 5 * 2 = 10 at dpr=2 when minSide=24 -> 24*0.24=5.76 < 10).
  const smallCtx = createMockCanvasContext();
  drawCornerReticle(smallCtx, { x: 40, y: 50, w: 24, h: 24 }, {
    color: '#ff5a4a',
    dpr: 2,
    lockProgress: 1,
    classification: 'drone',
    flapHz: null,
    isFlock: false,
  });

  const innerHairline = smallCtx.ops.find(op => op.type === 'strokeRect');
  assert.ok(innerHairline, 'draws subtle translucent inner framing hairline');
  assert.equal(innerHairline.strokeStyle, '#ff5a4a');
  assert.ok(innerHairline.globalAlpha > 0 && innerHairline.globalAlpha < 0.35);

  const strokes = smallCtx.ops.filter(op => op.type === 'stroke');
  assert.ok(strokes.length >= 2, 'draws corner bracket path and center tick');
  const cornerStroke = strokes[0];
  // Top-left starts at (x, y + arm) -> (40, 50 + 10)
  assert.deepEqual(cornerStroke.path[0], { cmd: 'moveTo', x: 40, y: 60 });
  assert.deepEqual(cornerStroke.path[1], { cmd: 'lineTo', x: 40, y: 50 });
  assert.deepEqual(cornerStroke.path[2], { cmd: 'lineTo', x: 50, y: 50 });

  const droneLabel = smallCtx.ops.find(op => op.type === 'fillText');
  assert.ok(droneLabel, 'draws monospace label for non-flock target');
  assert.equal(droneLabel.text, 'drone');
  assert.match(droneLabel.font, /monospace/i);
  assert.ok(droneLabel.y < 50, 'places label pill above top-left of reticle');

  // 2. Large box clamps bracket arm down to 16 * dpr, formats flapHz, and scales 1.22x at lockProgress=0.
  const largeCtx = createMockCanvasContext();
  drawCornerReticle(largeCtx, { x: 100, y: 100, w: 200, h: 100 }, {
    color: '#4f9cff',
    dpr: 1.5,
    lockProgress: 0,
    classification: 'bird',
    flapHz: 5.24,
    isFlock: false,
  });

  const scaledRect = largeCtx.ops.find(op => op.type === 'strokeRect');
  assert.ok(Math.abs(scaledRect.w - 200 * 1.22) < 1e-6);
  assert.ok(Math.abs(scaledRect.h - 100 * 1.22) < 1e-6);
  const largeCorner = largeCtx.ops.filter(op => op.type === 'stroke')[0];
  const expectedArm = 16 * 1.5; // 24
  assert.ok(Math.abs((largeCorner.path[0].y - scaledRect.y) - expectedArm) < 1e-6);

  const birdLabel = largeCtx.ops.find(op => op.type === 'fillText');
  assert.equal(birdLabel.text, 'bird 5.2 Hz');

  // 3. isFlock: true skips label pill while keeping corner reticle, and save/restore stays balanced.
  const flockCtx = createMockCanvasContext();
  drawCornerReticle(flockCtx, { x: 60, y: 60, w: 50, h: 40 }, {
    color: '#4f9cff',
    dpr: 1,
    lockProgress: 1,
    classification: 'bird',
    flapHz: 4.8,
    isFlock: true,
  });
  assert.equal(flockCtx.ops.some(op => op.type === 'fillText'), false);
  assert.equal(
    flockCtx.ops.filter(op => op.type === 'save').length,
    flockCtx.ops.filter(op => op.type === 'restore').length,
  );

  // 4. Unclamped 24% arm length, fallback without roundRect, and invalid-rect guard.
  const fallbackCtx = createMockCanvasContext();
  fallbackCtx.roundRect = undefined;
  drawCornerReticle(fallbackCtx, { x: 20, y: 30, w: 50, h: 40 }, {
    color: '#f2b705',
    dpr: 1,
    lockProgress: 1,
    classification: 'unknown',
    centerTick: false,
  });
  const midCorner = fallbackCtx.ops.filter(op => op.type === 'stroke')[0];
  assert.ok(Math.abs((midCorner.path[0].y - 30) - 40 * 0.24) < 1e-6);
  assert.equal(fallbackCtx.ops.filter(op => op.type === 'stroke').length, 2); // corners + pill border (no centerTick)

  const emptyCtx = createMockCanvasContext();
  drawCornerReticle(emptyCtx, { x: 0, y: 0, w: 0, h: 10 });
  drawCornerReticle(emptyCtx, null);
  assert.equal(emptyCtx.ops.length, 0);
});

test('frame-rate invariance holds across 30 fps vs 60 fps and motion threshold enforces 0.0005 epsilon', async () => {
  const { createReticleInterpolator, hasActiveReticleMotion } = await import('../public/js/hud-reticles.mjs');
  const frame60 = 1000 / 60;
  const start = { id: 1, bbox: { x: 0.1, y: 0.2, w: 0.05, h: 0.05 } };
  const dest = { id: 1, bbox: { x: 0.5, y: 0.6, w: 0.1, h: 0.1 } };

  const a = createReticleInterpolator({ smoothing: 0.32 });
  const b = createReticleInterpolator({ smoothing: 0.32 });

  a.step([start], 0);
  a.step([dest], frame60);
  const res60 = a.step([dest], frame60 * 2)[0];

  b.step([start], 0);
  const res30 = b.step([dest], frame60 * 2)[0];

  assert.ok(Math.abs(res60.bbox.x - res30.bbox.x) < 1e-9);
  assert.ok(Math.abs(res60.bbox.y - res30.bbox.y) < 1e-9);

  // Direct array check around 0.0005 normalized delta threshold.
  assert.equal(hasActiveReticleMotion([{
    bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    targetBbox: { x: 0.5006, y: 0.5, w: 0.1, h: 0.1 },
    lockProgress: 1,
  }]), true);
  assert.equal(hasActiveReticleMotion([{
    bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    targetBbox: { x: 0.5004, y: 0.5, w: 0.1, h: 0.1 },
    lockProgress: 1,
  }]), false);
});

