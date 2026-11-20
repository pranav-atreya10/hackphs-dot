const { test } = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../public/js/skysentry-v41-vote.mjs');
const phase = { cameraId: 'west', streamId: 'stream-a', generation: 'tracker-a' };
const bird = { bird: 1, drone: 0, other: 0 };
const drone = { bird: 0, drone: 1, other: 0 };
const frameInfo = (frameId, extra) => ({ ...phase, frameId, captureTime: frameId * 100, liveTrackIds: [1], ...extra });

async function setup(options) {
  const { createV41Votes } = await modulePromise;
  const votes = createV41Votes({ now: () => 0, ...options });
  function open(id, extra) {
    const frame = votes.prune(frameInfo(id, extra));
    assert.equal(frame.status, 'active');
    return frame;
  }
  function record(frame, probs = bird, trackId = 1) {
    return votes.record({ frame, trackId, probs });
  }
  return { ...votes, open, record };
}

test('a fifth distinct frame returns the probability mean, then the window rolls', async () => {
  const { open, record } = await setup();
  const weakBird = { bird: 0.5, drone: 0.375, other: 0.125 };
  const first = { ...weakBird };
  for (const [index, probs] of [first, weakBird, weakBird, drone].entries()) {
    assert.deepEqual(record(open(index + 1), probs), {
      status: 'collecting', count: index + 1, label: null, score: null, probs: null,
    });
  }
  first.bird = 0; // Callers can reuse prediction objects without changing the saved sample.
  assert.equal(record(open(5), { bird: 2, drone: 1, other: 0 }).reason, 'invalid-probabilities');
  assert.deepEqual(record(open(6), drone), {
    status: 'ready', count: 5, label: 'drone', score: 0.625,
    probs: { bird: 0.3, drone: 0.625, other: 0.075 },
  });
  assert.deepEqual(record(open(8), bird), {
    status: 'ready', count: 5, label: 'drone', score: 0.55,
    probs: { bird: 0.4, drone: 0.55, other: 0.05 },
  });
});

test('exact ties use model class order, including a tie between drone and other', async () => {
  for (const [probs, label] of [
    [{ bird: 0.5, drone: 0.5, other: 0 }, 'bird'],
    [{ bird: 0, drone: 0.5, other: 0.5 }, 'drone'],
  ]) {
    const { open, record } = await setup();
    for (let id = 1; id < 5; id++) assert.equal(record(open(id), probs).label, null);
    assert.equal(record(open(5), probs).label, label);
  }
});

test('camera, track, stream and detector lifetimes do not pool evidence', async () => {
  const { open, record, prune, clear } = await setup();
  const east = { cameraId: 'east' };
  const westFrame = open(1, { liveTrackIds: [1, 2] });
  const eastFrame = open(1, east);
  assert.equal(record(westFrame).count, 1);
  assert.equal(record(westFrame, drone, 2).count, 1);
  assert.equal(record(eastFrame).count, 1);

  const stream = { streamId: 'stream-b' };
  const generation = { ...stream, generation: 'tracker-b' };
  assert.equal(prune(frameInfo(2, stream)).reason, 'wrong-phase');
  clear(phase.cameraId);
  assert.equal(record(westFrame).reason, 'stale-frame');
  const newStreamFrame = open(1, stream);
  assert.equal(record(newStreamFrame).count, 1);
  assert.equal(prune(frameInfo(2, generation)).reason, 'wrong-phase');
  clear(phase.cameraId);
  assert.equal(record(newStreamFrame).reason, 'stale-frame');
  const newGenerationFrame = open(1, generation);
  assert.equal(record(newGenerationFrame).count, 1);
  assert.equal(record(open(2, east)).count, 2);

  clear();
  // Even registering the same metadata anew doesn't revive an old handle.
  const nextFrame = open(1, generation);
  assert.equal(record(newGenerationFrame).reason, 'stale-frame');
  assert.equal(record(nextFrame).count, 1);
  assert.equal(record(eastFrame).reason, 'stale-frame');
});

test('duplicate, reordered and late frames do not count, even after a track ID reappears', async () => {
  const { open, record, prune } = await setup();
  let frame;
  for (let id = 1; id <= 4; id++) {
    frame = open(id);
    assert.equal(record(frame).count, id);
    assert.equal(record(frame, drone).reason, 'duplicate-frame');
  }
  for (const attempt of [frameInfo(4, { captureTime: 450 }), frameInfo(3, { captureTime: 450 }),
    frameInfo(5, { captureTime: 400 }), frameInfo(5, { captureTime: 399 })]) {
    assert.equal(prune(attempt).reason, 'nonmonotonic-frame');
  }
  const empty = open(5, { liveTrackIds: [] });
  assert.equal(record(empty).reason, 'inactive-track');
  assert.equal(record(frame).reason, 'stale-frame');
  const revived = open(6);
  assert.equal(record(frame).reason, 'stale-frame');
  assert.equal(record(revived, drone).count, 1);
  assert.equal(record(open(7), drone).count, 2);
});

test('same-frame pruning keeps the handle for unvoted survivors but never restores an ID', async () => {
  const { open, record, prune } = await setup();
  const first = open(1, { liveTrackIds: [1, 2, 3] });
  assert.equal(record(first).count, 1);
  assert.equal(record(first, bird, 3).count, 1);
  const frame = open(2, { liveTrackIds: [1, 2, 3, 4] });
  assert.equal(record(frame).count, 2);

  assert.equal(prune(frameInfo(2, { liveTrackIds: [1, 2, 4] })), frame);
  assert.equal(prune(frameInfo(2, { liveTrackIds: [1, 2, 3, 4, 5] })), frame);
  assert.equal(record(frame).reason, 'duplicate-frame');
  assert.equal(record(frame, bird, 3).reason, 'inactive-track');
  assert.equal(record(frame, bird, 5).reason, 'inactive-track');
  assert.equal(record(frame, bird, 2).count, 1);
  assert.equal(record(frame, bird, 2).reason, 'duplicate-frame');

  const next = open(3, { liveTrackIds: [1, 2, 3, 4] });
  assert.equal(record(frame, bird, 4).reason, 'stale-frame');
  assert.equal(record(next, bird, 3).count, 1);
});

test('invalid metadata, rosters and probabilities do not advance a vote', async () => {
  const { open, record, prune } = await setup();
  for (const extra of [
    { cameraId: '' }, { streamId: null }, { generation: ' ' }, { captureTime: NaN },
    { captureTime: Infinity }, { captureTime: '100' }, { frameId: -1 }, { frameId: 1.5 },
    { frameId: Number.MAX_SAFE_INTEGER + 1 }, { frameId: '1' },
  ]) {
    assert.equal(prune(frameInfo(1, extra)).reason, 'invalid-frame');
  }
  assert.equal(prune(frameInfo(1, { liveTrackIds: ['1'] })).reason, 'invalid-roster');

  const frame = open(1);
  assert.equal(record({ ...frame }).reason, 'stale-frame');
  assert.equal(record(frame, bird, 2).reason, 'inactive-track');
  for (const probs of [
    null, [1, 0, 0], { bird: 1, drone: 0 }, { bird: NaN, drone: 0, other: 1 },
    { bird: '1', drone: 0, other: 0 }, { bird: 1, drone: -1, other: 1 },
    { bird: 0.7, drone: 0.7, other: 0.1 }, { bird: 0, drone: 0, other: 0 },
  ]) {
    assert.equal(record(frame, probs).reason, 'invalid-probabilities');
  }
  assert.equal(record(frame).count, 1);
});

test('inactivity expires a track even if the camera stays live; stale work gets no new lease', async () => {
  let now = 0;
  const { open, record, prune } = await setup({ ttlMs: 10, now: () => now });
  const first = open(1, { liveTrackIds: [1, 2] });
  now = 6;
  assert.equal(record(first).count, 1);

  const pending = open(2, { liveTrackIds: [1, 2] });
  assert.equal(record(pending, drone, 2).count, 1);
  now = 10;
  prune();
  assert.equal(record(pending).count, 1); // The earlier sample expired from capture, not inference.
  assert.equal(record(open(3, { liveTrackIds: [1, 2] }), drone, 2).count, 2);

  const expired = open(4);
  now = 19;
  assert.equal(prune(frameInfo(4)), expired);
  now = 20;
  assert.equal(record(expired).reason, 'expired-frame');
  assert.equal(prune(frameInfo(4)).reason, 'expired-frame');
  assert.equal(record(open(5)).count, 1);
});

test('capacity limits reject excess state without evicting an active camera or track', async () => {
  const { open, record, prune, clear } = await setup({ maxCameras: 1, maxTracks: 1 });
  assert.equal(record(open(1)).count, 1);
  assert.equal(prune(frameInfo(1, { cameraId: 'east' })).reason, 'camera-capacity');
  assert.equal(prune(frameInfo(2, { liveTrackIds: [1, 2] })).reason, 'track-capacity');
  assert.equal(record(open(2)).count, 2);
  clear(phase.cameraId);
  assert.equal(record(open(1, { cameraId: 'east' })).count, 1);
});

test('inspect returns frozen read-only progress only for live in-scope non-expired tracks', async () => {
  let now = 0;
  const { open, record, prune, clear, inspect } = await setup({ ttlMs: 10, now: () => now });
  const query = (extra = {}) => inspect({ ...phase, trackId: 1, ...extra });
  const weakBird = { bird: 0.5, drone: 0.375, other: 0.125 };

  assert.equal(inspect(), null);
  assert.equal(inspect(null), null);
  assert.equal(query(), null, 'absent before first frame');
  const first = open(1, { liveTrackIds: [1, 2] });
  assert.equal(query(), null, 'absent before first recorded sample');

  assert.equal(record(first, weakBird, 1).count, 1);
  const partial = query();
  assert.deepEqual(partial, {
    count: 1, total: 5, ready: false, label: null, confidence: null, probabilities: null,
  });
  assert.equal(Object.isFrozen(partial), true);
  for (const mismatch of [
    { cameraId: 'east' }, { streamId: 'stream-b' }, { generation: 'tracker-b' },
    { trackId: 2 }, { trackId: 0 }, { trackId: -1 }, { trackId: '1' }, { cameraId: '' },
  ]) {
    assert.equal(query(mismatch), null);
  }

  for (const [frameId, probs] of [[2, weakBird], [3, weakBird], [4, drone]]) {
    const f = open(frameId, { liveTrackIds: [1, 2] });
    record(f, probs, 1);
    record(f, bird, 2);
  }
  assert.deepEqual(query(), {
    count: 4, total: 5, ready: false, label: null, confidence: null, probabilities: null,
  });

  const fifth = open(5, { liveTrackIds: [1, 2] });
  record(fifth, drone, 1);
  const ready = query();
  assert.deepEqual(ready, {
    count: 5, total: 5, ready: true, label: 'drone', confidence: 0.625,
    probabilities: { bird: 0.3, drone: 0.625, other: 0.075 },
  });
  assert.equal(Object.isFrozen(ready), true);
  assert.equal(Object.isFrozen(ready.probabilities), true);
  assert.throws(() => { 'use strict'; ready.count = 0; }, TypeError);
  assert.throws(() => { 'use strict'; ready.probabilities.drone = 0; }, TypeError);

  // Rolling window updates inspect summary on 6th frame; same-frame roster narrowing drops pruned track.
  const sixth = open(6, { liveTrackIds: [1, 2] });
  record(sixth, bird, 1);
  assert.deepEqual(query(), {
    count: 5, total: 5, ready: true, label: 'drone', confidence: 0.55,
    probabilities: { bird: 0.4, drone: 0.55, other: 0.05 },
  });
  assert.equal(query({ trackId: 2 })?.count, 3);
  prune(frameInfo(6, { liveTrackIds: [1] }));
  assert.equal(query({ trackId: 2 }), null, 'pruned track returns null immediately');
  assert.equal(query()?.count, 5);

  // Expiry hides inactive tracks before prune() runs without mutating fresher tracks.
  now = 8;
  const seventh = open(7, { liveTrackIds: [1, 3] });
  record(seventh, bird, 3);
  now = 10;
  assert.equal(query(), null, 'expired track returns null before prune()');
  assert.equal(query({ trackId: 3 })?.count, 1, 'fresher sibling track stays inspectable');

  clear(phase.cameraId);
  assert.equal(query({ trackId: 3 }), null, 'cleared camera returns null');
});
