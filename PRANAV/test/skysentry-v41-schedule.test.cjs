const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = import('../public/js/skysentry-v41-schedule.mjs');
const START = 20_000;
const track = (id, opts = {}) => ({ id, classification: 'unknown', bbox: { x: .2, y: .2, w: .02, h: .04 }, ...opts });
const feed = (cameraId, opts = {}) => ({ cameraId, offline: false, video: { width: 4000, height: 2000 }, ...opts });
const feeds = (...list) => new Map(list.map(t => [t.cameraId, t]));
const decoded = (frameId, now, streamId) => ({
  streamId, frameId, frameT: frameId / 10, frameReceivedAt: now,
  bitmap: { width: 1000, height: 500, close() {} },
});
function frameFor(t, frameId, now, tracks, { streamId = `stream-${t.cameraId}`, generation = 'gen-1' } = {}) {
  const frame = decoded(frameId, now, streamId);
  t.birdStreamId = streamId;
  return t.birdEvidence = { source: 'server', frame, generation, state: { t: frame.frameT, generation, tracks } };
}
const ids = result => result?.tracks.map(t => t.id);

test('waits for an exact live evidence pair, not the newest displayed frame', async () => {
  const { createV41Scheduler } = await scheduler;
  const { BirdFramePairs } = await import('../public/js/bird-evidence.js');
  const a = feed('A', { birdStreamId: 'live' }), active = feeds(a), pairs = new BirdFramePairs();
  const s = createV41Scheduler();
  const first = decoded(1, START, 'live'), second = decoded(2, START, 'live');
  pairs.addFrame(first);
  pairs.addFrame(second);
  a.displayedFrame = second;
  const state = { t: first.frameT, generation: 'gen-1', tracks: [track(1)] };
  pairs.addState({ streamId: 'live', frameId: 2, state });
  a.birdEvidence = pairs.latest;
  assert.equal(s.pick(active, START), null);
  pairs.addState({ streamId: 'live', frameId: 1, state });
  a.birdEvidence = pairs.latest;
  const job = s.pick(active, START);
  assert.equal(job.feed, a);
  assert.equal(job.pair, pairs.latest);
  assert.equal(job.pair.frame, first);
  assert.deepEqual(ids(job), [1]);
});

test('skips disconnected, stale, unstable, and malformed evidence without blocking another feed', async () => {
  const { createV41Scheduler } = await scheduler;
  const a = feed('A'), b = feed('B'), active = feeds(a, b), s = createV41Scheduler();
  const invalidate = [
    (t, p) => { t.offline = true; },
    (t, p) => { p.frame.frameReceivedAt -= 2501; },
    (t, p) => { p.frame.frameReceivedAt++; },
    (t, p) => { p.frame.frameT += .001; },
    (t, p) => { t.birdStreamId = 'new-stream'; },
    (t, p) => { p.state.generation = 'retired'; },
    (t, p) => { p.source = 'demo'; },
    (t, p) => { p.frame.bitmap.width = 0; },
    ...['shake', 'learning', 'overflow'].map(flag => (t, p) => { p.state[flag] = true; }),
  ];
  for (const [i, reject] of invalidate.entries()) {
    const now = START + i * 400;
    a.offline = false;
    reject(a, frameFor(a, i + 1, now, [track(1)]));
    frameFor(b, i + 1, now, [track(1)]);
    assert.equal(s.pick(active, now)?.feed, b);
    assert.equal(s.pick(active, now), null);
  }
});

test('skips a fresh matched frame when its detector lease has expired', async () => {
  const { createV41Scheduler } = await scheduler;
  const { DetectorStatus } = await import('../public/js/detector-status.mjs');
  let monotonicNow = 0;
  const detector = new DetectorStatus(() => monotonicNow, () => START);
  const a = feed('A', { detector });
  const { state, generation } = frameFor(a, 1, START, [track(1)]);
  state.risk = 'green';
  detector.update({ mode: 'server', generation });
  assert.ok(detector.accept({ mode: 'server', state, at: START, remaining_ms: 100 }));
  monotonicNow = 100;
  assert.equal(createV41Scheduler().pick(feeds(a), START + 100), null);
  assert.equal(detector.state, state, 'checking freshness does not mutate detection results');
});

test('uses visible native box dimensions and excludes unfit tracks', async () => {
  const { createV41Scheduler } = await scheduler;
  const a = feed('A');
  const wide = track(8, { bbox: { x: .2, y: .2, w: .007, h: .004 }, is_flock: true });
  const tall = track(9, { bbox: { x: .2, y: .2, w: .003, h: .014 } });
  frameFor(a, 1, START, [
    track(1, { missed: 1 }),
    track(2, { dense: true }),
    track(3, { classification: 'debris' }),
    track(4, { classification: 'rejected' }),
    track(5, { bbox: { x: .2, y: .2, w: .0069, h: .0139 } }),
    track(6, { bbox: { x: 1, y: .2, w: .0005, h: .1 } }),
    track(7, { bbox: { x: -.2, y: .2, w: .4, h: .2 } }),
    track('7'), null, wide, tall,
  ]);
  const job = createV41Scheduler().pick(feeds(a), START);
  assert.deepEqual(ids(job), [8, 9]);
  assert.deepEqual(job.tracks.map(({ nativeWidth, nativeHeight }) => [nativeWidth, nativeHeight]), [[7, 2], [3, 7]]);
  assert.deepEqual(job.tracks[0].bbox, wide.bbox);
  assert.notEqual(job.tracks[0].bbox, wide.bbox, 'crop coordinates are detached from result state');
});

test('reserves each exact frame/track once and separates cameras, streams and generations', async () => {
  const { createV41Scheduler } = await scheduler;
  const a = feed('A'), b = feed('B'), active = feeds(a, b), s = createV41Scheduler();
  const shared = { streamId: 'stream', generation: 'gen-1' };
  frameFor(a, 4, START, [track(1), track(1)], shared);
  frameFor(b, 4, START, [track(1)], shared);
  const first = s.pick(active, START), second = s.pick(active, START);
  assert.deepEqual(ids(first), [1]);
  assert.deepEqual(JSON.parse(first.tracks[0].key), ['A', 'server', 'stream', 'gen-1', 1]);
  assert.deepEqual(JSON.parse(second.tracks[0].key), ['B', 'server', 'stream', 'gen-1', 1]);
  active.delete('A');
  assert.equal(s.pick(active, START), null);
  active.set('A', a);
  frameFor(a, 4, START, [track(1)], shared);
  assert.equal(s.pick(active, START + 10), null, 'recreating feed evidence does not make the frame new');
  frameFor(a, 5, START + 20, [track(1)], shared);
  assert.equal(s.pick(active, START + 20).tracks[0].key, first.tracks[0].key);
  frameFor(a, 3, START, [track(1)], shared);
  assert.equal(s.pick(active, START + 30), null, 'does not go backwards on a live timeline');
  frameFor(a, 5, START + 40, [track(1)], { ...shared, generation: 'gen-2' });
  assert.deepEqual(JSON.parse(s.pick(active, START + 40).tracks[0].key), ['A', 'server', 'stream', 'gen-2', 1]);
  frameFor(a, 1, START + 50, [track(1)], { streamId: 'new-stream', generation: 'gen-2' });
  assert.deepEqual(JSON.parse(s.pick(active, START + 50).tracks[0].key), ['A', 'server', 'new-stream', 'gen-2', 1]);
});

test('can serve untouched tracks on a still-fresh frame without enqueuing old work', async () => {
  const { createV41Scheduler } = await scheduler;
  const a = feed('A'), active = feeds(a), s = createV41Scheduler();
  const tracks = Array.from({ length: 18 }, (_, i) => track(i + 1));
  const pair = frameFor(a, 1, START, tracks);
  assert.deepEqual(ids(s.pick(active, START)), [1, 2, 3, 4, 5, 6, 7, 8]);
  const second = s.pick(active, START + 400);
  assert.equal(second.pair, pair);
  assert.deepEqual(ids(second), [9, 10, 11, 12, 13, 14, 15, 16]);
  frameFor(a, 2, START + 800, [track(19)]);
  assert.deepEqual(ids(s.pick(active, START + 800)), [19]);
  assert.equal(s.pick(active, START + 1200), null);
});

test('contended tracks complete five-frame votes while busy worker ticks still rotate cameras', async () => {
  const { createV41Scheduler } = await scheduler;
  const tickMs = 350, expiryMs = 3000;
  const workerMs = [180, 430, 250, 550, 210, 900, 330, 260];
  const dense = Array.from({ length: 12 }, (_, i) => track(101 + i, { dense: true }));
  for (const size of [40, 60]) {
    const a = feed('A'), b = feed('B'), s = createV41Scheduler();
    const flock = Array.from({ length: size }, (_, i) => track(i + 1, { is_flock: true }));
    const recent = new Map(), ready = new Set();
    let freeAt = START, jobs = 0;
    for (let i = 0; i * tickMs < 60_000; i++) {
      const now = START + i * tickMs;
      if (now < freeAt) continue;
      const offset = (i * 13) % size;
      frameFor(a, i + 1, now, [...dense, ...flock.slice(offset), ...flock.slice(0, offset)]);
      frameFor(b, i + 1, now, [...flock].reverse());
      const job = s.pick(i % 3 === 1 ? feeds(b, a) : feeds(a, b), now);
      assert.equal(job.feed, jobs % 2 === 0 ? a : b);
      assert.equal(job.pair, job.feed.birdEvidence);
      assert.equal(job.tracks.length, 8);
      freeAt = now + workerMs[jobs++ % workerMs.length];
      for (const { id, key } of job.tracks) {
        assert.ok(id <= size);
        const previous = recent.get(key);
        const { frameId } = job.pair.frame;
        if (previous) assert.ok(frameId > previous.frameId);
        // The voter measures expiry at result delivery against the prior dispatch.
        const count = (previous && freeAt - previous.at < expiryMs ? previous.count : 0) + 1;
        recent.set(key, { count, at: now, frameId });
        if (count === 5) ready.add(key);
      }
    }
    assert.equal(ready.size, size * 2, `2 x ${size} persistent tracks all complete a vote`);
  }
});

test('an unfinished turn does not leak across detector or stream phases', async () => {
  const { createV41Scheduler } = await scheduler;
  for (const nextPhase of [{ generation: 'gen-2' }, { streamId: 'reconnected' }]) {
    const a = feed('A'), active = feeds(a), s = createV41Scheduler();
    const tracks = Array.from({ length: 16 }, (_, i) => track(i + 1));
    const first = tracks.slice(0, 8).map(tr => tr.id), second = tracks.slice(8).map(tr => tr.id);
    for (let i = 0; i < 4; i++) {
      const now = START + i * 400;
      frameFor(a, i + 1, now, tracks);
      assert.deepEqual(ids(s.pick(active, now)), first);
    }
    for (let i = 0; i <= 5; i++) {
      const now = START + (i + 4) * 400;
      frameFor(a, i + 1, now, tracks, nextPhase);
      assert.deepEqual(ids(s.pick(active, now)), i === 5 ? second : first);
    }
  }
});

test('a persistent track gets turns even when each new frame adds more than one batch of arrivals', async () => {
  const { createV41Scheduler } = await scheduler;
  const a = feed('A'), active = feeds(a), s = createV41Scheduler();
  frameFor(a, 1, START, [track(1)]);
  assert.deepEqual(ids(s.pick(active, START)), [1]);
  let samples = 1;
  for (let i = 1; i <= 8; i++) {
    const now = START + i * 400;
    frameFor(a, i + 1, now, [...Array.from({ length: 12 }, (_, j) => track(100 + i * 12 + j)), track(1)]);
    if (ids(s.pick(active, now)).includes(1)) samples++;
  }
  assert.ok(samples > 1, 'new tracks do not continually jump ahead of a track that already had a turn');
});
