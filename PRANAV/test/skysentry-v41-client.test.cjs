const assert = require("node:assert/strict");
const test = require("node:test");

const clientModule = import("../public/js/skysentry-v41-client.mjs");
const boxes = [{ x: 0, y: 0, w: 1, h: 1 }];
const rgba = [11, 22, 33, 255];
const frame = (data = new Uint8ClampedArray(rgba)) => ({ data, width: 1, height: 1 });

class FakeWorker {
  messages = [];
  terminations = 0;

  postMessage(message, transfer) {
    this.messages.push(structuredClone(message, { transfer }));
  }

  terminate() {
    this.terminations++;
  }

  reply(fields) {
    this.onmessage?.({ data: { id: this.messages.at(-1).id, ...fields } });
  }
}

async function setup(t, createWorker = () => new FakeWorker()) {
  const { createV41WorkerClient } = await clientModule;
  const workers = [];
  const client = createV41WorkerClient({
    createWorker() {
      const worker = createWorker();
      workers.push(worker);
      return worker;
    },
    timeoutMs: 100,
  });
  t.after(() => client.close());
  return { client, workers };
}

async function ready(client, workers) {
  const loading = client.load();
  const worker = workers.at(-1);
  worker.reply({ ok: true });
  await loading;
  return worker;
}

test("starts only on load and transfers the frame copy for one classify job at a time", async (t) => {
  const { client, workers } = await setup(t);
  const source = frame();
  await assert.rejects(client.classify(source, boxes), /not loaded/);
  assert.equal(workers.length, 0);

  const loading = client.load();
  const [worker] = workers;
  assert.equal(client.load(), loading);
  assert.deepEqual(worker.messages, [{ id: worker.messages[0].id, type: "load" }]);
  worker.reply({ ok: true });
  await loading;
  await client.load();
  assert.equal(worker.messages.length, 1);
  assert.equal(workers.length, 1);

  const copied = frame(source.data.slice());
  const result = client.classify(copied, boxes);
  const sent = worker.messages[1];
  assert.notEqual(sent.id, worker.messages[0].id);
  assert.deepEqual(sent, { id: sent.id, type: "classify", frame: source, boxes });
  assert.equal(copied.data.byteLength, 0);
  assert.deepEqual([...source.data], rgba);
  const skipped = frame();
  worker.reply({ id: worker.messages[0].id, ok: true, results: [null] });
  await assert.rejects(client.classify(skipped, boxes), /busy/);
  assert.equal(worker.messages.length, 2);
  assert.deepEqual([...skipped.data], rgba);
  const results = [{ label: "bird", score: 0.8, probs: { bird: 0.8, drone: 0.1, other: 0.1 } }];
  worker.reply({ ok: true, results });
  assert.deepEqual(await result, results);
});

test("does not detach a view into a larger frame buffer", async (t) => {
  const { client, workers } = await setup(t);
  const worker = await ready(client, workers);
  const shared = new Uint8ClampedArray(8);
  await assert.rejects(client.classify(frame(shared.subarray(0, 4)), boxes), /owned RGBA/);
  assert.equal(shared.byteLength, 8);
  assert.equal(worker.messages.length, 1);
});

test("close cancels loading and classification; a stopped worker cannot settle a new load", async (t) => {
  const { client, workers } = await setup(t);
  const loading = client.load();
  const loadingRejected = assert.rejects(loading, { name: "AbortError" });
  const [old] = workers;
  const lateReply = old.onmessage;
  const lateError = old.onerror;
  client.close();
  client.close();
  await loadingRejected;
  assert.equal(old.terminations, 1);
  assert.equal(old.onmessage, null);
  assert.equal(old.onerror, null);
  assert.equal(old.onmessageerror, null);

  const reloading = client.load();
  const worker = workers[1];
  const id = worker.messages[0].id;
  assert.notEqual(id, old.messages[0].id);
  lateReply({ data: { id, ok: true } });
  lateError({ message: "terminated worker" });
  assert.equal(client.load(), reloading);
  worker.reply({ ok: true });
  await reloading;

  const classifying = assert.rejects(client.classify(frame(), boxes), { name: "AbortError" });
  client.close();
  await classifying;
  assert.equal(worker.terminations, 1);
});

test("times out an unanswered job and recovers only after an explicit load", async (t) => {
  const { client, workers } = await setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = await ready(client, workers);
  const expired = assert.rejects(client.classify(frame(), boxes), {
    name: "TimeoutError",
    message: /classify timed out after 100 ms/,
  });
  t.mock.timers.tick(99);
  assert.equal(worker.terminations, 0);
  t.mock.timers.tick(1);
  await expired;
  assert.equal(worker.terminations, 1);
  await assert.rejects(client.classify(frame(), boxes), { name: "TimeoutError" });
  assert.equal(workers.length, 1);

  const fresh = await ready(client, workers);
  t.mock.timers.tick(100);
  assert.equal(fresh.terminations, 0);
  const result = client.classify(frame(), boxes);
  fresh.reply({ ok: true, results: [null] });
  assert.deepEqual(await result, [null]);
});

test("worker replies and worker events fail requests explicitly", async (t) => {
  const { client, workers } = await setup(t);
  const loading = client.load();
  workers[0].reply({ ok: false, error: "weights unavailable" });
  await assert.rejects(loading, /load failed: weights unavailable/);
  assert.equal(workers[0].terminations, 1);

  const worker = await ready(client, workers);
  const badReply = client.classify(frame(), boxes);
  worker.reply({ ok: true, results: [] });
  await assert.rejects(badReply, /Invalid.*classify reply/);
  assert.equal(worker.terminations, 1);

  const unreadable = client.load();
  workers[2].onmessageerror();
  await assert.rejects(unreadable, /Could not read.*worker reply/);
  assert.equal(workers[2].terminations, 1);

  const crashed = await ready(client, workers);
  crashed.onerror({ message: "module unavailable" });
  await assert.rejects(client.classify(frame(), boxes), /module unavailable/);
  assert.equal(crashed.terminations, 1);
});

test("worker construction and posting errors do not prevent retrying", async (t) => {
  let attempts = 0;
  const { client, workers } = await setup(t, () => {
    if (++attempts === 1) throw new Error("worker creation blocked");
    const worker = new FakeWorker();
    if (attempts === 2) worker.postMessage = () => { throw new Error("cannot post message"); };
    return worker;
  });
  await assert.rejects(client.load(), /worker creation blocked/);
  await assert.rejects(client.load(), /cannot post message/);
  assert.equal(workers[0].terminations, 1);
  await ready(client, workers);
});
