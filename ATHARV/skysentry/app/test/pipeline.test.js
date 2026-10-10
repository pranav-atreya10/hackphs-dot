import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../server/pipeline.js';
import { openStores } from '../server/db.js';
import { makeEvent } from '../shared/event.js';

// No keys or connection strings are set in tests, so every service runs in demo mode.
const ev = (over = {}) => makeEvent({ cameraId: 'runway-east', type: 'bird', count: 0, direction: 'unknown', confidence: 0, risk: 'green', ...over });
const quiet = { error() {}, warn() {} };

test('one red alert travels all seven steps in demo mode', async () => {
  const stores = await openStores(), emitted = [];
  const p = createPipeline({ stores, emit: (n, d) => emitted.push([n, d]), log: quiet });

  assert.equal((await p.handle(ev())).incident, null);                          // green: stored, no incident
  const r = await p.handle(ev({ count: 8, direction: 'toward runway', confidence: 0.9, risk: 'red', snapshot: 'abc' }));
  assert.ok(r.ok && r.incident);
  assert.match(r.incident.report, /8 birds/);
  assert.deepEqual(emitted.map(e => e[0]), ['detection', 'detection', 'incident', 'alert']);
  assert.equal(emitted.at(-1)[1].text, 'Caution, flock of eight birds heading toward the runway.');

  const hourly = await stores.detections.hourly(24);
  assert.equal(hourly.reduce((s, h) => s + h.events, 0), 2);
  const list = await stores.incidents.latest();
  assert.equal(list.length, 1); assert.equal(list[0].snapshot, undefined); // list omits snapshots
});

test('repeat events during the cooldown do not open new incidents, escalation does', async () => {
  const stores = await openStores();
  const p = createPipeline({ stores, emit() {}, log: quiet, cooldownMs: 30000 });
  const t0 = Date.now();
  const at = s => new Date(t0 + s * 1000).toISOString();
  assert.ok((await p.handle(ev({ count: 2, direction: 'crossing', confidence: .8, risk: 'yellow', time: at(0) }))).incident);
  assert.equal((await p.handle(ev({ count: 2, direction: 'crossing', confidence: .8, risk: 'yellow', time: at(2) }))).incident, null);
  assert.ok((await p.handle(ev({ count: 6, direction: 'toward runway', confidence: .9, risk: 'red', time: at(4) }))).incident);
  assert.ok((await p.handle(ev({ count: 2, direction: 'crossing', confidence: .8, risk: 'yellow', time: at(40) }))).incident);
});

test('drone incidents get a report hash', async () => {
  const stores = await openStores();
  const p = createPipeline({ stores, emit() {}, log: quiet });
  const r = await p.handle(ev({ type: 'drone', count: 1, confidence: .92, risk: 'red' }));
  assert.match(r.incident.report_hash, /^[0-9a-f]{64}$/);
  assert.equal(r.incident.solana_tx, null);
});

test('invalid events are rejected with reasons', async () => {
  const stores = await openStores();
  const p = createPipeline({ stores, emit() {}, log: quiet });
  const r = await p.handle({ camera_id: '', type: 'plane' });
  assert.equal(r.ok, false); assert.ok(r.errors.length >= 2);
});
