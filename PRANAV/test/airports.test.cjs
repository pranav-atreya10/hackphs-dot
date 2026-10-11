const test = require('node:test');
const assert = require('node:assert/strict');
const { createAirports, AirportError } = require('../airports');

// Just enough of a MongoDB collection for airports.js.
function fakeCollection(docs = []) {
  const rows = new Map(docs.map(d => [d._id, { ...d }]));
  return {
    rows,
    find: () => ({ toArray: async () => [...rows.values()].map(d => ({ ...d })) }),
    insertOne: async d => { if (rows.has(d._id)) throw Object.assign(new Error('dup'), { code: 11000 }); rows.set(d._id, { ...d }); },
    updateOne: async ({ _id }, { $set }) => { Object.assign(rows.get(_id), $set); },
    deleteOne: async ({ _id }) => { rows.delete(_id); },
  };
}
const matches = (a, b) => typeof a === 'string' && a === b;

test('env airports are listed, join by code, and cannot be edited', async () => {
  const airports = createAirports({ env: 'KPCT=pct-sky-4821, KTTN = ttn-sky-9310', collection: async () => fakeCollection(), matches });
  await airports.load();
  assert.deepEqual(airports.all().map(a => a.code), ['KPCT', 'KTTN']);
  assert.equal(airports.forJoinCode('ttn-sky-9310'), 'KTTN');
  assert.equal(airports.forJoinCode('nope'), null);
  await assert.rejects(airports.rotate('KPCT'), e => e instanceof AirportError && e.status === 409);
  await assert.rejects(airports.remove('KPCT'), e => e.status === 409);
});

test('admins create an airport with a generated join code that works for sign-up', async () => {
  const coll = fakeCollection();
  const airports = createAirports({ env: 'KPCT=pct-sky-4821', collection: async () => coll, matches });
  const created = await airports.create({ code: ' kttn ', name: 'Trenton-Mercer', by: 'user_1' });
  assert.equal(created.code, 'KTTN');
  assert.equal(created.name, 'Trenton-Mercer');
  assert.match(created.joinCode, /^kttn-\d{4}-\d{4}$/);
  assert.equal(airports.forJoinCode(created.joinCode), 'KTTN');
  assert.ok(coll.rows.has('KTTN'));
  assert.equal(airports.size, 2);
  // survives a restart
  const again = createAirports({ env: '', collection: async () => coll, matches });
  await again.load();
  assert.equal(again.forJoinCode(created.joinCode), 'KTTN');
});

test('bad or duplicate codes are refused', async () => {
  const coll = fakeCollection();
  const airports = createAirports({ env: 'KPCT=x', collection: async () => coll, matches });
  await assert.rejects(airports.create({ code: 'K!' }), e => e.status === 400);
  await assert.rejects(airports.create({ code: 'TOOLONGCODE' }), e => e.status === 400);
  await assert.rejects(airports.create({ code: 'kpct' }), e => e.status === 409);
  await airports.create({ code: '39N' });
  await assert.rejects(airports.create({ code: '39n' }), e => e.status === 409);
});

test('a new join code replaces the old one; deleting removes the airport', async () => {
  const coll = fakeCollection();
  const airports = createAirports({ env: '', collection: async () => coll, matches });
  const { joinCode: first } = await airports.create({ code: 'KTTN' });
  const { joinCode: second } = await airports.rotate('KTTN');
  assert.notEqual(first, second);
  assert.equal(airports.forJoinCode(first), null);
  assert.equal(airports.forJoinCode(second), 'KTTN');
  await airports.remove('KTTN');
  assert.equal(airports.has('KTTN'), false);
  await assert.rejects(airports.remove('KTTN'), e => e.status === 404);
});

test('without MongoDB, env airports still work and creating says why it cannot', async () => {
  const airports = createAirports({ env: 'KPCT=pct', collection: async () => null, matches });
  await airports.load();
  assert.equal(airports.forJoinCode('pct'), 'KPCT');
  await assert.rejects(airports.create({ code: 'KTTN' }), e => e.status === 503);
});
