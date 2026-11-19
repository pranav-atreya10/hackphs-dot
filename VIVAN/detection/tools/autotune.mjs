// Auto-tune the engine's detection settings on the synthetic scenes (coordinate search).
//
//   node VIVAN/detection/tools/autotune.mjs [--seeds 1,2,3] [--check 101-110] [--workers 4] [--out file.json]
//
// For each setting (most important first) it tries values around the current one and keeps a change only
// if the total score on the TUNING seeds improves by more than `--margin`. Then it runs defaults vs tuned once
// on fresh CHECK seeds (never used for tuning), at 30 fps (laptop defaults) and 15 fps (phone preset), and writes
// everything to a JSON report. It never edits config.js: copy the winning values in by hand after reading the report.
//
// Settings that DEFINE the rules (risk.flockRed, risk.etaRedSec), and ones the synthetic scenes can't judge
// (audio.*, coco.*, corridor.*), are deliberately not tuned.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => resolve(here, '../src', f);

const TUNE = [
  'motion.threshold', 'blobs.minArea', 'tracker.maxJump', 'tracker.confirmFrames', 'wingbeat.windowSec',
  'wingbeat.peakThreshold', 'wingbeat.steadyCV', 'debris.minPull', 'flocks.radiusFrac',
  'motion.noiseK', 'motion.dilate', 'blobs.mergeGap', 'ghost.ratio', 'tracker.predictedGate', 'tracker.minTravel',
  'wingbeat.hzTolerance', 'wingbeat.minConsistent', 'wingbeat.minRepeat', 'flocks.maxHeadingDiff', 'flocks.inferBirdAtSize',
];

async function evaluate({ patch, seeds, fps, phone }) {
  const { evaluateConfig } = await import(src('tune.js'));
  const { mergeConfig } = await import(src('config.js'));
  const { PRESETS } = await import(src('params.js'));
  let cfg = mergeConfig({}, patch);
  if (phone) cfg = mergeConfig(cfg, mergeConfig(PRESETS.phone_15fps, { motion: { warmupFrames: 8, warmupAlpha: 0.4 } }));
  const r = evaluateConfig(cfg, { seeds, fps, width: 320 });
  const wrongClass = r.detail.filter((d) => d.parts.forbidden || d.parts.missingClass).length;
  return { score: r.score, passed: r.passed, runs: r.runs, falseAlarms: r.falseAlarms, missed: r.missed, wrongClass,
    failures: r.detail.filter((d) => !d.pass || d.parts.forbidden || d.parts.missingClass).map((d) => `${d.scene}#${d.seed}:${d.actual}(${d.classes})`) };
}

if (!isMainThread) {
  parentPort.on('message', async (job) => parentPort.postMessage({ id: job.id, result: await evaluate(job) }));
} else {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
  const range = (s) => s.includes('-') ? (([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))(s.split('-').map(Number)) : s.split(',').map(Number);
  const seeds = range(args.seeds || '1,2,3');
  const check = range(args.check || '101-110');
  const margin = Number(args.margin || 1);
  const nWorkers = Number(args.workers || 4);
  const out = resolve(args.out || resolve(here, '../tuning', `autotune-${new Date().toISOString().slice(0, 10)}.json`));

  const { PARAMS, patchFor, getParam } = await import(src('params.js'));
  const { DEFAULTS, mergeConfig } = await import(src('config.js'));

  const workers = Array.from({ length: nWorkers }, () => new Worker(fileURLToPath(import.meta.url)));
  const idle = [...workers];
  const waiting = [];
  let nextId = 0;
  const pending = new Map();
  for (const w of workers) w.on('message', ({ id, result }) => { pending.get(id)(result); pending.delete(id); idle.push(w); if (waiting.length) waiting.shift()(); });
  const run = async (job) => {
    while (!idle.length) await new Promise((r) => waiting.push(r));
    const w = idle.pop(), id = nextId++;
    return new Promise((res) => { pending.set(id, res); w.postMessage({ ...job, id }); });
  };

  const snap = (meta, v) => +Math.min(meta.max, Math.max(meta.min, Math.round(v / meta.step) * meta.step)).toFixed(6);
  let patch = {};
  const log = [];
  const t0 = Date.now();
  let best = await run({ patch, seeds, fps: 30 });
  console.log(`start: score ${best.score}, pass ${best.passed}/${best.runs}, FA ${best.falseAlarms}, missed ${best.missed}, wrong class ${best.wrongClass}`);

  for (const path of TUNE) {
    const meta = PARAMS.find((p) => p.path === path);
    const cur = getParam(mergeConfig(DEFAULTS, patch), path);
    const span = meta.max - meta.min;
    const cands = [...new Set([cur - 2 * meta.step, cur - meta.step, cur + meta.step, cur + 2 * meta.step, cur * 0.75, cur * 1.25]
      .concat(span / meta.step > 12 ? [cur - span * 0.1, cur + span * 0.1] : [])
      .map((v) => snap(meta, v)))].filter((v) => v !== cur);
    const results = await Promise.all(cands.map((v) => run({ patch: mergeConfig(patch, patchFor(path, v)), seeds, fps: 30 }).then((r) => ({ v, r }))));
    const top = results.reduce((a, b) => (b.r.score > a.r.score ? b : a));
    const safe = top.r.missed <= best.missed && top.r.falseAlarms <= best.falseAlarms && top.r.wrongClass <= best.wrongClass;
    const kept = top.r.score > best.score + margin && safe;
    log.push({ path, from: cur, tried: results.map((x) => [x.v, x.r.score]), best: top.v, bestScore: top.r.score, baseline: best.score, kept });
    console.log(`${path}: ${cur} -> ${kept ? top.v : '(kept ' + cur + ')'}  [${results.map((x) => `${x.v}:${x.r.score}`).join(' ')}]  ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    if (kept) { patch = mergeConfig(patch, patchFor(path, top.v)); best = top.r; }
  }

  console.log('checking on fresh seeds', check.join(','), '...');
  const [d30, t30, d15, t15] = await Promise.all([
    run({ patch: {}, seeds: check, fps: 30 }), run({ patch, seeds: check, fps: 30 }),
    run({ patch: {}, seeds: check, fps: 15, phone: true }), run({ patch, seeds: check, fps: 15, phone: true }),
  ]);
  const report = { created: new Date().toISOString(), tuneSeeds: seeds, checkSeeds: check, margin, patch, steps: log,
    tuneScore: best, check: { fps30: { defaults: d30, tuned: t30 }, fps15_phone: { defaults: d15, tuned: t15 } } };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 1));
  const row = (n, r) => console.log(`${n.padEnd(22)} score ${r.score}  pass ${r.passed}/${r.runs}  FA ${r.falseAlarms}  missed ${r.missed}  wrong class ${r.wrongClass}`);
  row('30 fps defaults', d30); row('30 fps tuned', t30); row('15 fps defaults', d15); row('15 fps tuned', t15);
  console.log('patch:', JSON.stringify(patch)); console.log('report:', out);
  for (const w of workers) w.terminate();
}
