// Browser flight-path forecaster for advisory HUD cone rendering and surveyed-corridor ETA previews.
//
// Adapts Shreyansh's Monte Carlo motion forecaster for real-time feed overlays with strict
// memory and CPU bounds (Audit Finding #33) and SkySentry's corridor safety rules:
//   - Strictly bounds tracked history per feed (`maxTracks` default 48, evicting oldest unseen
//     tracks first, plus bounded per-track sample history).
//   - Uses lightweight Monte Carlo sampling (`samples` default 120, capped at 300) for smooth UI
//     rendering, emitting curved per-horizon 10th-90th lateral fan points perpendicular to heading.
//   - Emits `pWithin`, `eta`, and `level` ONLY when a surveyed corridor polygon (>= 3 non-collinear
//     points) is configured. Browser forecasts are advisory HUD visuals only; server detection
//     remains authoritative for live tower risk and alerts.

const DEFAULT_HORIZONS = Object.freeze([15, 30, 60]);
const DEFAULT_MAX_TRACKS = 48;
const DEFAULT_SAMPLES = 120;
const MAX_SAMPLES = 300;
const MAX_HORIZON_SEC = 120;
const MAX_POINTS_PER_TRACK = 300;

export const FORECAST_DEFAULTS = Object.freeze({
  corridor: Object.freeze([]),
  horizons: DEFAULT_HORIZONS,
  samples: DEFAULT_SAMPLES,
  maxSamples: MAX_SAMPLES,
  maxTracks: DEFAULT_MAX_TRACKS,
  stepSec: 0.5,
  historySec: 4,
  minHistory: 6,
  keepSec: 10,
  staleSec: 3,
  opBufferSec: 20,
  noise: Object.freeze({
    bird: Object.freeze({ headingDeg: 7, speedFrac: 0.08, turnDegPerSec: 2.5 }),
    drone: Object.freeze({ headingDeg: 3, speedFrac: 0.05, turnDegPerSec: 1, hoverChancePerSec: 0.01 }),
    other: Object.freeze({ headingDeg: 5, speedFrac: 0.06, turnDegPerSec: 2 }),
  }),
  red: Object.freeze({ pWithin30: 0.25, dronePWithin60: 0.10 }),
  yellow: Object.freeze({ pWithin60: 0.15 }),
  seed: 12345,
});

export class FlightForecaster {
  constructor(rawCfg = {}) {
    const cfg = rawCfg || {};
    const maxTracks = cfg.maxTracks === undefined ? DEFAULT_MAX_TRACKS : cfg.maxTracks;
    if (!Number.isSafeInteger(maxTracks) || maxTracks <= 0) {
      throw new RangeError('maxTracks must be a positive integer');
    }
    const samples = normalizeSamples(cfg.samples);
    const stepSec = cfg.stepSec === undefined ? FORECAST_DEFAULTS.stepSec : cfg.stepSec;
    if (!Number.isFinite(stepSec) || stepSec <= 0 || stepSec > 5) {
      throw new RangeError('stepSec must be a positive finite number <= 5');
    }
    const horizons = normalizeHorizons(cfg.horizons ?? DEFAULT_HORIZONS);
    const noise = {
      bird: { ...FORECAST_DEFAULTS.noise.bird, ...(cfg.noise?.bird || {}) },
      drone: { ...FORECAST_DEFAULTS.noise.drone, ...(cfg.noise?.drone || {}) },
      other: { ...FORECAST_DEFAULTS.noise.other, ...(cfg.noise?.other || {}) },
    };

    this.cfg = {
      ...FORECAST_DEFAULTS,
      ...cfg,
      maxTracks,
      samples,
      stepSec,
      horizons,
      noise,
      red: { ...FORECAST_DEFAULTS.red, ...(cfg.red || {}) },
      yellow: { ...FORECAST_DEFAULTS.yellow, ...(cfg.yellow || {}) },
    };
    this.corridor = null;
    this.corridorBounds = null;
    this.surveyId = null;
    this.setCorridor(cfg.corridor, cfg);
    this.hist = new Map(); // id -> { cls, pts: [[t, x, y], ...], lastSeen }
    this.lastT = null;
    this.rand = createRng(this.cfg.seed);
  }

  get size() {
    return this.hist.size;
  }

  hasCorridor() {
    return this.corridor !== null;
  }

  setCorridor(corridor, opts = {}) {
    const resolved = resolveSurveyedCorridor(corridor, opts || {});
    this.corridor = resolved ? resolved.polygon : null;
    this.corridorBounds = resolved ? polygonBounds(resolved.polygon) : null;
    this.surveyId = resolved ? resolved.surveyId : null;
    this.cfg.corridor = this.corridor || [];
  }

  reset(opts = {}) {
    const { seed } = opts || {};
    this.hist.clear();
    this.lastT = null;
    if (seed !== undefined && Number.isFinite(seed)) this.cfg.seed = seed;
    this.rand = createRng(this.cfg.seed);
  }

  update(tracks, t) {
    if (!Array.isArray(tracks) || !Number.isFinite(t)) return;
    if (this.lastT !== null && t < this.lastT - 0.5) {
      this.hist.clear();
      this.lastT = t;
    } else {
      this.lastT = this.lastT === null ? t : Math.max(this.lastT, t);
    }

    const parsed = [];
    const seenInBatch = new Set();
    for (const tr of tracks) {
      if (!tr || !validTrackId(tr.id) || seenInBatch.has(tr.id)) continue;
      seenInBatch.add(tr.id);
      const rawCls = tr.cls ?? tr.classification;
      if (rawCls === 'rejected' || rawCls === 'debris') {
        this.hist.delete(tr.id);
        continue;
      }
      if (tr.missed === true) continue;
      const pt = extractPoint(tr);
      if (!pt) continue;
      parsed.push({ id: tr.id, rawCls, x: pt[0], y: pt[1] });
    }

    const incomingIds = new Set(parsed.map(item => item.id));
    for (const [id, h] of this.hist) {
      if (!incomingIds.has(id) && t - h.lastSeen > this.cfg.staleSec) {
        this.hist.delete(id);
      }
    }

    const activeNow = new Set();
    const newcomers = [];
    for (const item of parsed) {
      const existing = this.hist.get(item.id);
      if (existing) {
        appendTrackPoint(existing, item.rawCls, t, item.x, item.y, this.cfg.keepSec);
        activeNow.add(item.id);
      } else {
        newcomers.push(item);
      }
    }

    for (const item of newcomers) {
      if (this.hist.size >= this.cfg.maxTracks) {
        const victimId = oldestUnseenId(this.hist, activeNow);
        if (victimId === undefined) continue;
        this.hist.delete(victimId);
      }
      const entry = { cls: normalizeClass(item.rawCls, null), pts: [[t, item.x, item.y]], lastSeen: t };
      this.hist.set(item.id, entry);
      activeNow.add(item.id);
    }
  }

  // Least-squares motion fit over recent historySec: position, velocity, speed, heading, turn rate.
  fit(id) {
    const h = this.hist.get(id);
    if (!h || h.pts.length < this.cfg.minHistory) return null;
    const tEnd = h.pts[h.pts.length - 1][0];
    const p = h.pts.filter(q => tEnd - q[0] <= this.cfg.historySec);
    if (p.length < this.cfg.minHistory) return null;

    const vx = slopePts(p, 1);
    const vy = slopePts(p, 2);
    const hs = [];
    const ts = [];
    for (let i = 2; i < p.length; i += 2) {
      const dx = p[i][1] - p[i - 2][1];
      const dy = p[i][2] - p[i - 2][2];
      if (Math.hypot(dx, dy) > 1e-4) {
        hs.push(Math.atan2(dy, dx));
        ts.push(p[i][0]);
      }
    }
    for (let i = 1; i < hs.length; i++) {
      while (hs[i] - hs[i - 1] > Math.PI) hs[i] -= 2 * Math.PI;
      while (hs[i] - hs[i - 1] < -Math.PI) hs[i] += 2 * Math.PI;
    }
    const turn = hs.length >= 3 ? clamp(slopeArrays(ts, hs), -0.6, 0.6) : 0;
    const last = p[p.length - 1];
    return {
      x: last[1],
      y: last[2],
      vx,
      vy,
      speed: Math.hypot(vx, vy),
      heading: Math.atan2(vy, vx),
      turn,
      cls: h.cls,
    };
  }

  coneFan(id, rawOpts = {}) {
    const { horizons = this.cfg.horizons, samples, operations } = rawOpts || {};
    return this.forecast(id, { horizons, samples, operations });
  }

  forecast(id, rawOpts = {}) {
    const { horizons = this.cfg.horizons, samples, operations = [] } = rawOpts || {};
    const c = this.cfg;
    const state = this.fit(id);
    if (!state) return null;

    const hs = normalizeHorizons(horizons);
    const sampleCount = samples === undefined ? c.samples : normalizeSamples(samples);
    const kind = state.cls;
    const nz = c.noise[kind] || c.noise.other;
    const poly = this.corridor;
    const bounds = this.corridorBounds;

    const stepSec = c.stepSec;
    const maxRequestedH = hs[hs.length - 1];
    const simMaxT = poly ? Math.max(maxRequestedH, 60) : maxRequestedH;
    const steps = Math.max(1, Math.round(simMaxT / stepSec));
    const sq = Math.sqrt(stepSec);

    const stepBuckets = new Map();
    const horizonData = new Map();
    for (const H of hs) {
      const k = Math.max(1, Math.round(H / stepSec));
      const bucket = {
        H,
        xs: new Float64Array(sampleCount),
        ys: new Float64Array(sampleCount),
        hds: new Float64Array(sampleCount),
      };
      horizonData.set(H, bucket);
      const list = stepBuckets.get(k);
      if (list) list.push(bucket);
      else stepBuckets.set(k, [bucket]);
    }

    const inside0 = poly ? inCorridor(state.x, state.y, poly, bounds) : false;
    const entry = poly ? new Float64Array(sampleCount) : null;
    const hoverChance = kind === 'drone' ? (nz.hoverChancePerSec || 0) * stepSec : 0;
    const turnInitScale = deg(nz.turnDegPerSec) * 0.5;
    const turnStepScale = deg(nz.turnDegPerSec) * sq * 0.3;
    const hdStepScale = deg(nz.headingDeg) * sq;
    const spStepScale = nz.speedFrac * sq;
    const rng = this.rand;

    for (let s = 0; s < sampleCount; s++) {
      let x = state.x;
      let y = state.y;
      let hd = state.heading;
      let sp = state.speed;
      let om = state.turn + rng.gauss() * turnInitScale;
      let hovering = false;
      let entered = inside0 ? 0 : -1;

      for (let k = 1; k <= steps; k++) {
        if (hoverChance > 0 && !hovering && rng.next() < hoverChance) hovering = true;
        om += rng.gauss() * turnStepScale;
        hd += om * stepSec + rng.gauss() * hdStepScale;
        sp = Math.max(0, sp * (1 + rng.gauss() * spStepScale));
        if (!hovering) {
          x += Math.cos(hd) * sp * stepSec;
          y += Math.sin(hd) * sp * stepSec;
        }
        if (poly && entered < 0 && inCorridor(x, y, poly, bounds)) {
          entered = k * stepSec;
        }
        const buckets = stepBuckets.get(k);
        if (buckets) {
          for (let b = 0; b < buckets.length; b++) {
            const target = buckets[b];
            target.xs[s] = x;
            target.ys[s] = y;
            target.hds[s] = hd;
          }
        }
      }
      if (entry) entry[s] = entered;
    }

    const horizonsOut = {};
    const fan = [];
    const positions = {};
    const pWithin = poly ? {} : undefined;

    for (const H of hs) {
      const bucket = horizonData.get(H);
      const localHeading = wrapPi(state.heading + state.turn * H);
      const geom = computeHorizonGeometry(bucket, sampleCount, localHeading);
      positions[H] = {
        x: round(geom.medianX, 3),
        y: round(geom.medianY, 3),
        x_range: [round(geom.p10[0], 3), round(geom.p90[0], 3)],
        y_range: [round(geom.p10[1], 3), round(geom.p90[1], 3)],
      };

      const slice = {
        mean: geom.mean,
        p10: geom.p10,
        p90: geom.p90,
        spreadRad: geom.spreadRad,
        lateralLeft: geom.lateralLeft,
        lateralRight: geom.lateralRight,
        heading: localHeading,
      };
      if (poly) {
        const prob = round(fractionEnteredBy(entry, sampleCount, H), 3);
        pWithin[H] = prob;
        slice.pWithin = prob;
      }
      horizonsOut[H] = slice;
      fan.push({ horizonSec: H, ...slice });
    }

    const out = {
      id,
      cls: kind,
      advisory: true,
      corridorSurveyed: Boolean(poly),
      state,
      now: {
        x: state.x,
        y: state.y,
        speed_per_s: state.speed,
        heading_deg: round((state.heading * 180) / Math.PI),
        turn_deg_per_s: round((state.turn * 180) / Math.PI),
      },
      horizons: horizonsOut,
      fan,
      positions,
      samples: sampleCount,
    };

    if (!poly) return out;

    const hits = [];
    for (let s = 0; s < sampleCount; s++) {
      if (entry[s] >= 0) hits.push(entry[s]);
    }
    hits.sort((a, b) => a - b);

    const rawEta = hits.length
      ? { p10: quantile(hits, 0.1), p50: quantile(hits, 0.5), p90: quantile(hits, 0.9) }
      : null;
    const eta = rawEta
      ? { p10: round(rawEta.p10, 1), p50: round(rawEta.p50, 1), p90: round(rawEta.p90, 1) }
      : null;
    const straight = inside0 ? 0 : straightEta(state, poly, bounds, simMaxT);

    const p30 = fractionEnteredBy(entry, sampleCount, 30);
    const p60 = fractionEnteredBy(entry, sampleCount, 60);
    let level = 'green';
    let reason = 'unlikely to reach the corridor within 60 s';
    if (inside0) {
      level = 'red';
      reason = `${kind} is in the corridor now`;
    } else if (p30 >= c.red.pWithin30) {
      level = 'red';
      reason = `${pctStr(p30)} chance ${kind} enters the corridor within 30 s`;
    } else if (kind === 'drone' && p60 >= c.red.dronePWithin60) {
      level = 'red';
      reason = `${pctStr(p60)} chance drone enters the corridor within 60 s`;
    } else if (p60 >= c.yellow.pWithin60) {
      level = 'yellow';
      reason = `${pctStr(p60)} chance ${kind} enters the corridor within 60 s`;
    }

    const clashes = [];
    if ((rawEta || inside0) && Array.isArray(operations) && operations.length) {
      const lo = inside0 ? 0 : rawEta.p10;
      const hi = inside0 ? c.opBufferSec : rawEta.p90;
      for (const op of operations) {
        if (!op || !Number.isFinite(op.inSec)) continue;
        if (op.inSec >= lo - c.opBufferSec && op.inSec <= hi + c.opBufferSec &&
            (inside0 || p60 >= c.yellow.pWithin60)) {
          clashes.push({
            ...op,
            message: `${op.kind || 'operation'} in ${Math.round(op.inSec)} s may meet this ${kind} (likely in corridor ${Math.round(lo)}-${Math.round(hi)} s)`,
          });
        }
      }
      if (clashes.length && level === 'yellow') {
        level = 'red';
        reason += `; clashes with a scheduled ${clashes[0].kind || 'operation'}`;
      }
    }

    out.level = level;
    out.reason = reason;
    out.pWithin = pWithin;
    out.p_enter = Object.fromEntries(hs.map(H => [`within_${H}s`, pWithin[H]]));
    out.eta = eta;
    out.eta_sec = rawEta
      ? { p10: round(rawEta.p10), p50: round(rawEta.p50), p90: round(rawEta.p90) }
      : null;
    out.straight_line_eta_sec = straight === null ? null : round(straight);
    out.clashes = clashes;
    if (this.surveyId) out.surveyId = this.surveyId;
    return out;
  }

  forecastAll(opts = {}) {
    return [...this.hist.keys()]
      .map(id => this.forecast(id, opts))
      .filter(Boolean)
      .sort((a, b) => rankForecast(b) - rankForecast(a));
  }

  coneFanAll(opts = {}) {
    return this.forecastAll(opts);
  }
}

export function createFlightForecaster(cfg = {}) {
  return new FlightForecaster(cfg);
}

export function validCorridorPolygon(poly) {
  if (!Array.isArray(poly) || poly.length < 3 || poly.length > 256) return false;
  for (let i = 0; i < poly.length; i++) {
    const pt = poly[i];
    if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1]) ||
        pt[0] < 0 || pt[0] > 1 || pt[1] < 0 || pt[1] > 1) {
      return false;
    }
  }
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    area2 += x1 * y2 - y1 * x2;
  }
  return Math.abs(area2) > 1e-8;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function resolveSurveyedCorridor(corridor, opts = {}) {
  if (!corridor) return null;
  if (Array.isArray(corridor)) {
    if (opts.demo === true || opts.surveyed === false) return null;
    if ('surveyId' in opts && opts.surveyId !== undefined) {
      if (typeof opts.surveyId !== 'string' || !opts.surveyId.trim()) return null;
    }
    if (!validCorridorPolygon(corridor)) return null;
    return {
      polygon: corridor.map(([x, y]) => [x, y]),
      surveyId: typeof opts.surveyId === 'string' && opts.surveyId.trim() ? opts.surveyId.trim() : null,
    };
  }
  if (typeof corridor === 'object') {
    if (corridor.demo === true || corridor.surveyed === false || opts.demo === true || opts.surveyed === false) {
      return null;
    }
    const rawPoly = corridor.polygon ?? corridor.corridor;
    const surveyId = corridor.surveyId ?? opts.surveyId;
    const surveyed = corridor.surveyed === true || (typeof surveyId === 'string' && surveyId.trim().length > 0);
    if (!surveyed || !validCorridorPolygon(rawPoly)) return null;
    return {
      polygon: rawPoly.map(([x, y]) => [x, y]),
      surveyId: typeof surveyId === 'string' && surveyId.trim() ? surveyId.trim() : null,
    };
  }
  return null;
}

function polygonBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x, y] = poly[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function inCorridor(x, y, poly, bounds) {
  if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return false;
  return pointInPolygon(x, y, poly);
}

function normalizeSamples(value) {
  if (value === undefined) return DEFAULT_SAMPLES;
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError('samples must be a positive finite number');
  }
  return Math.min(MAX_SAMPLES, Math.max(1, Math.round(value)));
}

function normalizeHorizons(horizons) {
  if (!Array.isArray(horizons) || horizons.length === 0) {
    throw new RangeError('horizons must be a non-empty array of positive finite seconds');
  }
  const unique = new Set();
  for (const h of horizons) {
    if (!Number.isFinite(h) || h <= 0) {
      throw new RangeError('horizons must contain positive finite seconds');
    }
    unique.add(Math.min(MAX_HORIZON_SEC, h));
  }
  return [...unique].sort((a, b) => a - b);
}

function validTrackId(id) {
  return (typeof id === 'number' && Number.isFinite(id)) ||
    (typeof id === 'string' && id.length > 0);
}

function extractPoint(tr) {
  if (Number.isFinite(tr.x) && Number.isFinite(tr.y)) {
    return [tr.x, tr.y];
  }
  const b = tr.bbox;
  if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)) {
    return [b.x + b.w * 0.5, b.y + b.h * 0.5];
  }
  return null;
}

function normalizeClass(rawCls, prevCls) {
  if (rawCls === 'drone' || rawCls === 'bird') return rawCls;
  if (typeof rawCls === 'string' && rawCls.length > 0) return 'other';
  return prevCls || 'other';
}

function appendTrackPoint(entry, rawCls, t, x, y, keepSec) {
  entry.cls = normalizeClass(rawCls, entry.cls);
  const pts = entry.pts;
  if (pts.length) {
    const lastT = pts[pts.length - 1][0];
    if (t < lastT) return;
    if (t === lastT) {
      pts[pts.length - 1] = [t, x, y];
      entry.lastSeen = t;
      return;
    }
  }
  pts.push([t, x, y]);
  entry.lastSeen = t;
  while (pts.length && t - pts[0][0] > keepSec) pts.shift();
  while (pts.length > MAX_POINTS_PER_TRACK) pts.shift();
}

function oldestUnseenId(hist, activeNow) {
  let victimId;
  let oldestSeen = Infinity;
  for (const [id, entry] of hist) {
    if (activeNow.has(id)) continue;
    if (entry.lastSeen < oldestSeen) {
      oldestSeen = entry.lastSeen;
      victimId = id;
    }
  }
  return victimId;
}

function computeHorizonGeometry(bucket, n, localHeading) {
  const { xs, ys, hds } = bucket;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const mx = sumX / n;
  const my = sumY / n;

  // Screen/image coordinates (+x right, +y down): right-perpendicular normal to heading is [-sin, cos].
  // Negative projection lies to port (lateralLeft); positive projection lies to starboard (lateralRight).
  const nx = -Math.sin(localHeading);
  const ny = Math.cos(localHeading);
  const lateral = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lateral[i] = (xs[i] - mx) * nx + (ys[i] - my) * ny;
  }

  const sortedX = Float64Array.from(xs).sort();
  const sortedY = Float64Array.from(ys).sort();
  const sortedHd = Float64Array.from(hds).sort();
  lateral.sort();

  const lat10 = quantile(lateral, 0.1);
  const lat90 = quantile(lateral, 0.9);
  const spreadRad = clamp(quantile(sortedHd, 0.9) - quantile(sortedHd, 0.1), 0, Math.PI * 2);

  return {
    mean: [mx, my],
    medianX: quantile(sortedX, 0.5),
    medianY: quantile(sortedY, 0.5),
    p10: [quantile(sortedX, 0.1), quantile(sortedY, 0.1)],
    p90: [quantile(sortedX, 0.9), quantile(sortedY, 0.9)],
    spreadRad,
    lateralLeft: [mx + nx * lat10, my + ny * lat10],
    lateralRight: [mx + nx * lat90, my + ny * lat90],
  };
}

function fractionEnteredBy(entry, n, horizonSec) {
  let count = 0;
  for (let i = 0; i < n; i++) {
    const e = entry[i];
    if (e >= 0 && e <= horizonSec + 1e-9) count++;
  }
  return count / n;
}

function straightEta(state, poly, bounds, maxT) {
  for (let t = 0.25; t <= maxT; t += 0.25) {
    if (inCorridor(state.x + state.vx * t, state.y + state.vy * t, poly, bounds)) return t;
  }
  return null;
}

function rankForecast(f) {
  if (f.corridorSurveyed) {
    const levelScore = ({ red: 2, yellow: 1, green: 0 })[f.level] ?? 0;
    const probs = Object.values(f.pWithin || {});
    const maxP = probs.length ? Math.max(...probs) : 0;
    return levelScore * 10 + maxP;
  }
  const classScore = f.cls === 'drone' ? 2 : f.cls === 'bird' ? 1 : 0;
  return classScore * 10 + Math.min(9, f.state.speed);
}

function slopePts(pts, coordIdx) {
  const n = pts.length;
  let mt = 0;
  let mv = 0;
  for (let i = 0; i < n; i++) {
    mt += pts[i][0];
    mv += pts[i][coordIdx];
  }
  mt /= n;
  mv /= n;
  let stv = 0;
  let stt = 0;
  for (let i = 0; i < n; i++) {
    const dt = pts[i][0] - mt;
    stv += dt * (pts[i][coordIdx] - mv);
    stt += dt * dt;
  }
  return stt > 0 ? stv / stt : 0;
}

function slopeArrays(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxy += dx * (ys[i] - my);
    sxx += dx * dx;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function wrapPi(a) {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

function deg(d) {
  return (d * Math.PI) / 180;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function round(v, d = 1) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function pctStr(p) {
  return `${Math.round(p * 100)}%`;
}

function createRng(seed) {
  let a = seed | 0;
  let hasSpare = false;
  let spare = 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }
    let u = 0;
    while (u === 0) u = next();
    const mag = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * next();
    spare = mag * Math.sin(angle);
    hasSpare = true;
    return mag * Math.cos(angle);
  };
  return { next, gauss };
}
