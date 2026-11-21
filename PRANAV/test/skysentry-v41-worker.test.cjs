const assert = require('node:assert/strict');
const { on, once } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Worker } = require('node:worker_threads');

const modelDir = path.join(__dirname, '..', '..', 'Shreyansh Local Ai Model');
const weightsPath = path.join(modelDir, 'skysentry_classifier.json');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const classifierUrl = moduleUrl(readFileSync(path.join(modelDir, 'skysentry_classifier.js')));
const workerSource = readFileSync(path.join(__dirname, '..', 'public', 'js', 'skysentry-v41-worker.mjs'), 'utf8');
const workerUrl = moduleUrl(workerSource.replace("'/ai-models/skysentry_classifier.js'", JSON.stringify(classifierUrl)));

// Bridge the browser Worker API to a real worker thread; intercept only the two local asset URLs.
function workerBootstrap() {
  const assert = require('node:assert/strict');
  const { readFileSync } = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');
  let releaseLoad;
  const loadAllowed = new Promise(resolve => { releaseLoad = resolve; });
  if (!workerData.holdLoad) releaseLoad();
  globalThis.self = {
    addEventListener(event, receive) {
      assert.equal(event, 'message');
      parentPort.on('message', data => {
        if (data === 'release-load') releaseLoad();
        else receive({ data });
      });
    },
    postMessage: reply => parentPort.postMessage(reply),
  };
  let fetches = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/ai-models/skysentry_classifier.json');
    assert.equal(options.mode, 'same-origin');
    const mode = workerData.responses[fetches++];
    await loadAllowed;
    if (mode === 'missing') return new Response('', { status: 404 });
    if (mode === 'invalid-json') return new Response('not json');
    assert.ok(['truncated', 'nonfinite', 'valid'].includes(mode), 'unexpected extra weight request');
    const spec = JSON.parse(readFileSync(workerData.weightsPath, 'utf8'));
    if (mode === 'truncated') spec.layers[0].weight_b64 = 'AAAA';
    if (mode === 'nonfinite') {
      const bias = Buffer.from(spec.layers[0].bias_b64, 'base64');
      bias.writeFloatLE(NaN, 0);
      spec.layers[0].bias_b64 = bias.toString('base64');
    }
    return Response.json(spec);
  };
  import(workerData.workerUrl).then(() => {
    assert.equal(fetches, 0, 'assets must not load before a request');
    parentPort.postMessage('ready');
  }).catch(error => { throw error; });
}

async function startWorker(t, responses, holdLoad = false) {
  const worker = new Worker(`(${workerBootstrap.toString()})()`, {
    eval: true, workerData: { workerUrl, weightsPath, responses, holdLoad },
  });
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, 'message'), ['ready']);
  return worker;
}

async function request(worker, data, transfer = []) {
  const reply = once(worker, 'message');
  worker.postMessage(data, transfer);
  return (await reply)[0];
}

function assertError(reply, id, pattern) {
  assert.deepEqual(Object.keys(reply).sort(), ['error', 'id', 'ok']);
  assert.equal(reply.id, id);
  assert.equal(reply.ok, false);
  assert.match(reply.error, pattern);
}

const box = { x: 0, y: 0, w: 0.1, h: 0.1 };

test('a cold classify of transferred RGBA matches direct v4.1 inference in box order', { timeout: 5000 }, async t => {
  const worker = await startWorker(t, ['valid']);
  const { loadClassifier } = await import(classifierUrl);
  const classifier = await loadClassifier(JSON.parse(readFileSync(weightsPath, 'utf8')));
  const width = 96, height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      data.set([x * 2, y * 3, (x * y) % 256, 255], i);
    }
  }
  const frame = { data, width, height };
  const boxes = [box, { x: 0.72, y: 0.55, w: 0.28, h: 0.45 }];
  const expected = boxes.map(b => classifier.classifyBox(frame, b)).map(({ label, score, probs }) => ({ label, score, probs }));
  assert.notDeepEqual(expected[0].probs, expected[1].probs);

  const reply = await request(worker, { id: 1, type: 'classify', frame, boxes }, [data.buffer]);
  assert.equal(data.byteLength, 0);
  assert.deepEqual(Object.keys(reply).sort(), ['id', 'ok', 'results']);
  assert.equal(reply.id, 1);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.results.map(({ ms, ...result }) => {
    assert.ok(Number.isFinite(ms) && ms >= 0);
    return result;
  }), expected);
  assert.deepEqual(await request(worker, { id: 'loaded', type: 'load' }), { id: 'loaded', ok: true });
});

test('concurrent loads share initialization, and 8 boxes on an 8-megapixel frame are accepted', { timeout: 5000 }, async t => {
  const worker = await startWorker(t, ['valid'], true);
  const replies = on(worker, 'message');
  try {
    worker.postMessage({ id: 0, type: 'load' });
    worker.postMessage({ id: 1, type: 'load' });
    worker.postMessage('release-load');
    assert.deepEqual((await replies.next()).value, [{ id: 0, ok: true }]);
    assert.deepEqual((await replies.next()).value, [{ id: 1, ok: true }]);
  } finally { await replies.return(); }

  const frame = { width: 4000, height: 2000, data: new Uint8ClampedArray(8_000_000 * 4) };
  const boxes = Array.from({ length: 8 }, () => ({ x: 0, y: 0, w: 0.01, h: 0.01 }));
  const reply = await request(worker, { id: 2, type: 'classify', frame, boxes }, [frame.data.buffer]);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.results.length, 8);
});

test('invalid requests are rejected before loading assets', { timeout: 5000 }, async t => {
  const worker = await startWorker(t, []);
  const valid = { id: 'batch', type: 'classify', frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) }, boxes: [box] };
  assertError(await request(worker, null), null, /request id/);
  assertError(await request(worker, { id: { data: valid.frame.data }, type: 'load' }), null, /request id/);
  assertError(await request(worker, { id: 3, type: 'unrecognized' }), 3, /request type/);
  for (const [changes, error] of [
    [{ frame: { ...valid.frame, width: 1.5 } }, /dimensions/],
    [{ frame: { ...valid.frame, width: 8_000_001, height: 1 } }, /8 megapixels/],
    [{ frame: { ...valid.frame, data: new Uint8Array(16) } }, /RGBA bytes/],
    [{ frame: { ...valid.frame, data: new Uint8ClampedArray(15) } }, /RGBA bytes/],
    [{ boxes: null }, /array/],
    [{ boxes: Array(9).fill(box) }, /up to 8 boxes/],
    [{ boxes: Array(1) }, /normalized box/],
    [{ boxes: [{ ...box, x: Infinity }] }, /normalized box/],
    [{ boxes: [{ ...box, h: 0 }] }, /normalized box/],
    [{ boxes: [{ ...box, x: 1 }] }, /normalized box/],
    [{
      frame: { width: 4097, height: 1, data: new Uint8ClampedArray(4097 * 4) },
      boxes: [{ x: 0, y: 0, w: 1, h: 1 }],
    }, /Box exceeds/],
  ]) {
    assertError(await request(worker, { ...valid, ...changes }), valid.id, error);
  }
});

test('missing and malformed weights fail cleanly and can be retried', { timeout: 5000 }, async t => {
  const worker = await startWorker(t, ['missing', 'invalid-json', 'truncated', 'nonfinite', 'valid']);
  for (const [id, error] of [
    [1, /HTTP 404/], [2, /weights JSON/], [3, /Malformed.*weights/], [4, /Malformed.*weights/],
  ]) {
    assertError(await request(worker, { id, type: 'load' }), id, error);
  }
  assert.deepEqual(await request(worker, { id: 5, type: 'load' }), { id: 5, ok: true });
});
