const { test } = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../public/js/hud-vote-ring.mjs');

function createMockContext({ width = 640, height = 360 } = {}) {
  const stateStack = [];
  const state = {
    strokeStyle: '#000',
    fillStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '10px sans-serif',
    fontVariantNumeric: 'normal',
    textBaseline: 'alphabetic',
    textAlign: 'start',
  };

  const calls = {
    arcs: [],
    strokes: [],
    fills: [],
    texts: [],
    roundRects: [],
    saveCount: 0,
    restoreCount: 0,
  };

  let currentPath = [];

  const ctx = {
    canvas: { width, height },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v) { state.fillStyle = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v) { state.lineWidth = v; },
    get lineCap() { return state.lineCap; },
    set lineCap(v) { state.lineCap = v; },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v) { state.globalAlpha = v; },
    get font() { return state.font; },
    set font(v) { state.font = v; },
    get fontVariantNumeric() { return state.fontVariantNumeric; },
    set fontVariantNumeric(v) { state.fontVariantNumeric = v; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(v) { state.textBaseline = v; },
    get textAlign() { return state.textAlign; },
    set textAlign(v) { state.textAlign = v; },

    save() {
      calls.saveCount += 1;
      stateStack.push({ ...state });
    },
    restore() {
      calls.restoreCount += 1;
      const prev = stateStack.pop();
      if (prev) Object.assign(state, prev);
    },
    beginPath() {
      currentPath = [];
    },
    arc(x, y, radius, startAngle, endAngle, counterclockwise = false) {
      const entry = { x, y, radius, startAngle, endAngle, counterclockwise };
      currentPath.push({ type: 'arc', ...entry });
      calls.arcs.push(entry);
    },
    roundRect(x, y, w, h, r) {
      const entry = { x, y, w, h, r };
      currentPath.push({ type: 'roundRect', ...entry });
      calls.roundRects.push(entry);
    },
    stroke() {
      calls.strokes.push({
        strokeStyle: state.strokeStyle,
        lineWidth: state.lineWidth,
        lineCap: state.lineCap,
        globalAlpha: state.globalAlpha,
        path: [...currentPath],
      });
    },
    fill() {
      calls.fills.push({
        fillStyle: state.fillStyle,
        globalAlpha: state.globalAlpha,
        path: [...currentPath],
      });
    },
    measureText(text) {
      return { width: String(text).length * 6.2 };
    },
    fillText(text, x, y) {
      calls.texts.push({
        text,
        x,
        y,
        fillStyle: state.fillStyle,
        font: state.font,
        fontVariantNumeric: state.fontVariantNumeric,
      });
    },
  };

  return { ctx, calls };
}

test('returns false and draws nothing when voteState is missing or inactive (count <= 0 && !pending)', async () => {
  const { drawVoteProgressRing } = await modulePromise;
  const anchor = Object.freeze({ x: 100, y: 80, w: 48, h: 36 });

  for (const voteState of [
    null,
    undefined,
    Object.freeze({ count: 0 }),
    Object.freeze({ count: 0, pending: false }),
    Object.freeze({ count: -2, pending: false }),
    Object.freeze({ count: NaN, pending: false }),
  ]) {
    const { ctx, calls } = createMockContext();
    assert.equal(drawVoteProgressRing(ctx, anchor, voteState), false);
    assert.equal(calls.arcs.length, 0);
    assert.equal(calls.strokes.length, 0);
    assert.equal(calls.texts.length, 0);
    assert.equal(calls.saveCount, 0);
  }

  const { ctx, calls } = createMockContext();
  assert.equal(drawVoteProgressRing(ctx, { x: 10, y: 10, w: -5, h: 20 }, { count: 2 }), false);
  assert.equal(calls.arcs.length, 0);
});

test('renders 0..5 filled segments out of 5 at top-right anchor with dpr scaling', async () => {
  const { drawVoteProgressRing, VOTE_RING_COLORS } = await modulePromise;
  const anchor = Object.freeze({ x: 120, y: 90, w: 50, h: 40 });

  for (let count = 0; count <= 5; count++) {
    const { ctx, calls } = createMockContext({ width: 800, height: 600 });
    const voteState = Object.freeze({
      count,
      total: 5,
      ready: false,
      label: null,
      confidence: null,
      pending: count === 0,
    });
    const drawn = drawVoteProgressRing(ctx, anchor, voteState, Object.freeze({
      dpr: 2,
      reducedMotion: true,
      nowMs: 100,
    }));

    assert.equal(drawn, true);
    assert.equal(calls.saveCount, 1);
    assert.equal(calls.restoreCount, 1);
    assert.equal(calls.arcs.length, 5);
    assert.equal(calls.strokes.length, 5);
    assert.equal(calls.texts.length, 0);

    const expectedCx = anchor.x + anchor.w + 11 * 2;
    const expectedCy = anchor.y + 7 * 2;
    const expectedRadius = 7 * 2;

    for (let i = 0; i < 5; i++) {
      const arc = calls.arcs[i];
      assert.equal(arc.x, expectedCx);
      assert.equal(arc.y, expectedCy);
      assert.equal(arc.radius, expectedRadius);
      assert.ok(arc.endAngle > arc.startAngle, 'each segment sweeps a positive clockwise angle');
      if (i > 0) {
        assert.ok(arc.startAngle > calls.arcs[i - 1].endAngle, 'segments have an angular gap');
      }

      const stroke = calls.strokes[i];
      assert.equal(stroke.lineWidth, 4);
      const expectedColor = i < count ? VOTE_RING_COLORS.gathering : VOTE_RING_COLORS.unfilled;
      assert.equal(stroke.strokeStyle, expectedColor);
    }
  }
});

test('applies bird, drone, other, and gathering segment colors accurately', async () => {
  const { drawVoteProgressRing } = await modulePromise;
  const anchor = Object.freeze({ x: 60, y: 60, w: 30, h: 30 });

  const cases = [
    [{ count: 3, label: 'bird' }, '#4f9cff'],
    [{ count: 4, label: 'drone' }, '#ff5a4a'],
    [{ count: 2, label: 'other' }, '#a1a1aa'],
    [{ count: 2, label: null }, '#f2b705'],
    [{ count: 1, label: 'unknown' }, '#f2b705'],
  ];

  for (const [voteState, expectedHex] of cases) {
    const { ctx, calls } = createMockContext();
    assert.equal(drawVoteProgressRing(ctx, anchor, Object.freeze(voteState)), true);
    const filledStrokes = calls.strokes.slice(0, voteState.count).map(s => s.strokeStyle);
    const unfilledStrokes = calls.strokes.slice(voteState.count).map(s => s.strokeStyle);
    assert.deepEqual(filledStrokes, Array(voteState.count).fill(expectedHex));
    assert.deepEqual(unfilledStrokes, Array(5 - voteState.count).fill('rgba(255,255,255,0.24)'));
  }
});

test('pulses only the next unfilled segment when pending && !ready && !reducedMotion', async () => {
  const { drawVoteProgressRing, VOTE_RING_COLORS } = await modulePromise;
  const anchor = Object.freeze({ x: 80, y: 50, w: 40, h: 40 });
  const pendingState = Object.freeze({
    count: 2,
    total: 5,
    ready: false,
    label: null,
    pending: true,
  });

  const sampleAt = (nowMs, reducedMotion) => {
    const { ctx, calls } = createMockContext();
    assert.equal(drawVoteProgressRing(ctx, anchor, pendingState, { dpr: 1, reducedMotion, nowMs }), true);
    return calls.strokes.map(s => s.strokeStyle);
  };

  const animatedA = sampleAt(0, false);
  const animatedB = sampleAt(225, false);
  const animatedC = sampleAt(675, false);

  for (const styles of [animatedA, animatedB, animatedC]) {
    assert.equal(styles[0], VOTE_RING_COLORS.gathering);
    assert.equal(styles[1], VOTE_RING_COLORS.gathering);
    assert.notEqual(styles[2], VOTE_RING_COLORS.unfilled);
    assert.match(styles[2], /^rgba\(255,255,255,0\.\d+\)$/);
    assert.equal(styles[3], VOTE_RING_COLORS.unfilled);
    assert.equal(styles[4], VOTE_RING_COLORS.unfilled);
  }
  assert.notEqual(animatedA[2], animatedB[2]);
  assert.notEqual(animatedB[2], animatedC[2]);

  const reducedA = sampleAt(0, true);
  const reducedB = sampleAt(225, true);
  assert.deepEqual(reducedA, reducedB);
  assert.equal(reducedA[2], VOTE_RING_COLORS.unfilled);
});

test('clamps ring and advisory pill inside canvas bounds near right and top edges', async () => {
  const { drawVoteProgressRing } = await modulePromise;
  const width = 320;
  const height = 180;
  const nearTopRight = Object.freeze({ x: 285, y: 0, w: 32, h: 28 });

  const { ctx: ringCtx, calls: ringCalls } = createMockContext({ width, height });
  assert.equal(drawVoteProgressRing(ringCtx, nearTopRight, Object.freeze({ count: 3 })), true);
  for (const arc of ringCalls.arcs) {
    assert.ok(arc.x + arc.radius + 1 <= width, `arc right edge (${arc.x + arc.radius + 1}) stays within ${width}`);
    assert.ok(arc.y - arc.radius - 1 >= 0, `arc top edge (${arc.y - arc.radius - 1}) stays >= 0`);
  }

  const { ctx: pillCtx, calls: pillCalls } = createMockContext({ width, height });
  const readyState = Object.freeze({
    count: 5,
    total: 5,
    ready: true,
    label: 'bird',
    confidence: 0.96,
    pending: false,
  });
  assert.equal(drawVoteProgressRing(pillCtx, nearTopRight, readyState), true);
  for (const arc of pillCalls.arcs) {
    assert.ok(arc.x - arc.radius - 1 >= 0);
    assert.ok(arc.x + arc.radius + 1 <= width);
    assert.ok(arc.y - arc.radius - 1 >= 0);
    assert.ok(arc.y + arc.radius + 1 <= height);
  }
  assert.equal(pillCalls.roundRects.length, 1);
  const pill = pillCalls.roundRects[0];
  assert.ok(pill.x >= 0, 'pill left stays inside canvas');
  assert.ok(pill.x + pill.w <= width, `pill right (${pill.x + pill.w}) stays within ${width}`);
  assert.ok(pill.y >= 0, 'pill top stays inside canvas');
  assert.ok(pill.y + pill.h <= height, 'pill bottom stays inside canvas');
});

test('renders compact tabular-monospace advisory pill when ready && label without mutating inputs', async () => {
  const { drawVoteProgressRing, toVoteRingState } = await modulePromise;
  const anchor = Object.freeze({ x: 40, y: 40, w: 40, h: 40 });

  const birdReady = Object.freeze({
    count: 5,
    total: 5,
    ready: true,
    label: 'bird',
    confidence: 0.96,
    pending: false,
  });
  const { ctx: birdCtx, calls: birdCalls } = createMockContext();
  assert.equal(drawVoteProgressRing(birdCtx, anchor, birdReady, Object.freeze({ dpr: 1 })), true);
  assert.equal(birdCalls.arcs.length, 5);
  assert.equal(birdCalls.strokes.slice(0, 5).every(s => s.strokeStyle === '#4f9cff'), true);
  assert.equal(birdCalls.texts.length, 1);
  assert.equal(birdCalls.texts[0].text, 'v4.1 BIRD 96%');
  assert.match(birdCalls.texts[0].font, /monospace/);
  assert.equal(birdCalls.texts[0].fontVariantNumeric, 'tabular-nums');
  assert.ok(birdCalls.roundRects[0].x > birdCalls.arcs[0].x + birdCalls.arcs[0].radius, 'pill sits beside the ring');

  const otherReady = Object.freeze({
    count: 5,
    total: 5,
    ready: true,
    label: 'other',
    confidence: null,
  });
  const { ctx: otherCtx, calls: otherCalls } = createMockContext();
  assert.equal(drawVoteProgressRing(otherCtx, anchor, otherReady), true);
  assert.equal(otherCalls.texts.length, 1);
  assert.equal(otherCalls.texts[0].text, 'v4.1 OTHER');
  assert.equal(otherCalls.strokes.slice(0, 5).every(s => s.strokeStyle === '#a1a1aa'), true);

  // Mapped directly from skysentry-v41-vote.mjs record() output
  const mapped = toVoteRingState({ status: 'ready', count: 5, label: 'drone', score: 0.884 });
  const { ctx: droneCtx, calls: droneCalls } = createMockContext();
  assert.equal(drawVoteProgressRing(droneCtx, anchor, Object.freeze(mapped)), true);
  assert.equal(droneCalls.texts[0].text, 'v4.1 DRONE 88%');
  assert.equal(droneCalls.strokes.slice(0, 5).every(s => s.strokeStyle === '#ff5a4a'), true);

  // Pill stays hidden if !ready or !label, and fallback rect path works without roundRect/canvas
  const { ctx: noReadyCtx, calls: noReadyCalls } = createMockContext();
  assert.equal(drawVoteProgressRing(noReadyCtx, anchor, Object.freeze({ count: 5, ready: false, label: 'bird', confidence: 0.9 })), true);
  assert.equal(noReadyCalls.texts.length, 0);

  const { ctx: noLabelCtx, calls: noLabelCalls } = createMockContext();
  assert.equal(drawVoteProgressRing(noLabelCtx, anchor, Object.freeze({ count: 5, ready: true, label: null, confidence: 0.9 })), true);
  assert.equal(noLabelCalls.texts.length, 0);

  const { ctx: fallbackCtx, calls: fallbackCalls } = createMockContext();
  delete fallbackCtx.roundRect;
  delete fallbackCtx.canvas;
  let rectCalled = 0;
  fallbackCtx.rect = () => { rectCalled += 1; };
  assert.equal(drawVoteProgressRing(fallbackCtx, anchor, Object.freeze({ count: 8, total: 5, ready: true, label: 'bird', confidence: 96 })), true);
  assert.equal(rectCalled, 1);
  assert.equal(fallbackCalls.arcs.length, 5);
  assert.equal(fallbackCalls.texts[0].text, 'v4.1 BIRD 96%');
});
