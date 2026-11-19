const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/js/tower.js'), 'utf8').replace(/^import .*;\r?$/gm, '');

test('only an authorized socket reveals tower data and starts optional loads', async () => {
  const { reconcileIncidents } = await import('../public/js/incident-history.mjs');
  const monitoring = await import('../public/js/tower-monitoring.mjs');
  const byId = new Map(), events = new Map(), assetPaths = [];
  const el = () => ({ hidden: true, dataset: {}, addEventListener() {}, replaceChildren() {}, append() {}, remove() {} });
  const document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, el()); return byId.get(id); },
    createElement: el, addEventListener() {},
    head: { append(node) { assetPaths.push(node.src || node.href); node.onerror(); } },
  };
  let releaseAuth, socketStarted;
  const started = new Promise(resolve => { socketStarted = resolve; });
  const socket = {
    connected: false,
    on(name, fn) { events.set(name, fn); },
    connect() { socketStarted(); },
  };
  vm.runInNewContext(source, {
    ...monitoring, refreshSocketAuth() {},
    document, location: { origin: 'https://test.invalid', search: '', protocol: 'https:' },
    signIn: () => new Promise(resolve => { releaseAuth = resolve; }),
    io: (name, options) => {
      assert.equal(name, '/tower');
      assert.equal(options.autoConnect, false);
      return socket;
    },
    fetch: async path => ({ ok: true, json: async () => path === '/api/airports' ? { airports: [] } : [] }),
    createAlertPlayer: () => ({ receive() {}, update() {} }), reconcileIncidents,
    AbortController, AbortSignal, URLSearchParams, setTimeout, clearTimeout, setInterval() {}, window: {},
    console: { warn() {} },
  });
  assert.equal(events.size, 0);
  releaseAuth({ airport: 'TEST', socketAuth: async () => ({ token: 'test' }), headers: async () => ({}) });
  await started;
  assert.equal(document.getElementById('dashboard').hidden, true);
  assert.deepEqual(assetPaths, []);
  socket.connected = true;
  events.get('connect')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById('dashboard').hidden, false);
  assert.equal(document.getElementById('conn').textContent, 'Live');
  assert.ok(assetPaths.includes('/vendor/leaflet/leaflet.js'));
  assert.ok(assetPaths.includes('/js/walkthrough.js'));
  assert.match(document.getElementById('mapNote').textContent, /Loading|unavailable/);
  assert.equal(assetPaths.includes('/vendor/chart.umd.min.js'), false);
});
