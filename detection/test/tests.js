// Tests for the detection engine. Open detection/test/index.html from a local server.
// Pure ES modules with no DOM use, so they can also run in Node later.

import { DetectionEngine, SyntheticSky, SCENARIOS, ClipEvaluator, analyzeWingbeat, DEFAULTS } from '../index.js';
import { bearingFromX, destination, motionHeading } from '../src/geo.js';
import { etaToPolygon, pointInPolygon, rasterizePolygon } from '../src/geometry.js';
import { BlobLabeler } from '../src/blobs.js';
import { Tracker } from '../src/tracker.js';
import { FlockGrouper } from '../src/flocks.js';
import { RiskEngine } from '../src/risk.js';
import { HumDetector } from '../src/audio.js';
import { mulberry32 } from '../src/synthetic.js';
import { runScenario, evaluateConfig } from '../src/tune.js';
import { PARAMS, PRESETS, describeParams, getParam } from '../src/params.js';
import { cropRect, interpretPredictions } from '../adapters/coco.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}±${tol}, got ${a}`);

// ---------- geo ----------
test('bearing: center of frame = camera heading, edges = heading ± fov/2', () => {
  near(bearingFromX(0.5, 90, 65), 90, 1e-9);
  near(bearingFromX(1, 90, 65), 122.5, 1e-9);
  near(bearingFromX(0, 10, 65), 337.5, 1e-9, 'wraps past north');
});
test('motion heading: moving right in an east-facing camera = heading south', () => {
  ok(motionHeading(0.05, 0, 90).name === 'south');
  ok(motionHeading(-0.05, 0, 90).name === 'north');
  ok(motionHeading(0.001, 0, 90) === null, 'too slow = null');
});
test('destination: 1 km due north is ~0.009° latitude', () => {
  const [lon, lat] = destination(40, -74, 0, 1000);
  near(lat, 40.008993, 1e-5); near(lon, -74, 1e-9);
});

// ---------- geometry ----------
const square = [[0.6, 0], [1, 0], [1, 1], [0.6, 1]];
test('point in polygon', () => {
  ok(pointInPolygon(0.8, 0.5, square)); ok(!pointInPolygon(0.2, 0.5, square));
});
test('ETA: 0.4 away at 0.1/s = 4 s; moving away = null; inside = 0', () => {
  near(etaToPolygon(0.2, 0.5, 0.1, 0, square, 60), 4, 1e-9);
  ok(etaToPolygon(0.2, 0.5, -0.1, 0, square, 60) === null);
  ok(etaToPolygon(0.8, 0.5, 0, 0, square, 60) === 0);
  ok(etaToPolygon(0.2, 0.5, 0.001, 0, square, 60) === null, 'beyond horizon');
});
test('rasterize polygon fills the right pixels', () => {
  const out = new Uint8Array(10 * 10);
  rasterizePolygon([[0.5, 0], [1, 0], [1, 1], [0.5, 1]], 10, 10, out);
  ok(out.reduce((a, b) => a + b, 0) === 50, `got ${out.reduce((a, b) => a + b, 0)}`);
  ok(out[5] === 1 && out[4] === 0);
});

// ---------- blobs ----------
test('blob labeling: two squares, 8-connectivity joins a diagonal', () => {
  const w = 20, h = 10, m = new Uint8Array(w * h), diff = new Uint8Array(w * h).fill(30);
  const set = (x, y) => (m[y * w + x] = 1);
  for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) set(x, y);
  set(5, 5); // diagonal touch, same blob
  for (let y = 2; y < 6; y++) for (let x = 12; x < 16; x++) set(x, y);
  const { blobs } = new BlobLabeler().label(m, m, diff, w, h, { minArea: 1, maxAreaFrac: 1, maxBlobs: 50 });
  ok(blobs.length === 2, `got ${blobs.length}`);
  ok(blobs[0].area === 10 && blobs[1].area === 16);
  near(blobs[1].x, 14, 1e-9); near(blobs[1].y, 4, 1e-9);
});

// ---------- wingbeat ----------
function series(fn, fps, sec, jitter = 0, seed = 3) {
  const rng = mulberry32(seed);
  const s = { t: [], mass: [], area: [], major: [] };
  for (let i = 0; i < fps * sec; i++) {
    const t = i / fps + (rng() - 0.5) * jitter / fps;
    const v = fn(t, rng);
    s.t.push(t); s.mass.push(v * 40); s.area.push(v); s.major.push(Math.sqrt(v) * 2);
  }
  return s;
}
const cfgW = DEFAULTS.wingbeat;
test('wingbeat: 4 Hz flap at 30 fps -> flapping ~4 Hz', () => {
  const a = analyzeWingbeat(series((t, r) => 30 + 8 * Math.sin(2 * Math.PI * 4 * t) + (r() - 0.5) * 3, 30, 2), cfgW);
  ok(a.kind === 'flapping', a.kind); near(a.hz, 4, 0.35);
});
test('wingbeat: 4.5 Hz at a jittery 15 fps still found', () => {
  const a = analyzeWingbeat(series((t, r) => 30 + 8 * Math.sin(2 * Math.PI * 4.5 * t) + (r() - 0.5) * 3, 15, 2, 0.3), cfgW);
  ok(a.kind === 'flapping', a.kind); near(a.hz, 4.5, 0.5);
});
test('wingbeat: 2.5 Hz goose with a growing trend (approaching)', () => {
  const a = analyzeWingbeat(series((t, r) => 20 + 15 * t + 6 * Math.sin(2 * Math.PI * 2.5 * t) + (r() - 0.5) * 2, 30, 2), { ...cfgW, windowSec: 1.8 });
  ok(a.kind === 'flapping', a.kind); near(a.hz, 2.5, 0.35);
});
test('wingbeat: constant size + noise -> steady', () => {
  const a = analyzeWingbeat(series((t, r) => 30 + (r() - 0.5) * 2, 30, 2), cfgW);
  ok(a.kind === 'steady', a.kind);
});
test('wingbeat: random-walk size -> irregular (not flapping)', () => {
  let v = 30;
  const a = analyzeWingbeat(series((t, r) => (v = Math.max(8, v + (r() - 0.5) * 10)), 30, 2, 0, 9), cfgW);
  ok(a.kind === 'irregular', a.kind);
});
test('wingbeat: tiny blobs are too small to judge', () => {
  const a = analyzeWingbeat(series((t) => 3 + Math.sin(2 * Math.PI * 4 * t), 30, 2), cfgW);
  ok(a.kind === 'too_small', a.kind);
});

// ---------- tracker ----------
test('tracker: one moving blob keeps one ID and confirms after 4 frames', () => {
  const tr = new Tracker({ ...DEFAULTS.tracker });
  let confirmedAt = null;
  for (let i = 0; i < 30; i++) {
    const t = i / 30;
    const tracks = tr.update([{ x: 20 + 2 * i, y: 50 + 0.5 * i, area: 20, mass: 600, major: 8, minX: 0, minY: 0, maxX: 1, maxY: 1 }], t);
    ok(tracks.length === 1 && tracks[0].id === 1, `frame ${i}: ${tracks.length} tracks, id ${tracks[0] && tracks[0].id}`);
    if (tracks[0].confirmed && confirmedAt === null) confirmedAt = i;
  }
  ok(confirmedAt !== null && confirmedAt <= 4, `confirmed at ${confirmedAt}`);
  near(tr.tracks[0].vx, 60, 3, 'vx px/s');
});
test('tracker: random flicker noise never confirms', () => {
  const tr = new Tracker({ ...DEFAULTS.tracker });
  const rng = mulberry32(5);
  let confirmed = 0;
  for (let i = 0; i < 300; i++) {
    const blobs = Array.from({ length: 4 }, () => ({ x: rng() * 320, y: rng() * 240, area: 3, mass: 60, major: 2, minX: 0, minY: 0, maxX: 1, maxY: 1 }));
    confirmed += tr.update(blobs, i / 30).filter((t) => t.confirmed).length;
  }
  ok(confirmed === 0, `${confirmed} noise confirmations`);
});
test('tracker: two crossing targets keep their IDs', () => {
  const tr = new Tracker({ ...DEFAULTS.tracker });
  for (let i = 0; i < 40; i++) {
    const t = i / 30;
    tr.update([
      { x: 20 + 4 * i, y: 100, area: 20, mass: 500, major: 8, minX: 0, minY: 0, maxX: 1, maxY: 1 },
      { x: 180 - 4 * i, y: 112, area: 20, mass: 500, major: 8, minX: 0, minY: 0, maxX: 1, maxY: 1 },
    ], t);
  }
  const [a, b] = tr.tracks.sort((p, q) => p.id - q.id);
  ok(a.vx > 0 && b.vx < 0, `ids swapped: vx ${a.vx.toFixed(1)}, ${b.vx.toFixed(1)}`);
});

// ---------- flocks ----------
test('flocks: same-direction neighbours group; flock ID is stable', () => {
  const g = new FlockGrouper({ ...DEFAULTS.flocks });
  const mk = (id, x, y, vx, vy) => ({ id, x, y, vx, vy, svx: vx, svy: vy, blob: { minX: x - 2, minY: y - 2, maxX: x + 2, maxY: y + 2 } });
  const f1 = g.group([mk(1, 100, 100, 20, 0), mk(2, 112, 105, 21, 2), mk(3, 120, 95, 19, -1), mk(4, 110, 100, -20, 0)], 320);
  ok(f1.length === 1 && f1[0].size === 3, `got ${f1.map((f) => f.size)}`);
  const f2 = g.group([mk(1, 101, 100, 20, 0), mk(2, 113, 105, 21, 2), mk(3, 121, 95, 19, -1), mk(5, 300, 10, 0, 0)], 320);
  ok(f2[0].id === f1[0].id, 'flock id changed');
});

// ---------- risk ----------
test('risk: rises immediately, steps down only after the hold time', () => {
  const r = new RiskEngine({ ...DEFAULTS.risk });
  const flock = [{ kind: 'flock', size: 6, classification: 'bird', eta_seconds: null, label: 'f1' }];
  ok(r.evaluate(flock, null, 0).level === 'red');
  ok(r.evaluate([], null, 1).level === 'red', 'held');
  ok(r.evaluate([], null, 3.5).level === 'red', 'still held');
  ok(r.evaluate([], null, 4.1).level === 'green', 'released');
  ok(r.evaluate([{ kind: 'track', size: 1, classification: 'bird', eta_seconds: 12, label: '#1' }], null, 5).level === 'red', 'ETA under 30 s');
});

// ---------- audio ----------
test('hum detector: steady 220 Hz harmonic buzz scores high, flat noise low', () => {
  const sr = 48000, n = 2048, binHz = sr / 2 / n;
  const rng = mulberry32(2);
  const spectrum = (tonal) => {
    const s = new Float32Array(n);
    for (let k = 0; k < n; k++) s[k] = -90 + rng() * 6;
    if (tonal) for (const m of [1, 2, 3]) { const k = Math.round((220 * m) / binHz); s[k] = -45; s[k - 1] = -55; s[k + 1] = -55; }
    return s;
  };
  const hum = new HumDetector();
  let p = 0;
  for (let i = 0; i < 8; i++) p = hum.update(spectrum(true), sr);
  ok(p > 0.8, `tonal p=${p}`);
  const quiet = new HumDetector();
  for (let i = 0; i < 8; i++) p = quiet.update(spectrum(false), sr);
  ok(p < 0.3, `noise p=${p}`);
});

// ---------- end-to-end on synthetic scenes ----------
export { runScenario };

test('scenario flock_corridor: red, flock of 6, flapping ~4 Hz, ETA counts down', () => {
  const { row, events } = runScenario('flock_corridor');
  ok(row.pass, JSON.stringify(row));
  ok(row.max_flock >= 5, `max flock ${row.max_flock}`);
  near(row.median_flap_hz, 4, 0.6, 'flap hz');
  const red = events.filter((e) => e.risk === 'red' && e.eta_seconds !== null && e.flock_size >= 5);
  ok(red.length, 'no red event with a 5+ flock and an ETA');
  ok(red.every((e) => e.type === 'bird' && e.bearing_deg !== null && e.eta_range), 'red flock events missing type/bearing/eta_range');
  ok(red.some((e) => e.needs_snapshot && e.crop_box), 'no photo requested for the flock');
  const etas = red.map((e) => e.eta_seconds);
  ok(etas[etas.length - 1] < etas[0], `ETA should count down: ${etas.join(', ')}`);
});
test('scenario single_bird: yellow, flapping ~3.3 Hz', () => {
  const { row } = runScenario('single_bird');
  ok(row.pass, JSON.stringify(row)); near(row.median_flap_hz, 3.3, 0.5);
});
test('scenario drone + sound: red drone with high confidence', () => {
  const { row, events } = runScenario('drone');
  ok(row.pass && row.classes.includes('drone'), JSON.stringify(row));
  const e = events.find((x) => x.type === 'drone' && x.confidence >= 0.85);
  ok(e, JSON.stringify(e && { type: e.type, confidence: e.confidence }));
});
test('scenario drone_silent: steady object stays unknown, never red', () => {
  const { row } = runScenario('drone_silent');
  ok(row.pass && !row.classes.includes('bird'), JSON.stringify(row));
});
test('scenario bag: never called a bird, never red', () => {
  const { row } = runScenario('bag');
  ok(row.pass && !row.classes.includes('bird'), JSON.stringify(row));
});
test('scenario plane: steady, never a bird, never red', () => {
  const { row } = runScenario('plane');
  ok(row.pass && !row.classes.includes('bird'), JSON.stringify(row));
});
test('scenario empty sky: stays green, zero confirmed tracks', () => {
  const { row, state } = runScenario('empty');
  ok(row.pass && state.stats.tracks_confirmed === 0, JSON.stringify(row));
});
test('scenario distant_flock: tiny birds still raise red as a flock', () => {
  const { row } = runScenario('distant_flock');
  ok(row.pass && row.max_flock >= 5, JSON.stringify(row));
});
test('contract: track_batch points have every field the backend needs', () => {
  const { batches } = runScenario('flock_corridor');
  ok(batches.length >= 8, `${batches.length} batches`);
  const p = batches[5].points[0];
  for (const k of ['time', 'track_id', 'x', 'y', 'bearing_deg', 'speed', 'flap_hz', 'is_flock', 'flock_id', 'classification']) ok(k in p, `missing ${k}`);
});
test('Gemini rejection turns a track gray and is counted', () => {
  const sky = new SyntheticSky({ scenario: 'bag', seed: 7 });
  const engine = new DetectionEngine();
  let st;
  for (let i = 0; i < 150; i++) st = engine.process(sky.render(i / 30), i / 30);
  ok(st.tracks.length >= 1, 'bag not tracked');
  engine.applyVerdict({ track_id: st.tracks[0].id, verdict: 'rejected', label: 'plastic bag' });
  for (let i = 150; i < 260; i++) st = engine.process(sky.render(i / 30), i / 30);
  ok(st.tracks.every((t) => t.classification === 'rejected'), st.tracks.map((t) => t.classification).join());
  ok(st.stats.gemini_rejected === 1 && st.risk.level === 'green', `${st.stats.gemini_rejected} ${st.risk.level}`);
});
test('performance: 320x240 frame processes in under 4 ms on average', () => {
  const { row } = runScenario('flock_corridor');
  ok(row.avg_proc_ms < 4, `${row.avg_proc_ms} ms`);
});

test('ghost filter: object present in frame 1 leaves no stationary track', () => {
  const { engine, state } = runScenario('single_bird');
  ok(state.stats.ghosts_removed > 0, 'no ghosts were removed');
  ok(state.stats.tracks_confirmed <= 2, `${state.stats.tracks_confirmed} tracks confirmed for one gull`);
});
test('ETA range brackets the ETA and diagnostics are filled', () => {
  const { events, state } = runScenario('flock_corridor');
  const e = events.find((x) => x.eta_range && x.eta_seconds !== null);
  ok(e, 'no event with an ETA range');
  ok(e.eta_range[0] <= e.eta_seconds + 0.05 && e.eta_range[1] >= e.eta_seconds - 0.05, JSON.stringify(e.eta_range) + ' vs ' + e.eta_seconds);
  const tr = state.tracks[0];
  ok(tr && tr.diag && tr.diag.snr > 0 && tr.quality > 0 && Array.isArray(tr.diag.hz_history), 'missing diagnostics');
  ok(Object.keys(state.stats.stage_ms).length >= 5, 'missing stage timings');
});
test('parameter registry: every path exists in the config and the default is in range', () => {
  for (const p of describeParams()) {
    ok(p.default !== undefined, `${p.path} not in DEFAULTS`);
    ok(p.default >= p.min && p.default <= p.max, `${p.path} default ${p.default} outside ${p.min}-${p.max}`);
  }
});
test('presets only touch real parameters and still pass the flock scene', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (const [sec, vals] of Object.entries(preset)) for (const k of Object.keys(vals)) ok(getParam(DEFAULTS, `${sec}.${k}`) !== undefined, `${name}: ${sec}.${k}`);
    const { row } = runScenario('flock_corridor', { config: preset });
    ok(row.actual === 'red', `${name}: flock scene gave ${row.actual}`);
  }
});
test('robustness: every scene passes on 3 random seeds', () => {
  const r = evaluateConfig({});
  const bad = r.detail.filter((d) => !d.pass || d.parts.forbidden || d.parts.missingClass);
  ok(!bad.length, bad.map((d) => `${d.scene}#${d.seed}: ${d.actual} ${d.classes}`).join('; '));
});
test('robustness: flock scenes pass at a phone-like 15 fps with the phone preset', () => {
  for (const s of ['flock_corridor', 'single_bird', 'empty', 'bag']) {
    const { row } = runScenario(s, { fps: 15, config: PRESETS.phone_15fps });
    ok(row.pass, `${s} @15fps: ${JSON.stringify(row)}`);
  }
});

// ---------- COCO-SSD integration (no model needed: fusion + geometry) ----------
function engineOn(scene, frames, config = {}) {
  const sky = new SyntheticSky({ scenario: scene, seed: 7 });
  const engine = new DetectionEngine(config);
  engine.setCorridor(sky.corridor);
  let st;
  let i = 0;
  const step = (n) => { for (const end = i + n; i < end; i++) st = engine.process(sky.render(i / 30), i / 30); return st; };
  step(frames);
  return { engine, step, get state() { return st; } };
}
test('COCO fusion: "bird" upgrades an unknown object, and the label expires', () => {
  const run = engineOn('bag', 150);
  const tr = run.state.tracks[0];
  ok(tr && tr.classification === 'unknown', `start ${tr && tr.classification}`);
  run.engine.applyLabel(tr.id, 'bird', 0.8);
  let t2 = run.step(1).tracks.find((x) => x.id === tr.id);
  ok(t2.classification === 'bird' && /COCO/.test(t2.reason), `${t2.classification} ${t2.reason}`);
  t2 = run.step(30 * (DEFAULTS.coco.maxAgeSec + 1)).tracks.find((x) => x.id === tr.id);
  ok(!t2 || t2.classification === 'unknown', `after expiry: ${t2 && t2.classification}`);
});
test('COCO fusion: agreement boosts a flapping bird, disagreement lowers it', () => {
  const run = engineOn('single_bird', 120);
  const tr = run.state.tracks.find((x) => x.profile === 'flapping');
  ok(tr, 'no flapping track');
  const base = tr.confidence;
  run.engine.applyLabel(tr.id, 'bird', 0.9);
  const up = run.step(1).tracks.find((x) => x.id === tr.id);
  run.engine.applyLabel(tr.id, 'airplane', 0.9);
  const down = run.step(1).tracks.find((x) => x.id === tr.id);
  ok(up.confidence > base && down.confidence < up.confidence && down.classification === 'bird', `${base} -> ${up.confidence} -> ${down.confidence} ${down.classification}`);
  run.engine.applyLabel(tr.id, 'frisbee', 0.9);
  const vague = run.step(1).tracks.find((x) => x.id === tr.id);
  ok(vague.confidence === base, `frisbee should be neutral: ${base} vs ${vague.confidence}`);
  ok(run.state.stats.coco_agreement !== null, 'agreement stat missing');
});
test('COCO candidates: big enough at full resolution, unknowns first, cooldown respected', () => {
  const run = engineOn('bag', 150);
  ok(run.engine.cocoCandidates({ sourceWidth: 320, sourceHeight: 240 }).length === 0, 'tiny at 320 px should not be sent to COCO');
  const [c] = run.engine.cocoCandidates({ sourceWidth: 1920, sourceHeight: 1440 });
  ok(c && c.classification === 'unknown' && c.longSidePx >= DEFAULTS.coco.minPx, JSON.stringify(c));
  run.engine.applyLabel(c.id, null, 0);
  ok(run.engine.cocoCandidates({ sourceWidth: 1920, sourceHeight: 1440 }).every((x) => x.id !== c.id), 'cooldown ignored');
  ok(run.state.stats.coco_nothing === 0 && run.step(1).stats.coco_nothing === 1, 'nothing-count');
});
test('COCO crop: square, padded, inside the frame, object position mapped into the crop', () => {
  const c = cropRect({ x: 0.5, y: 0.5, w: 0.02, h: 0.01 }, { width: 1920, height: 1080 }, 0.6, 48);
  ok(c.side === Math.max(0.02 * 1920 * 2.2, 48), `side ${c.side}`);
  near(c.obj.x + c.obj.w / 2, 0.5, 1e-9, 'object centred');
  const edge = cropRect({ x: 0.99, y: 0.0, w: 0.01, h: 0.02 }, { width: 1920, height: 1080 }, 0.6, 48);
  ok(edge.sx + edge.side <= 1920 && edge.sy >= 0, 'clamped');
  ok(edge.obj.x > 0.5, 'object pushed toward crop edge when clamped');
});
test('COCO interpretation: only boxes on our object count; sky classes preferred', () => {
  const obj = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
  const preds = [
    { class: 'person', score: 0.9, bbox: [120, 120, 60, 60] },   // centred on object, not a sky class
    { class: 'kite', score: 0.5, bbox: [125, 125, 50, 50] },     // centred on object, sky class
    { class: 'bird', score: 0.95, bbox: [0, 0, 40, 40] },        // elsewhere in the crop
  ];
  const r = interpretPredictions(preds, obj, 300, 0.75);
  ok(r.label === 'kite' && r.ignored === 1, JSON.stringify(r));
  ok(interpretPredictions([], obj, 300, 0.75).label === null);
});

// ---------- runner ----------
export async function runAll(log = console.log) {
  const results = [];
  for (const t of tests) {
    const start = performance.now();
    try {
      await t.fn();
      results.push({ name: t.name, pass: true, ms: +(performance.now() - start).toFixed(1) });
    } catch (e) {
      results.push({ name: t.name, pass: false, error: e.message, ms: +(performance.now() - start).toFixed(1) });
    }
    log(results[results.length - 1]);
  }
  const table = Object.keys(SCENARIOS).map((name) => runScenario(name).row);
  return { results, table, passed: results.filter((r) => r.pass).length, total: results.length };
}
