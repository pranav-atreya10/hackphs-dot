const { test } = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../public/js/flight-forecast.mjs');

const SURVEYED_CORRIDOR = [
  [0.35, 0.55],
  [0.65, 0.55],
  [0.65, 0.75],
  [0.35, 0.75],
];

function feedTrack(ff, id, cls, path, fps = 10, t0 = 0) {
  for (let i = 0; i < path.length; i++) {
    ff.update([{ id, cls, x: path[i][0], y: path[i][1] }], t0 + i / fps);
  }
}

function straightPath(x, y, vx, vy, sec, fps = 10) {
  return Array.from({ length: sec * fps }, (_, i) => [x + (vx * i) / fps, y + (vy * i) / fps]);
}

test('defaults enforce maxTracks=48, samples=120 (capped at 300), and horizons=[15, 30, 60]', async () => {
  const { FlightForecaster, FORECAST_DEFAULTS, createFlightForecaster } = await modulePromise;
  const ff = createFlightForecaster();
  assert.equal(FORECAST_DEFAULTS.maxTracks, 48);
  assert.equal(FORECAST_DEFAULTS.samples, 120);
  assert.equal(FORECAST_DEFAULTS.maxSamples, 300);
  assert.deepEqual(FORECAST_DEFAULTS.horizons, [15, 30, 60]);
  assert.equal(ff.cfg.maxTracks, 48);
  assert.equal(ff.cfg.samples, 120);
  assert.deepEqual(ff.cfg.horizons, [15, 30, 60]);
  assert.equal(ff.hasCorridor(), false);

  const high = new FlightForecaster({ samples: 250 });
  assert.equal(high.cfg.samples, 250);
  const capped = new FlightForecaster({ samples: 999 });
  assert.equal(capped.cfg.samples, 300);

  feedTrack(capped, 1, 'bird', straightPath(0.1, 0.5, 0.01, 0, 2));
  assert.equal(capped.coneFan(1, { samples: 1000 }).samples, 300);

  for (const bad of [0, -5, 1.5, NaN]) {
    assert.throws(() => new FlightForecaster({ maxTracks: bad }), RangeError);
  }
  for (const bad of [0, -10, NaN, Infinity]) {
    assert.throws(() => new FlightForecaster({ samples: bad }), RangeError);
  }
  assert.throws(() => new FlightForecaster({ horizons: [] }), RangeError);
});

test('maxTracks strictly bounds feed memory and evicts oldest unseen tracks first (Audit Finding #33)', async () => {
  const { FlightForecaster } = await modulePromise;
  const small = new FlightForecaster({ maxTracks: 3, minHistory: 2 });

  small.update([{ id: 'a', cls: 'bird', x: 0.1, y: 0.1 }], 0.1);
  small.update([{ id: 'b', cls: 'bird', x: 0.2, y: 0.2 }], 0.2);
  small.update([{ id: 'c', cls: 'bird', x: 0.3, y: 0.3 }], 0.3);
  assert.equal(small.size, 3);

  // Refresh 'a' at t=0.4 -> 'b' (lastSeen 0.2) is now oldest unseen, then 'c' (0.3).
  small.update([{ id: 'a', cls: 'bird', x: 0.12, y: 0.1 }], 0.4);
  small.update([{ id: 'd', cls: 'drone', x: 0.4, y: 0.4 }], 0.5);
  assert.equal(small.size, 3);
  assert.equal(small.hist.has('b'), false, 'oldest unseen track b must be evicted first');
  assert.equal(small.hist.has('a'), true);
  assert.equal(small.hist.has('c'), true);
  assert.equal(small.hist.has('d'), true);

  small.update([{ id: 'e', cls: 'bird', x: 0.5, y: 0.5 }], 0.6);
  assert.equal(small.size, 3);
  assert.equal(small.hist.has('c'), false, 'next oldest unseen track c must be evicted');
  assert.deepEqual([...small.hist.keys()].sort(), ['a', 'd', 'e']);

  // Default 48-track cap holds under single-frame bursts >48 and avoids thrashing active tracks.
  const bounded = new FlightForecaster();
  for (let frame = 0; frame < 10; frame++) {
    const burst = Array.from({ length: 80 }, (_, k) => ({
      id: k + 1,
      cls: 'bird',
      x: 0.05 + k * 0.005 + frame * 0.004,
      y: 0.25 + frame * 0.002,
    }));
    bounded.update(burst, frame * 0.1);
    assert.ok(bounded.size <= 48, `size ${bounded.size} must never exceed default 48`);
  }
  assert.equal(bounded.size, 48);
  assert.equal(bounded.forecastAll().length, 48, 'all 48 retained active tracks accumulate fit history without thrashing');
});

test('coneFan and forecast emit perpendicular 10th-90th lateral fans without corridor, omitting pWithin/eta/level', async () => {
  const { FlightForecaster } = await modulePromise;

  const invalidCorridors = [
    undefined,
    [],
    [[0.2, 0.2], [0.8, 0.8]], // < 3 points
    [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]], // 3 collinear points (zero area)
    { corridor: SURVEYED_CORRIDOR }, // config object missing surveyId
    { polygon: SURVEYED_CORRIDOR, surveyId: 'rwy-27l', demo: true }, // demo mask is non-operational
  ];

  for (const corridor of invalidCorridors) {
    const ff = new FlightForecaster({ corridor, seed: 42 });
    assert.equal(ff.hasCorridor(), false);
    feedTrack(ff, 7, 'bird', straightPath(0.1, 0.4, 0.01, 0, 3));
    const fan = ff.coneFan(7);
    assert.ok(fan);
    assert.equal(fan.corridorSurveyed, false);

    // State matches { x, y, vx, vy, speed, heading, turn, cls }
    for (const key of ['x', 'y', 'vx', 'vy', 'speed', 'heading', 'turn', 'cls']) {
      assert.ok(Object.hasOwn(fan.state, key), `state missing ${key}`);
    }
    assert.equal(fan.state.cls, 'bird');
    assert.ok(Math.abs(fan.state.vx - 0.01) < 1e-6);
    assert.ok(Math.abs(fan.state.vy) < 1e-6);
    assert.ok(Math.abs(fan.state.heading) < 1e-6);

    // No safety/corridor verdicts when unsurveyed!
    for (const forbidden of ['pWithin', 'eta', 'level', 'p_enter', 'eta_sec', 'straight_line_eta_sec', 'clashes']) {
      assert.equal(Object.hasOwn(fan, forbidden), false, `${forbidden} must not be present without surveyed corridor`);
    }

    // Per-horizon cone geometry across [15, 30, 60]
    let prevWidth = 0;
    let prevSpread = 0;
    for (const H of [15, 30, 60]) {
      const h = fan.horizons[H];
      assert.ok(h, `missing horizon ${H}`);
      assert.equal(Object.hasOwn(h, 'pWithin'), false);
      assert.equal(h.mean.length, 2);
      assert.equal(h.p10.length, 2);
      assert.equal(h.p90.length, 2);
      assert.equal(h.lateralLeft.length, 2);
      assert.equal(h.lateralRight.length, 2);
      assert.ok(h.p10[0] <= h.mean[0] && h.mean[0] <= h.p90[0]);
      assert.ok(h.p10[1] <= h.mean[1] && h.mean[1] <= h.p90[1]);

      // Lateral vector must be perpendicular to heading (dot product == 0)
      const ux = Math.cos(h.heading);
      const uy = Math.sin(h.heading);
      const lx = h.lateralRight[0] - h.lateralLeft[0];
      const ly = h.lateralRight[1] - h.lateralLeft[1];
      const dot = lx * ux + ly * uy;
      assert.ok(Math.abs(dot) < 1e-9, `lateral axis must be perpendicular to heading (dot=${dot})`);

      // Eastward flight: port (lateralLeft) has smaller y than mean; starboard (lateralRight) has larger y.
      assert.ok(h.lateralLeft[1] < h.mean[1]);
      assert.ok(h.lateralRight[1] > h.mean[1]);

      const width = Math.hypot(lx, ly);
      assert.ok(width > prevWidth, `cone lateral width should grow with horizon (${H}s)`);
      assert.ok(h.spreadRad > prevSpread, `spreadRad should grow with horizon (${H}s)`);
      prevWidth = width;
      prevSpread = h.spreadRad;
    }
  }
});

test('curved trajectory bends cone spine and birds exhibit wider angular spread than drones', async () => {
  const { FlightForecaster } = await modulePromise;

  // Turning bird: circular arc curving downward (+y)
  const turning = new FlightForecaster({ seed: 99 });
  const arc = Array.from({ length: 40 }, (_, i) => {
    const a = -Math.PI / 2 + (i / 10) * 0.25; // turning right (+0.25 rad/s)
    return [0.3 + 0.15 * Math.cos(a), 0.4 + 0.15 * Math.sin(a)];
  });
  feedTrack(turning, 1, 'bird', arc);
  const curved = turning.coneFan(1, { horizons: [10, 20, 30] });
  assert.ok(curved.state.turn > 0.15, `expected positive turn rate, got ${curved.state.turn}`);
  assert.notEqual(curved.horizons[10].heading, curved.horizons[30].heading);
  for (const slice of curved.fan) {
    const ux = Math.cos(slice.heading);
    const uy = Math.sin(slice.heading);
    const dx = slice.lateralRight[0] - slice.lateralLeft[0];
    const dy = slice.lateralRight[1] - slice.lateralLeft[1];
    assert.ok(Math.abs(dx * ux + dy * uy) < 1e-9, 'lateral fan stays perpendicular along curved spine');
  }

  // Bird vs drone uncertainty width on identical straight trajectory
  const birdFF = new FlightForecaster({ seed: 7 });
  const droneFF = new FlightForecaster({ seed: 7 });
  const samePath = straightPath(0.2, 0.5, 0.008, 0, 3);
  feedTrack(birdFF, 1, 'bird', samePath);
  feedTrack(droneFF, 1, 'drone', samePath);
  const bFan = birdFF.coneFan(1);
  const dFan = droneFF.coneFan(1);
  assert.ok(bFan.horizons[30].spreadRad > dFan.horizons[30].spreadRad);
  const bWidth = Math.hypot(
    bFan.horizons[30].lateralRight[0] - bFan.horizons[30].lateralLeft[0],
    bFan.horizons[30].lateralRight[1] - bFan.horizons[30].lateralLeft[1],
  );
  const dWidth = Math.hypot(
    dFan.horizons[30].lateralRight[0] - dFan.horizons[30].lateralLeft[0],
    dFan.horizons[30].lateralRight[1] - dFan.horizons[30].lateralLeft[1],
  );
  assert.ok(bWidth > dWidth, 'bird lateral cone width must exceed steadier drone cone width');
});

test('surveyed corridor (>= 3 points) enables pWithin, eta, level, and operation clash escalation', async () => {
  const { FlightForecaster } = await modulePromise;

  // 1. Bird straight toward surveyed corridor (~20 s away)
  const ffIn = new FlightForecaster({
    corridor: { corridor: SURVEYED_CORRIDOR, surveyId: 'rwy-27l' },
    seed: 12345,
  });
  assert.equal(ffIn.hasCorridor(), true);
  feedTrack(ffIn, 1, 'bird', straightPath(0.05, 0.65, 0.015, 0, 4));
  const fIn = ffIn.forecast(1);
  assert.equal(fIn.corridorSurveyed, true);
  assert.equal(fIn.surveyId, 'rwy-27l');
  assert.equal(fIn.level, 'red');
  assert.ok(fIn.pWithin[30] > 0.5);
  assert.ok(fIn.horizons[30].pWithin > 0.5);
  assert.ok(fIn.eta && fIn.eta.p10 <= fIn.eta.p50 && fIn.eta.p50 <= fIn.eta.p90);

  // 2. Bird flying away -> green, low entry probability; distant departing track -> eta null
  const ffAway = new FlightForecaster({ corridor: SURVEYED_CORRIDOR, seed: 12345 });
  feedTrack(ffAway, 2, 'bird', straightPath(0.2, 0.3, -0.01, -0.005, 4));
  const fAway = ffAway.forecast(2);
  assert.equal(fAway.level, 'green');
  assert.ok(fAway.pWithin[60] < 0.1);

  feedTrack(ffAway, 22, 'bird', straightPath(0.05, 0.05, -0.003, -0.003, 4));
  const fFarAway = ffAway.forecast(22);
  assert.equal(fFarAway.level, 'green');
  assert.equal(fFarAway.pWithin[60], 0);
  assert.equal(fFarAway.eta, null);
  assert.equal(fFarAway.eta_sec, null);

  // 2b. Hovering drone far from corridor -> not red; circling bird near corridor -> elevated chance
  const ffHover = new FlightForecaster({ corridor: SURVEYED_CORRIDOR, seed: 12345 });
  feedTrack(
    ffHover,
    4,
    'drone',
    straightPath(0.15, 0.2, 0, 0, 4).map(([x, y], i) => [x + 0.0005 * Math.sin(i), y]),
  );
  assert.notEqual(ffHover.forecast(4).level, 'red');

  const circlePath = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 10) * 0.5;
    return [0.5 + 0.12 * Math.cos(a), 0.35 + 0.12 * Math.sin(a)];
  });
  feedTrack(ffHover, 3, 'bird', circlePath);
  assert.ok(ffHover.forecast(3).pWithin[60] > 0.15);

  // 3. Drone heading into corridor within 60 s -> red
  const ffDrone = new FlightForecaster({ corridor: SURVEYED_CORRIDOR });
  feedTrack(ffDrone, 5, 'drone', straightPath(0.9, 0.2, -0.008, 0.008, 4));
  const fDrone = ffDrone.forecast(5);
  assert.equal(fDrone.level, 'red');
  assert.ok(fDrone.pWithin[60] >= 0.1);

  // 4. Bird reaching corridor around scheduled departure -> clash upgrades to red
  const ffClash = new FlightForecaster({ corridor: SURVEYED_CORRIDOR });
  feedTrack(ffClash, 6, 'bird', straightPath(0.05, 0.65, 0.008, 0, 4));
  const fClash = ffClash.forecast(6, { operations: [{ kind: 'departure', runway: '27L', inSec: 45 }] });
  assert.ok(fClash.clashes.length > 0);
  assert.equal(fClash.level, 'red');

  // Clearing corridor suppresses pWithin / eta / level immediately
  ffClash.setCorridor(null);
  assert.equal(ffClash.hasCorridor(), false);
  const cleared = ffClash.forecast(6);
  assert.equal(Object.hasOwn(cleared, 'pWithin'), false);
  assert.equal(Object.hasOwn(cleared, 'eta'), false);
  assert.equal(Object.hasOwn(cleared, 'level'), false);
});

test('reset() clears history on stream/generation changes and accepts DetectionEngine track shapes', async () => {
  const { FlightForecaster } = await modulePromise;
  const ff = new FlightForecaster({ seed: 55 });

  // Feed DetectionEngine-style state.tracks ({ id, classification, bbox, missed })
  for (let i = 0; i < 12; i++) {
    ff.update([
      { id: 10, classification: 'drone', bbox: { x: 0.2 + i * 0.01, y: 0.3, w: 0.02, h: 0.02 }, missed: false },
      { id: 11, classification: 'rejected', bbox: { x: 0.5, y: 0.5, w: 0.02, h: 0.02 }, missed: false },
      { id: 12, classification: 'debris', bbox: { x: 0.6, y: 0.6, w: 0.02, h: 0.02 }, missed: false },
    ], i * 0.1);
  }
  // Duplicate timestamp frame should update in-place rather than corrupting slope
  ff.update([
    { id: 10, classification: 'drone', bbox: { x: 0.31, y: 0.3, w: 0.02, h: 0.02 }, missed: false },
  ], 1.1);

  assert.equal(ff.size, 1, 'rejected and debris tracks must not occupy forecaster slots');
  const firstRun = ff.coneFan(10);
  assert.ok(firstRun);
  assert.equal(firstRun.state.cls, 'drone');
  assert.ok(firstRun.state.vx > 0.08);

  // Stream / generation / camera switch: reset() wipes all state and restores deterministic seed
  ff.reset();
  assert.equal(ff.size, 0);
  assert.equal(ff.coneFan(10), null);

  for (let i = 0; i < 12; i++) {
    ff.update([
      { id: 10, classification: 'drone', bbox: { x: 0.2 + i * 0.01, y: 0.3, w: 0.02, h: 0.02 }, missed: false },
    ], i * 0.1);
  }
  const secondRun = ff.coneFan(10);
  assert.deepEqual(secondRun, firstRun, 'reset() must deterministically replay with no leftover state');

  // Exact stationary track produces finite zero-speed cone with no NaNs, and tolerates null options
  feedTrack(ff, 99, 'drone', Array.from({ length: 8 }, () => [0.5, 0.5]));
  const still = ff.coneFan(99, null);
  assert.ok(still);
  assert.equal(still.state.speed, 0);
  assert.deepEqual(still.horizons[30].mean, [0.5, 0.5]);
  assert.ok(Number.isFinite(still.horizons[30].spreadRad));
});

test('lightweight 120-sample UI forecaster stays fast at 48 tracks and beats straight-line Brier score', async () => {
  const { FlightForecaster, pointInPolygon } = await modulePromise;

  const perfFF = new FlightForecaster({ corridor: SURVEYED_CORRIDOR, samples: 120 });
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    perfFF.update(
      Array.from({ length: 48 }, (_, k) => ({
        id: k + 1,
        cls: k % 6 === 0 ? 'drone' : 'bird',
        x: 0.08 + k * 0.015 + i * 0.002,
        y: 0.2 + i * 0.003,
      })),
      i * 0.1,
    );
  }
  const all = perfFF.coneFanAll();
  const elapsedMs = performance.now() - t0;
  assert.equal(all.length, 48);
  assert.ok(elapsedMs < 1000, `48-track HUD cone sweep should complete rapidly (${elapsedMs.toFixed(1)} ms)`);

  // Calibration check on synthetic birds with bursty turns and speed shifts (samples=120)
  let seed = 7;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let brierMC30 = 0, brierSL30 = 0, brierMC60 = 0, brierSL60 = 0, n = 0;
  for (let b = 0; b < 200; b++) {
    let x = rng(), y = rng() * 0.5, hd = rng() * 2 * Math.PI, sp = 0.004 + rng() * 0.016, turn = 0;
    const fps = 10, hist = [], fut = [];
    for (let i = 0; i < 64 * fps; i++) {
      if (rng() < 0.01) turn = (rng() - 0.5) * 0.8;
      if (rng() < 0.004) sp *= 0.3 + rng() * 1.4;
      hd += turn / fps;
      x += (Math.cos(hd) * sp) / fps;
      y += (Math.sin(hd) * sp) / fps;
      (i < 4 * fps ? hist : fut).push([x, y]);
    }
    if (pointInPolygon(hist[hist.length - 1][0], hist[hist.length - 1][1], SURVEYED_CORRIDOR)) continue;
    const enterIdx = fut.findIndex(p => pointInPolygon(p[0], p[1], SURVEYED_CORRIDOR));
    const truth30 = enterIdx >= 0 && enterIdx / fps <= 30 ? 1 : 0;
    const truth60 = enterIdx >= 0 && enterIdx / fps <= 60 ? 1 : 0;
    const ff = new FlightForecaster({ corridor: SURVEYED_CORRIDOR, samples: 120, seed: b + 1 });
    feedTrack(ff, 1, 'bird', hist, fps);
    const f = ff.forecast(1);
    if (!f) continue;
    n++;
    const sl30 = f.straight_line_eta_sec !== null && f.straight_line_eta_sec <= 30 ? 1 : 0;
    const sl60 = f.straight_line_eta_sec !== null && f.straight_line_eta_sec <= 60 ? 1 : 0;
    brierMC30 += (f.pWithin[30] - truth30) ** 2;
    brierSL30 += (sl30 - truth30) ** 2;
    brierMC60 += (f.pWithin[60] - truth60) ** 2;
    brierSL60 += (sl60 - truth60) ** 2;
  }
  assert.ok(n > 100);
  assert.ok(brierMC30 / n < brierSL30 / n, `30s Brier ${(brierMC30 / n).toFixed(3)} should beat straight-line ${(brierSL30 / n).toFixed(3)}`);
  assert.ok(brierMC60 / n < brierSL60 / n, `60s Brier ${(brierMC60 / n).toFixed(3)} should beat straight-line ${(brierSL60 / n).toFixed(3)}`);
});
