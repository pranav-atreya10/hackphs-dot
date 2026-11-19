const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoleRequests } = require('../role-requests');

// Just enough of a MongoDB collection for role-requests.js.
function fakeCollection() {
  const rows = new Map();
  const matches = (row, filter) => row && Object.entries(filter).every(([key, value]) => value?.$in ? value.$in.includes(row[key]) : value === row[key]);
  return {
    rows,
    replaceOne: async (filter, doc) => {
      if (rows.has(doc._id) && !matches(rows.get(doc._id), filter)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      rows.set(doc._id, { ...doc });
    },
    findOne: async ({ _id }) => (rows.has(_id) ? { ...rows.get(_id) } : null),
    updateOne: async (filter, { $set }) => {
      const row = rows.get(filter._id);
      if (!matches(row, filter)) return { matchedCount: 0 };
      Object.assign(row, $set);
      return { matchedCount: 1 };
    },
    find: (filter) => ({ sort: () => ({ toArray: async () => [...rows.values()].filter(d => matches(d, filter)).map(d => ({ ...d })) }) }),
  };
}
const camera = { userId: 'user_cam', email: 'cam@example.com', name: 'Cam', role: 'camera', airport: 'KPCT' };

test('a camera account asks to become a tower; approving switches it and keeps the airport', async () => {
  const coll = fakeCollection(), saved = [];
  let actual = { role: 'camera', airport: 'KPCT' };
  const requests = createRoleRequests({
    collection: async () => coll,
    readRole: async () => actual,
    setRole: async (id, role, airport, transitionId) => { saved.push([id, role, airport]); actual = { role, airport, transitionId }; },
  });
  const doc = await requests.submit(camera, { to: 'dashboard', note: '  need the tower for the demo  ' });
  assert.equal(doc.status, 'pending');
  assert.equal(doc.note, 'need the tower for the demo');
  assert.deepEqual((await requests.pending()).map(r => r._id), ['user_cam']);
  const done = await requests.decide('user_cam', doc.revision, true, 'user_admin');
  assert.equal(done.status, 'approved');
  assert.deepEqual(saved, [['user_cam', 'dashboard', 'KPCT']]);
  assert.equal((await requests.pending()).length, 0);
  await assert.rejects(requests.decide('user_cam', doc.revision, true), e => e.status === 409);
});

test('denying leaves the role alone; the user can ask again', async () => {
  const coll = fakeCollection(), saved = [];
  const requests = createRoleRequests({ collection: async () => coll, setRole: async (...args) => saved.push(args) });
  const doc = await requests.submit(camera, { to: 'dashboard' });
  assert.equal((await requests.decide('user_cam', doc.revision, false, 'user_admin')).status, 'denied');
  assert.equal(saved.length, 0);
  assert.equal((await requests.mine('user_cam')).status, 'denied');
  assert.equal((await requests.submit(camera, { to: 'dashboard' })).status, 'pending');
});

test('bad requests are refused; an open request can be cancelled', async () => {
  const requests = createRoleRequests({ collection: async () => fakeCollection(), setRole: async () => {} });
  const coll = fakeCollection();
  const r2 = createRoleRequests({ collection: async () => coll, setRole: async () => {} });
  await assert.rejects(requests.submit(camera, { to: 'camera' }), e => e.status === 400);         // already that
  await assert.rejects(requests.submit(camera, { to: 'admin' }), e => e.status === 400);          // not a switchable type
  await assert.rejects(requests.submit({ userId: 'u', role: null }, { to: 'camera' }), e => e.status === 400);
  const doc = await r2.submit(camera, { to: 'dashboard' });
  await r2.cancel('user_cam', doc.revision);
  assert.equal((await r2.mine('user_cam')).status, 'cancelled');
  await assert.rejects(r2.cancel('user_cam', doc.revision), e => e.status === 404);
});

test('without MongoDB it says why', async () => {
  const requests = createRoleRequests({ collection: async () => null, setRole: async () => {} });
  await assert.rejects(requests.submit(camera, { to: 'dashboard' }), e => e.status === 503);
});
