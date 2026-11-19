const test = require('node:test');
const assert = require('node:assert/strict');
const { createPipeline } = require('../ai-voice/pipeline');

const event = { id: 'incident', receivedAt: Date.now(), airport: 'KPCT', cameraId: 'test',
  risk: 'yellow', type: 'drone', snapshot: 'synthetic-evidence' };
const pipeline = createPipeline({
  shouldAlert: () => true,
  analyzeEvent: async ev => {
    assert.equal(ev.snapshot, event.snapshot);
    return { label: 'drone', report: 'Synthetic report', source: 'test' };
  },
  solana: { stampReport: async () => ({ hash: 'test-hash' }) },
});

test('only successful writes advance revisions; live metadata never carries evidence', async () => {
  const live = [], writes = [];
  await pipeline.processIncident(event, {
    allowImageReview: true,
    create: async ({ revision }) => { writes.push(revision); },
    save: async fields => {
      writes.push(fields.revision);
      if (fields.revision === 2) throw new Error('test report write failure');
      assert.equal(fields.report, 'Synthetic report');
    },
    emit: (name, data) => { if (name === 'incident') live.push(data); },
  });
  assert.deepEqual(writes, [1, 2, 3]);
  assert.deepEqual(live.map(row => row.revision), [undefined, 1, 3]);
  assert.ok(live.every(row => !Object.hasOwn(row, 'snapshot')));
});
