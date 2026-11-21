const test = require('node:test');
const assert = require('node:assert/strict');

const frameBudgetModule = import('../public/js/frame-budget.mjs');

function createFakeResizeObserver() {
  const instances = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      this.observeCalls = [];
      this.unobserveCalls = [];
      this.disconnectCalls = 0;
      instances.push(this);
    }
    observe(el) {
      this.observed.add(el);
      this.observeCalls.push(el);
    }
    unobserve(el) {
      this.observed.delete(el);
      this.unobserveCalls.push(el);
    }
    disconnect() {
      this.observed.clear();
      this.disconnectCalls++;
    }
    emit(entries) {
      this.callback(entries, this);
    }
  }
  return { FakeResizeObserver, instances };
}

function createZeroReflowCanvas(initialWidth = 300, initialHeight = 150) {
  let w = initialWidth;
  let h = initialHeight;
  let widthWrites = 0;
  let heightWrites = 0;
  const forbidLayoutRead = prop => () => {
    throw new Error(`Unexpected synchronous layout read: ${prop}`);
  };
  const canvas = {};
  Object.defineProperties(canvas, {
    width: {
      get: () => w,
      set: v => { widthWrites++; w = v; },
      enumerable: true,
    },
    height: {
      get: () => h,
      set: v => { heightWrites++; h = v; },
      enumerable: true,
    },
    clientWidth: { get: forbidLayoutRead('clientWidth') },
    clientHeight: { get: forbidLayoutRead('clientHeight') },
    offsetWidth: { get: forbidLayoutRead('offsetWidth') },
    offsetHeight: { get: forbidLayoutRead('offsetHeight') },
    getBoundingClientRect: { value: forbidLayoutRead('getBoundingClientRect') },
  });
  return {
    canvas,
    writes: () => ({ widthWrites, heightWrites }),
  };
}

function createFakeRaf(initialNow = 0) {
  let clock = initialNow;
  let nextId = 0; // Starts at 0 to verify id === 0 edge-case handling.
  const pending = new Map();
  let rafCalls = 0;
  let cafCalls = 0;

  const raf = cb => {
    const id = nextId++;
    rafCalls++;
    pending.set(id, cb);
    return id;
  };
  const caf = id => {
    cafCalls++;
    pending.delete(id);
  };
  const step = dtMs => {
    clock += dtMs;
    const snapshot = [...pending.entries()];
    pending.clear();
    for (const [, cb] of snapshot) {
      cb(clock);
    }
    return clock;
  };
  const advanceClock = ms => { clock += ms; };

  return {
    raf,
    caf,
    now: () => clock,
    step,
    advanceClock,
    pendingCount: () => pending.size,
    counts: () => ({ rafCalls, cafCalls }),
  };
}

test('createCanvasSizer shares ONE ResizeObserver across canvases with zero layout reads in RAF', async () => {
  const { createCanvasSizer } = await frameBudgetModule;
  const { FakeResizeObserver, instances } = createFakeResizeObserver();
  let currentDpr = 1;

  const sizer = createCanvasSizer({
    ResizeObserverImpl: FakeResizeObserver,
    dpr: () => currentDpr,
  });
  assert.equal(instances.length, 1, 'creates exactly one shared ResizeObserver');
  const ro = instances[0];

  const a = createZeroReflowCanvas(300, 150);
  const b = createZeroReflowCanvas(300, 150);

  // Sync before ResizeObserver fires: zero layout reads and does not clobber backing size to 0x0.
  const before = sizer.syncCanvasSize(a.canvas, 1);
  assert.equal(before.resized, false);
  assert.equal(a.canvas.width, 300);
  assert.equal(a.canvas.height, 150);
  assert.deepEqual(a.writes(), { widthWrites: 0, heightWrites: 0 });

  sizer.observe(b.canvas);
  assert.equal(ro.observeCalls.length, 2);
  assert.equal(instances.length, 1, 'still only one ResizeObserver for multiple tiles');

  // Async ResizeObserver delivers CSS contentRect sizes.
  ro.emit([
    { target: a.canvas, contentRect: { width: 640, height: 360 } },
    { target: b.canvas, contentRect: { width: 480, height: 270 } },
  ]);

  const firstSyncA = sizer.syncCanvasSize(a.canvas, 1);
  assert.deepEqual(firstSyncA, {
    width: 640,
    height: 360,
    cssWidth: 640,
    cssHeight: 360,
    dpr: 1,
    baseDpr: 1,
    zoomScale: 1,
    resized: true,
  });
  assert.deepEqual(a.writes(), { widthWrites: 1, heightWrites: 1 });

  // 120 simulated RAF ticks with unchanged CSS size, zoom, and dpr perform zero canvas width/height writes.
  for (let i = 0; i < 120; i++) {
    const res = sizer.syncCanvasSize(a.canvas, 1);
    assert.equal(res.resized, false);
  }
  assert.deepEqual(a.writes(), { widthWrites: 1, heightWrites: 1 });
  assert.equal(ro.observeCalls.length, 2, 'does not re-observe already tracked canvas');

  // Changing zoomScale resizes backing store once, then stays clean on subsequent ticks.
  const zoomed = sizer.syncCanvasSize(a.canvas, 2.5);
  assert.equal(zoomed.resized, true);
  assert.equal(a.canvas.width, 1600);
  assert.equal(a.canvas.height, 900);
  assert.equal(zoomed.dpr, 2.5);
  assert.deepEqual(a.writes(), { widthWrites: 2, heightWrites: 2 });
  assert.equal(sizer.syncCanvasSize(a.canvas, 2.5).resized, false);
  assert.deepEqual(a.writes(), { widthWrites: 2, heightWrites: 2 });

  // Changing dpr (e.g. moving window to Retina display) resizes backing store once.
  currentDpr = 2;
  const hidpi = sizer.syncCanvasSize(a.canvas, 2.5);
  assert.equal(hidpi.resized, true);
  assert.equal(a.canvas.width, 3200);
  assert.equal(a.canvas.height, 1800);
  assert.deepEqual(a.writes(), { widthWrites: 3, heightWrites: 3 });

  // Second canvas remains independently tracked on the same ResizeObserver.
  const syncB = sizer.syncCanvasSize(b.canvas, 1);
  assert.equal(syncB.resized, true);
  assert.equal(b.canvas.width, 960);
  assert.equal(b.canvas.height, 540);

  // unobserve and disconnect clean up cleanly, ignoring stale queued entries.
  assert.equal(sizer.unobserve(a.canvas), true);
  assert.equal(ro.unobserveCalls.length, 1);
  assert.equal(ro.unobserveCalls[0], a.canvas);
  ro.emit([{ target: a.canvas, contentRect: { width: 999, height: 999 } }]);
  assert.deepEqual(sizer.getSize(a.canvas), { cssWidth: 0, cssHeight: 0 });
  assert.equal(sizer.unobserve(a.canvas), false);

  sizer.disconnect();
  assert.equal(ro.disconnectCalls, 1);
  ro.emit([{ target: b.canvas, contentRect: { width: 1280, height: 720 } }]);
  assert.deepEqual(sizer.getSize(b.canvas), { cssWidth: 480, cssHeight: 270 });
});

test('createCanvasSizer falls back to a one-time initial layout read only when ResizeObserver is absent', async () => {
  const { createCanvasSizer } = await frameBudgetModule;
  let clientWidthReads = 0;
  let clientHeightReads = 0;

  const canvas = { width: 300, height: 150 };
  Object.defineProperties(canvas, {
    clientWidth: { get: () => { clientWidthReads++; return 400; } },
    clientHeight: { get: () => { clientHeightReads++; return 225; } },
  });

  const sizer = createCanvasSizer({
    ResizeObserverImpl: undefined,
    dpr: () => 2,
  });

  for (let i = 0; i < 60; i++) {
    sizer.syncCanvasSize(canvas, i >= 30 ? 1.5 : 1);
  }

  assert.equal(clientWidthReads, 1, 'reads clientWidth only once on initial fallback');
  assert.equal(clientHeightReads, 1, 'reads clientHeight only once on initial fallback');
  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 675);
});

test('createFrameBudgetLoop shares one RAF across tiles and stops RAF completely when subscriber set empties', async () => {
  const { createFrameBudgetLoop } = await frameBudgetModule;
  const env = createFakeRaf(1000);
  const loop = createFrameBudgetLoop({
    raf: env.raf,
    caf: env.caf,
    now: env.now,
    isHidden: () => false,
  });

  assert.equal(loop.isRunning(), false);
  assert.equal(env.pendingCount(), 0);

  const hits = { cam1: 0, cam2: 0, cam3: 0 };
  const unsub1 = loop.subscribe('cam1', () => { hits.cam1++; });
  const unsub2 = loop.subscribe('cam2', () => { hits.cam2++; });
  const unsub3 = loop.subscribe('cam3', () => { hits.cam3++; });

  assert.equal(loop.isRunning(), true);
  assert.equal(loop.size, 3);
  assert.equal(env.pendingCount(), 1, 'three tiles share a single pending requestAnimationFrame');
  assert.equal(env.counts().rafCalls, 1);

  for (let i = 0; i < 5; i++) env.step(16);
  assert.deepEqual(hits, { cam1: 5, cam2: 5, cam3: 5 });
  assert.equal(env.pendingCount(), 1);

  // Removing two subscribers keeps the loop alive for the last one.
  unsub1();
  unsub2();
  assert.equal(loop.isRunning(), true);
  env.step(16);
  assert.deepEqual(hits, { cam1: 5, cam2: 5, cam3: 6 });

  // Removing the final subscriber cancels the pending RAF immediately (including rafId === 0 or > 0).
  const cafBefore = env.counts().cafCalls;
  unsub3();
  assert.equal(loop.size, 0);
  assert.equal(loop.isRunning(), false);
  assert.equal(env.pendingCount(), 0);
  assert.equal(env.counts().cafCalls, cafBefore + 1);

  // Stepping time while empty fires nothing and schedules nothing.
  env.step(16);
  assert.equal(env.pendingCount(), 0);
  assert.deepEqual(hits, { cam1: 5, cam2: 5, cam3: 6 });

  // Re-subscribing restarts the loop cleanly; one-shot schedule() also auto-stops when done.
  let oneShotCalls = 0;
  loop.schedule('once', () => { oneShotCalls++; });
  assert.equal(loop.isRunning(), true);
  env.step(16);
  assert.equal(oneShotCalls, 1);
  assert.equal(loop.isRunning(), false);
  assert.equal(env.pendingCount(), 0);
});

test('createFrameBudgetLoop skips hidden frames, drops to 30fps eco cadence on slow deltas, and recovers to 60fps', async () => {
  const { createFrameBudgetLoop } = await frameBudgetModule;
  const env = createFakeRaf(0);
  let hidden = false;
  const loop = createFrameBudgetLoop({
    ecoThresholdMs: 26,
    raf: env.raf,
    caf: env.caf,
    now: env.now,
    isHidden: () => hidden,
  });

  let runs = 0;
  const modes = [];
  loop.subscribe('hud', (_ts, info) => {
    runs++;
    modes.push(info.mode);
  });

  // Smooth 60 fps (16 ms deltas): runs every frame in full mode.
  for (let i = 0; i < 6; i++) env.step(16);
  assert.equal(runs, 6);
  assert.equal(loop.isEco(), false);
  assert.equal(loop.targetFps, 60);

  // A single transient 30ms blip does not jitter into eco mode.
  env.step(30);
  env.step(16);
  assert.equal(loop.isEco(), false);
  assert.equal(runs, 8);

  // Hidden tab skips work completely, and a long background pause does not trigger false eco on return.
  hidden = true;
  env.step(16);
  env.step(15_000);
  assert.equal(runs, 8, 'skips frames while document is hidden');
  hidden = false;
  env.step(16);
  assert.equal(runs, 9);
  assert.equal(loop.isEco(), false, 'long hidden gap does not poison frame-delta window');

  // Sustained slow frames (> 26 ms) on a loaded laptop trigger 30 fps eco cadence (skipping odd frames).
  const runsBeforeSlow = runs;
  env.step(34); // 1st slow delta: runs
  env.step(34); // 2nd slow delta: enters eco & skips this odd frame immediately
  assert.equal(loop.isEco(), true);
  assert.equal(loop.targetFps, 30);
  assert.equal(runs - runsBeforeSlow, 1);

  // Over the next 10 slow RAF ticks, exactly 5 even frames run and 5 odd frames are skipped.
  const runsAtEcoStart = runs;
  for (let i = 0; i < 10; i++) env.step(34);
  assert.equal(runs - runsAtEcoStart, 5, 'runs at half rate (30 fps, skipping odd frames) while in eco mode');
  assert.ok(modes.slice(-5).every(m => m === 'eco'));

  // Once frame deltas settle back to ~16 ms, recovers to 60 fps and runs every frame again.
  for (let i = 0; i < 4; i++) env.step(16);
  assert.equal(loop.isEco(), false, 'recovers from eco once frame deltas settle');
  assert.equal(loop.targetFps, 60);

  const runsAfterRecovery = runs;
  for (let i = 0; i < 6; i++) env.step(16);
  assert.equal(runs - runsAfterRecovery, 6, 'runs every frame again at 60 fps');
});

test('createFrameBudgetLoop enforces maxWorkMs per tick with starvation-free round-robin across tiles', async () => {
  const { createFrameBudgetLoop } = await frameBudgetModule;
  const env = createFakeRaf(100);
  const errors = [];
  const loop = createFrameBudgetLoop({
    maxWorkMs: 6,
    ecoThresholdMs: 26,
    raf: env.raf,
    caf: env.caf,
    now: env.now,
    isHidden: () => false,
    onError: (err, key) => errors.push([key, err.message]),
  });

  const executed = [];
  for (const id of ['A', 'B', 'C', 'D']) {
    loop.subscribe(id, () => {
      executed.push(id);
      env.advanceClock(3.5); // Two tiles = 7.0ms >= 6ms budget.
    });
  }

  // Frame 1 runs A and B (7ms >= 6ms), deferring C and D to Frame 2.
  env.step(12.5);
  assert.deepEqual(executed, ['A', 'B']);

  // Frame 2 resumes at C and D rather than starving them behind A and B.
  env.step(9);
  assert.deepEqual(executed, ['A', 'B', 'C', 'D']);

  // Frame 3 wraps back around to A and B.
  env.step(9);
  assert.deepEqual(executed, ['A', 'B', 'C', 'D', 'A', 'B']);

  // A throwing subscriber is isolated and cannot break remaining tiles.
  loop.clear();
  let healthyRuns = 0;
  loop.subscribe('broken', () => { throw new Error('boom'); });
  loop.subscribe('healthy', () => { healthyRuns++; });
  env.step(16);
  assert.equal(healthyRuns, 1);
  assert.deepEqual(errors, [['broken', 'boom']]);
});
