// Bird-count forecaster: are more and more birds gathering in view?
//
// Every `sampleSec` we record how many birds are in view, fit a straight line through
// the last `windowSec`, and project it `horizonSec` ahead. Birds gathering one after another
// (a feeding spot, a field being mowed, birds following a tractor) is an early warning:
// the flock forms before it is a flock.
//
// Guards so noise can't fake a trend:
//  - each bird counts from when its track was first seen (recognising it takes a second or two),
//    and stays counted until `holdSec` after it was last seen (a track lost for a moment);
//  - the first `warmupSec` after start-up is the baseline (birds already there aren't arrivals);
//  - "rising" needs the slope to be clearly above zero (slope − sigma × its standard error > 0),
//    at least `minRise` more birds than the lowest count in the window, and the count must have
//    gone up at `minSteps` separate moments (one group arriving together is a flock, not a trend);
//  - red needs a bigger rise (`redMinRise`) and a forecast reaching the flock-red size.

export class BirdForecaster {
  constructor(cfg) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.birds = new Map(); // track id -> { born, last }: when each bird was first and last seen
    this.startT = null;
    this.snap = idle(this.cfg);
  }

  // tracks: the engine's confirmed tracks after classification (tr.id, tr.born, tr.cls).
  // A bird is counted from the moment its track was FIRST SEEN, not from when it was recognised
  // as a bird (that takes a second or two), so birds already in view when the camera starts,
  // or recognised one after another, don't look like birds arriving.
  update(tracks, t) {
    const c = this.cfg;
    if (!c.enabled) return (this.snap = idle(c));
    if (this.startT === null) this.startT = t;
    for (const tr of tracks) {
      if (tr.cls !== 'bird') continue;
      const e = this.birds.get(tr.id);
      const n = tr.denseCount || 1; // a dense flock counts as all its birds
      if (e) { e.last = t; e.n = n; }
      else this.birds.set(tr.id, { born: tr.born, last: t, n });
    }
    for (const [id, e] of this.birds) if (t - e.last > c.windowSec + c.holdSec) this.birds.delete(id);

    // Count at time T = birds first seen by T and still seen within holdSec of T
    // (a track lost for a moment isn't "a bird left").
    const countAt = (T) => {
      let n = 0;
      for (const e of this.birds.values()) if (e.born <= T && e.last >= T - c.holdSec) n += e.n;
      return n;
    };
    // Samples every sampleSec over the window, skipping the camera's first warmupSec
    // (everything in view at start-up is the baseline, not an arrival).
    const from = Math.max(t - c.windowSec, this.startT + c.warmupSec);
    const samples = [];
    for (let T = t; T >= from; T -= c.sampleSec) samples.push([T, countAt(T)]);
    samples.reverse();
    this.samples = samples;
    return (this.snap = this.assess(countAt(t), t));
  }

  assess(now, t) {
    const c = this.cfg;
    const s = this.samples;
    const out = idle(c);
    out.birds_now = now;
    if (s.length < 4 || t - s[0][0] < c.minSpanSec) { out.trend = 'learning'; return out; }

    // Least-squares slope (birds per second) and its standard error.
    const n = s.length;
    let mt = 0, my = 0;
    for (const [ti, y] of s) { mt += ti; my += y; }
    mt /= n; my /= n;
    let stt = 0, sty = 0;
    for (const [ti, y] of s) { stt += (ti - mt) ** 2; sty += (ti - mt) * (y - my); }
    if (stt <= 0) return out;
    const slope = sty / stt;
    let ss = 0;
    for (const [ti, y] of s) ss += (y - my - slope * (ti - mt)) ** 2;
    const se = n > 2 ? Math.sqrt(ss / (n - 2) / stt) : Infinity;

    let low = Infinity, steps = 0;
    for (let i = 0; i < n; i++) {
      low = Math.min(low, s[i][1]);
      if (i && s[i][1] > s[i - 1][1]) steps++;
    }
    const rise = now - low;
    const perMin = slope * 60;
    const clearlyUp = slope - c.sigma * se > 0;
    const clearlyDown = slope + c.sigma * se < 0;

    out.per_min = Math.round(perMin * 10) / 10;
    out.rise = rise;
    out.steps = steps;
    out.predicted = Math.max(0, Math.round((now + slope * c.horizonSec) * 10) / 10);
    if (perMin >= c.minSlopePerMin && clearlyUp && rise >= c.minRise && steps >= c.minSteps) out.trend = 'rising';
    else if (perMin <= -c.minSlopePerMin && clearlyDown) out.trend = 'falling';
    else out.trend = 'steady';
    out.red_ready = out.trend === 'rising' && rise >= c.redMinRise;
    return out;
  }
}

function idle(c) {
  return { trend: 'off', birds_now: 0, per_min: 0, predicted: null, horizon_sec: c.horizonSec, rise: 0, steps: 0, red_ready: false };
}
