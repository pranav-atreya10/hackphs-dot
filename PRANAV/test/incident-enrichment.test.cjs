const test = require('node:test');
const assert = require('node:assert/strict');
const { createIncidentJob, createEnrichmentWorker } = require('../incident-enrichment');
const { createEventJournal } = require('../durable-events');
const { createHash } = require('node:crypto');

const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]).toString('base64');
const event = { id: 'incident', receivedAt: 5000, cameraId: 'cam', type: 'drone', risk: 'red', airport: 'AAA', snapshot: jpeg };
const doc = { _id: event.id, airport: 'AAA', object_count: 2, snapshot_state: 'incomplete' };

test('majority receipt contains vetted exact evidence and a bounded immutable job before ACK; retry does not change it', async () => {
  let first;
  const alert = { id: event.id, airport: 'AAA', text: 'Warning' };
  const collection = { insertOne: async (row, opts) => {
    assert.equal(row._id, event.id);
    assert.equal(opts.writeConcern.w, 'majority');
    if (first) throw Object.assign(new Error('duplicate'), { code: 11000 });
    first = structuredClone(row);
    throw new Error('receipt response lost');
  }, findOne: async (filter, opts) => {
    assert.deepEqual(filter, { _id: event.id, airport: 'AAA', $expr: { $eq: ['$airport', 'AAA'] } });
    assert.equal(opts.readConcern.level, 'majority');
    return first;
  } };
  const journal = createEventJournal(fn => fn({ collection: () => collection }));
  const job = createIncidentJob(event, doc, { retainEvidence: true });
  assert.equal(job.evidence.bytes, jpeg);
  assert.equal(job.evidence.sha256, createHash('sha256').update(Buffer.from(jpeg, 'base64')).digest('hex'));
  assert.equal(createIncidentJob(event, doc).incident.snapshot_state, 'retention_disabled');
  assert.equal(createIncidentJob(event, doc).evidence, null);
  const invalid = createIncidentJob({ ...event, snapshot: 'x'.repeat(800_000) }, doc, { retainEvidence: true });
  assert.equal(invalid.incident.snapshot_state, 'invalid');
  assert.equal(invalid.evidence, null);
  await assert.rejects(() => journal.record(event, alert, job), /response lost/);
  assert.deepEqual(await journal.record(event, null, createIncidentJob(event, doc)), { alert, acknowledged: false });
  assert.equal(first.enrichment.evidence.bytes, jpeg);
  assert.equal(first.airport, 'AAA');
  first.acknowledged_at = new Date();
  assert.deepEqual(await journal.record(event, alert, job), { alert: null, acknowledged: true });
});

function fixture({ stage = 'report', airport = 'AAA', ...overrides } = {}) {
  const saved = { _id: event.id, airport, enrichment: createIncidentJob(event, doc, { retainEvidence: true }) };
  Object.assign(saved.enrichment, { stage, ...(stage === 'stamp' ? { report: { report: 'observed' } } : {}) });
  const receipts = [];
  const journal = {
    async claimEnrichment() {
      saved.enrichment.attempts++;
      return structuredClone(saved);
    },
    async setEnrichment(row, next, fields, hold) {
      if (row.enrichment.stage !== saved.enrichment.stage) return false;
      Object.assign(saved.enrichment, fields, { stage: next, attempts: 0 });
      if (hold) Object.assign(row.enrichment, fields, { stage: next, attempts: 0 });
      return true;
    },
  };
  const params = {
    journal, allowed: code => code === 'AAA', analyze: async () => ({ report: 'observed', label: 'drone', source: 'fallback' }),
    reportError: err => receipts.push(err.message),
    stamp: async () => { throw new Error('unexpected submission'); },
    verify: async () => ({ matches: false }),
    project: async (_doc, rev, fields, evidence) => receipts.push({ rev, fields, evidence }),
    ...overrides,
  };
  return { saved, receipts, restart: () => createEnrichmentWorker(params) };
}

test('recovering after a crash between staging and projection reuses the bounded report', async () => {
  let analyzeCalls = 0;
  const f = fixture({ analyze: async ({ snapshot }) => {
    analyzeCalls++;
    assert.equal(snapshot, undefined, 'retention does not grant upload permission');
    return { report: 'observed', label: 'drone', source: 'fallback' };
  } });
  await f.restart().runOne();
  assert.equal(f.saved.enrichment.stage, 'project_report');
  await f.restart().runOne();
  assert.equal(analyzeCalls, 1);
  assert.equal(f.receipts.find(row => row.rev === 1).evidence.bytes, jpeg);
  assert.equal(f.receipts.find(row => row.rev === 2).fields.report, 'observed');
});

test('bounded verified and unavailable bird verdicts survive durable staging and projection', async () => {
  for (const [verdict, expected] of [
    [{ status: 'verified', verdict: 'uncertain', confidence: 0.4, object: 'o'.repeat(90), evidence: 'e'.repeat(300), model: 'm'.repeat(120), unexpected: 'discard' },
      { status: 'verified', verdict: 'uncertain', isBird: null, confidence: 0.4, object: 'o'.repeat(80), evidence: 'e'.repeat(200), model: 'm'.repeat(80), source: 'gemini' }],
    [{ status: 'unavailable', verdict: 'bird', evidence: 'No eligible image.', reason: 'no_image' },
      { status: 'unavailable', verdict: null, isBird: null, confidence: null, object: '', evidence: 'No eligible image.', source: 'fallback', reason: 'no_image' }],
  ]) {
    const f = fixture({ imageUploadAllowed: () => verdict.status === 'verified', analyze: async ({ snapshot }) => {
      assert.equal(snapshot, verdict.status === 'verified' ? jpeg : undefined);
      return { report: 'observed', label: 'bird', source: 'fallback', bird_verdict: verdict };
    } });
    f.saved.enrichment.input.type = 'bird';
    await f.restart().runOne();
    assert.deepEqual(f.saved.enrichment.report.bird_verdict, expected);
    await f.restart().runOne();
    assert.deepEqual(f.receipts.find(row => row.rev === 2).fields.bird_verdict, expected);
    assert.equal(f.saved.enrichment.stage, 'complete');
  }
});

test('crash after stamp reservation never re-submits; restart reconciles only the saved signature', async () => {
  let attempts = 0;
  const f = fixture({ stage: 'stamp',
    stamp: async (_report, { beforeSubmit }) => {
      attempts++;
      await beforeSubmit({ signature: 'prepared-signature' });
      throw new Error('simulated crash after submission became possible');
    },
    verify: async (report, sig) => {
      assert.equal(report, 'observed');
      assert.equal(sig, 'prepared-signature');
      return { matches: true, tx: sig };
    },
  });
  await f.restart().runOne();
  assert.equal(f.saved.enrichment.stage, 'submitting');
  await f.restart().runOne();
  await f.restart().runOne();
  assert.equal(attempts, 1);
  assert.equal(f.receipts.find(row => row.rev === 3).fields.stamp_state, 'reconciliation_required');
  assert.equal(f.receipts.find(row => row.rev === 4).fields.stamp_state, 'stored');
});

test('a mismatched airport job is quarantined before provider calls or projection', async () => {
  const f = fixture({ airport: 'BBB', analyze: () => assert.fail('unexpected analysis'), project: () => assert.fail('unexpected projection') });
  await f.restart().runOne();
  assert.equal(f.saved.enrichment.stage, 'incomplete');
  assert.deepEqual(f.receipts, []);
});

test('exhausted report work projects an incomplete report instead of leaving the dashboard pending', async () => {
  const f = fixture({ analyze: async () => { throw new Error('simulated enrichment failure'); } });
  f.saved.enrichment.attempts = 7;
  await f.restart().runOne();
  assert.equal(f.saved.enrichment.stage, 'project_incomplete');
  await f.restart().runOne();
  assert.equal(f.saved.enrichment.stage, 'incomplete');
  assert.deepEqual(f.receipts.find(row => row.rev === 2).fields, { report_state: 'incomplete' });
});

test('a stale lease cannot stage report output or reserve a stamp', async () => {
  const original = { _id: 'incident', airport: 'AAA', enrichment: { stage: 'stamp', lease: 'old-token' } };
  const journal = createEventJournal(fn => fn({ collection: () => ({
    updateOne: async (filter, update) => {
      assert.equal(filter.airport, 'AAA');
      assert.equal(filter['enrichment.lease'], 'old-token');
      assert.equal(update.$set['enrichment.stage'], 'submitting');
      assert.ok(filter['enrichment.due_at'].$gt instanceof Date);
      return { acknowledged: true, matchedCount: 0 };
    },
  }) }));
  assert.equal(await journal.setEnrichment(original, 'submitting', { submission: { signature: 'sig' } }, true), false);
  assert.equal(original.enrichment.stage, 'stamp');
});

test('replay and acknowledgment use one exact scalar airport and preserve the first acknowledgment', async () => {
  const expected = { airport: 'AAA', $expr: { $eq: ['$airport', 'AAA'] } };
  const journal = createEventJournal(fn => fn({ collection: () => ({
    find(filter, options) {
      assert.equal(filter.acknowledged_at.$exists, false);
      assert.deepEqual({ airport: filter.airport, $expr: filter.$expr }, expected);
      assert.equal(options.readConcern.level, 'majority');
      return { sort() { return this; }, limit() { return this; }, async toArray() { return [{ alert: { id: 'a', airport: 'AAA' } }]; } };
    },
    async findOneAndUpdate({ _id, ...filter }, [update], options) {
      assert.equal(_id, 'a');
      assert.deepEqual({ airport: filter.airport, $expr: filter.$expr }, expected);
      assert.deepEqual(update.$set.acknowledged_at.$ifNull, ['$acknowledged_at', '$$NOW']);
      assert.deepEqual(update.$set.acknowledged_by.$ifNull, ['$acknowledged_by', { $literal: 'operator' }]);
      assert.equal(options.writeConcern.w, 'majority');
      return { airport: 'AAA' };
    },
  }) }));
  await assert.rejects(() => journal.replay(['AAA', 'BBB']), /authorized airport/);
  assert.deepEqual(await journal.replay('AAA'), { alerts: [{ id: 'a', airport: 'AAA' }], next: null });
  assert.deepEqual(await journal.acknowledge('AAA', 'a', 'operator'), { airport: 'AAA' });
});
