// Comprehensive suite for RunwayOpsStore (`runway-ops-store.mjs`) and Runway Clash Board UI (`runway-clash-board.mjs`).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const storePromise = import('../public/js/runway-ops-store.mjs');
const boardPromise = import('../public/js/runway-clash-board.mjs');
const forecastPromise = import('../public/js/flight-forecast.mjs');

const SURVEYED_CORRIDOR = [
  [0.35, 0.55],
  [0.65, 0.55],
  [0.65, 0.75],
  [0.35, 0.75],
];

function straightPath(x, y, vx, vy, sec, fps = 10) {
  return Array.from({ length: sec * fps }, (_, i) => [x + (vx * i) / fps, y + (vy * i) / fps]);
}

function feedTrack(ff, id, cls, pts, fps = 10, t0 = 0) {
  for (let i = 0; i < pts.length; i++) {
    ff.update([{ id, cls, x: pts[i][0], y: pts[i][1] }], t0 + i / fps);
  }
}

/* ---------- Lightweight DOM + timer harness ---------- */

function createDomHarness({ reducedMotion = false } = {}) {
  let currentMotion = Boolean(reducedMotion);
  const mediaListeners = new Set();
  const intervals = new Map();
  let nextIntervalId = 1;

  function createElement(tagName = 'div') {
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    const el = {
      nodeType: 1,
      tagName: String(tagName).toUpperCase(),
      className: '',
      textContent: '',
      value: '',
      name: '',
      type: '',
      placeholder: '',
      hidden: false,
      disabled: false,
      dataset: {},
      children: [],
      parentNode: null,
      ownerDocument: null,
      classList: {
        add(...names) {
          for (const n of names) if (n) classes.add(n);
          el.className = [...classes].join(' ');
        },
        remove(...names) {
          for (const n of names) classes.delete(n);
          el.className = [...classes].join(' ');
        },
        contains(name) {
          return classes.has(name);
        },
      },
      setAttribute(name, val) {
        const key = String(name).toLowerCase();
        const str = String(val);
        attrs.set(key, str);
        if (key === 'class') {
          el.className = str;
          classes.clear();
          for (const tok of str.split(/\s+/)) if (tok) classes.add(tok);
        } else if (key === 'hidden') {
          el.hidden = true;
        } else if (key === 'disabled') {
          el.disabled = true;
        } else if (key.startsWith('data-')) {
          const camel = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          el.dataset[camel] = str;
        }
      },
      getAttribute(name) {
        const key = String(name).toLowerCase();
        if (key === 'class') return el.className || null;
        return attrs.get(key) ?? null;
      },
      hasAttribute(name) {
        return attrs.has(String(name).toLowerCase());
      },
      removeAttribute(name) {
        const key = String(name).toLowerCase();
        attrs.delete(key);
        if (key === 'hidden') el.hidden = false;
        if (key === 'disabled') el.disabled = false;
        if (key.startsWith('data-')) {
          const camel = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          delete el.dataset[camel];
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      click() {
        if (el.disabled) return;
        for (const fn of [...(listeners.get('click') || [])]) fn({ target: el, currentTarget: el });
      },
      appendChild(child) {
        if (!child || typeof child !== 'object') return child;
        if (child.parentNode && Array.isArray(child.parentNode.children)) {
          const prevIdx = child.parentNode.children.indexOf(child);
          if (prevIdx !== -1) child.parentNode.children.splice(prevIdx, 1);
        }
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      append(...nodes) {
        for (const n of nodes) {
          if (n && typeof n === 'object') el.appendChild(n);
        }
      },
      replaceChildren(...nodes) {
        for (const old of el.children) {
          if (old && typeof old === 'object') old.parentNode = null;
        }
        el.children = [];
        el.append(...nodes);
      },
      remove() {
        if (el.parentNode && Array.isArray(el.parentNode.children)) {
          const idx = el.parentNode.children.indexOf(el);
          if (idx !== -1) el.parentNode.children.splice(idx, 1);
        }
        el.parentNode = null;
      },
      listenerCount(type) {
        return listeners.get(type)?.size ?? 0;
      },
    };
    el.ownerDocument = doc;
    return el;
  }

  const doc = {
    documentElement: null,
    createElement,
  };
  doc.documentElement = createElement('html');

  const matchMedia = query => ({
    media: String(query),
    get matches() {
      return /prefers-reduced-motion\s*:\s*reduce/i.test(String(query)) ? currentMotion : false;
    },
    addEventListener(type, fn) {
      if (type === 'change') mediaListeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'change') mediaListeners.delete(fn);
    },
  });

  const setIntervalMock = (fn, ms) => {
    const id = nextIntervalId++;
    intervals.set(id, { id, fn, ms });
    return id;
  };
  const clearIntervalMock = id => {
    intervals.delete(id);
  };

  function tickAllIntervals() {
    for (const entry of [...intervals.values()]) {
      entry.fn();
    }
  }

  function setReducedMotion(next) {
    currentMotion = Boolean(next);
    for (const fn of [...mediaListeners]) {
      fn({ matches: currentMotion });
    }
  }

  return {
    doc,
    container: createElement('div'),
    matchMedia,
    setIntervalMock,
    clearIntervalMock,
    intervals,
    mediaListeners,
    tickAllIntervals,
    setReducedMotion,
  };
}

function walkDom(root, predicate, acc = []) {
  if (!root || typeof root !== 'object') return acc;
  if (predicate(root)) acc.push(root);
  for (const child of root.children || []) {
    walkDom(child, predicate, acc);
  }
  return acc;
}

function findByClass(root, cls) {
  return walkDom(root, node => node.classList?.contains?.(cls))[0] ?? null;
}

function findAllByClass(root, cls) {
  return walkDom(root, node => node.classList?.contains?.(cls));
}

/* ========================================================================== *
 *  1. RunwayOpsStore (`runway-ops-store.mjs`)                                *
 * ========================================================================== */

describe('createRunwayOpsStore (runway-ops-store.mjs)', () => {
  test('adds, normalizes, removes, and clears departure and arrival operations scoped per airport', async () => {
    const { createRunwayOpsStore, DEFAULT_MAX_OPS, OP_BUFFER_SEC, VALID_OP_KINDS, normalizeAirportCode } =
      await storePromise;

    assert.equal(DEFAULT_MAX_OPS, 12);
    assert.equal(OP_BUFFER_SEC, 20);
    assert.deepEqual(VALID_OP_KINDS, ['departure', 'arrival']);
    assert.equal(normalizeAirportCode('  kteb '), 'KTEB');
    assert.equal(normalizeAirportCode(null), '');

    let nowMs = 1_000_000;
    const store = createRunwayOpsStore({ now: () => nowMs });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    const dep = store.addOperation({
      airport: ' kteb ',
      kind: 'departure',
      callsign: ' ual412 ',
      runway: ' 27l ',
      inSec: 60,
    });
    assert.equal(dep.airport, 'KTEB');
    assert.equal(dep.kind, 'departure');
    assert.equal(dep.callsign, 'UAL412');
    assert.equal(dep.runway, '27L');
    assert.equal(dep.createdAtMs, 1_000_000);
    assert.equal(dep.dueAtMs, 1_060_000);

    const arr = store.addOperation({
      airport: 'KTEB',
      kind: 'arrival',
      callsign: 'n9876543210abcdef999', // truncated to 16 chars
      runway: '09r-extra-long', // truncated to 8 chars
      inSec: 30,
    });
    assert.equal(arr.callsign.length, 16);
    assert.equal(arr.runway.length, 8);

    // Separate airport bucket must remain completely isolated
    const other = store.addOperation({
      airport: 'kjfk',
      kind: 'departure',
      callsign: 'DAL88',
      runway: '04L',
      inSec: 45,
    });
    assert.equal(notifications, 3);

    // Sorted by earliest dueAtMs first (arr 30s before dep 60s)
    const ktebOps = store.activeOperations('kteb');
    assert.equal(ktebOps.length, 2);
    assert.deepEqual(
      ktebOps.map(op => ({ id: op.id, kind: op.kind, inSec: op.inSec })),
      [
        { id: arr.id, kind: 'arrival', inSec: 30 },
        { id: dep.id, kind: 'departure', inSec: 60 },
      ],
    );
    assert.equal(store.count('KTEB'), 2);
    assert.equal(store.count('KJFK'), 1);

    // Remove single operation by id
    assert.equal(store.removeOperation(arr.id), true);
    assert.equal(store.removeOperation(arr.id), false);
    assert.equal(store.count('KTEB'), 1);

    // Clearing KTEB leaves KJFK intact
    store.clear('KTEB');
    assert.equal(store.count('KTEB'), 0);
    assert.equal(store.count('KJFK'), 1);
    assert.equal(store.activeOperations('KJFK')[0].id, other.id);

    // Clearing all wipes remaining airports
    store.clear();
    assert.equal(store.count('KJFK'), 0);

    const prevNotifications = notifications;
    unsubscribe();
    store.addOperation({ airport: 'KTEB', kind: 'departure', inSec: 30 });
    assert.equal(notifications, prevNotifications, 'unsubscribed listener must not be called');

    // Input validation guards
    assert.throws(() => store.addOperation({ airport: '', kind: 'departure', inSec: 30 }), RangeError);
    assert.throws(() => store.addOperation({ airport: 'KTEB', kind: 'taxi', inSec: 30 }), RangeError);
    assert.throws(() => store.addOperation({ airport: 'KTEB', kind: 'departure', inSec: 0 }), RangeError);
    assert.throws(() => store.addOperation({ airport: 'KTEB', kind: 'departure', inSec: -5 }), RangeError);
  });

  test('enforces maxOps eviction (evicting earliest dueAtMs first) and auto-expires past dueAtMs', async () => {
    const { createRunwayOpsStore } = await storePromise;
    let nowMs = 5_000_000;
    const store = createRunwayOpsStore({ maxOps: 3, now: () => nowMs });

    const op30 = store.addOperation({ airport: 'KTEB', kind: 'departure', callsign: 'A30', inSec: 30 });
    const op60 = store.addOperation({ airport: 'KTEB', kind: 'arrival', callsign: 'B60', inSec: 60 });
    const op90 = store.addOperation({ airport: 'KTEB', kind: 'departure', callsign: 'C90', inSec: 90 });
    assert.equal(store.count('KTEB'), 3);

    // Adding 4th op evicts earliest-due op (op30)
    const op45 = store.addOperation({ airport: 'KTEB', kind: 'arrival', callsign: 'D45', inSec: 45 });
    assert.deepEqual(
      store.activeOperations('KTEB').map(o => o.id),
      [op45.id, op60.id, op90.id],
    );
    assert.equal(store.activeOperations('KTEB').some(o => o.id === op30.id), false);

    // Advance clock by 45s -> op45 hits dueAtMs and expires; op60 has 15s left; op90 has 45s left
    nowMs += 45_000;
    const remaining = store.activeOperations('KTEB');
    assert.deepEqual(
      remaining.map(o => ({ id: o.id, inSec: o.inSec })),
      [
        { id: op60.id, inSec: 15 },
        { id: op90.id, inSec: 45 },
      ],
    );

    // Advance past all dueAtMs -> bucket auto-pruned
    nowMs += 46_000;
    assert.deepEqual(store.activeOperations('KTEB'), []);
    assert.equal(store.count('KTEB'), 0);
  });

  test('evaluateClashes uses real FlightForecaster instances, enforces [eta.p10 - 20, eta.p90 + 20] & pWithin[60] >= 0.15, and blocks uncalibrated/demo/cross-airport feeds', async () => {
    const { createRunwayOpsStore } = await storePromise;
    const { FlightForecaster } = await forecastPromise;

    let nowMs = 10_000_000;
    const store = createRunwayOpsStore({ now: () => nowMs });

    // 1. Surveyed corridor FlightForecaster: drone heading east into corridor (~26s ETA, high pWithin[60])
    const surveyedForecaster = new FlightForecaster({
      corridor: { corridor: SURVEYED_CORRIDOR, surveyId: 'rwy-27l-survey' },
      seed: 12345,
    });
    feedTrack(surveyedForecaster, 101, 'drone', straightPath(0.05, 0.65, 0.01, 0, 4));
    const baselineForecast = surveyedForecaster.forecast(101);
    assert.equal(baselineForecast.corridorSurveyed, true);
    assert.equal(baselineForecast.surveyId, 'rwy-27l-survey');
    assert.ok(baselineForecast.pWithin[60] >= 0.15);
    assert.ok(baselineForecast.eta && baselineForecast.eta.p10 > 20 && baselineForecast.eta.p90 < 40);

    // 2. Surveyed corridor FlightForecaster with track flying AWAY (pWithin[60] < 0.15 -> must not clash)
    const departingTrackForecaster = new FlightForecaster({
      corridor: { corridor: SURVEYED_CORRIDOR, surveyId: 'rwy-09r-survey' },
      seed: 12345,
    });
    feedTrack(departingTrackForecaster, 202, 'bird', straightPath(0.15, 0.2, -0.01, -0.008, 4));
    assert.ok(departingTrackForecaster.forecast(202).pWithin[60] < 0.15);

    // 3. Uncalibrated FlightForecaster (no corridor survey) on identical collision course -> zero clashes
    const uncalibratedForecaster = new FlightForecaster({ seed: 12345 });
    feedTrack(uncalibratedForecaster, 303, 'drone', straightPath(0.05, 0.65, 0.01, 0, 4));
    assert.equal(uncalibratedForecaster.hasCorridor(), false);

    // 4. Demo camera feed (even with surveyed forecaster) -> zero clashes
    const demoForecaster = new FlightForecaster({
      corridor: { corridor: SURVEYED_CORRIDOR, surveyId: 'demo-survey' },
      seed: 12345,
    });
    feedTrack(demoForecaster, 404, 'drone', straightPath(0.05, 0.65, 0.01, 0, 4));

    // 5. Cross-airport surveyed camera (KJFK vs KTEB) -> zero clashes for KTEB
    const kjfkForecaster = new FlightForecaster({
      corridor: { corridor: SURVEYED_CORRIDOR, surveyId: 'kjfk-04l' },
      seed: 12345,
    });
    feedTrack(kjfkForecaster, 505, 'drone', straightPath(0.05, 0.65, 0.01, 0, 4));

    // Schedule:
    // - Overlapping KTEB departure inside [eta.p10 - 20, eta.p90 + 20] (~[4s, 49s]) -> inSec = 30s (MUST CLASH)
    // - Non-overlapping KTEB arrival far outside eta.p90 + 20 -> inSec = 120s (MUST NOT CLASH)
    // - Cross-airport KJFK departure at 30s -> MUST NOT LEAK into KTEB evaluation
    const clashOp = store.addOperation({
      airport: 'KTEB',
      kind: 'departure',
      callsign: 'UAL412',
      runway: '27L',
      inSec: 30,
    });
    store.addOperation({
      airport: 'KTEB',
      kind: 'arrival',
      callsign: 'SWA900',
      runway: '27L',
      inSec: 120,
    });
    store.addOperation({
      airport: 'KJFK',
      kind: 'departure',
      callsign: 'JBU11',
      runway: '04L',
      inSec: 30,
    });

    const cameras = {
      'cam-surveyed': {
        cameraId: 'cam-surveyed',
        cameraLabel: 'North Threshold',
        airport: 'KTEB',
        surveyId: 'rwy-27l-survey',
        forecaster: surveyedForecaster,
      },
      'cam-low-prob': {
        cameraId: 'cam-low-prob',
        airport: 'KTEB',
        surveyId: 'rwy-09r-survey',
        forecaster: departingTrackForecaster,
      },
      'cam-uncalibrated': {
        cameraId: 'cam-uncalibrated',
        airport: 'KTEB',
        forecaster: uncalibratedForecaster,
      },
      'cam-demo': {
        cameraId: 'cam-demo',
        airport: 'KTEB',
        demo: true,
        surveyId: 'demo-survey',
        forecaster: demoForecaster,
      },
      'cam-other-airport': {
        cameraId: 'cam-other-airport',
        airport: 'KJFK',
        surveyId: 'kjfk-04l',
        forecaster: kjfkForecaster,
      },
    };

    const clashes = store.evaluateClashes(cameras, 'KTEB', nowMs);
    assert.equal(clashes.length, 1);
    assert.equal(clashes[0].cameraId, 'cam-surveyed');
    assert.equal(clashes[0].cameraLabel, 'North Threshold');
    assert.equal(clashes[0].surveyId, 'rwy-27l-survey');
    assert.equal(clashes[0].trackId, 101);
    assert.equal(clashes[0].cls, 'drone');
    assert.equal(clashes[0].operationId, clashOp.id);
    assert.equal(clashes[0].callsign, 'UAL412');
    assert.equal(clashes[0].runway, '27L');
    assert.equal(clashes[0].severity, 'red');
    assert.equal(clashes[0].advisory, true);
    assert.ok(clashes[0].pWithin60 >= 0.15);
    assert.match(clashes[0].message, /departure in 30 s may meet this drone/i);

    // Verify exact [eta.p10 - 20, eta.p90 + 20] window boundary around baselineForecast.eta
    store.clear('KTEB');
    const insideUpperOp = store.addOperation({
      airport: 'KTEB',
      kind: 'arrival',
      inSec: Math.floor(baselineForecast.eta.p90 + 18),
    });
    store.addOperation({
      airport: 'KTEB',
      kind: 'arrival',
      inSec: Math.ceil(baselineForecast.eta.p90 + 25),
    });
    const boundaryClashes = store.evaluateClashes(
      { 'cam-surveyed': cameras['cam-surveyed'] },
      'KTEB',
      nowMs,
    );
    assert.deepEqual(
      boundaryClashes.map(c => c.operationId),
      [insideUpperOp.id],
    );
  });
});

/* ========================================================================== *
 *  2. Runway Clash Board UI (`runway-clash-board.mjs`)                       *
 * ========================================================================== */

describe('mountRunwayClashBoard (runway-clash-board.mjs)', () => {
  test('returns a safe no-op controller when called with non-container optionsBag, canvas, or null in Node', async () => {
    const { mountRunwayClashBoard, createRunwayClashBoard } = await boardPromise;
    const dom = createDomHarness();
    const mockCanvas = dom.doc.createElement('canvas');
    const optionsBag = { container: dom.container, canvas: mockCanvas, reducedMotion: true };

    for (const fn of [mountRunwayClashBoard, createRunwayClashBoard]) {
      for (const [first, second] of [
        [null, {}],
        [optionsBag, optionsBag],
        [mockCanvas, optionsBag],
      ]) {
        const ctrl = fn(first, second);
        assert.equal(ctrl.element, null);
        assert.deepEqual(ctrl.getActiveOperations(), []);
        assert.deepEqual(ctrl.getClashes(), []);
        assert.doesNotThrow(() => {
          ctrl.setAirport('KTEB');
          ctrl.updateForecasts({});
          ctrl.refresh();
          ctrl.destroy();
        });
      }
    }
  });

  test('renders controls, logs preset operations with callsign & runway, ticks live countdowns, and prunes expired ops', async () => {
    const { mountRunwayClashBoard, CLASH_ADVISORY_DISCLAIMER } = await boardPromise;
    const dom = createDomHarness();
    let nowMs = 20_000_000;

    const board = mountRunwayClashBoard(dom.container, {
      document: dom.doc,
      airport: 'kteb',
      now: () => nowMs,
      matchMedia: dom.matchMedia,
      setInterval: dom.setIntervalMock,
      clearInterval: dom.clearIntervalMock,
    });

    assert.ok(board.element);
    assert.equal(board.element.classList.contains('sky-clash-board'), true);
    assert.equal(findByClass(board.element, 'sky-clash-airport-pill').textContent, 'KTEB');
    assert.equal(findByClass(board.element, 'sky-clash-disclaimer').textContent, CLASH_ADVISORY_DISCLAIMER);
    assert.equal(findByClass(board.element, 'sky-clash-clear-btn').disabled, true);
    assert.equal(findByClass(board.element, 'sky-clash-empty').hidden, false);
    assert.equal(dom.intervals.size, 0, 'countdown interval stays idle when no operations exist');

    const inputs = findAllByClass(board.element, 'sky-clash-input');
    assert.equal(inputs.length, 2);
    const [callsignInput, runwayInput] = inputs;

    const presetBtns = findAllByClass(board.element, 'sky-clash-preset-btn');
    const dep30Btn = presetBtns.find(b => b.dataset.kind === 'departure' && b.dataset.inSec === '30');
    const arr60Btn = presetBtns.find(b => b.dataset.kind === 'arrival' && b.dataset.inSec === '60');
    assert.ok(dep30Btn && arr60Btn);

    // Log Departure +30s with callsign & runway
    callsignInput.value = 'ual412';
    runwayInput.value = '27l';
    dep30Btn.click();
    assert.equal(callsignInput.value, '', 'callsign resets after logging flight');
    assert.equal(runwayInput.value, '27l', 'active runway persists for quick subsequent logging');

    // Log Arrival +60s
    callsignInput.value = 'dal99';
    arr60Btn.click();

    assert.equal(dom.intervals.size, 1, 'countdown interval starts while active operations exist');
    assert.equal(findByClass(board.element, 'sky-clash-clear-btn').disabled, false);
    assert.equal(findByClass(board.element, 'sky-clash-empty').hidden, true);

    let rows = findAllByClass(board.element, 'sky-clash-op-row');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.kind, 'departure');
    assert.equal(findByClass(rows[0], 'sky-clash-kind-badge').dataset.kind, 'departure');
    assert.equal(findByClass(rows[0], 'sky-clash-op-meta').textContent, 'UAL412 · RWY 27L');
    assert.equal(findByClass(rows[0], 'sky-clash-countdown').textContent, 'T-30s');

    assert.equal(rows[1].dataset.kind, 'arrival');
    assert.equal(findByClass(rows[1], 'sky-clash-op-meta').textContent, 'DAL99 · RWY 27L');
    assert.equal(findByClass(rows[1], 'sky-clash-countdown').textContent, 'T-60s');

    // Advance 2 seconds and fire periodic tick -> T-28s and T-58s without recreating row elements
    const originalFirstRow = rows[0];
    nowMs += 2_000;
    dom.tickAllIntervals();
    rows = findAllByClass(board.element, 'sky-clash-op-row');
    assert.equal(rows[0], originalFirstRow, 'existing operation row element is updated in place across ticks');
    assert.equal(findByClass(rows[0], 'sky-clash-countdown').textContent, 'T-28s');
    assert.equal(findByClass(rows[1], 'sky-clash-countdown').textContent, 'T-58s');

    // Remove second row via its per-row remove button
    findByClass(rows[1], 'sky-clash-op-remove').click();
    assert.equal(findAllByClass(board.element, 'sky-clash-op-row').length, 1);

    // Advance past remaining operation's dueAtMs -> auto-prunes and pauses interval
    nowMs += 29_000;
    dom.tickAllIntervals();
    assert.equal(findAllByClass(board.element, 'sky-clash-op-row').length, 0);
    assert.equal(findByClass(board.element, 'sky-clash-empty').hidden, false);
    assert.equal(findByClass(board.element, 'sky-clash-clear-btn').disabled, true);
    assert.equal(dom.intervals.size, 0, 'countdown interval auto-pauses once queue empties');

    board.destroy();
  });

  test('enforces !surveyId / unsurveyed / demo safety gate, renders polite ARIA clash cards, isolates airports, and honors reduced motion & destroy()', async () => {
    const { mountRunwayClashBoard, NO_SURVEYED_CORRIDOR_NOTE } = await boardPromise;
    const { FlightForecaster } = await forecastPromise;

    const dom = createDomHarness({ reducedMotion: true });
    let nowMs = 30_000_000;

    const board = mountRunwayClashBoard(dom.container, {
      document: dom.doc,
      airport: 'KTEB',
      now: () => nowMs,
      matchMedia: dom.matchMedia,
      setInterval: dom.setIntervalMock,
      clearInterval: dom.clearIntervalMock,
    });

    // Reduced-motion attribute reflects matchMedia('(prefers-reduced-motion: reduce)')
    assert.equal(board.element.getAttribute('data-reduced-motion'), 'true');
    dom.setReducedMotion(false);
    assert.equal(board.element.getAttribute('data-reduced-motion'), null);
    dom.setReducedMotion(true);
    assert.equal(board.element.getAttribute('data-reduced-motion'), 'true');

    const banner = findByClass(board.element, 'sky-clash-banner');
    assert.equal(banner.getAttribute('aria-live'), 'polite');
    assert.equal(banner.dataset.clashState, 'clear');
    assert.equal(findByClass(banner, 'sky-clash-banner-title').textContent, NO_SURVEYED_CORRIDOR_NOTE);

    // Log KTEB Departure +30s
    const [callsignInput, runwayInput] = findAllByClass(board.element, 'sky-clash-input');
    callsignInput.value = 'N400SK';
    runwayInput.value = '27L';
    findAllByClass(board.element, 'sky-clash-preset-btn')[0].click(); // Departure +30s

    // Safety gate check: uncalibrated (!surveyId), corridorSurveyed: false, and demo: true feeds NEVER trigger clash cards
    board.updateForecasts({
      'uncal-missing-survey-id': {
        cameraId: 'uncal-missing-survey-id',
        surveyId: null,
        forecasts: [
          {
            id: 1,
            cls: 'drone',
            corridorSurveyed: true, // claims surveyed without surveyId -> MUST BE BLOCKED
            eta: { p10: 20, p50: 25, p90: 30 },
            pWithin: { 30: 0.9, 60: 0.95 },
          },
        ],
      },
      'uncal-corridor-false': {
        cameraId: 'uncal-corridor-false',
        surveyId: 'rwy-27l',
        corridorSurveyed: false,
        forecasts: [
          {
            id: 2,
            cls: 'drone',
            corridorSurveyed: false,
            eta: { p10: 20, p50: 25, p90: 30 },
            pWithin: { 30: 0.9, 60: 0.95 },
          },
        ],
      },
      'demo-feed': {
        cameraId: 'demo-feed',
        demo: true,
        surveyId: 'rwy-27l',
        forecasts: [
          {
            id: 3,
            cls: 'drone',
            corridorSurveyed: true,
            surveyId: 'rwy-27l',
            eta: { p10: 20, p50: 25, p90: 30 },
            pWithin: { 30: 0.9, 60: 0.95 },
          },
        ],
      },
    });
    assert.equal(board.hasSurveyedCorridor(), false);
    assert.deepEqual(board.getClashes(), []);
    assert.equal(findAllByClass(board.element, 'sky-clash-alert-row').length, 0);
    assert.equal(banner.dataset.clashState, 'clear');
    assert.equal(findByClass(banner, 'sky-clash-banner-title').textContent, NO_SURVEYED_CORRIDOR_NOTE);

    // Now feed a real surveyed FlightForecaster (red drone clash) + an amber bird forecast on a second surveyed camera
    const surveyedFF = new FlightForecaster({
      corridor: { corridor: SURVEYED_CORRIDOR, surveyId: 'kteb-27l-survey' },
      seed: 12345,
    });
    feedTrack(surveyedFF, 7, 'drone', straightPath(0.05, 0.65, 0.01, 0, 4));

    const clashes = board.updateForecasts({
      'cam-north': {
        cameraId: 'cam-north',
        cameraLabel: 'Threshold 27L',
        airport: 'KTEB',
        surveyId: 'kteb-27l-survey',
        forecaster: surveyedFF,
      },
      'cam-south': {
        cameraId: 'cam-south',
        cameraLabel: 'Approach 27L',
        airport: 'KTEB',
        surveyId: 'kteb-27l-south',
        forecasts: [
          {
            id: 19,
            cls: 'bird',
            severity: 'amber',
            level: 'yellow',
            corridorSurveyed: true,
            surveyId: 'kteb-27l-south',
            eta: { p10: 22, p50: 28, p90: 34 },
            pWithin: { 30: 0.12, 60: 0.24 },
          },
        ],
      },
    });

    assert.equal(board.hasSurveyedCorridor(), true);
    assert.equal(clashes.length, 2);
    assert.equal(banner.dataset.clashState, 'red');

    const alertRows = findAllByClass(board.element, 'sky-clash-alert-row');
    assert.equal(alertRows.length, 2);
    assert.equal(alertRows[0].dataset.severity, 'red');
    assert.equal(alertRows[1].dataset.severity, 'amber');
    assert.match(findByClass(alertRows[0], 'sky-clash-alert-main').textContent, /N400SK · RWY 27L/);
    assert.match(findByClass(alertRows[0], 'sky-clash-alert-meta').textContent, /Threshold 27L \(kteb-27l-survey\)/);

    // Switch airport via setAirport('KBOS') -> pill updates, KTEB ops/clashes do not leak
    board.setAirport('kbos');
    assert.equal(board.getAirport(), 'KBOS');
    assert.equal(findByClass(board.element, 'sky-clash-airport-pill').textContent, 'KBOS');
    assert.deepEqual(board.getActiveOperations(), []);
    assert.deepEqual(board.getClashes(), []);
    assert.equal(findAllByClass(board.element, 'sky-clash-op-row').length, 0);
    assert.equal(findAllByClass(board.element, 'sky-clash-alert-row').length, 0);
    assert.equal(banner.dataset.clashState, 'clear');

    // Switch back to KTEB -> KTEB operation and clashes are still preserved, then Clear wipes KTEB ops
    board.setAirport('KTEB');
    assert.equal(board.getActiveOperations().length, 1);
    assert.equal(board.getClashes().length, 2);

    findByClass(board.element, 'sky-clash-clear-btn').click();
    assert.deepEqual(board.getActiveOperations(), []);
    assert.deepEqual(board.getClashes(), []);
    assert.equal(banner.dataset.clashState, 'clear');
    assert.equal(findAllByClass(board.element, 'sky-clash-alert-row').length, 0);

    // Log one more op so interval is active, then verify destroy() cleans up timers, listeners, and DOM
    findAllByClass(board.element, 'sky-clash-preset-btn')[1].click();
    assert.equal(dom.intervals.size, 1);
    assert.equal(dom.mediaListeners.size, 1);
    assert.equal(dom.container.children.length, 1);

    board.destroy();
    board.destroy(); // idempotent
    assert.equal(dom.intervals.size, 0, 'destroy() clears countdown interval');
    assert.equal(dom.mediaListeners.size, 0, 'destroy() detaches matchMedia listener');
    assert.equal(dom.container.children.length, 0, 'destroy() removes board element from container');
    assert.deepEqual(board.getActiveOperations(), []);
    assert.deepEqual(board.getClashes(), []);
  });

  test('supports getAirport/getForecasts callbacks, re-mounting on same container, and minimal tower-startup mock DOM nodes', async () => {
    const { mountRunwayClashBoard } = await boardPromise;
    const dom = createDomHarness();
    let activeAirport = 'KTEB';
    let liveSnapshot = {
      'cam-1': {
        cameraId: 'cam-1',
        surveyId: 'kteb-survey',
        forecasts: [
          {
            id: 42,
            cls: 'drone',
            corridorSurveyed: true,
            surveyId: 'kteb-survey',
            eta: { p10: 20, p50: 25, p90: 32 },
            pWithin: { 30: 0.75, 60: 0.9 },
          },
        ],
      },
    };

    const first = mountRunwayClashBoard(dom.container, {
      document: dom.doc,
      getAirport: () => activeAirport,
      getForecasts: () => liveSnapshot,
      setInterval: dom.setIntervalMock,
      clearInterval: dom.clearIntervalMock,
    });
    first.logOperation({ kind: 'departure', inSec: 30, callsign: 'UAL1', runway: '27L' });
    assert.equal(first.getClashes().length, 1);
    assert.equal(dom.intervals.size, 1);

    // Re-mounting onto the same container tears down the previous board automatically
    const second = mountRunwayClashBoard(dom.container, {
      document: dom.doc,
      getAirport: () => activeAirport,
      getForecasts: () => liveSnapshot,
      setInterval: dom.setIntervalMock,
      clearInterval: dom.clearIntervalMock,
    });
    assert.equal(dom.container.children.length, 1);
    assert.equal(second.element, dom.container.children[0]);
    activeAirport = 'KBOS';
    liveSnapshot = {};
    second.refresh();
    assert.equal(second.getAirport(), 'KBOS');
    second.destroy();
    assert.equal(dom.intervals.size, 0);

    // Minimal mock DOM (matching tower-startup.test.cjs element shape: no classList/setAttribute/appendChild)
    const minimalEl = () => ({
      hidden: true,
      dataset: {},
      children: [],
      addEventListener() {},
      replaceChildren(...nodes) {
        this.children = nodes;
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      remove() {},
    });
    const minimalDoc = { createElement: minimalEl };
    const minimalContainer = minimalEl();
    const minimalBoard = mountRunwayClashBoard(minimalContainer, {
      document: minimalDoc,
      airport: 'KTEB',
      setInterval: dom.setIntervalMock,
      clearInterval: dom.clearIntervalMock,
    });
    assert.ok(minimalBoard.element);
    assert.equal(minimalBoard.element.hidden, false);
    minimalBoard.logOperation('arrival', 45, { callsign: 'AAL7', runway: '09R' });
    assert.equal(minimalBoard.getActiveOperations().length, 1);
    minimalBoard.destroy();
  });
});
