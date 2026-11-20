const test = require('node:test');
const assert = require('node:assert/strict');

const feedsModule = import('../public/js/feeds.js');

function createHarness(t, {
  reducedMotion = false,
  hidden = false,
  demo = false,
  getTrackVote,
  hudRenderer,
} = {}) {
  let now = 10_000;
  let wallNow = 1_700_000_000_000;
  let nextRafId = 1;
  const rafQueue = new Map();
  let rafScheduledCount = 0;
  let rafCancelledCount = 0;

  const docListeners = new Map();
  const motionListeners = new Set();
  const state = { reducedMotion, hidden };

  const socketHandlers = {};
  const socket = { on(name, fn) { socketHandlers[name] = fn; } };

  const makeCtx = log => ({
    strokeStyle: '',
    fillStyle: '',
    font: '',
    lineWidth: 1,
    globalAlpha: 1,
    drawImage(...args) { log.push({ op: 'drawImage', args }); },
    getImageData(_x, _y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    clearRect(...args) { log.push({ op: 'clearRect', args }); },
    strokeRect(...args) { log.push({ op: 'strokeRect', args, strokeStyle: this.strokeStyle, alpha: this.globalAlpha }); },
    fillText(...args) { log.push({ op: 'fillText', args, fillStyle: this.fillStyle }); },
    beginPath() { log.push({ op: 'beginPath' }); },
    moveTo(...args) { log.push({ op: 'moveTo', args }); },
    lineTo(...args) { log.push({ op: 'lineTo', args }); },
    closePath() { log.push({ op: 'closePath' }); },
    fill() { log.push({ op: 'fill' }); },
    stroke() { log.push({ op: 'stroke', strokeStyle: this.strokeStyle, alpha: this.globalAlpha }); },
    setLineDash(dash) { log.push({ op: 'setLineDash', dash: [...dash] }); },
  });

  const tilesByTag = [];
  const createTileDom = () => {
    const vLog = [], oLog = [], sLog = [];
    const video = { width: 800, height: 600, getContext: () => makeCtx(vLog) };
    const overlay = { clientWidth: 800, clientHeight: 600, width: 0, height: 0, getContext: () => makeCtx(oLog), oLog };
    const wrap = { style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    const tag = { textContent: '' };
    const bot = { textContent: '' };
    const zl = { textContent: '1×' };
    const srcBtn = {
      hidden: false, disabled: false, textContent: 'Demo', dataset: { src: '' }, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      closest(sel) { return sel === 'button' ? this : null; },
    };
    const closeBtn = { onclick: null, dataset: { close: '' }, closest(sel) { return sel === 'button' ? this : null; } };
    const fsBtn = { textContent: 'Full screen', dataset: { fs: '' }, closest(sel) { return sel === 'button' ? this : null; } };
    const toolsListeners = new Map();
    const tools = {
      addEventListener(name, fn) { toolsListeners.set(name, fn); },
      click(btn) { toolsListeners.get('click')?.({ target: btn }); },
    };
    const tileListeners = new Map();
    const classes = new Set();
    const el = {
      clientWidth: 800,
      clientHeight: 600,
      removed: false,
      innerHTML: '',
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
        contains(c) { return classes.has(c); },
      },
      querySelectorAll(sel) { return sel === 'canvas' ? [video, overlay] : []; },
      querySelector(sel) {
        if (sel === '.wrap') return wrap;
        if (sel === '.tag') return tag;
        if (sel === '.bot') return bot;
        if (sel === '.zl') return zl;
        if (sel === '.tools') return tools;
        if (sel === '[data-src]') return srcBtn;
        if (sel === '[data-close]') return closeBtn;
        if (sel === '[data-fs]') return fsBtn;
        return { setAttribute() {}, addEventListener() {} };
      },
      addEventListener(name, fn) { tileListeners.set(name, fn); },
      getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
      remove() { this.removed = true; },
      _parts: { video, overlay, oLog, sLog, wrap, tag, bot, srcBtn, closeBtn, tools },
    };
    tilesByTag.push(el);
    return el;
  };

  const createdVideos = [];
  const documentMock = {
    get hidden() { return state.hidden; },
    fullscreenElement: null,
    createElement(tagName) {
      if (tagName === 'div') return createTileDom();
      if (tagName === 'canvas') {
        const cLog = [];
        return { width: 0, height: 0, getContext: () => makeCtx(cLog) };
      }
      if (tagName === 'video') {
        const vListeners = new Map();
        const vid = {
          readyState: 4,
          videoWidth: 640,
          videoHeight: 480,
          currentTime: 0,
          muted: false,
          loop: false,
          playsInline: false,
          preload: '',
          paused: false,
          children: [],
          setAttribute() {},
          removeAttribute() {},
          append(child) { this.children.push(child); },
          replaceChildren() { this.children = []; },
          load() {},
          play() { this.paused = false; return Promise.resolve(); },
          pause() { this.paused = true; },
          addEventListener(name, fn) { vListeners.set(name, fn); },
          emit(name) { vListeners.get(name)?.(); },
        };
        createdVideos.push(vid);
        return vid;
      }
      return { type: '', className: '', hidden: false, textContent: '', setAttribute() {}, addEventListener() {} };
    },
    addEventListener(name, fn) {
      if (!docListeners.has(name)) docListeners.set(name, new Set());
      docListeners.get(name).add(fn);
    },
  };

  const matchMediaMock = query => ({
    media: query,
    get matches() { return query.includes('prefers-reduced-motion') ? state.reducedMotion : false; },
    addEventListener(name, fn) { if (name === 'change') motionListeners.add(fn); },
  });

  const saved = new Map();
  const installGlobal = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  installGlobal('document', documentMock);
  installGlobal('devicePixelRatio', 1);
  installGlobal('matchMedia', matchMediaMock);
  installGlobal('performance', { now: () => now });
  installGlobal('requestAnimationFrame', cb => {
    const id = nextRafId++;
    rafScheduledCount++;
    rafQueue.set(id, cb);
    return id;
  });
  installGlobal('cancelAnimationFrame', id => {
    if (rafQueue.delete(id)) rafCancelledCount++;
  });
  installGlobal('createImageBitmap', async () => ({ width: 800, height: 600, closed: 0, close() { this.closed++; } }));

  t.mock.method(Date, 'now', () => wallNow);
  const intervals = [];
  const timeouts = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; });
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; });

  t.after(() => {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  });

  const feedsSeen = new Map();
  const removed = [];

  return {
    socket,
    socketHandlers,
    feedsSeen,
    removed,
    createdVideos,
    intervals,
    timeouts,
    get now() { return now; },
    get wallNow() { return wallNow; },
    get pendingRafCount() { return rafQueue.size; },
    get rafScheduledCount() { return rafScheduledCount; },
    get rafCancelledCount() { return rafCancelledCount; },
    advance(ms) {
      now += ms;
      wallNow += ms;
    },
    stepRaf(ms = 16) {
      now += ms;
      wallNow += ms;
      const batch = [...rafQueue.entries()];
      for (const [id] of batch) rafQueue.delete(id);
      for (const [, cb] of batch) cb(now);
      return batch.length;
    },
    setHidden(val) {
      state.hidden = val;
      for (const fn of docListeners.get('visibilitychange') || []) fn();
    },
    setReducedMotion(val) {
      state.reducedMotion = val;
      for (const fn of motionListeners) fn();
    },
    async mount() {
      const { startFeeds } = await feedsModule;
      const api = startFeeds(socket, {
        container: { after() {}, appendChild() {} },
        hint: { hidden: false, textContent: '' },
        demo,
        onFeed: f => feedsSeen.set(f.cameraId, f),
        onRemove: id => removed.push(id),
        getTrackVote,
        hudRenderer,
      });
      return api;
    },
    async pushLivePair(cameraId, {
      streamId = 'live-1',
      generation = 'gen-1',
      frameId,
      tracks,
      remainingMs = 2500,
    }) {
      socketHandlers['bot:status']({ cameraId, mode: 'server', generation });
      socketHandlers['camera:frame']({
        cameraId,
        streamId,
        frameId,
        t: frameId / 15,
        jpeg: new Uint8Array([1, 2, 3]),
      });
      await Promise.resolve();
      await Promise.resolve();
      socketHandlers['bot:state']({
        cameraId,
        streamId,
        frameId,
        mode: 'server',
        generation,
        at: wallNow,
        remaining_ms: remainingMs,
        state: {
          t: frameId / 15,
          generation,
          risk: tracks.length ? 'yellow' : 'green',
          tracks,
        },
      });
    },
  };
}

const lastBoxes = feed => {
  const log = feed.overlay.oLog;
  let lastClear = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].op === 'clearRect') { lastClear = i; break; }
  }
  return log.slice(lastClear + 1).filter(e => e.op === 'strokeRect');
};

const lastTexts = feed => {
  const log = feed.overlay.oLog;
  let lastClear = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].op === 'clearRect') { lastClear = i; break; }
  }
  return log.slice(lastClear + 1).filter(e => e.op === 'fillText').map(e => e.args[0]);
};

test('interpolates active track boxes at 60 fps and stops rAF as soon as tracks clear', async t => {
  const h = createHarness(t);
  const api = await h.mount();
  assert.equal(typeof api.redraw, 'function');
  assert.equal(typeof api.redrawAll, 'function');
  assert.equal(h.pendingRafCount, 0);

  await h.pushLivePair('cam-A', {
    frameId: 1,
    tracks: [{ id: 1, classification: 'bird', flap_hz: 6.2, bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.1 } }],
  });
  const feed = h.feedsSeen.get('cam-A');
  assert.equal(feed.hud.running, true);
  assert.ok(feed.hud.raf > 0, 'schedules 60fps HUD rAF during lock-on');
  assert.equal(lastBoxes(feed)[0].args[0], 80);

  // Advance 68ms (~15fps server cadence) and move track #1 from x=0.1 (80px) to x=0.3 (240px)
  h.advance(68);
  await h.pushLivePair('cam-A', {
    frameId: 2,
    tracks: [{ id: 1, classification: 'bird', flap_hz: 6.2, bbox: { x: 0.3, y: 0.2, w: 0.1, h: 0.1 } }],
  });

  const xs = [lastBoxes(feed)[0].args[0]];
  assert.ok(xs[0] > 80 && xs[0] < 240, 'begins smooth step immediately without jumping straight to target');

  for (let i = 0; i < 5; i++) {
    h.stepRaf(16);
    xs.push(lastBoxes(feed)[0].args[0]);
  }
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] >= xs[i - 1], `expected monotonic 60fps progression: ${xs.join(', ')}`);
  }
  assert.equal(xs.at(-1), 240, 'converges cleanly onto exact target pixel coordinate');

  // Empty tracks immediately clear HUD state, erase boxes, and stop rAF loop
  h.advance(68);
  await h.pushLivePair('cam-A', { frameId: 3, tracks: [] });
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.hud.raf, 0);
  assert.equal(feed.hud.running, false);
  assert.equal(h.pendingRafCount, 0);
  assert.equal(lastBoxes(feed).length, 0, 'no stale boxes linger after tracks disappear');
});

test('respects prefers-reduced-motion and document.hidden without running background rAF', async t => {
  const h = createHarness(t, { reducedMotion: true });
  await h.mount();

  await h.pushLivePair('cam-A', {
    frameId: 1,
    tracks: [{ id: 1, classification: 'drone', bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }],
  });
  const feed = h.feedsSeen.get('cam-A');
  assert.equal(h.rafScheduledCount, 0, 'never schedules rAF when prefers-reduced-motion is active');
  assert.equal(feed.hud.tracks.get(1).lock, 1);

  h.advance(68);
  await h.pushLivePair('cam-A', {
    frameId: 2,
    tracks: [{ id: 1, classification: 'drone', bbox: { x: 0.4, y: 0.1, w: 0.1, h: 0.1 } }],
  });
  assert.equal(lastBoxes(feed)[0].args[0], 320, 'snaps directly to target under reduced motion');
  assert.equal(h.pendingRafCount, 0);

  // Re-enable motion -> starts 60fps rAF; hiding tab immediately stops rAF
  h.setReducedMotion(false);
  h.advance(68);
  await h.pushLivePair('cam-A', {
    frameId: 3,
    tracks: [{ id: 1, classification: 'drone', bbox: { x: 0.5, y: 0.1, w: 0.1, h: 0.1 } }],
  });
  assert.ok(h.pendingRafCount > 0, 'schedules rAF once reduced-motion is off');

  h.setHidden(true);
  assert.equal(feed.hud.raf, 0);
  assert.equal(h.pendingRafCount, 0, 'stops rAF immediately when document becomes hidden');
});

test('resets t.hud and clears overlay on stream change, generation change, offline, closeTile, and disconnect', async t => {
  let resetCalls = 0;
  const h = createHarness(t, {
    hudRenderer: {
      createTileState: () => ({ customEntries: new Set() }),
      stepTile(tileHud, tracks) {
        for (const tr of tracks) tileHud.customEntries.add(tr.id);
        return true;
      },
      resetTile(tileHud) {
        resetCalls++;
        tileHud.customEntries.clear();
      },
    },
  });
  await h.mount();

  // 1. Active track on stream live-1
  await h.pushLivePair('cam-A', {
    streamId: 'live-1',
    generation: 'gen-1',
    frameId: 1,
    tracks: [{ id: 7, classification: 'bird', bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }],
  });
  const feed = h.feedsSeen.get('cam-A');
  assert.equal(feed.hud.tracks.size, 1);
  assert.equal(feed.hud.tileState.customEntries.has(7), true);
  assert.ok(feed.hud.raf > 0);

  // 2. Stream change clears t.hud immediately before new state arrives (no cross-stream interpolation)
  h.advance(50);
  h.socketHandlers['camera:frame']({
    cameraId: 'cam-A',
    streamId: 'live-2',
    frameId: 1,
    t: 1 / 15,
    jpeg: new Uint8Array([1]),
  });
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.hud.raf, 0);
  assert.equal(feed.hud.tileState.customEntries.size, 0);
  assert.equal(lastBoxes(feed).length, 0);
  await Promise.resolve();
  await Promise.resolve();

  // New track on live-2 with same id=7 starts fresh at x=0.1 (80px), not interpolating from old x=0.5!
  h.socketHandlers['bot:state']({
    cameraId: 'cam-A',
    streamId: 'live-2',
    frameId: 1,
    mode: 'server',
    generation: 'gen-1',
    at: h.wallNow,
    remaining_ms: 2500,
    state: { t: 1 / 15, generation: 'gen-1', risk: 'yellow', tracks: [{ id: 7, classification: 'bird', bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }] },
  });
  assert.equal(lastBoxes(feed)[0].args[0], 80);

  // 3. Detector generation change invalidates evidence & resets HUD
  h.socketHandlers['bot:status']({ cameraId: 'cam-A', mode: 'server', generation: 'gen-2' });
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.hud.raf, 0);
  assert.equal(lastBoxes(feed).length, 0);

  // 4. Camera offline resets HUD & stops rAF
  h.advance(20);
  await h.pushLivePair('cam-A', {
    streamId: 'live-2',
    generation: 'gen-2',
    frameId: 2,
    tracks: [{ id: 7, classification: 'bird', bbox: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } }],
  });
  assert.ok(feed.hud.raf > 0);
  h.socketHandlers['camera:status']({ cameraId: 'cam-A', online: false });
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.hud.raf, 0);
  assert.equal(lastBoxes(feed).length, 0);

  // 5. Disconnect resets HUD across open tiles
  h.advance(20);
  h.socketHandlers['camera:status']({ cameraId: 'cam-A', online: true });
  await h.pushLivePair('cam-A', {
    streamId: 'live-3',
    generation: 'gen-3',
    frameId: 1,
    tracks: [{ id: 7, classification: 'bird', bbox: { x: 0.25, y: 0.25, w: 0.1, h: 0.1 } }],
  });
  assert.ok(feed.hud.raf > 0);
  h.socketHandlers.disconnect();
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.hud.raf, 0);
  assert.equal(lastBoxes(feed).length, 0);

  // 6. Close button resets HUD and removes tile
  h.advance(20);
  h.socketHandlers['camera:status']({ cameraId: 'cam-A', online: true });
  await h.pushLivePair('cam-A', {
    streamId: 'live-4',
    generation: 'gen-4',
    frameId: 1,
    tracks: [{ id: 7, classification: 'bird', bbox: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 } }],
  });
  feed.el._parts.closeBtn.onclick();
  assert.equal(feed.hud.raf, 0);
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.el.removed, true);
  assert.ok(resetCalls >= 5);
});

test('switching between live and demo resets HUD and isolates live votes from demo tracks', async t => {
  const votes = new Map([['cam-A:1', { status: 'ready', label: 'drone', score: 0.96 }]]);
  const voteQueries = [];
  const h = createHarness(t, {
    demo: true,
    getTrackVote: (cameraId, trackId, meta) => {
      voteQueries.push({ cameraId, trackId, demo: meta.demo });
      return votes.get(`${cameraId}:${trackId}`) ?? null;
    },
  });
  await h.mount();

  await h.pushLivePair('cam-A', {
    frameId: 1,
    tracks: [{ id: 1, classification: 'unknown', bbox: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } }],
  });
  const feed = h.feedsSeen.get('cam-A');
  assert.match(lastTexts(feed)[0], /unknown · v4\.1 drone 96%/);
  assert.equal(feed.hud.tracks.size, 1);

  // Switch tile from live -> demo: clears live HUD tracks & stops live HUD rAF immediately
  feed.el._parts.tools.click(feed.el._parts.srcBtn);
  assert.equal(Boolean(feed.demo), true);
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.hud.raf, 0);

  // Inject a synthetic demo track #1 on the demo engine and step demo rAF
  feed.demo.engine.process = () => ({
    t: 0.5,
    risk: { level: 'yellow', reasons: [] },
    flocks: [],
    tracks: [{ id: 1, classification: 'bird', bbox: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } }],
  });
  h.stepRaf(70);
  assert.equal(voteQueries.at(-1).cameraId, 'demo:cam-A', 'demo feed queries namespaced demo cameraId');
  assert.equal(voteQueries.at(-1).demo, true);
  assert.doesNotMatch(lastTexts(feed)[0], /drone 96%/, 'live server vote never bleeds onto recorded demo track');

  // Demo video loop seek clears HUD
  feed.demo.v.emit('seeked');
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.hud.raf, 0);
  assert.equal(lastBoxes(feed).length, 0);

  // Switch back demo -> live while live video is recent: stops demo and resets HUD
  feed.el._parts.tools.click(feed.el._parts.srcBtn);
  assert.equal(feed.demo, null);
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(feed.hud.raf, 0);
});

test('supports pluggable hudRenderer hooks and feedsApi.redraw / redrawAll on 5-frame vote updates', async t => {
  const votes = new Map();
  const calls = { forecast: [], track: [], step: [] };
  const h = createHarness(t, {
    getTrackVote: (cameraId, trackId) => votes.get(`${cameraId}:${trackId}`) ?? null,
    hudRenderer: {
      createTileState: () => ({ tag: 'custom-hud' }),
      stepTile(tileHud, tracks, frameT, nowMs, meta) {
        calls.step.push({ tag: tileHud.tag, count: tracks.length, frameT, nowMs, cameraId: meta.cameraId });
        return true;
      },
      drawForecast(_ctx, P, tr, helpers) {
        calls.forecast.push({ id: tr.id, p0: P([0.5, 0.5]), vel: helpers.velocity, tag: helpers.tileHud.tag });
      },
      drawTrack(ctx, rect, tr, helpers) {
        calls.track.push({ id: tr.id, rect: { ...rect }, vote: helpers.vote, lock: helpers.lock, classification: tr.classification });
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      },
    },
  });
  const feedsApi = await h.mount();

  votes.set('cam-B:3', { status: 'collecting', count: 2 });
  await h.pushLivePair('cam-B', {
    frameId: 1,
    tracks: [{ id: 3, classification: 'unknown', vx: 0.12, vy: -0.04, bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.1 } }],
  });

  assert.equal(calls.step.at(-1).tag, 'custom-hud');
  assert.equal(calls.forecast.at(-1).id, 3);
  assert.deepEqual(calls.forecast.at(-1).vel, { vx: 0.12, vy: -0.04 });
  assert.deepEqual(calls.track.at(-1).vote, { status: 'collecting', count: 2 });
  assert.equal(calls.track.at(-1).classification, 'unknown', 'advisory vote never mutates detector classification');

  // Begin a 60fps interpolation toward x=0.3 (240px)
  h.advance(68);
  await h.pushLivePair('cam-B', {
    frameId: 2,
    tracks: [{ id: 3, classification: 'unknown', vx: 0.12, vy: -0.04, bbox: { x: 0.3, y: 0.2, w: 0.1, h: 0.1 } }],
  });
  h.stepRaf(16);
  const midX = calls.track.at(-1).rect.x;
  assert.ok(midX > 80 && midX < 240);

  // VisualBirdVerifier 5-frame vote completes mid-frame and calls feedsApi.redraw / redrawAll
  votes.set('cam-B:3', { status: 'ready', count: 5, label: 'bird', score: 0.94 });
  feedsApi.redraw({ cameraId: 'cam-B' });
  assert.deepEqual(calls.track.at(-1).vote, { status: 'ready', count: 5, label: 'bird', score: 0.94 });
  assert.equal(calls.track.at(-1).rect.x, midX, 'mid-frame vote redraw preserves ongoing interpolation curve');

  feedsApi.redrawAll();
  assert.equal(calls.track.at(-1).vote.label, 'bird');

  // Expiry stops rAF on the very next tick without leaving stale boxes on screen
  h.advance(3000);
  h.stepRaf(16);
  const feed = h.feedsSeen.get('cam-B');
  assert.equal(feed.hud.raf, 0);
  assert.equal(feed.hud.tracks.size, 0);
  assert.equal(lastBoxes(feed).length, 0);
});

test('stops scheduling rAF when custom hudRenderer.stepTile returns false', async t => {
  let keepGoing = true;
  const h = createHarness(t, {
    hudRenderer: {
      stepTile() { return keepGoing; },
    },
  });
  await h.mount();

  await h.pushLivePair('cam-C', {
    frameId: 1,
    tracks: [{ id: 1, classification: 'bird', trail: [[0.1, 0.2], [0.14, 0.22]], bbox: { x: 0.14, y: 0.22, w: 0.08, h: 0.08 } }],
  });
  const feed = h.feedsSeen.get('cam-C');
  assert.ok(feed.hud.raf > 0);

  keepGoing = false;
  h.stepRaf(16);
  assert.equal(feed.hud.raf, 0);
  assert.equal(feed.hud.running, false);
  assert.equal(h.pendingRafCount, 0);
});

