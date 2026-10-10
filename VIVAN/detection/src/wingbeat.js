// Wingbeat detection: birds flap at a steady rhythm, so their blob size pulses.
// Drones, planes and gliders hold a steady size; bags and debris change size randomly.
//
// For each track we look at the last ~1.5 s of three size signals (contrast mass,
// pixel area, long-axis length), resample them onto an even time grid (frame
// rates wobble), remove the slow trend, and use autocorrelation to find the
// strongest repeating period between 2 and 12 Hz.

export function analyzeWingbeat(samples, cfg) {
  const { t } = samples;
  const n0 = t.length;
  const none = { kind: 'insufficient', hz: null, strength: 0, cv: null, signal: null, series: null, fs: null };
  if (n0 < cfg.minSamples) return none;

  const tEnd = t[n0 - 1];
  let first = n0 - 1;
  while (first > 0 && tEnd - t[first - 1] <= cfg.windowSec) first--;
  const n = n0 - first;
  const duration = tEnd - t[first];
  if (n < cfg.minSamples || duration < cfg.minDurationSec) return none;

  let meanArea = 0;
  for (let i = first; i < n0; i++) meanArea += samples.area[i];
  meanArea /= n;
  if (meanArea < cfg.minArea) return { ...none, kind: 'too_small' };

  // Need at least 3 frames per wingbeat to measure it, so 30 fps reads up to 10 Hz, 15 fps up to 5 Hz.
  const fs = (n - 1) / duration;
  const maxHz = Math.min(cfg.maxHz, fs / 3);
  if (maxHz <= cfg.minHz) return none;

  let best = null;
  let massCV = null;
  const bySignal = {};
  for (const name of ['mass', 'area', 'major']) {
    const series = resample(t, samples[name], first, n0, n);
    const { cv } = detrend(series);
    if (name === 'mass') massCV = cv;
    const r = findPeriod(series, fs, cfg.minHz, maxHz);
    bySignal[name] = r ? { hz: +r.hz.toFixed(2), strength: +r.strength.toFixed(3) } : null;
    if (r && (!best || r.strength > best.strength)) best = { ...r, signal: name, series };
  }

  // Two pixel-grid checks before trusting a rhythm:
  //  1. Size must really swing (mass CV). A steady drone crossing pixel boundaries makes a
  //     tiny regular ripple in pixel counts; contrast mass barely moves for it.
  //  2. Mass must show the same beat. Objects drifting across pixel rows/columns make
  //     regular blips in area/major (whole-pixel counts) even when tumbling randomly;
  //     real wings change the darkness footprint, which mass measures smoothly.
  const mass = bySignal.mass;
  const massAgrees = best && mass && (best.signal === 'mass' ||
    (mass.strength >= cfg.peakThreshold * cfg.massSupport && Math.abs(mass.hz - best.hz) / best.hz <= cfg.massHzTolerance));
  if (best && best.strength >= cfg.peakThreshold && massCV >= cfg.steadyCV && massAgrees) {
    return { kind: 'flapping', hz: best.hz, strength: best.strength, cv: massCV, signal: best.signal, bySignal, series: normalize(best.series), fs };
  }
  const kind = massCV !== null && massCV < cfg.steadyCV ? 'steady' : 'irregular';
  return {
    kind,
    hz: null,
    strength: best ? best.strength : 0,
    cv: massCV,
    signal: best ? best.signal : null,
    bySignal,
    vetoed: best && best.strength >= cfg.peakThreshold ? (massCV < cfg.steadyCV ? 'size_too_steady' : 'mass_disagrees') : null,
    series: best ? normalize(best.series) : null,
    fs,
  };
}

// Linear interpolation of values[first..end) onto n evenly spaced times.
function resample(t, values, first, end, n) {
  const out = new Float64Array(n);
  const t0 = t[first];
  const step = (t[end - 1] - t0) / (n - 1);
  let j = first;
  for (let i = 0; i < n; i++) {
    const ti = t0 + i * step;
    while (j < end - 2 && t[j + 1] < ti) j++;
    const span = t[j + 1] - t[j];
    const f = span > 0 ? Math.min(1, Math.max(0, (ti - t[j]) / span)) : 0;
    out[i] = values[j] + f * (values[j + 1] - values[j]);
  }
  return out;
}

// Subtract the best-fit line in place. Returns the coefficient of variation
// (residual std / mean) of the original signal.
function detrend(x) {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += x[i]; sxx += i * i; sxy += i * x[i];
  }
  const mean = sy / n;
  const den = n * sxx - sx * sx;
  const slope = den ? (n * sxy - sx * sy) / den : 0;
  const icept = mean - (slope * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    x[i] -= icept + slope * i;
    ss += x[i] * x[i];
  }
  const std = Math.sqrt(ss / n);
  return { cv: mean > 0 ? std / mean : Infinity };
}

// Pearson correlation of x with itself shifted by k samples. Normalizing per lag
// (instead of by the zero-lag energy) keeps long lags from being unfairly shrunk.
function corrAtLag(x, k) {
  const m = x.length - k;
  let a = 0, b = 0, ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < m; i++) { a += x[i]; b += x[i + k]; }
  a /= m; b /= m;
  for (let i = 0; i < m; i++) {
    const u = x[i] - a, v = x[i + k] - b;
    ab += u * v; aa += u * u; bb += v * v;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

function findPeriod(x, fs, minHz, maxHz) {
  const n = x.length;
  const kMin = Math.max(2, Math.floor(fs / maxHz));
  const kMax = Math.min(Math.floor(n / 2), Math.ceil(fs / minHz));
  if (kMax <= kMin) return null;

  const r = new Float64Array(kMax + 2);
  for (let k = 1; k <= kMax + 1 && k < n - 2; k++) r[k] = corrAtLag(x, k);

  // Candidate peaks: local maxima inside the lag range.
  const peaks = [];
  let best = -1;
  for (let k = kMin; k <= kMax; k++) {
    if (r[k] >= r[k - 1] && r[k] >= r[k + 1] && r[k] > 0) {
      peaks.push(k);
      if (r[k] > best) best = r[k];
    }
  }
  if (!peaks.length) return null;

  // Prefer the shortest strong period, so we don't report half the real wingbeat
  // rate (a signal repeating every T also repeats every 2T).
  const k = peaks.find((p) => r[p] >= 0.85 * best);

  // A real rhythm must dip between beats.
  let dip = Infinity;
  for (let i = 1; i < k; i++) dip = Math.min(dip, r[i]);
  if (r[k] - dip < 0.3) return null;

  const y0 = r[k - 1], y1 = r[k], y2 = r[k + 1];
  const den = y0 - 2 * y1 + y2;
  const lag = k + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0);
  return { hz: fs / lag, strength: r[k] };
}

function normalize(x) {
  let lo = Infinity, hi = -Infinity;
  for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  return Array.from(x, (v) => +(((v - lo) / span) * 2 - 1).toFixed(3));
}
