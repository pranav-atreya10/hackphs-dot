const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

async function fixture() {
  const { createTowerMonitoring, imageEta } = await import('../public/js/tower-monitoring.mjs');
  let now = 100_000;
  const tower = createTowerMonitoring(() => now);
  return {
    tower, imageEta, tick: (ms) => { now += ms; },
    status: (cameraId, online) => tower.status({ cameraId, online, at: now }),
    state: (cameraId, risk, learning = false) => tower.detector({ cameraId, at: now, state: { risk, learning, shake: false } }),
    event: (cameraId, risk, data) => tower.event({ cameraId, risk, receivedAt: now, ...data }),
  };
}

test('no feeds, legacy clear, warmup, stale state and socket loss never render green', async () => {
  const { tower, tick, status, state, event } = await fixture();
  assert.equal(tower.snapshot().level, 'unavailable');
  tower.setConnected(true);
  assert.equal(tower.snapshot().level, 'unavailable');
  status('A', true);
  event('A', 'green');
  assert.equal(tower.snapshot().level, 'degraded');
  state('A', 'green', true);
  assert.match(tower.snapshot().reason, /warming/);
  assert.equal(tower.snapshot().level, 'degraded');
  state('A', 'green');
  assert.equal(tower.snapshot().level, 'green');
  tick(3_000);
  assert.match(tower.snapshot().reason, /detector timed out/);
  assert.equal(tower.snapshot().level, 'degraded');
  tick(7_000);
  assert.equal(tower.snapshot().level, 'unavailable');
  tower.setConnected(false);
  assert.equal(state('A', 'green'), false);
  tower.setConnected(true);
  assert.equal(tower.snapshot().level, 'unavailable');
});

test('the highest fresh warning survives lesser reports and partial coverage', async () => {
  const { tower, tick, state, status, event } = await fixture();
  tower.setConnected(true);
  state('A', 'green');
  state('B', 'green', true);
  assert.equal(tower.snapshot().level, 'degraded');
  event('A', 'red');
  tick(500);
  state('B', 'yellow');
  assert.equal(tower.snapshot().top.cameraId, 'A');
  assert.equal(tower.snapshot().level, 'red');
  status('C', false);
  assert.equal(tower.snapshot().level, 'red');
  assert.equal(tower.snapshot().coverage, 'degraded');
  status('A', false);
  assert.equal(tower.snapshot().level, 'yellow');
  assert.equal(event('A', 'red'), null);
  tick(500);
  state('B', 'green');
  assert.equal(tower.snapshot().level, 'degraded');
  assert.equal(tower.snapshot().top, null);
});

test('a later event-only clear cannot suppress a fresh detector warning from the same camera', async () => {
  const { tower, tick, state, event } = await fixture();
  tower.setConnected(true);
  state('A', 'red');
  tick(100);
  event('A', 'green');
  assert.equal(tower.snapshot().coverage, 'healthy');
  assert.equal(tower.snapshot().level, 'red');
  state('A', 'green');
  assert.equal(tower.snapshot().level, 'green');
});

test('server generation changes invalidate old state; sender TTL is not renewed on delivery', async () => {
  const { tower, tick } = await fixture();
  const state = { risk: 'green', learning: false, generation: 'old' };
  tower.setConnected(true);
  tower.mode({ cameraId: 'A', mode: 'server', generation: 'old' });
  assert.equal(tower.detector({ cameraId: 'A', at: 100_000, state }), true);
  assert.equal(tower.snapshot().level, 'green');
  tick(100);
  assert.equal(tower.mode({ cameraId: 'A', mode: 'server', generation: 'new' }), true);
  assert.equal(tower.snapshot().level, 'degraded');
  assert.equal(tower.detector({ cameraId: 'A', at: 100_100, state }), false);
  const next = { cameraId: 'A', at: 100_100, remaining_ms: 500, state: { ...state, generation: 'new' } };
  tick(400);
  assert.equal(tower.detector({ ...next, at: undefined }), false);
  assert.equal(tower.detector(next), true);
  assert.equal(tower.snapshot().level, 'green');
  tick(100);
  assert.equal(tower.snapshot().level, 'degraded');
  assert.equal(tower.detector(next), false);
});

test('rejects demo packets, stale data and unusable detector handoffs', async () => {
  const { tower, tick, state, event, imageEta } = await fixture();
  tower.setConnected(true);
  assert.equal(event('A', 'red', { demo: true }), null);
  assert.equal(event('A', 'yellow', { sourceMode: 'upload' }), null);
  assert.equal(event('A', 'red', { receivedAt: 50_000 }), null);
  assert.equal(event('A', 'bogus'), null);
  assert.equal(tower.snapshot().level, 'unavailable');
  state('A', 'green');
  tower.mode({ cameraId: 'A', mode: 'unavailable' });
  assert.equal(state('A', 'green'), false);
  assert.equal(tower.snapshot().level, 'degraded');
  tower.mode({ cameraId: 'A', mode: 'server' });
  tick(5_000);
  assert.equal(tower.detector({ cameraId: 'A', at: 100_000, state: { risk: 'green', learning: false } }), false);
  assert.equal(tower.snapshot().level, 'degraded');
  assert.equal(imageEta({ eta_seconds: 4 }), null);
  assert.equal(imageEta({ eta_seconds: 4, eta_basis: 'image_space_corridor' }), 4);
});

test('Leaflet reuses one live threat pair per camera and ignores legacy guessed geometry', async t => {
  const { createTowerLayers } = await import('../public/js/tower-layers.mjs');
  const created = [];
  function layer(kind) {
    const obj = { kind, updates: 0, removed: false,
      bindTooltip() { return this; }, bindPopup() { return this; }, addTo() { return this; },
      setLatLng() { this.updates++; return this; }, setLatLngs() { this.updates++; return this; },
      setStyle() { return this; }, remove() { this.removed = true; },
    };
    created.push(obj);
    return obj;
  }
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ textContent: '' }) };
  t.after(() => { globalThis.document = previousDocument; });
  const layers = createTowerLayers({
    polygon: () => layer('cone'), circleMarker: () => layer('marker'), polyline: () => layer('path'),
  }, { setView() {} });
  const ev = { cameraId: 'A', id: 'delivery-1', risk: 'yellow', camera: { lat: 40, lon: -74, heading_deg: 90, hfov_deg: 60 },
    target_geo: { coordinates: [-74, 40] }, path_geo: { coordinates: [[-74, 40], [-74, 40.1]] } };
  layers.placeCamera(ev);
  layers.pin(ev);
  assert.deepEqual(created.map(l => l.kind), ['cone', 'marker']);
  const measured = { ...ev, geo_basis: 'measured' };
  layers.pin(measured);
  layers.placeCamera({ ...ev, id: 'delivery-2' });
  layers.pin({ ...measured, id: 'delivery-2' });
  assert.deepEqual(created.map(l => l.kind), ['cone', 'marker', 'marker', 'path']);
  assert.deepEqual(created.map(l => l.updates), [0, 0, 0, 0]);
  layers.pin({ ...measured, id: 'delivery-3', risk: 'red' });
  assert.deepEqual(created.map(l => l.updates), [0, 0, 1, 1]);
  layers.prune(new Set(['A']), new Set());
  assert.deepEqual(created.map(l => l.removed), [false, false, true, true]);
});

test('server HTML shows unavailable before JS and preview has no active media or auto-play', () => {
  const html = readFileSync(path.join(__dirname, '../public/tower.html'), 'utf8');
  for (const id of ['risk', 'sideRisk']) assert.match(html, new RegExp(`id="${id}"[^>]+data-risk="unavailable"`));
  assert.match(html, /id="beaconLamps"[^>]+ hidden/);
  assert.match(html, /id="beaconReading">UNAVAILABLE/);
  const preview = html.match(/<details class="card" id="towerDemo">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(preview);
  assert.match(preview, /<video .* data-src="\/clips\/[^"]+"/);
  assert.doesNotMatch(preview, /\s(?:src=|autoplay\b)/);
});

test('real tower socket wiring renders the same highest warning in the dashboard and beacon', async () => {
  const monitoring = await import('../public/js/tower-monitoring.mjs');
  const beacon = await import('../public/detection/adapters/beacon.js');
  const { reconcileIncidents } = await import('../public/js/incident-history.mjs');
  const elements = new Map(), handlers = new Map(), frames = [];
  function element() {
    return {
      dataset: {}, textContent: '', children: [], events: {},
      addEventListener(name, fn) { this.events[name] = fn; },
      querySelector() { return this.child ??= element(); },
      prepend(child) { this.children.unshift(child); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
    };
  }
  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }
  const code = readFileSync(path.join(__dirname, '../public/js/tower.js'), 'utf8');
  runInNewContext(code.replace(/^import [^\n]+\n/gm, ''), {
    ...monitoring, ...beacon, URLSearchParams, AbortController, AbortSignal, reconcileIncidents,
    document: { getElementById, createElement: element, addEventListener() {}, documentElement: element(),
      head: { append(node) { node.onload(); } } },
    location: { protocol: 'https:', hostname: 'example.test', origin: 'https://example.test', search: '' },
    L: { map: () => ({ setView() { return this; } }), tileLayer: () => ({ addTo() {} }) },
    createTowerLayers: () => ({ prune() {}, pin() {}, placeCamera() {} }),
    Chart: class {
      static defaults = { font: {} };
      constructor(_el, { data, options }) {
        Object.assign(this, { data, options });
        for (const axis of Object.values(options.scales)) axis.ticks ??= {};
      }
      update() {}
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    VirtualBeacon: class { feed(line) { frames.push(beacon.parseBeaconLine(line)); } render() {} },
    createAlertPlayer: () => ({ receive() {}, update() {} }),
    signIn: async () => ({ role: 'dashboard', airport: 'TEST', socketAuth: async () => ({}), headers: async () => ({}) }),
    refreshSocketAuth() {},
    fetch: async path => ({ ok: true, json: async () => path === '/api/airports'
      ? { airports: [{ code: 'TEST' }], scoped: true }
      : path.startsWith('/api/incidents') ? [] : {} }),
    io: () => ({ on: (name, fn) => handlers.set(name, fn), connect() {} }),
    setInterval() {}, setTimeout() {}, clearTimeout() {}, window: {},
    console: { warn() {} },
  });
  await new Promise(resolve => setImmediate(resolve));
  handlers.get('connect')();
  assert.equal(getElementById('beaconLamps').hidden, true);
  handlers.get('camera:event')({ cameraId: 'A', risk: 'red', demo: true });
  assert.equal(frames.length, 0);
  handlers.get('camera:event')({ cameraId: 'A', risk: 'red', type: 'drone', eta_seconds: 4 });
  handlers.get('camera:event')({ cameraId: 'B', risk: 'yellow', type: 'bird' });
  assert.equal(getElementById('risk').dataset.risk, 'red');
  assert.equal(getElementById('sideRisk').dataset.risk, 'red');
  assert.match(getElementById('beaconReading').textContent, /^RED/);
  assert.equal(frames.at(-1).level, 'R');
  assert.equal(frames.at(-1).eta, -1);
  handlers.get('disconnect')();
  assert.equal(getElementById('risk').dataset.risk, 'unavailable');
  assert.equal(getElementById('beaconLamps').hidden, true);
});
