// Checks for flight_forecast.js:  node test_flight_forecast.mjs
// 1. Scenario checks (straight in, flying away, circling, hovering drone, drone heading in, clash with a takeoff).
// 2. Honest comparison against the straight-line ETA on 300 synthetic birds whose real future paths turn
//    and change speed in a DIFFERENT way from the forecaster's own model (piecewise turns, pauses), so the
//    test does not just grade the model against itself. Scored with the Brier score (lower is better) for
//    "enters the corridor within 30 s / 60 s". Synthetic only: real airport tracks are needed to validate it.
import { FlightForecaster, pointInPolygon } from './flight_forecast.js';

const corridor = [[0.35, 0.55], [0.65, 0.55], [0.65, 0.75], [0.35, 0.75]];
let failures = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); if (!ok) failures++; };

function feed(ff, id, cls, path, fps = 10) {
  for (let i = 0; i < path.length; i++) ff.update([{ id, cls, x: path[i][0], y: path[i][1] }], i / fps);
}
function line(x, y, vx, vy, sec, fps = 10) { return Array.from({ length: sec * fps }, (_, i) => [x + vx * i / fps, y + vy * i / fps]); }

// 1. Scenarios -------------------------------------------------------------------------------------
{
  const ff = new FlightForecaster({ corridor });
  feed(ff, 1, 'bird', line(0.05, 0.65, 0.015, 0, 4));   // heading straight in, ~20 s out
  const f = ff.forecast(1);
  check('bird straight toward corridor -> likely within 30 s', f.p_enter.within_30s > 0.5, JSON.stringify({ p: f.p_enter, eta: f.eta_sec, straight: f.straight_line_eta_sec, level: f.level }));
}
{
  const ff = new FlightForecaster({ corridor });
  feed(ff, 2, 'bird', line(0.2, 0.3, -0.01, -0.005, 4));  // flying away
  const f = ff.forecast(2);
  check('bird flying away -> green', f.level === 'green' && f.p_enter.within_60s < 0.1, JSON.stringify({ p: f.p_enter, level: f.level }));
}
{
  const ff = new FlightForecaster({ corridor });
  const path = Array.from({ length: 40 }, (_, i) => { const a = i / 10 * 0.5; return [0.5 + 0.12 * Math.cos(a), 0.35 + 0.12 * Math.sin(a)]; });
  feed(ff, 3, 'bird', path);                              // circling just above the corridor
  const f = ff.forecast(3);
  check('bird circling near corridor -> some chance, straight line says no or late', f.p_enter.within_60s > 0.15, JSON.stringify({ p: f.p_enter, turn: f.now.turn_deg_per_s, straight: f.straight_line_eta_sec, level: f.level }));
}
{
  const ff = new FlightForecaster({ corridor });
  feed(ff, 4, 'drone', line(0.15, 0.2, 0, 0, 4).map(([x, y], i) => [x + 0.0005 * Math.sin(i), y]));  // hovering
  const f = ff.forecast(4);
  check('hovering drone far from corridor -> not red', f.level !== 'red', JSON.stringify({ p: f.p_enter, level: f.level }));
}
{
  const ff = new FlightForecaster({ corridor });
  feed(ff, 5, 'drone', line(0.9, 0.2, -0.008, 0.008, 4));  // drone drifting toward the corridor, ~45 s
  const f = ff.forecast(5);
  check('drone heading in within 60 s -> red', f.level === 'red', JSON.stringify({ p: f.p_enter, eta: f.eta_sec, level: f.level, reason: f.reason }));
}
{
  const ff = new FlightForecaster({ corridor });
  feed(ff, 6, 'bird', line(0.05, 0.65, 0.008, 0, 4));    // reaches corridor in ~35-40 s
  const f = ff.forecast(6, { operations: [{ kind: 'departure', runway: '27L', inSec: 45 }] });
  check('bird reaching corridor around a scheduled departure -> clash flagged', f.clashes.length > 0 && f.level === 'red', JSON.stringify({ eta: f.eta_sec, clashes: f.clashes.map(c => c.message), level: f.level }));
}
{
  const ff = new FlightForecaster({ corridor, samples: 300 });
  const ids = 60;
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) ff.update(Array.from({ length: ids }, (_, k) => ({ id: k, cls: 'bird', x: 0.1 + k * 0.01 + i * 0.001, y: 0.2 + 0.002 * i })), i / 10);
  const all = ff.forecastAll();
  const ms = performance.now() - t0;
  check('60-bird flock forecast is fast enough to run every second', ms < 3000 && all.length === ids, `${ms.toFixed(0)} ms for ${ids} birds`);
}

// 2. Synthetic comparison vs straight line ------------------------------------------------------
function rng(seed) { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(7);
let brierMC = { 30: 0, 60: 0 }, brierSL = { 30: 0, 60: 0 }, n = 0, positives = { 30: 0, 60: 0 };
for (let b = 0; b < 300; b++) {
  // a "real" bird: speed 0.004-0.02 /s, starts somewhere around the corridor, turns in bursts, sometimes pauses
  let x = r(), y = r() * 0.5, hd = r() * 2 * Math.PI, sp = 0.004 + r() * 0.016, turn = 0;
  const fps = 10, hist = [], fut = [];
  for (let i = 0; i < 64 * fps; i++) {
    if (r() < 0.01) turn = (r() - 0.5) * 0.8;            // start / stop a turn (rad/s)
    if (r() < 0.004) sp *= 0.3 + r() * 1.4;              // speed changes
    hd += turn / fps; x += Math.cos(hd) * sp / fps; y += Math.sin(hd) * sp / fps;
    (i < 4 * fps ? hist : fut).push([x, y]);
  }
  if (pointInPolygon(...hist[hist.length - 1], corridor)) continue;
  const enterAt = fut.findIndex(p => pointInPolygon(p[0], p[1], corridor));
  const truth = { 30: enterAt >= 0 && enterAt / fps <= 30, 60: enterAt >= 0 && enterAt / fps <= 60 };
  const ff = new FlightForecaster({ corridor, samples: 200, seed: b + 1 });
  feed(ff, 1, 'bird', hist);
  const f = ff.forecast(1);
  if (!f) continue;
  n++;
  for (const H of [30, 60]) {
    const p = f.p_enter[`within_${H}s`];
    const sl = f.straight_line_eta_sec !== null && f.straight_line_eta_sec <= H ? 1 : 0;
    brierMC[H] += (p - truth[H]) ** 2; brierSL[H] += (sl - truth[H]) ** 2; positives[H] += truth[H];
  }
}
for (const H of [30, 60]) {
  const mc = brierMC[H] / n, sl = brierSL[H] / n;
  check(`synthetic birds, within ${H} s: forecaster beats straight line`, mc < sl,
    `Brier ${mc.toFixed(3)} vs straight line ${sl.toFixed(3)} (lower is better; ${positives[H]} of ${n} birds really entered)`);
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
