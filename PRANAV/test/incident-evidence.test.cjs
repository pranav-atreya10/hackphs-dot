const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { airportFilter } = require('../airport-history');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const route = source.match(/app\.get\("\/api\/incidents\/:id\/snapshot"[\s\S]+?\n\}\);/)[0];
const scope = source.match(/function requireAirport\(req, res, next\) \{[\s\S]+?\n\}/)[0];
const id = '1c2d3e4f-4321-1234-aabb-bbccddeeffaa';

test('evidence requires a matching scope and queries only that incident and scalar airport', async () => {
  const headers = {}, jpeg = Buffer.from([255, 216, 255, 217]);
  const dashboardGuard = () => {};
  let handler, lookup;
  vm.runInNewContext(`${scope}\n${route}`, {
    app: { get(_path, guard, authorize, fn) {
      assert.equal(guard, dashboardGuard);
      handler = (req, res) => authorize(req, res, () => fn(req, res));
    } },
    requireDashboard: dashboardGuard,
    viewAirport: (req, requested) => requested === req.approvedAirport ? requested : undefined,
    airportFilter, EVIDENCE_CAP: 512 * 1024,
    mongo: true,
    withMongo: fn => fn({ collection: () => ({ findOne(filter, options) {
      lookup = { filter, options }; return { snapshot: jpeg.toString('base64') };
    } }) }),
    Buffer,
  });
  const res = {
    set(name, value) { headers[name] = value; return this; },
    status(code) { this.code = code; return this; },
    type(type) { this.contentType = type; return this; },
    json(payload) { this.payload = payload; },
    send(payload) { this.payload = payload; },
  };
  const req = { approvedAirport: 'KAAA', get() {}, params: { id } };
  await handler({ ...req, query: { airport: 'KBBB' } }, res);
  assert.equal(res.code, 403);
  assert.equal(lookup, undefined);
  await handler({ ...req, query: { airport: 'KAAA' } }, res);
  assert.equal(lookup.filter._id, id);
  assert.equal(lookup.filter.airport, 'KAAA');
  assert.deepEqual(Array.from(lookup.filter.$expr.$eq), ['$airport', 'KAAA']);
  assert.equal(lookup.options.projection.snapshot, 1);
  assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.equal(res.contentType, 'image/jpeg');
  assert.deepEqual(res.payload, jpeg);
});
