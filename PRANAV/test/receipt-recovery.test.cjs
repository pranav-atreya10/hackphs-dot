const test = require('node:test');
const assert = require('node:assert/strict');
const { writeFile, mkdtemp, open, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createIncidentJob } = require('../incident-enrichment');
const { createReceiptSpool } = require('../receipt-spool');
const { createReceiptRecovery } = require('../receipt-recovery');

async function spoolFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'skysentry-receipts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'spool');
  await writeFile(path, '', { flag: 'wx', mode: 0o600 });
  return path;
}

function warning(time = 1000, airport = 'KAAA', snapshot = null) {
  const record = { id: randomUUID(), cameraId: 'a'.repeat(64), receivedAt: time, airport,
    type: 'bird', risk: 'red', object_count: 7 };
  const alert = { id: record.id, incident_id: record.id, airport, text: 'Synthetic warning', time, risk: 'red', type: 'bird' };
  const job = createIncidentJob({ ...record, snapshot }, { _id: record.id, camera_id: record.cameraId,
    airport, risk: record.risk, time: new Date(time), snapshot_state: 'unavailable', object_count: 7, confidence: null,
    detection: { streamId: randomUUID(), frameId: 7, generation: randomUUID(), t: 1.5 } }, { retainEvidence: true });
  return { record, alert, job };
}

test('a torn checkpoint cannot discard the last synced file state', async t => {
  const path = await spoolFile(t);
  const spool = createReceiptSpool(path);
  const saved = warning();
  await spool.put(saved);
  const stride = (await readFile(path)).length;
  await spool.remove(saved.record.id);
  assert.deepEqual(await createReceiptSpool(path).rows(), []);
  const file = await open(path, 'r+');
  try { await file.write(Buffer.alloc(16), 0, 16, stride); } // Simulate a torn second page, no network/production.
  finally { await file.close(); }
  assert.deepEqual(await createReceiptSpool(path).rows(), [saved]);
});

test('restart resumes only eligible receipts, preserving provenance but never a retained JPEG', async t => {
  const path = await spoolFile(t);
  const spool = createReceiptSpool(path);
  const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]).toString('base64');
  const fresh = warning(12000, 'KAAA', jpeg), expired = warning(1000), retired = warning(12000, 'KBBB');
  const options = { allowed: async () => true, publish() {}, report() {}, maxAgeMs: 20000, now: () => 12000 };
  const first = createReceiptRecovery({ ...options, spool, journal: { async record() { throw new Error('test outage'); } } });
  for (const { record, alert, job } of [fresh, expired, retired]) await first.submit(record, alert, job);
  await first.stop();
  const checkpoints = await spool.rows();
  assert.equal(checkpoints.length, 3);
  assert.ok(!checkpoints.some(({ job }) => job.evidence));
  assert.equal(checkpoints.find(({ record }) => record.id === fresh.record.id).job.incident.snapshot_state, 'unavailable');
  assert.ok(!(await readFile(path)).includes(Buffer.from(jpeg)));

  const attempts = [], published = [];
  const restart = createReceiptRecovery({ ...options, spool: createReceiptSpool(path), now: () => 22000,
    allowed: code => code === 'KAAA', publish: (item, state) => published.push([item.record.id, state]),
    journal: { async record(record, alert, job) { attempts.push({ record, alert, job }); return { alert }; } },
  });
  await restart.drain();
  assert.deepEqual(attempts.map(({ record }) => record.id), [fresh.record.id]);
  assert.deepEqual(attempts[0].job.incident.detection, fresh.job.incident.detection);
  assert.equal(attempts[0].job.evidence, null);
  assert.deepEqual(published, [[fresh.record.id, 'confirmed'], [expired.record.id, 'unavailable'],
    [retired.record.id, 'unavailable']]);
  assert.deepEqual(await spool.rows(), []);
});

test('nonpersistent retries exhaust visibly and never enter confirmed history', async () => {
  const { record, alert, job } = warning();
  const states = [];
  let time = record.receivedAt;
  const queue = createReceiptRecovery({ allowed: () => true, publish: (_item, state) => states.push(state),
    report() {}, maxAgeMs: 100000, now: () => time, journal: { async record() { throw new Error('test outage'); } } });
  await queue.submit(record, alert, job);
  for (let i = 0; i < 6; i++) {
    await queue.drain();
    time += 10000;
  }
  assert.deepEqual(states, ['retrying_volatile', 'unavailable']);
  assert.equal((await queue.forAirport(record.airport))[0].state, 'unavailable');
  assert.deepEqual(await queue.forAirport('KBBB'), []);
});
