const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
let VisualBirdVerifier;

before(async () => {
  ({ VisualBirdVerifier } = await import('../public/js/visual-ai.js'));
});

const FRAME_STEP = 550;
const BIRD = { bird: .96, drone: .02, other: .02 };
const DRONE = { bird: .02, drone: .96, other: .02 };

function feed(cameraId = 'iphone', source = 'server') {
  const labelWrites = [];
  return {
    cameraId, mode: source === 'server' ? 'server' : 'tower', source, demo: source === 'demo', labelWrites,
    engine: { applyLabel(...args) { labelWrites.push(args); } },
  };
}

function frame(tile, { frameId = 5, trackId = 1, generation = 'generation-a', dense = false } = {}) {
  const streamId = `${tile.cameraId}-stream`;
  const frameT = frameId / 10, frameReceivedAt = Date.now();
  const track = { id: trackId, classification: 'unknown', bbox: { x: .25, y: .25, w: .2, h: .2 }, dense };
  const state = { generation, t: frameT, tracks: [track], risk: 'yellow', reasons: ['existing detector warning'] };
  tile.lastFrameAt = frameReceivedAt;
  tile.birdStreamId = streamId;
  tile[tile.source === 'server' ? 'botState' : 'fallbackState'] = state;
  tile.birdEvidence = {
    source: tile.source, state, generation,
    frame: { streamId, frameId, frameT, frameReceivedAt, bitmap: { width: 320, height: 240 } },
  };
  return tile;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function predictions(boxes, probs = BIRD) {
  return boxes.map(() => ({ probs: { ...probs } }));
}

function worker({ load = async () => {}, classify = (_frame, boxes) => predictions(boxes) } = {}) {
  const calls = [];
  return {
    calls, closes: 0,
    load,
    async classify(frame, boxes) {
      calls.push({ frame, boxes });
      return classify(frame, boxes);
    },
    close() { this.closes++; },
  };
}

function setup(t, { createClient = () => worker(), judge } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: tag => {
        assert.equal(tag, 'canvas');
        return { getContext: () => ({
          drawImage() {},
          getImageData: (_x, _y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        }) };
      },
    },
  });
  t.after(() => {
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else delete globalThis.document;
  });
  const button = { attrs: {}, addEventListener() {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const status = { dataset: {}, textContent: '' }, reviewStatus = { textContent: '' }, clients = [];
  const createWorkerClient = async () => {
    const client = createClient(clients.length);
    clients.push(client);
    return client;
  };
  const verifier = new VisualBirdVerifier({ button, status, reviewStatus, createWorkerClient,
    now: () => Date.now(), isHidden: () => false });
  t.after(() => verifier.disable());
  if (judge) {
    verifier.setJudge(judge);
    t.after(() => verifier.setJudge(null));
  }
  const advance = (ms = FRAME_STEP) => t.mock.timers.setTime(Date.now() + ms);
  const publish = (tile, options) => verifier.onFeed(frame(tile, options));
  const sample = async (tile, options) => {
    advance();
    publish(tile, options);
    await verifier.tick();
  };
  return { verifier, button, status, reviewStatus, clients, advance, publish, sample };
}

function collecting(s, count) {
  assert.notEqual(s.status.dataset.state, 'active', 'a partial vote must not publish a class');
  assert.match(s.status.textContent, new RegExp(`\\b${count}\\s*/\\s*5\\b`), `expected ${count}/5 accepted frames`);
  assert.doesNotMatch(s.status.textContent, /object \d+\s*:\s*(bird|drone|other)\b/i);
}

test('model stays unloaded until enable, shows loading while pending, and stops on disable', async t => {
  const pending = deferred(), tile = feed();
  const client = worker({ load: () => pending.promise });
  const s = setup(t, { createClient: () => client });
  s.publish(tile);
  await s.verifier.tick();
  assert.deepEqual(s.clients, []);
  assert.equal(s.button.attrs['aria-pressed'], 'false');

  const loading = s.verifier.enable();
  await nextTurn();
  assert.deepEqual(s.clients, [client]);
  assert.equal(s.status.dataset.state, 'loading');
  assert.match(s.status.textContent, /Loading v4\.1.*motion detection stays active/i);
  await s.verifier.tick();
  assert.equal(client.calls.length, 0, 'loading cannot start inference');

  pending.resolve();
  await loading;
  assert.equal(s.status.dataset.state, 'ready');
  assert.equal(s.button.attrs['aria-pressed'], 'true');
  t.mock.timers.tick(FRAME_STEP);
  await nextTurn();
  assert.equal(client.calls.length, 1, 'enable schedules local checks');

  s.verifier.disable();
  s.publish(tile, { frameId: 6 });
  t.mock.timers.tick(FRAME_STEP);
  await nextTurn();
  assert.equal(client.calls.length, 1, 'disable cancels scheduled checks');
  assert.equal(client.closes, 1);
  assert.equal(s.status.dataset.state, 'off');
  assert.equal(s.button.attrs['aria-pressed'], 'false');
});

test('slow inference does not overlap and its completion cannot update a new enable session', async t => {
  const pending = deferred(), tile = feed();
  // Keep the fake promise pending across close to exercise the controller's own lifetime guard.
  const firstClient = worker({ classify: () => pending.promise });
  const s = setup(t, { createClient: index => index === 0 ? firstClient : worker() });
  await s.verifier.enable();
  s.publish(tile);
  const first = s.verifier.tick();
  s.advance();
  s.publish(tile, { frameId: 6 });
  const overlapping = s.verifier.tick();
  await nextTurn();
  assert.equal(firstClient.calls.length, 1);

  s.verifier.disable();
  assert.equal(s.status.dataset.state, 'off');
  assert.equal(firstClient.closes, 1);
  await s.verifier.enable();
  await s.sample(tile, { frameId: 7 });
  assert.equal(s.clients[1].calls.length, 1);
  collecting(s, 1);
  const freshStatus = s.status.textContent;

  pending.resolve(predictions(firstClient.calls[0].boxes, DRONE));
  await Promise.all([first, overlapping]);
  assert.equal(s.status.textContent, freshStatus);
});

test('only five distinct frames publish a browser advisory without writing detector state', async t => {
  const tile = feed();
  let probs = BIRD;
  const s = setup(t, { createClient: () => worker({ classify: (_frame, boxes) => predictions(boxes, probs) }) });
  await s.verifier.enable();
  for (let frameId = 1; frameId <= 4; frameId++) {
    await s.sample(tile, { frameId });
    collecting(s, frameId);
  }
  s.advance();
  s.verifier.onFeed(tile); // Same paired frame, still fresh and past the sampling interval.
  await s.verifier.tick();
  collecting(s, 4);

  probs = DRONE;
  s.advance();
  s.publish(tile, { frameId: 5 });
  const operational = tile.botState, prior = structuredClone(operational);
  await s.verifier.tick();
  assert.equal(s.status.dataset.state, 'active');
  assert.match(s.status.textContent, /Browser advisory.*object 1:\s*bird\b.*5 frames.*Not a clearance/i);
  assert.equal(tile.botState, operational);
  assert.deepEqual(tile.botState, prior);
  assert.deepEqual(tile.labelWrites, []);
});

test('a late sample from the previous tracker generation cannot warm the reused track ID', async t => {
  const tile = feed(), pending = deferred();
  const client = worker({ classify: (_frame, boxes) => client.calls.length === 5 ? pending.promise : predictions(boxes) });
  const s = setup(t, { createClient: () => client });
  await s.verifier.enable();
  for (let frameId = 1; frameId <= 4; frameId++) await s.sample(tile, { frameId });
  collecting(s, 4);
  s.advance();
  s.publish(tile, { frameId: 5 });
  const old = s.verifier.tick();
  await nextTurn();
  assert.equal(client.calls.length, 5);

  s.advance();
  s.publish(tile, { frameId: 6, generation: 'generation-b' });
  pending.resolve(predictions(client.calls[4].boxes, DRONE));
  await old;
  assert.notEqual(s.status.dataset.state, 'active', 'the old generation cannot complete a vote');
  await s.verifier.tick();
  assert.equal(client.calls.length, 6);
  collecting(s, 1);
});

test('replacing a track discards its partial vote even if its ID reappears', async t => {
  const tile = feed(), s = setup(t);
  await s.verifier.enable();
  for (let frameId = 1; frameId <= 4; frameId++) await s.sample(tile, { frameId });
  collecting(s, 4);
  await s.sample(tile, { frameId: 5, trackId: 2 });
  collecting(s, 1);
  await s.sample(tile, { frameId: 6, trackId: 1 });
  collecting(s, 1);
});

test('a model fetch failure keeps motion detection active and retry creates a fresh worker', async t => {
  const tile = feed();
  const broken = worker({ load: async () => { throw new Error('Weights unavailable'); } });
  const s = setup(t, { createClient: index => index === 0 ? broken : worker() });
  s.publish(tile);
  const operational = structuredClone(tile.botState);
  await s.verifier.enable();
  await s.verifier.tick();
  assert.deepEqual(s.clients, [broken]);
  assert.equal(s.verifier.enabled, false);
  assert.equal(s.button.attrs['aria-pressed'], 'false');
  assert.equal(s.status.dataset.state, 'unavailable');
  assert.match(s.status.textContent, /Motion detection stays active.*retry/i);
  assert.equal(broken.calls.length, 0);
  assert.equal(broken.closes, 1);
  assert.deepEqual(tile.botState, operational);

  await s.verifier.enable();
  assert.equal(s.clients.length, 2);
  assert.equal(s.status.dataset.state, 'ready');
  await s.sample(tile, { frameId: 6 });
  assert.equal(s.clients[1].calls.length, 1);
  collecting(s, 1);
  assert.deepEqual(tile.labelWrites, []);
});

function reviewResult(ref, verdict) {
  return { status: 'verified', source: 'gemini', verdict, application: 'advisory',
    evidenceRef: { ...ref, generation: 'generation-a', t: ref.frameId / 10 } };
}

test('pending review does not delay browser checks and a late verdict is historical', async t => {
  const tile = feed(), result = deferred(), requests = [];
  const s = setup(t, { judge: ref => { requests.push(ref); return result.promise; } });
  s.publish(tile);
  await s.verifier.tick();
  assert.deepEqual(s.clients, [], 'optional evidence review works with browser inference off');
  assert.deepEqual(requests, [{ cameraId: 'iphone', streamId: 'iphone-stream', frameId: 5, trackId: 1 }]);
  assert.match(s.reviewStatus.textContent, /pending/);

  await s.verifier.enable();
  await s.verifier.tick();
  await s.sample(tile, { frameId: 6 });
  assert.equal(s.clients[0].calls.length, 2);
  collecting(s, 2);
  assert.equal(requests.length, 1);

  s.advance(2501);
  result.resolve(reviewResult(requests[0], 'not_bird'));
  await result.promise;
  assert.match(s.reviewStatus.textContent, /Earlier cloud review.*not a bird.*Not a clearance/);
  assert.deepEqual(tile.labelWrites, []);
});

for (const [verdict, text] of [['bird', /: bird\./], ['uncertain', /: uncertain\./]]) {
  test(`cloud review renders ${verdict} without changing the detector`, async t => {
    const s = setup(t, { judge: async ref => reviewResult(ref, verdict) });
    const tile = feed();
    s.publish(tile);
    const operational = structuredClone(tile.botState);
    await s.verifier.tick();
    assert.match(s.reviewStatus.textContent, text);
    assert.deepEqual(tile.botState, operational);
    assert.deepEqual(tile.labelWrites, []);
  });
}

for (const [source, dense] of [['tower', false], ['demo', false], ['server', true]]) {
  test(`does not request cloud review for ${dense ? 'a dense track' : source}`, async t => {
    const requests = [];
    const s = setup(t, { judge: ref => { requests.push(ref); } });
    s.publish(feed('iphone', source), { dense });
    await s.verifier.tick();
    assert.deepEqual(requests, []);
    assert.equal(s.reviewStatus.textContent, '');
  });
}
