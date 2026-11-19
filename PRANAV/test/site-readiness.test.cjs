const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadiness } = require('../site-readiness');
const { checkReceiptStorage } = require('../durable-events');

test('a timed-out required check is coalesced, never counted as ready, and is retried after recovery', async () => {
  let count = 0, now = 0, release;
  const check = createReadiness({ stuck: () => { count++; return new Promise(resolve => { release = resolve; }); },
    detector: () => 'ready' }, { cacheMs: 100, timeoutMs: 10, now: () => now });
  const [a, b] = await Promise.all([check(), check()]);
  assert.deepEqual(a, { ready: false, checks: { stuck: 'timed_out', detector: 'ready' } });
  assert.equal(a, b);
  now += 101;
  assert.equal((await check()).ready, false);
  assert.equal(count, 1, 'hung dependencies must not produce an unbounded queue of probes');
  release('ready');
  await new Promise(resolve => setImmediate(resolve));
  now += 101;
  const next = check();
  await new Promise(resolve => setImmediate(resolve));
  release('ready');
  assert.equal((await next).ready, true);
});

test('storage readiness requires the retention index and concrete majority read-back in each collection', async () => {
  let ttl = 0, readable = true;
  const docs = new Map(), writes = [];
  const db = { collection: name => ({
    listIndexes: () => ({ toArray: async () => [{ key: { time: 1 }, expireAfterSeconds: ttl }] }),
    async updateOne(filter, { $set }, options) {
      assert.equal(options.writeConcern.w, 'majority');
      assert.equal(options.upsert, true);
      assert.equal($set.airport, undefined);
      assert.equal($set.alert, undefined);
      docs.set(name, { ...filter, ...$set }); writes.push(name);
      return { acknowledged: true };
    },
    async findOne(filter, options) {
      assert.equal(options.readConcern.level, 'majority');
      assert.equal(filter.marker, docs.get(name).marker);
      return readable ? docs.get(name) : null;
    },
  }) };
  assert.equal(await checkReceiptStorage(db, 100), 'retention_unverified');
  assert.deepEqual(writes, []);
  ttl = 100; readable = false;
  assert.equal(await checkReceiptStorage(db, 100), 'majority_unverified');
  writes.length = 0; readable = true;
  assert.equal(await checkReceiptStorage(db, 100), 'ready');
  assert.deepEqual(writes, ['detections', 'incidents']);
});
