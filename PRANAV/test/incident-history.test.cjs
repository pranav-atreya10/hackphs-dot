const test = require('node:test');
const assert = require('node:assert/strict');

const row = (_id, time, data) => ({ _id, time: new Date(time).toISOString(), ...data });

test('slow history backfills older rows without replacing newer live rows or dropping pending alerts', async () => {
  const { reconcileIncidents: merge } = await import('../public/js/incident-history.mjs');
  const live = merge(new Map(), [row('report', 200, { revision: 3, report: 'new' }), row('pending', 300)], 'live');
  const combined = merge(live, [row('report', 200, { revision: 1 }), row('older', 100)], 'history');
  assert.deepEqual([...combined.keys()], ['pending', 'report', 'older']);
  assert.equal(combined.get('report').row.report, 'new');
  assert.equal(combined.get('report'), live.get('report'));
});

test('a newer persisted report wins on reconnect; provisional and duplicate revisions cannot undo it', async () => {
  const { reconcileIncidents: merge } = await import('../public/js/incident-history.mjs');
  const live = merge(new Map(), [row('r', 200)], 'live');
  const restored = merge(live, [row('r', 200, { report: 'legacy' })], 'history');
  const refreshed = merge(restored, [row('r', 200, { revision: 2, report: 'persisted' })], 'history');
  const replayed = merge(refreshed, [row('r', 200), row('r', 200, { revision: 1 }), row('r', 200, { revision: 2 })], 'live');
  assert.equal(restored.get('r').row.report, 'legacy');
  assert.equal(replayed.get('r').row.report, 'persisted');
});

test('an unconfirmed write replaces pending but cannot downgrade a stored report', async () => {
  const { reconcileIncidents: merge } = await import('../public/js/incident-history.mjs');
  const pending = row('r', 200, { persistence: 'pending' });
  const unavailable = row('r', 200, { persistence: 'unavailable' });
  const stored = row('r', 200, { persistence: 'stored', revision: 1 });
  const failed = merge(new Map(), [pending, unavailable, pending], 'live');
  assert.equal(failed.get('r').row, unavailable);
  assert.equal(merge(failed, [stored, unavailable], 'live').get('r').row, stored);
});
