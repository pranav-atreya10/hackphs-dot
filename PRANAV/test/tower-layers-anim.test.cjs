const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function createMockLeaflet() {
  const created = [];
  const mapViews = [];

  function makeLayer(kind, coords, options = {}) {
    const el = { dataset: {} };
    const listeners = new Map();
    const inst = {
      kind,
      coords,
      options: { ...options },
      styleCalls: [],
      latLngCalls: 0,
      tooltipBinds: 0,
      popupBinds: 0,
      addCalls: 0,
      removed: false,
      tooltipNode: null,
      popupNode: null,
      getElement() { return el; },
      on(event, fn) {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
        return this;
      },
      once(event, fn) {
        return this.on(event, fn);
      },
      listenerCount(event) {
        return event ? (listeners.get(event)?.length ?? 0) : [...listeners.values()].reduce((n, l) => n + l.length, 0);
      },
      bindTooltip(node) {
        this.tooltipBinds++;
        this.tooltipNode = node;
        return this;
      },
      bindPopup(node) {
        this.popupBinds++;
        this.popupNode = node;
        return this;
      },
      addTo() {
        this.addCalls++;
        return this;
      },
      setLatLng(next) {
        this.latLngCalls++;
        this.coords = next;
        return this;
      },
      setLatLngs(next) {
        this.latLngCalls++;
        this.coords = next;
        return this;
      },
      setStyle(style) {
        this.styleCalls.push(style);
        Object.assign(this.options, style);
        return this;
      },
      remove() {
        this.removed = true;
      },
    };
    created.push(inst);
    return inst;
  }

  const L = {
    polygon: (coords, opts) => makeLayer('polygon', coords, opts),
    circleMarker: (coords, opts) => makeLayer('circleMarker', coords, opts),
    polyline: (coords, opts) => makeLayer('polyline', coords, opts),
  };
  const map = {
    setView(center, zoom) { mapViews.push({ center, zoom }); },
  };
  return { L, map, created, mapViews };
}

function withMockDocument(t) {
  const prev = globalThis.document;
  globalThis.document = { createElement: () => ({ textContent: '' }) };
  t.after(() => { globalThis.document = prev; });
}

test('placeCamera and setCameraStatus tint FOV cones and pins across risk/freshness states while reusing layers', async t => {
  withMockDocument(t);
  const { createTowerLayers, LAYER_COLORS } = await import('../public/js/tower-layers.mjs');
  const { L, map, created, mapViews } = createMockLeaflet();
  let now = 500_000;
  const layers = createTowerLayers(L, map, { now: () => now });
  const camGeom = { lat: 40.3987, lon: -74.6586, heading_deg: 90, hfov_deg: 60 };

  // 1. Idle / configured camera -> blue (#1f6fd1)
  layers.placeCamera({ cameraId: 'cam-1', cameraLabel: 'North', camera: camGeom });
  assert.equal(created.length, 2);
  const [cone, camPin] = created;
  assert.equal(cone.options.className, 'sky-fov-cone');
  assert.equal(camPin.options.className, 'sky-cam-pin');
  assert.equal(cone.options.color, '#1f6fd1');
  assert.equal(camPin.options.color, '#1f6fd1');
  assert.equal(cone.getElement().dataset.risk, 'blue');
  assert.equal(camPin.getElement().dataset.risk, 'blue');
  assert.equal(mapViews.length, 1);

  // 2. Fresh clear -> green (#16a34a), reuses exact cone & marker without re-binding or moving
  layers.setCameraStatus('cam-1', { risk: 'green', online: true, pulse: false });
  assert.equal(created.length, 2);
  assert.equal(cone.options.color, '#16a34a');
  assert.equal(camPin.options.color, '#16a34a');
  assert.equal(cone.getElement().dataset.risk, 'green');
  assert.equal(cone.latLngCalls, 0);
  assert.equal(camPin.tooltipBinds, 1);

  // 3. Repeated identical setCameraStatus is idempotent (no redundant setStyle or listener growth)
  const priorStyleCount = cone.styleCalls.length;
  layers.setCameraStatus('cam-1', { risk: 'green', online: true, pulse: false });
  assert.equal(cone.styleCalls.length, priorStyleCount);
  assert.equal(cone.listenerCount(), 0);
  assert.equal(camPin.listenerCount(), 0);

  // 4. Offline / stale -> muted #6b7280 with dashed cone, then recovery clears dashArray
  layers.setCameraStatus('cam-1', { risk: 'green', online: false, pulse: true });
  assert.equal(created.length, 2, 'offline camera never spawns a pulseMarker');
  assert.equal(cone.options.color, '#6b7280');
  assert.equal(cone.options.dashArray, '4 4');
  assert.equal(cone.getElement().dataset.risk, 'offline');
  assert.equal(camPin.options.color, '#6b7280');

  // Stale timestamp on placeCamera also renders muted/dashed #6b7280
  layers.placeCamera({ cameraId: 'cam-1', cameraLabel: 'North', camera: camGeom, risk: 'red', receivedAt: now - 20_000 });
  assert.equal(cone.options.color, LAYER_COLORS.offline);
  assert.equal(cone.options.dashArray, '4 4');
  assert.equal(created.length, 2);

  // Fresh green placeCamera recovers solid cone
  layers.placeCamera({ cameraId: 'cam-1', cameraLabel: 'North-2', camera: camGeom, risk: 'green', receivedAt: now });
  assert.equal(cone.options.color, '#16a34a');
  assert.equal(cone.options.dashArray, null);
  assert.equal(camPin.tooltipNode.textContent, 'Camera North-2');
  assert.equal(camPin.tooltipBinds, 1);
  assert.equal(cone.latLngCalls, 0);
});

test('pin automatically updates camera cone tint and manages at most ONE reusable pulseMarker per camera/threat', async t => {
  withMockDocument(t);
  const { createTowerLayers } = await import('../public/js/tower-layers.mjs');
  const { L, map, created } = createMockLeaflet();
  let now = 1_000_000;
  const layers = createTowerLayers(L, map, { now: () => now, describe: ev => `${ev.risk}:${ev.id}` });
  const camGeom = { lat: 40.0, lon: -74.0, heading_deg: 180, hfov_deg: 70 };

  layers.placeCamera({ cameraId: 'A', camera: camGeom });
  const [cone, camPin] = created;
  assert.equal(cone.options.color, '#1f6fd1');

  // Unmeasured fresh yellow warning tints camera cone & pulses at camera, but NEVER creates a guessed threat pin
  layers.pin({
    cameraId: 'A', id: 'u-1', risk: 'yellow', receivedAt: now,
    target_geo: { coordinates: [-74.01, 40.01] },
  });
  const threatPinsAfterUnmeasured = created.filter(l => l.options.className === 'sky-threat-pin');
  const pulsesAfterUnmeasured = created.filter(l => l.options.className === 'sky-map-pulse');
  assert.equal(threatPinsAfterUnmeasured.length, 0, 'geo_basis !== measured must never place threat pin');
  assert.equal(cone.options.color, '#d99a00');
  assert.equal(cone.getElement().dataset.risk, 'yellow');
  assert.equal(pulsesAfterUnmeasured.length, 1);
  const pulseMarker = pulsesAfterUnmeasured[0];
  assert.deepEqual(pulseMarker.coords, [40.0, -74.0]);
  assert.equal(pulseMarker.options.color, '#d99a00');

  // Measured fresh yellow -> creates 1 threat pin and REUSES the exact same pulseMarker moved to threat coords
  layers.pin({
    cameraId: 'A', id: 'm-1', risk: 'yellow', geo_basis: 'measured', receivedAt: now,
    target_geo: { coordinates: [-74.02, 40.02] },
    path_geo: { coordinates: [[-74.01, 40.01], [-74.02, 40.02]] },
  });
  const threatPins = created.filter(l => l.options.className === 'sky-threat-pin');
  assert.equal(threatPins.length, 1);
  assert.equal(created.filter(l => l.options.className === 'sky-map-pulse').length, 1, 'reuses single pulseMarker');
  assert.equal(pulseMarker.removed, false);
  assert.deepEqual(pulseMarker.coords, [40.02, -74.02]);

  // Escalate to fresh red across repeated pin + placeCamera calls -> zero new layers, cone + threat + pulse tint #dc2626
  const countBeforeEscalation = created.length;
  for (let i = 0; i < 4; i++) {
    now += 200;
    const redEv = {
      cameraId: 'A', id: `m-red-${i}`, risk: 'red', geo_basis: 'measured', receivedAt: now,
      camera: camGeom,
      target_geo: { coordinates: [-74.02, 40.02] },
      path_geo: { coordinates: [[-74.01, 40.01], [-74.02, 40.02]] },
    };
    layers.pin(redEv);
    layers.placeCamera(redEv);
  }
  assert.equal(created.length, countBeforeEscalation, 'repeated pin/placeCamera never recreates layers');
  assert.equal(cone.options.color, '#dc2626');
  assert.equal(camPin.options.color, '#dc2626');
  assert.equal(cone.getElement().dataset.risk, 'red');
  assert.equal(threatPins[0].options.color, '#dc2626');
  assert.equal(threatPins[0].getElement().dataset.risk, 'red');
  assert.equal(threatPins[0].popupBinds, 1);
  assert.equal(pulseMarker.options.color, '#dc2626');
  assert.equal(pulseMarker.removed, false);

  // Camera leaves yellow/red via green pin -> threat + pulse removed, camera cone tints green (#16a34a)
  layers.pin({ cameraId: 'A', id: 'clear-1', risk: 'green', receivedAt: now });
  assert.equal(threatPins[0].removed, true);
  assert.equal(pulseMarker.removed, true);
  assert.equal(cone.options.color, '#16a34a');
  assert.equal(cone.getElement().dataset.risk, 'green');
  assert.equal(cone.removed, false);
});

test('prune and clear clean up pulseMarkers and revert warning cone tints when warnings expire', async t => {
  withMockDocument(t);
  const { createTowerLayers } = await import('../public/js/tower-layers.mjs');
  const { L, map, created } = createMockLeaflet();
  const now = 2_000_000;
  const layers = createTowerLayers(L, map, { now: () => now });
  const camGeom = { lat: 40.1, lon: -74.1, heading_deg: 45, hfov_deg: 50 };

  // Pre-configure status before camera geometry arrives
  layers.setCameraStatus('B', { risk: 'green', online: true, pulse: false });
  layers.placeCamera({ cameraId: 'B', camera: camGeom });
  const [coneB] = created;
  assert.equal(coneB.options.color, '#16a34a');

  // Trigger pulse via setCameraStatus({ pulse: true }) and escalate via pin
  layers.setCameraStatus('B', { risk: 'yellow', online: true, pulse: true });
  const pulses1 = created.filter(l => l.options.className === 'sky-map-pulse');
  assert.equal(pulses1.length, 1);

  layers.pin({
    cameraId: 'B', id: 'w-1', risk: 'red', geo_basis: 'measured', receivedAt: now,
    target_geo: { coordinates: [-74.11, 40.11] },
  });
  assert.equal(created.filter(l => l.options.className === 'sky-map-pulse').length, 1);
  assert.equal(coneB.options.color, '#dc2626');

  // Prune warnings while keeping camera B active -> threat & pulse cleaned up, cone reverts to green
  layers.prune(new Set(['B']), new Set());
  assert.equal(pulses1[0].removed, true);
  assert.equal(coneB.removed, false);
  assert.equal(coneB.options.color, '#16a34a');

  // Clear removes all remaining camera layers and pulses
  layers.setCameraStatus('B', { risk: 'red', online: true, pulse: true });
  const activePulses = created.filter(l => l.options.className === 'sky-map-pulse' && !l.removed);
  assert.equal(activePulses.length, 1);
  layers.clear();
  assert.ok(created.every(l => l.removed), 'every Leaflet layer is removed on clear()');
});

test('camera relocation, offline transition during active threat, and missing L.circleMarker degrade gracefully', async t => {
  withMockDocument(t);
  const { createTowerLayers } = await import('../public/js/tower-layers.mjs');
  const { L, map, created } = createMockLeaflet();
  const now = 3_000_000;
  const layers = createTowerLayers(L, map, { clock: () => now });

  layers.placeCamera({
    cameraId: 'C',
    camera: { lat: 40.0, lon: -74.0, heading_deg: 0, hfov_deg: 60 },
    risk: 'yellow',
    receivedAt: now,
  });
  const [cone, camPin, camPulse] = created;
  assert.equal(created.length, 3);
  assert.deepEqual(camPulse.coords, [40.0, -74.0]);

  // Move camera position -> reuses cone, camPin, and pulseMarker in place
  layers.placeCamera({
    cameraId: 'C',
    camera: { lat: 40.05, lon: -74.05, heading_deg: 30, hfov_deg: 60 },
    risk: 'yellow',
    receivedAt: now,
  });
  assert.equal(created.length, 3);
  assert.equal(cone.latLngCalls, 1);
  assert.equal(camPin.latLngCalls, 1);
  assert.equal(camPulse.latLngCalls, 1);
  assert.deepEqual(camPulse.coords, [40.05, -74.05]);

  // Add measured threat, then mark camera offline -> threat and pulse are both cleaned up
  layers.pin({
    cameraId: 'C',
    risk: 'red',
    geo_basis: 'measured',
    receivedAt: now,
    target_geo: { coordinates: [-74.06, 40.06] },
  });
  const threatPin = created.find(l => l.options.className === 'sky-threat-pin');
  assert.ok(threatPin && !threatPin.removed);
  assert.equal(camPulse.removed, false);

  layers.setCameraStatus('C', { online: false });
  assert.equal(threatPin.removed, true);
  assert.equal(camPulse.removed, true);
  assert.equal(cone.options.color, '#6b7280');
  assert.equal(cone.options.dashArray, '4 4');

  // Minimal L without circleMarker does not throw when placing cameras or pulsing warnings
  const polyOnly = [];
  const minimalLayers = createTowerLayers({
    polygon: (coords, options) => {
      const p = { coords, options, addTo() { return this; }, setLatLngs() { return this; }, setStyle() { return this; }, remove() {} };
      polyOnly.push(p);
      return p;
    },
  }, { setView() {} }, { now: () => now });
  minimalLayers.placeCamera({
    cameraId: 'D',
    camera: { lat: 40.0, lon: -74.0, heading_deg: 90, hfov_deg: 45 },
    risk: 'red',
    receivedAt: now,
  });
  minimalLayers.pin({
    cameraId: 'D',
    risk: 'red',
    geo_basis: 'measured',
    receivedAt: now,
    target_geo: { coordinates: [-74.01, 40.01] },
  });
  minimalLayers.clear();
  assert.equal(polyOnly.length, 1);
  assert.equal(polyOnly[0].options.className, 'sky-fov-cone');
});

test('map-hud.css defines FOV breathe, red warning glow, radar ripple, and reduced-motion suppression', () => {
  const css = readFileSync(path.join(__dirname, '../public/css/map-hud.css'), 'utf8');
  assert.match(css, /@keyframes\s+sky-fov-breathe\b/);
  assert.match(css, /@keyframes\s+sky-radar-ripple\b/);
  assert.match(css, /\.sky-fov-cone\b/);
  assert.match(css, /\.sky-fov-cone\[data-risk="red"\]/);
  assert.match(css, /\.sky-threat-pin\b/);
  assert.match(css, /\.sky-map-pulse\b/);
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
});
