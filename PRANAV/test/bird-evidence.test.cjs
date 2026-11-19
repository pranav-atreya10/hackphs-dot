const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = import('../public/js/bird-evidence.js');
const track = (id, opts = {}) => ({ id, classification: 'unknown', bbox: { x: .1, y: .1, w: .2, h: .15 }, ...opts });
const decoded = (frameId, opts = {}) => ({
  streamId: 'live-a', frameId, frameT: frameId / 10, frameReceivedAt: 1000,
  bitmap: { width: 800, height: 600, closed: 0, close() { this.closed++; } }, ...opts,
});
const detected = (frame, tracks, opts = {}) => ({
  streamId: frame.streamId, frameId: frame.frameId, generation: 3, state: { t: frame.frameT, tracks }, ...opts,
});

test('pairs only exact stream, frame, and time; keeps the matched generation', async () => {
  const { BirdFramePairs } = await helpers;
  const pairs = new BirdFramePairs(), first = decoded(1), next = decoded(2);
  pairs.addFrame(first);
  pairs.addState(detected(first, [track(1)], { streamId: 'previous-stream' }));
  pairs.addState(detected(next, [track(2)], { frameId: 1 }));
  assert.equal(pairs.latest, null);
  pairs.addState(detected(next, [track(2)], { generation: 4 }));
  pairs.addFrame(next);
  assert.equal(pairs.latest.frame, next);
  assert.equal(pairs.latest.generation, 4);
  pairs.addState(detected(first, [track(1)]));
  assert.equal(pairs.latest.frame, next, 'late state cannot replace more recent exact evidence');
  for (let id = 3; id <= 12; id++) pairs.addFrame(decoded(id));
  assert.equal(first.bitmap.closed, 1, 'nonmatching frames are reclaimed');
  assert.equal(next.bitmap.closed, 0, 'latest matched frame remains usable while unmatched frames are evicted');
  pairs.clear();
  assert.equal(next.bitmap.closed, 1);
});

test('samples across cameras and long-lived tracks even at the slow check interval', async () => {
  const { chooseBirdCandidate, pruneBirdAttempts } = await helpers;
  const frameA = decoded(1), frameB = decoded(1, { streamId: 'live-b' });
  const a = { cameraId: 'A', birdEvidence: { frame: frameA, source: 'server', state: detected(frameA,
    [1, 2, 3, 4, 5, 6].map(id => track(id))).state } };
  const b = { cameraId: 'B', birdEvidence: { frame: frameB, source: 'server', state: detected(frameB,
    [track(1, { classification: 'bird' })]).state } };
  const feeds = new Map([['A', a], ['B', b]]), checked = new Map(), cameraAttempts = new Map();
  const picks = [];
  for (let i = 0; i < 12; i++) {
    const now = 1000 + i * 4000;
    a.lastFrameAt = b.lastFrameAt = frameA.frameReceivedAt = frameB.frameReceivedAt = now;
    pruneBirdAttempts(feeds, checked, cameraAttempts, now);
    const c = chooseBirdCandidate(feeds, checked, now, cameraAttempts);
    picks.push(`${c.t.cameraId}${c.tr.id}`);
    checked.set(c.key, now);
    cameraAttempts.set(c.t.cameraId, now);
  }
  assert.deepEqual(picks, ['A1', 'B1', 'A2', 'B1', 'A3', 'B1', 'A4', 'B1', 'A5', 'B1', 'A6', 'B1']);
});

test('skips dense, missed, stale, and undersized evidence but keeps an individually visible flock member', async () => {
  const { chooseBirdCandidate } = await helpers;
  const frame = decoded(1), state = detected(frame, [
    track(1, { dense: true }), track(2, { missed: true }),
    track(3, { bbox: { x: .25, y: .25, w: .025, h: .02 } }),
    track(4, { is_flock: true }),
  ]).state;
  const t = { cameraId: 'A', birdEvidence: { source: 'server', frame, state } };
  const feeds = new Map([['A', t]]);
  assert.equal(chooseBirdCandidate(feeds, new Map(), 1000).tr.id, 4);
  assert.equal(chooseBirdCandidate(feeds, new Map(), 3501), null);
  assert.equal(chooseBirdCandidate(feeds, new Map(), 1000, new Map()).nativeWidth, 160);
});

test('captures into a detached, bounded canvas without substituting a later frame', async () => {
  const { chooseBirdCandidate, captureBirdEvidence } = await helpers;
  const frame = decoded(1), t = { cameraId: 'A', video: { width: 1600, height: 1200 } };
  const big = track(1, { bbox: { x: 0, y: 0, w: 1, h: 1 } });
  t.birdEvidence = { frame, source: 'server', state: detected(frame, [big]).state };
  const candidate = chooseBirdCandidate(new Map([['A', t]]), new Map(), 1000);
  let draw;
  const capture = captureBirdEvidence(candidate, undefined, () => ({ getContext: () => ({ drawImage: (...args) => { draw = args; } }) }));
  assert.equal(draw[0], frame.bitmap);
  assert.equal(capture.canvas.width, 600);
  assert.equal(capture.nativeWidth, 800);
  assert.equal(capture.nativeHeight, 600);
  const small = track(2, { bbox: { x: .1, y: .1, w: .04, h: .04 } });
  t.birdEvidence = { frame, source: 'server', state: detected(frame, [small]).state };
  const smallCandidate = chooseBirdCandidate(new Map([['A', t]]), new Map(), 1000);
  const native = captureBirdEvidence(smallCandidate, undefined, () => ({ getContext: () => ({ drawImage() {} }) }));
  assert.equal(native.nativeWidth, 32);
  assert.equal(native.canvas.width, 70, 'copies 70 source pixels rather than enlarging to the model input');
  t.birdEvidence = null;
  assert.equal(captureBirdEvidence(candidate), null);
});

test('feed overlay ignores late boxes on newer video while verifier keeps the exact older pair', async t => {
  const { startFeeds } = await import('../public/js/feeds.js');
  const handlers = {}, video = { width: 0, height: 0 }, boxCalls = [];
  video.getContext = () => ({ drawImage() {} });
  const overlay = { clientWidth: 800, clientHeight: 600, getContext: () => ({
    clearRect() {}, strokeRect(...args) { boxCalls.push(args); }, fillText() {},
  }) };
  const element = { setAttribute() {}, addEventListener() {} };
  const tile = { querySelectorAll: () => [video, overlay], querySelector: () => element, addEventListener() {} };
  const document = { createElement: tag => tag === 'div' ? tile : { ...element, getContext: () => ({}) }, addEventListener() {} };
  t.mock.method(globalThis, 'setTimeout', () => {});
  t.mock.method(globalThis, 'setInterval', () => {});
  const before = new Map();
  for (const [key, value] of Object.entries({ document, devicePixelRatio: 1, createImageBitmap: async () => decoded(0).bitmap })) {
    before.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let feed;
  startFeeds({ on: (name, fn) => { handlers[name] = fn; } }, {
    container: { after() {}, appendChild() {} }, hint: {}, demo: false, onFeed: v => { feed = v; },
  });
  const send = async id => {
    const frame = decoded(id);
    handlers['camera:frame']({ cameraId: 'A', streamId: frame.streamId, frameId: id, t: frame.frameT, jpeg: new Uint8Array() });
    await Promise.resolve();
    return frame;
  };
  const state = (frame, generation = 'active') => handlers['bot:state']({
    cameraId: 'A', ...detected(frame, [track(frame.frameId)], { generation, state: {
      t: frame.frameT, generation, risk: 'yellow', tracks: [track(frame.frameId)],
    } }), mode: 'server', at: Date.now() - 10 + frame.frameId, remaining_ms: 1000,
  });
  handlers['bot:status']({ cameraId: 'A', mode: 'server', generation: 'active' });
  const first = await send(1), next = await send(2);
  state(next, 'stale');
  assert.equal(feed.birdEvidence, null);
  state(first);
  assert.equal(feed.birdEvidence.frame.frameId, 1);
  assert.equal(boxCalls.length, 0, 'state for frame 1 must not draw on frame 2');
  state(next);
  assert.equal(feed.birdEvidence.frame.frameId, 2);
  assert.equal(boxCalls.length, 1);
  handlers.disconnect();
  assert.equal(feed.birdEvidence, null);
  assert.equal(feed.offline, true);
});
