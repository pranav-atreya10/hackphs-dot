// Clip evaluation for tuning (hours 11-13): run each clip, record what the engine
// did versus what was expected, and export a table for the pitch.

const RANK = { green: 0, yellow: 1, red: 2 };

export class ClipEvaluator {
  constructor() {
    this.rows = [];
    this.cur = null;
  }

  // expected: 'green' | 'yellow' | 'red'
  start(clip, expected) {
    this.cur = {
      clip, expected, frames: 0, t0: null, tLast: null, maxRisk: 'green', firstRedAt: null,
      redSec: 0, yellowSec: 0, maxFlock: 0, classes: new Set(), flapHz: [], procMs: 0,
    };
  }

  observe(state) {
    const c = this.cur;
    if (!c) return;
    if (c.t0 === null) c.t0 = state.t;
    const dt = c.tLast === null ? 0 : Math.max(0, state.t - c.tLast);
    c.tLast = state.t;
    c.frames++;
    c.procMs += state.stats.proc_ms || 0;
    const lvl = state.risk.level;
    if (RANK[lvl] > RANK[c.maxRisk]) c.maxRisk = lvl;
    if (lvl === 'red') { c.redSec += dt; if (c.firstRedAt === null) c.firstRedAt = state.t - c.t0; }
    if (lvl === 'yellow') c.yellowSec += dt;
    for (const f of state.flocks) c.maxFlock = Math.max(c.maxFlock, f.size);
    for (const tr of state.tracks) {
      c.classes.add(tr.classification);
      if (tr.flap_hz) c.flapHz.push(tr.flap_hz);
    }
  }

  finish() {
    const c = this.cur;
    if (!c) return null;
    this.cur = null;
    const hz = c.flapHz.length ? c.flapHz.sort((a, b) => a - b)[c.flapHz.length >> 1] : null;
    const row = {
      clip: c.clip,
      expected: c.expected,
      actual: c.maxRisk,
      pass: c.maxRisk === c.expected,
      false_alarm: RANK[c.maxRisk] > RANK[c.expected],
      missed: RANK[c.maxRisk] < RANK[c.expected],
      first_red_s: c.firstRedAt === null ? null : +c.firstRedAt.toFixed(1),
      red_s: +c.redSec.toFixed(1),
      yellow_s: +c.yellowSec.toFixed(1),
      max_flock: c.maxFlock,
      classes: [...c.classes].join('|'),
      median_flap_hz: hz,
      avg_proc_ms: c.frames ? +(c.procMs / c.frames).toFixed(2) : null,
    };
    this.rows.push(row);
    return row;
  }

  summary() {
    const n = this.rows.length;
    return {
      clips: n,
      passed: this.rows.filter((r) => r.pass).length,
      false_alarms: this.rows.filter((r) => r.false_alarm).length,
      missed: this.rows.filter((r) => r.missed).length,
    };
  }

  toCSV() {
    if (!this.rows.length) return '';
    const cols = Object.keys(this.rows[0]);
    const esc = (v) => (v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [cols.join(','), ...this.rows.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n');
  }
}
