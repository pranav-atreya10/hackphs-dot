// Flight-path forecaster: will this bird or drone get into the runway corridor in the next 30-60 s,
// and would that clash with a takeoff or landing?
//
// Vivan's engine already gives each track a straight-line ETA to the corridor (VIVAN/detection/src/
// engine.js, geometry.js etaToPolygon, 60 s horizon). A straight line is a poor guess 30-60 s ahead,
// because birds turn, circle and change speed, and drones stop and hover. This module instead:
//   1. fits each track's recent motion: position, speed, heading and how fast the heading is turning;
//   2. simulates N possible futures (default 300) with realistic randomness for that kind of object:
//      birds wander in heading and speed, drones hold course but may stop and hover or turn sharply;
//   3. reports, out of those futures, the chance it enters the corridor within 30 s and within 60 s,
//      when (10th / 50th / 90th percentile), and where it is likely to be at 30 s and 60 s;
//   4. optionally compares that time window with the tower's scheduled departures / arrivals.
//
// Positions are in the camera image, normalised 0..1 (like the engine's tracks and corridor polygon).
// LIMIT: one camera knows direction, not distance. "Enters the corridor" means "enters the corridor
// as drawn on this camera's view". A bird far behind the runway can look like it is in it. Two or
// more cameras, or known heights, are needed to be sure (see HANDOFF.md).
//
// Usage:
//   import { FlightForecaster } from './flight_forecast.js';
//   const ff = new FlightForecaster({ corridor: [[0.3,0.6],[0.7,0.6],[0.7,0.8],[0.3,0.8]] });
//   every frame: ff.update(state.tracks.map(t => ({ id: t.id, cls: t.classification, x: t.x, y: t.y })), timeSec);
//   const f = ff.forecast(trackId, { operations: [{ kind: 'departure', inSec: 40 }] });

const DEFAULTS = {
  corridor: [],            // normalised polygon [[x,y],...], as drawn in the engine
  horizons: [30, 60],      // seconds ahead to report
  samples: 300,            // simulated futures per track
  stepSec: 0.5,            // simulation step
  historySec: 4,           // how much recent track history the motion fit uses
  minHistory: 6,           // points needed before forecasting
  keepSec: 10,             // history kept per track
  opBufferSec: 20,         // an operation within +-20 s of the likely corridor time counts as a clash
  // randomness per class (per sqrt(second)); birds are much less predictable than drones
  noise: {
    bird:  { headingDeg: 7, speedFrac: 0.08, turnDegPerSec: 2.5 },
    drone: { headingDeg: 3, speedFrac: 0.05, turnDegPerSec: 1, hoverChancePerSec: 0.01 },
    other: { headingDeg: 5, speedFrac: 0.06, turnDegPerSec: 2 },
  },
  red: { pWithin30: 0.25, dronePWithin60: 0.10 },
  yellow: { pWithin60: 0.15 },
  seed: 12345,
};

export class FlightForecaster {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg, noise: { ...DEFAULTS.noise, ...(cfg.noise || {}) } };
    this.hist = new Map(); // id -> { cls, pts: [[t,x,y], ...] }
    this.rand = mulberry32(this.cfg.seed);
  }

  setCorridor(poly) { this.cfg.corridor = poly || []; }

  update(tracks, t) {
    const seen = new Set();
    for (const tr of tracks) {
      if (!Number.isFinite(tr.x) || !Number.isFinite(tr.y)) continue;
      seen.add(tr.id);
      const h = this.hist.get(tr.id) || { cls: tr.cls, pts: [] };
      h.cls = tr.cls || h.cls;
      h.pts.push([t, tr.x, tr.y]);
      while (h.pts.length && t - h.pts[0][0] > this.cfg.keepSec) h.pts.shift();
      this.hist.set(tr.id, h);
    }
    for (const [id, h] of this.hist) if (!seen.has(id) && t - h.pts[h.pts.length - 1][0] > 3) this.hist.delete(id);
  }

  // Motion fit over the last historySec: velocity (least squares), speed, heading and turn rate.
  fit(id) {
    const h = this.hist.get(id);
    if (!h || h.pts.length < this.cfg.minHistory) return null;
    const tEnd = h.pts[h.pts.length - 1][0];
    const p = h.pts.filter(q => tEnd - q[0] <= this.cfg.historySec);
    if (p.length < this.cfg.minHistory) return null;
    const vx = slope(p.map(q => q[0]), p.map(q => q[1]));
    const vy = slope(p.map(q => q[0]), p.map(q => q[2]));
    // heading over time from successive steps, unwrapped, to get a turn rate
    const hs = [], ts = [];
    for (let i = 2; i < p.length; i += 2) {
      const dx = p[i][1] - p[i - 2][1], dy = p[i][2] - p[i - 2][2];
      if (Math.hypot(dx, dy) > 1e-4) { hs.push(Math.atan2(dy, dx)); ts.push(p[i][0]); }
    }
    for (let i = 1; i < hs.length; i++) {
      while (hs[i] - hs[i - 1] > Math.PI) hs[i] -= 2 * Math.PI;
      while (hs[i] - hs[i - 1] < -Math.PI) hs[i] += 2 * Math.PI;
    }
    const turn = hs.length >= 3 ? clamp(slope(ts, hs), -0.6, 0.6) : 0; // rad/s, capped (~35 deg/s)
    const last = p[p.length - 1];
    return { cls: h.cls, x: last[1], y: last[2], vx, vy, speed: Math.hypot(vx, vy), heading: Math.atan2(vy, vx), turn, n: p.length };
  }

  forecast(id, { operations = [] } = {}) {
    const c = this.cfg, m = this.fit(id);
    if (!m) return null;
    const kind = m.cls === 'drone' ? 'drone' : m.cls === 'bird' ? 'bird' : 'other';
    const nz = c.noise[kind];
    const poly = c.corridor && c.corridor.length >= 3 ? c.corridor : null;
    const maxT = Math.max(...c.horizons);
    const steps = Math.round(maxT / c.stepSec);
    const sq = Math.sqrt(c.stepSec);
    const entry = [];
    const at = Object.fromEntries(c.horizons.map(H => [H, []]));
    const inside0 = poly ? pointInPolygon(m.x, m.y, poly) : false;
    for (let s = 0; s < c.samples; s++) {
      let x = m.x, y = m.y, hd = m.heading, sp = m.speed, om = m.turn + gauss(this.rand) * deg(nz.turnDegPerSec) * 0.5;
      let hovering = false, entered = inside0 ? 0 : null;
      for (let k = 1; k <= steps; k++) {
        const t = k * c.stepSec;
        if (kind === 'drone' && !hovering && this.rand() < (nz.hoverChancePerSec || 0) * c.stepSec) hovering = true;
        om += gauss(this.rand) * deg(nz.turnDegPerSec) * sq * 0.3;
        hd += om * c.stepSec + gauss(this.rand) * deg(nz.headingDeg) * sq;
        sp = Math.max(0, sp * (1 + gauss(this.rand) * nz.speedFrac * sq));
        if (!hovering) { x += Math.cos(hd) * sp * c.stepSec; y += Math.sin(hd) * sp * c.stepSec; }
        if (poly && entered === null && pointInPolygon(x, y, poly)) entered = t;
        if (at[t]) at[t].push([x, y]);
      }
      entry.push(entered);
    }
    const hits = entry.filter(e => e !== null).sort((a, b) => a - b);
    const pWithin = Object.fromEntries(c.horizons.map(H => [H, entry.filter(e => e !== null && e <= H).length / c.samples]));
    const eta = hits.length ? { p10: pct(hits, 0.1), p50: pct(hits, 0.5), p90: pct(hits, 0.9) } : null;
    const positions = Object.fromEntries(c.horizons.map(H => [H, summarise(at[H])]));
    // straight-line ETA, the same idea as the engine's, for comparison
    const straight = poly && !inside0 ? straightEta(m, poly, maxT) : inside0 ? 0 : null;

    let level = 'green', reason = poly ? 'unlikely to reach the corridor within 60 s' : 'no corridor drawn';
    const p30 = pWithin[30] ?? 0, p60 = pWithin[60] ?? pWithin[maxT] ?? 0;
    if (inside0) { level = 'red'; reason = `${kind} is in the corridor now`; }
    else if (p30 >= c.red.pWithin30) { level = 'red'; reason = `${pctStr(p30)} chance ${kind} enters the corridor within 30 s`; }
    else if (kind === 'drone' && p60 >= c.red.dronePWithin60) { level = 'red'; reason = `${pctStr(p60)} chance drone enters the corridor within 60 s`; }
    else if (p60 >= c.yellow.pWithin60) { level = 'yellow'; reason = `${pctStr(p60)} chance ${kind} enters the corridor within 60 s`; }

    // Clash with scheduled operations: an operation inside the likely corridor-time window (+- buffer).
    const clashes = [];
    if (eta || inside0) {
      const lo = inside0 ? 0 : eta.p10, hi = inside0 ? c.opBufferSec : eta.p90;
      for (const op of operations) {
        if (op.inSec >= lo - c.opBufferSec && op.inSec <= hi + c.opBufferSec && (inside0 || p60 >= c.yellow.pWithin60)) {
          clashes.push({ ...op, message: `${op.kind || 'operation'} in ${Math.round(op.inSec)} s may meet this ${kind} (likely in corridor ${Math.round(lo)}-${Math.round(hi)} s)` });
        }
      }
      if (clashes.length && level === 'yellow') { level = 'red'; reason += '; clashes with a scheduled ' + clashes[0].kind; }
    }
    return {
      id, cls: kind, level, reason,
      now: { x: m.x, y: m.y, speed_per_s: m.speed, heading_deg: round(m.heading * 180 / Math.PI), turn_deg_per_s: round(m.turn * 180 / Math.PI) },
      p_enter: Object.fromEntries(Object.entries(pWithin).map(([k, v]) => [`within_${k}s`, round(v, 3)])),
      eta_sec: eta && { p10: round(eta.p10), p50: round(eta.p50), p90: round(eta.p90) },
      straight_line_eta_sec: straight === null ? null : round(straight),
      positions, clashes, samples: c.samples,
    };
  }

  forecastAll(opts) {
    return [...this.hist.keys()].map(id => this.forecast(id, opts)).filter(Boolean)
      .sort((a, b) => rank(b) - rank(a));
  }
}

function rank(f) { return ({ red: 2, yellow: 1, green: 0 })[f.level] * 10 + (f.p_enter.within_60s || 0); }
function slope(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : 0;
}
function summarise(pts) {
  if (!pts || !pts.length) return null;
  const xs = pts.map(p => p[0]).sort((a, b) => a - b), ys = pts.map(p => p[1]).sort((a, b) => a - b);
  return { x: round(pct(xs, 0.5), 3), y: round(pct(ys, 0.5), 3), x_range: [round(pct(xs, 0.1), 3), round(pct(xs, 0.9), 3)], y_range: [round(pct(ys, 0.1), 3), round(pct(ys, 0.9), 3)] };
}
function straightEta(m, poly, maxT) {
  for (let t = 0.25; t <= maxT; t += 0.25) if (pointInPolygon(m.x + m.vx * t, m.y + m.vy * t, poly)) return t;
  return null;
}
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function pct(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]; }
function deg(d) { return (d * Math.PI) / 180; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function round(v, d = 1) { return Math.round(v * 10 ** d) / 10 ** d; }
function pctStr(p) { return `${Math.round(p * 100)}%`; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
