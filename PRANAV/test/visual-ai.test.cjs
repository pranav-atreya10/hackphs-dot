const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let VisualBirdVerifier, chooseBirdCandidate;

before(async () => {
  // Use ESM semantics in tests without changing the CommonJS server package.
  const source = await fs.readFile(path.join(__dirname, '../public/js/visual-ai.js'), 'utf8');
  ({ VisualBirdVerifier, chooseBirdCandidate } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
});

function feed(patch = {}) {
  return { cameraId: 'iphone', video: { width: 1280, height: 720 }, lastFrameAt: Date.now(), frameT: 100,
    mode: 'server', botState: { t: 100, tracks: [{ id: 1, classification: 'unknown', bbox: { x: .3, y: .2, w: .08, h: .1 } }] }, ...patch };
}
function setup({ classify, load } = {}) {
  const emitted = [], button = { textContent: '', addEventListener() {}, setAttribute() {} }, status = { dataset: {} };
  let calls = 0;
  class Adapter {
    constructor() { this.stats = { intervalMs: 900 }; }
    async load() { if (load) await load(); }
    async classifyBox() { calls++; return classify ? classify() : { label: 'bird', score: .84, ms: 30 }; }
    adapt() {}
  }
  const socket = { connected: true, timeout() { return { emit(name, payload, ack) { emitted.push({ name, payload }); ack(null, { ok: true }); } }; } };
  const verifier = new VisualBirdVerifier({ socket, button, status, loadAdapter: async () => ({ CocoVerifier: Adapter }) });
  return { verifier, emitted, status, calls: () => calls };
}

test('selection skips small, invalid, stale, moving and learning feeds', () => {
  const now = Date.now(), valid = feed();
  const cases = [
    feed({ lastFrameAt: now - 3000 }), feed({ offline: true }), feed({ frameT: NaN }),
    feed({ botState: { shake: true, tracks: valid.botState.tracks } }),
    feed({ botState: { learning: true, tracks: valid.botState.tracks } }),
    feed({ botState: { motion: { ready: false }, tracks: valid.botState.tracks } }),
    feed({ botState: { tracks: [{ ...valid.botState.tracks[0], bbox: { x: .9, y: .2, w: .2, h: .1 } }] } }),
    feed({ botState: { tracks: [{ ...valid.botState.tracks[0], bbox: { x: .3, y: .2, w: .001, h: .001 } }] } }),
    feed({ botState: { tracks: [{ ...valid.botState.tracks[0], classification: 'rejected' }] } }),
  ];
  for (const item of cases) assert.equal(chooseBirdCandidate(new Map([['iphone', item]]), new Map(), now), null);
  assert.equal(chooseBirdCandidate(new Map([['iphone', valid]]), new Map(), now).tr.id, 1);
  assert.equal(chooseBirdCandidate(new Map([['iphone', valid]]), new Map([['iphone:1', now - 100]]), now), null);
});

test('a second opinion prioritizes an unknown track over a larger already-classified bird', () => {
  const unknown = feed(), bird = feed({ cameraId: 'other' });
  bird.botState.tracks = [{ id: 2, classification: 'bird', bbox: { x: .1, y: .1, w: .4, h: .4 } }];
  assert.equal(chooseBirdCandidate(new Map([['other', bird], ['iphone', unknown]]), new Map()).t.cameraId, 'iphone');
});

test('trained label carries the matching track, crop and capture clock to the server', async () => {
  const s = setup();
  try {
    await s.verifier.enable(); s.verifier.onFeed(feed()); await s.verifier.tick();
    assert.equal(s.emitted.length, 1);
    assert.equal(s.emitted[0].name, 'tower:label');
    assert.deepEqual(s.emitted[0].payload, { cameraId: 'iphone', trackId: 1, label: 'bird', score: .84,
      bbox: { x: .3, y: .2, w: .08, h: .1 }, frameT: 100, source: 'coco' });
    assert.match(s.status.textContent, /bird 84%/);
  } finally { s.verifier.disable(); }
});

test('slow inference never overlaps another check and disabling discards its result', async () => {
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const s = setup({ classify: () => result });
  try {
    await s.verifier.enable(); s.verifier.onFeed(feed());
    const first = s.verifier.tick(); await s.verifier.tick();
    assert.equal(s.calls(), 1);
    s.verifier.disable(); finish({ label: 'bird', score: .9, ms: 800 }); await first;
    assert.equal(s.emitted.length, 0);
    assert.equal(s.status.dataset.state, 'off');
  } finally { s.verifier.disable(); }
});

test('a vanished track cannot receive an old trained label', async () => {
  let finish;
  const result = new Promise(resolve => { finish = resolve; }), s = setup({ classify: () => result }), t = feed();
  try {
    await s.verifier.enable(); s.verifier.onFeed(t);
    const first = s.verifier.tick(); t.botState = { t: 101, tracks: [] };
    finish({ label: 'bird', score: .9, ms: 30 }); await first;
    assert.equal(s.emitted.length, 0);
  } finally { s.verifier.disable(); }
});

test('handover during an inference cannot label a different engine with the same track ID', async () => {
  let finish;
  const result = new Promise(resolve => { finish = resolve; }), s = setup({ classify: () => result }), t = feed();
  const applied = [];
  try {
    await s.verifier.enable(); s.verifier.onFeed(t);
    const first = s.verifier.tick();
    t.mode = 'tower'; t.fallbackState = t.botState;
    t.engine = { applyLabel(...args) { applied.push(args); } };
    finish({ label: 'bird', score: .9, ms: 30 }); await first;
    assert.equal(s.emitted.length, 0); assert.equal(applied.length, 0);
  } finally { s.verifier.disable(); }
});

test('unavailable model download leaves detection usable with a retryable status', async () => {
  const s = setup({ load: async () => { throw new Error('CDN unavailable'); } });
  await s.verifier.enable(); s.verifier.onFeed(feed()); await s.verifier.tick();
  assert.equal(s.verifier.enabled, false);
  assert.equal(s.status.dataset.state, 'unavailable');
  assert.match(s.status.textContent, /Motion detection stays active/);
  assert.equal(s.calls(), 0); assert.equal(s.emitted.length, 0);
});

test('fallback labels go to the local engine, never the inactive server engine', async () => {
  const applied = [], t = feed({ mode: 'tower', engine: { applyLabel(...args) { applied.push(args); } } });
  t.fallbackState = t.botState;
  const s = setup();
  try {
    await s.verifier.enable(); s.verifier.onFeed(t); await s.verifier.tick();
    assert.deepEqual(applied, [[1, 'bird', .84, 'coco']]); assert.equal(s.emitted.length, 0);
  } finally { s.verifier.disable(); }
});
