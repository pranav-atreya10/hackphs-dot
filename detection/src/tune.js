// Tuning tools: run scenes through the engine, score the result, and sweep a parameter
// across values to see which setting scores best. Works on the synthetic scenes now;
// the same scoring applies to real clips once you log them with ClipEvaluator.

import { DetectionEngine } from './engine.js';
import { SyntheticSky, SCENARIOS } from './synthetic.js';
import { ClipEvaluator } from './eval.js';
import { mergeConfig, DEFAULTS } from './config.js';
import { PARAMS, patchFor, getParam } from './params.js';

// Run one synthetic scene end to end. Returns the evaluator row plus all messages.
export function runScenario(name, { fps = 30, width = 320, seed = 7, config = {} } = {}) {
  const sky = new SyntheticSky({ width, height: Math.round(width * 0.75), scenario: name, seed });
  const engine = new DetectionEngine(config);
  engine.setCorridor(sky.corridor);
  const ev = new ClipEvaluator();
  const events = [];
  const batches = [];
  engine.on('event', (e) => events.push(e));
  engine.on('track_batch', (b) => batches.push(b));
  ev.start(name, sky.expected);
  let state;
  const frames = Math.round(sky.durationSec * fps);
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    if (i % Math.max(1, Math.round(fps / 10)) === 0) engine.setAudioProbability(sky.audioProbability(), 'synthetic');
    state = engine.process(sky.render(t), t);
    ev.observe(state);
  }
  return { row: ev.finish(), state, events, batches, engine };
}

// Score one run against the scene's known answers. Higher is better.
export const WEIGHTS = {
  pass: 3,          // risk level correct
  missed: -6,       // a real hazard under-reported (worst)
  falseAlarm: -4,   // over-reported (erodes trust)
  flockErrPer: -1,  // per bird of flock-count error
  hzErrFrac: -2,    // per 100% wingbeat-rate error
  wrongClass: -3,   // forbidden label appeared / expected label missing
  redDelayPerSec: -0.3,
};

export function scoreRun(name, row, w = WEIGHTS) {
  const sc = SCENARIOS[name];
  const classes = row.classes ? row.classes.split('|') : [];
  const parts = {};
  parts.risk = row.pass ? w.pass : row.missed ? w.missed : w.falseAlarm;
  if (sc.expectFlock !== undefined) parts.flock = w.flockErrPer * Math.abs(row.max_flock - sc.expectFlock);
  if (sc.expectHz !== undefined) {
    parts.hz = row.median_flap_hz ? w.hzErrFrac * Math.abs(row.median_flap_hz - sc.expectHz) / sc.expectHz : w.hzErrFrac;
  }
  if (sc.forbidClass && classes.includes(sc.forbidClass)) parts.forbidden = w.wrongClass;
  if (sc.expectClass && !classes.includes(sc.expectClass)) parts.missingClass = w.wrongClass;
  if (sc.expected === 'red' && row.first_red_s !== null) parts.redDelay = w.redDelayPerSec * row.first_red_s;
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: +total.toFixed(2), parts };
}

// Evaluate one config over scenes x seeds.
export function evaluateConfig(config = {}, { scenarios = Object.keys(SCENARIOS), seeds = [7, 11, 23], fps = 30, width = 320 } = {}) {
  let score = 0, passed = 0, falseAlarms = 0, missed = 0, runs = 0, ms = 0;
  const detail = [];
  for (const name of scenarios) {
    for (const seed of seeds) {
      const { row } = runScenario(name, { seed, fps, width, config });
      const s = scoreRun(name, row);
      score += s.total; runs++; ms += row.avg_proc_ms;
      if (row.pass) passed++;
      if (row.false_alarm) falseAlarms++;
      if (row.missed) missed++;
      detail.push({ scene: name, seed, ...row, score: s.total, parts: s.parts });
    }
  }
  return { score: +score.toFixed(2), passed, runs, falseAlarms, missed, avgMs: +(ms / runs).toFixed(3), detail };
}

// Try a parameter across values (default: 5 evenly spaced values across its registry range).
// Example: sweep('motion.threshold') or sweep('tracker.maxJump', [16, 24, 32], { fps: 15 })
export function sweep(path, values, opts = {}) {
  const meta = PARAMS.find((p) => p.path === path);
  if (!values) {
    if (!meta) throw new Error(`No registry range for ${path}; pass values explicitly`);
    const n = 5;
    values = Array.from({ length: n }, (_, i) => {
      const v = meta.min + ((meta.max - meta.min) * i) / (n - 1);
      return Math.round(v / meta.step) * meta.step;
    });
    const def = getParam(DEFAULTS, path);
    if (!values.includes(def)) values.push(def);
    values.sort((a, b) => a - b);
  }
  const base = opts.base || {};
  const rows = values.map((v) => {
    const r = evaluateConfig(mergeConfig(base, patchFor(path, v)), opts);
    return { value: v, score: r.score, passed: `${r.passed}/${r.runs}`, falseAlarms: r.falseAlarms, missed: r.missed, avgMs: r.avgMs, detail: r.detail };
  });
  const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
  return { path, default: getParam(DEFAULTS, path), best: best.value, rows };
}
