// Engine flock probe: drives Vivan's DetectionEngine (read-only import, no engine code changed)
// with synthetic frames and measures what happens with many small birds, a drone inside/near the
// flock, tiny objects, fast objects and crossing paths.
//
//   node "Shreyansh Local Ai Model/engine_flock_probe.mjs"            # all probes (~1-2 min)
//   node "Shreyansh Local Ai Model/engine_flock_probe.mjs" --quick    # fewer seeds
//
// Frames are rendered with the team's own SyntheticSky (VIVAN/detection/src/synthetic.js): same sky
// gradient, drifting clouds and sensor noise. We start it with the built-in 'empty' scene and replace
// its object list with our own birds / drone (the object models below copy synthetic.js's bird() and
// drone()), so nothing inside VIVAN/ is modified. Processing size is the engine default, 320x240.
//
// Ground truth is known for every object in every frame, so we can check:
//   - how many birds have their own confirmed track (one-to-one match within a few px)
//   - whether the drone has its own track AND its own box (no bird centre inside its blob box)
//   - track-ID switches, swaps and merges when paths cross
//   - engine.process() time per frame (rendering not included)

import { DetectionEngine } from '../VIVAN/detection/src/engine.js';
import { SyntheticSky, mulberry32 } from '../VIVAN/detection/src/synthetic.js';
import { DEFAULTS } from '../VIVAN/detection/src/config.js';

const QUICK = process.argv.includes('--quick');
const W = 320, H = 240;

// ---------- object models (copies of synthetic.js bird()/drone(), plus straight-line drone) ----------
function bird(x0, y0, vx, vy, hz, phase, span, dark = 0.55) {
  return {
    type: 'bird', span,
    at(t) {
      const ph = 2 * Math.PI * hz * t + phase;
      const open = 0.5 + 0.5 * Math.cos(ph);
      return {
        x: x0 + vx * t,
        y: y0 + vy * t + 0.6 * Math.sin(ph) * Math.min(1, span / 3),
        rx: span * (0.45 + 0.55 * open),
        ry: span * 0.22 * (1 + 0.8 * Math.abs(Math.sin(ph))),
        dark,
      };
    },
  };
}
// Steady-size drone moving in a straight line (same body as synthetic.js drone(): rx 4.2, ry 2.6, dark 0.6).
function drone(x0, y0, vx, vy, rx = 4.2, ry = 2.6) {
  return { type: 'drone', span: rx, at(t) { return { x: x0 + vx * t, y: y0 + vy * t + 0.5 * Math.sin(t * 0.7), rx, ry, dark: 0.6 }; } };
}

// ---------- one run ----------
function run({ objects, seconds = 8, fps = 30, seed = 7, audio = false, config = {}, warm = 1.0 }) {
  const sky = new SyntheticSky({ width: W, height: H, scenario: 'empty', seed });
  sky.objects = objects; // replace the empty scene's (empty) object list on this instance only
  const engine = new DetectionEngine(config);
  const frames = Math.round(seconds * fps);
  const procMs = [];
  const per = []; // per-frame measurements after warm-up
  const idHist = objects.map(() => []); // matched track id per frame (null = not matched)
  let overflowFrames = 0;
  let state;
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    if (i % 3 === 0) engine.setAudioProbability(audio ? 0.95 : 0.05, 'synthetic');
    const frame = sky.render(t);
    const t0 = performance.now();
    state = engine.process(frame, t);
    procMs.push(performance.now() - t0);
    if (state.motion.overflow) overflowFrames++;
    // ground truth positions in processing pixels (scale = 1 at 320 px)
    const truth = objects.map((o) => { const s = o.at(t); return { x: s.x, y: s.y, type: o.type, span: o.span, inView: s.x > 2 && s.x < W - 2 && s.y > 2 && s.y < H - 2 }; });
    const confirmed = engine.tracker.tracks.filter((tr) => tr.confirmed);
    // greedy closest-first one-to-one matching, gate = max(4, 1.2*span) px
    const pairs = [];
    truth.forEach((g, gi) => {
      if (!g.inView) return;
      const gate = Math.max(4, 1.2 * g.span);
      confirmed.forEach((tr, ti) => { const d = Math.hypot(tr.x - g.x, tr.y - g.y); if (d < gate) pairs.push([d, gi, ti]); });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const gUsed = new Map(), tUsed = new Set();
    for (const [, gi, ti] of pairs) { if (gUsed.has(gi) || tUsed.has(ti)) continue; gUsed.set(gi, ti); tUsed.add(ti); }
    truth.forEach((g, gi) => idHist[gi].push(gUsed.has(gi) ? confirmed[gUsed.get(gi)].id : null));
    if (t < warm) continue;
    // does each object's blob box hold any OTHER object's centre? (= merged / not its own box)
    const ownBox = truth.map((g, gi) => {
      if (!gUsed.has(gi)) return null;
      const b = confirmed[gUsed.get(gi)].blob;
      return !truth.some((o, oi) => oi !== gi && o.inView && o.x >= b.minX - 0.5 && o.x <= b.maxX + 0.5 && o.y >= b.minY - 0.5 && o.y <= b.maxY + 0.5);
    });
    const tracksAll = engine.tracker.tracks;
    per.push({
      t,
      inView: truth.filter((g) => g.inView).length,
      blobs: state.motion.blobs,
      components: state.motion.components,
      confirmed: confirmed.length,
      tentative: tracksAll.length - confirmed.length,
      flocks: state.flocks.length,
      // what the engine would report as the number of objects in view: sum of group sizes
      // (a flock counts its members, and a merged "dense flock" blob counts its dark cores)
      counted: state.groups.filter((g) => g.kind !== 'audio').reduce((s, g) => s + g.size, 0),
      flockSizes: state.flocks.map((f) => f.size).sort((a, b) => b - a),
      birdsMatched: truth.filter((g, gi) => g.type === 'bird' && g.inView && gUsed.has(gi)).length,
      birdsOwnBox: truth.filter((g, gi) => g.type === 'bird' && ownBox[gi]).length,
      ownBox,
      matchedTrack: truth.map((g, gi) => (gUsed.has(gi) ? confirmed[gUsed.get(gi)] : null)),
    });
  }
  procMs.sort((a, b) => a - b);
  const stats = {
    msMean: procMs.reduce((a, b) => a + b, 0) / procMs.length,
    msP95: procMs[Math.floor(0.95 * (procMs.length - 1))],
    stageMs: state.stats.stage_ms,
    overflowFrames,
  };
  return { engine, per, idHist, stats, state, objects };
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const pct = (x) => `${Math.round(100 * x)}%`;

// Longest run of the same non-null id, and how many distinct ids an object had.
function idSummary(ids) {
  let best = 0, cur = 0, prev = null;
  const distinct = new Set();
  for (const id of ids) {
    if (id !== null) distinct.add(id);
    if (id !== null && id === prev) cur++; else cur = id === null ? 0 : 1;
    prev = id;
    best = Math.max(best, cur);
  }
  return { longestRun: best, distinctIds: distinct.size };
}

// ---------- scene builders ----------
// n birds in a jittered grid, `spacing` px apart, flying right at `vx` px/s.
function flock(n, { spacing = 10, x0 = 40, y0 = null, vx = 15, vy = 0, span = 3, rng }) {
  const cols = Math.ceil(Math.sqrt(n * 1.5));
  const rows = Math.ceil(n / cols);
  const top = y0 ?? (H / 2 - ((rows - 1) * spacing) / 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    out.push(bird(x0 + c * spacing + (rng() - 0.5) * spacing * 0.4, top + r * spacing + (rng() - 0.5) * spacing * 0.4,
      vx + (rng() - 0.5) * 2, vy + (rng() - 0.5) * 2, 4 + rng() * 2, rng() * 6.28, span));
  }
  const xs = out.map((o) => o.at(0).x), ys = out.map((o) => o.at(0).y);
  return { birds: out, cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2,
    w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function droneReport(r, di) {
  const per = r.per;
  const seen = per.filter((p) => p.matchedTrack[di]);
  const own = per.filter((p) => p.ownBox[di] === true);
  const inFlock = seen.filter((p) => p.matchedTrack[di].flockId);
  const ids = idSummary(r.idHist[di]);
  const last = [...per].reverse().find((p) => p.matchedTrack[di]);
  const tr = last ? last.matchedTrack[di] : null;
  return {
    trackedFrac: seen.length / per.length,
    ownBoxFrac: own.length / per.length,
    inFlockFrac: seen.length ? inFlock.length / seen.length : 0,
    distinctIds: ids.distinctIds,
    longestRunSec: ids.longestRun / 30,
    lastCls: tr ? `${tr.cls} (${tr.why})` : 'not tracked at end',
  };
}

const lines = [];
const log = (s = '') => { lines.push(s); console.log(s); };

// =====================================================================================
// 1. Mass flock + one drone crossing through it
// =====================================================================================
log('== 1. N small birds (span 3 px = ~3-6 px wide) flying right at ~15 px/s, spacing 10 px, + 1 drone ==');
log('Engine limits in play: blobs.maxBlobs=' + DEFAULTS.blobs.maxBlobs + ' components/frame, flocks.radiusFrac=' + DEFAULTS.flocks.radiusFrac +
  ' (' + (DEFAULTS.flocks.radiusFrac * W).toFixed(1) + ' px), maxHeadingDiff=' + DEFAULTS.flocks.maxHeadingDiff + ' deg');
log('drone modes: "cross" = drone flies up-right through the flock centre (heading ~-45 deg vs birds 0 deg);');
log('             "with"  = drone flies with the flock (same heading, slightly faster), starting inside it.');
log('');
log('N    drone  blobs  confirmed  counted  birds-own-track  flocks(largest)  drone-tracked  drone-own-box  drone-in-flock  drone-ids  drone-final-class                       ms/frame(mean/p95)  overflow');
const massRows = [];
for (const n of [10, 30, 60, 100]) {
  for (const mode of ['cross', 'with']) {
    const rng = mulberry32(100 + n);
    const f = flock(n, { spacing: 10, rng });
    const d = mode === 'cross'
      ? drone(f.cx - 20, f.cy + 20, 14, -14)   // passes through the flock centre at ~t=1.4 s relative to the birds
      : drone(f.cx, f.cy, 18, 0);
    const objects = [...f.birds, d];
    const r = run({ objects, seconds: 8, seed: 7 + n });
    const p = r.per;
    const late = p.filter((x) => x.t > 2);
    const dr = droneReport(r, objects.length - 1);
    const row = {
      n, mode,
      blobs: median(late.map((x) => x.blobs)),
      confirmed: median(late.map((x) => x.confirmed)),
      counted: median(late.map((x) => x.counted)),
      birdsOwn: median(late.map((x) => x.birdsOwnBox)),
      flocks: median(late.map((x) => x.flocks)),
      largest: median(late.map((x) => x.flockSizes[0] || 0)),
      ...dr, ...r.stats,
    };
    massRows.push(row);
    if (n === 100 && mode === 'cross') var stage100 = r.stats.stageMs;
    log(`${String(n).padEnd(4)} ${mode.padEnd(6)} ${String(row.blobs).padEnd(6)} ${String(row.confirmed).padEnd(10)} ${String(row.counted).padEnd(8)} ${(row.birdsOwn + '/' + n).padEnd(16)} ${(row.flocks + ' (' + row.largest + ')').padEnd(16)} ${pct(dr.trackedFrac).padEnd(14)} ${pct(dr.ownBoxFrac).padEnd(14)} ${pct(dr.inFlockFrac).padEnd(15)} ${String(dr.distinctIds).padEnd(10)} ${dr.lastCls.slice(0, 38).padEnd(39)} ${row.msMean.toFixed(2)}/${row.msP95.toFixed(2)}          ${row.overflowFrames}`);
  }
}

log('stage ms (smoothed) at N=100 cross: ' + JSON.stringify(stage100));

// Same flock size, different gaps between birds: is it the count or the spacing that hurts?
log('');
log('-- spacing sweep: 60 birds (span 3, wings ~6 px), drone crossing, flock moving 10 px/s --');
for (const spacing of [6, 8, 10, 14, 18]) {
  const rng = mulberry32(170);
  const f = flock(60, { spacing, x0: 20, vx: 10, rng });
  const objects = [...f.birds, drone(f.cx - 20, f.cy + 20, 9, -14)];
  const r = run({ objects, seconds: 8, seed: 62 });
  const late = r.per.filter((x) => x.t > 2);
  const dr = droneReport(r, objects.length - 1);
  log(`spacing ${String(spacing).padStart(2)} px: blobs ${median(late.map((x) => x.blobs))}, confirmed ${median(late.map((x) => x.confirmed))}, engine count ${median(late.map((x) => x.counted))}, birds with own track ${median(late.map((x) => x.birdsOwnBox))}/60, flocks ${median(late.map((x) => x.flocks))} (largest ${median(late.map((x) => x.flockSizes[0] || 0))}); drone tracked ${pct(dr.trackedFrac)}, own box ${pct(dr.ownBoxFrac)}, in a flock ${pct(dr.inFlockFrac)}, ids ${dr.distinctIds}; ${r.stats.msMean.toFixed(2)} ms/frame`);
}

// Same 60-bird flock but packed tightly (outlines touch), and with drone sound on.
log('');
log('-- variants at N=60 --');
for (const v of [
  { name: 'tight spacing 6 px, drone cross', spacing: 6, mode: 'cross' },
  { name: 'tight spacing 4 px, drone cross', spacing: 4, mode: 'cross' },
  { name: 'spacing 10, drone WITH flock + drone sound', spacing: 10, mode: 'with', audio: true },
  { name: 'spacing 10, drone CROSS + drone sound', spacing: 10, mode: 'cross', audio: true },
  { name: 'spacing 10, drone hovering inside flock path', spacing: 10, mode: 'hover' },
]) {
  const rng = mulberry32(160);
  const f = flock(60, { spacing: v.spacing, rng });
  const d = v.mode === 'cross' ? drone(f.cx - 20, f.cy + 20, 14, -14)
    : v.mode === 'with' ? drone(f.cx, f.cy, 18, 0)
      : drone(f.cx + 60, f.cy, 0.5, 0);
  const objects = [...f.birds, d];
  const r = run({ objects, seconds: 8, seed: 61, audio: !!v.audio });
  const late = r.per.filter((x) => x.t > 2);
  const dr = droneReport(r, objects.length - 1);
  const flockCls = r.state.flocks.map((g) => `${g.id}:${g.classification}x${g.size}`).join(' ');
  log(`${v.name.padEnd(46)} blobs ${median(late.map((x) => x.blobs))}, confirmed ${median(late.map((x) => x.confirmed))}, engine count ${median(late.map((x) => x.counted))}, birds w/ own track ${median(late.map((x) => x.birdsOwnBox))}/60, ` +
    `largest flock ${median(late.map((x) => x.flockSizes[0] || 0))}; drone tracked ${pct(dr.trackedFrac)}, own box ${pct(dr.ownBoxFrac)}, in a flock ${pct(dr.inFlockFrac)}, ids ${dr.distinctIds}; ` +
    `drone final: ${dr.lastCls}; flocks at end: ${flockCls || 'none'}; ${r.stats.msMean.toFixed(2)} ms/frame`);
}

// Per-frame component cap: how many separate dots before the engine skips frames?
log('');
log('-- blob cap: widely spaced single dots (spacing 14 px, so each is its own component) --');
for (const n of [150, 200, 250, 300]) {
  const rng = mulberry32(300 + n);
  const f = flock(n, { spacing: 14, x0: 10, vx: 6, rng, span: 2.5 });
  const r = run({ objects: f.birds, seconds: 4, seed: 3 });
  const late = r.per.filter((x) => x.t > 2);
  log(`N=${n}: dots in view ${median(late.map((x) => x.inView))}, components ${median(late.map((x) => x.components))}, overflow (skipped) frames ${r.stats.overflowFrames}/${Math.round(4 * 30)}, confirmed tracks ${median(late.map((x) => x.confirmed))}, ${r.stats.msMean.toFixed(2)} ms/frame`);
}

// =====================================================================================
// 2. Tiny objects (2-4 px)
// =====================================================================================
log('');
log('== 2. Tiny birds: 20 birds spread out (spacing 14 px) at a given full wingspan; dark 0.55 like the team scenes ==');
log('(span param = half-length; full width with wings open ~= 2 x span)');
for (const width of [2, 3, 4, 6]) {
  for (const dark of [0.55, 0.3]) {
    const rng = mulberry32(400 + width);
    const f = flock(20, { spacing: 14, span: width / 2, rng });
    f.birds.forEach((b) => { const at = b.at; b.at = (t) => ({ ...at(t), dark }); });
    const r = run({ objects: f.birds, seconds: 6, seed: 9 });
    const late = r.per.filter((x) => x.t > 2);
    log(`width ~${width} px, darkness ${dark}: blobs ${median(late.map((x) => x.blobs))}, confirmed ${median(late.map((x) => x.confirmed))}, birds with own track ${median(late.map((x) => x.birdsOwnBox))}/20`);
  }
}
log('note: blobs.minArea = ' + DEFAULTS.blobs.minArea + ' raw changed pixels; the distant_birds preset lowers it to 2.');
{
  const rng = mulberry32(402);
  const f = flock(20, { spacing: 14, span: 1, rng });
  const r = run({ objects: f.birds, seconds: 6, seed: 9, config: { motion: { threshold: 12, dilate: 1 }, blobs: { minArea: 2, mergeGap: 1 }, tracker: { confirmFrames: 5, minTravel: 2 } } });
  const late = r.per.filter((x) => x.t > 2);
  log(`width ~2 px with the distant_birds preset: confirmed ${median(late.map((x) => x.confirmed))}, birds with own track ${median(late.map((x) => x.birdsOwnBox))}/20`);
}

// =====================================================================================
// 3. Fast objects (px per frame at 30 fps)
// =====================================================================================
log('');
log('== 3. Fast single objects crossing the frame (30 fps, tracker.maxJump=' + DEFAULTS.tracker.maxJump + ' px, predictedGate=' + DEFAULTS.tracker.predictedGate + ') ==');
log('(no motion blur is drawn: a real fast bird would also be smeared and fainter, which makes this optimistic)');
for (const kind of ['bird', 'drone']) {
  for (const ppf of [4, 10, 15, 20, 24, 30]) {
    const vx = ppf * 30;
    const enter = 0.8; // enter the frame after the engine's 0.5 s background warm-up
    const seconds = enter + (W + 40) / vx + 0.2;
    const x0 = -10 - vx * enter;
    const o = kind === 'bird' ? bird(x0, 120, vx, 0, 6, 0, 5) : drone(x0, 120, vx, 0);
    const r = run({ objects: [o], seconds, seed: 5, warm: 0.6 });
    const ids = idSummary(r.idHist[0]);
    const inView = r.idHist[0].filter((_, i) => { const x = o.at(i / 30).x; return x > 2 && x < W - 2; }).length;
    const matched = r.idHist[0].filter((x) => x !== null).length;
    log(`${kind} ${String(ppf).padStart(2)} px/frame (${vx} px/s): in view ${inView} frames; frames with a confirmed track on it ${matched}/${inView}, distinct ids ${ids.distinctIds}, longest same-id run ${ids.longestRun} frames`);
  }
}
{
  // phone at 15 fps: same speed in px/s doubles the per-frame jump; try the phone preset
  for (const ppf of [20, 30, 36]) {
    const vx = ppf * 15;
    const o = bird(-10 - vx * 1.2, 120, vx, 0, 6, 0, 5); // enters after warm-up (15 frames = 1 s at 15 fps)
    const r = run({ objects: [o], seconds: 1.2 + (W + 40) / vx + 0.3, fps: 15, seed: 5, warm: 0.6, config: { tracker: { maxJump: 36, confirmFrames: 3, maxMisses: 4, minTravel: 2 }, wingbeat: { windowSec: 2.0, minSamples: 12, evalEvery: 1 } } });
    const matched = r.idHist[0].filter((x) => x !== null).length;
    const inView = r.idHist[0].filter((_, i) => { const x = o.at(i / 15).x; return x > 2 && x < W - 2; }).length;
    log(`bird ${ppf} px/frame at 15 fps with the phone_15fps preset (maxJump 36): frames with a confirmed track ${matched}/${inView}, distinct ids ${idSummary(r.idHist[0]).distinctIds}`);
  }
}

// =====================================================================================
// 4. Crossing paths: identity kept, swapped or merged?
// =====================================================================================
log('');
log('== 4. Crossing paths (identity before vs after the crossing; several seeds) ==');
function crossing(name, makeObjects, { seeds, seconds = 6, crossT, beforeDt = 0.6, afterDt = 0.8 }) {
  let kept = 0, swapped = 0, lost = 0, mergedFrames = 0, total = 0, frames = 0;
  const notes = [];
  for (const seed of seeds) {
    const objects = makeObjects(mulberry32(seed));
    const r = run({ objects, seconds, seed, warm: 0.5 });
    const fps = 30;
    const before = Math.round((crossT - beforeDt) * fps), after = Math.round((crossT + afterDt) * fps);
    const idsBefore = r.idHist.map((h) => h[before]);
    const idsAfter = r.idHist.map((h) => h[Math.min(after, h.length - 1)]);
    objects.forEach((o, i) => {
      total++;
      if (idsBefore[i] === null || idsAfter[i] === null) { lost++; return; }
      if (idsBefore[i] === idsAfter[i]) { kept++; return; }
      if (idsBefore.includes(idsAfter[i])) swapped++; else lost++; // new id = track broke and restarted
    });
    // merged: frames near the crossing where an object has no box of its own
    for (const p of r.per) {
      if (Math.abs(p.t - crossT) > 0.5) continue;
      frames++;
      if (p.ownBox.some((x) => x === false)) mergedFrames++;
    }
    if (seed === seeds[0]) notes.push(`seed ${seed}: ids before ${JSON.stringify(idsBefore)} after ${JSON.stringify(idsAfter)}`);
  }
  log(`${name.padEnd(52)} kept id ${kept}/${total}, swapped ${swapped}, lost/new id/no own track ${lost}; frames within 0.5 s of crossing where an object shares a box: ${pct(mergedFrames / Math.max(1, frames))}   [${notes[0]}]`);
}
const seeds = QUICK ? [1, 2] : [1, 2, 3, 4, 5, 6];
// two birds meeting at the centre (160,120) at t=3 s
const meet = (angleDeg, speed, span = 5) => (rng) => {
  const a = (angleDeg / 2) * Math.PI / 180;
  const vx = speed * Math.cos(a), vy = speed * Math.sin(a);
  return [
    bird(160 - 3 * vx, 120 - 3 * vy, vx, vy, 4 + rng(), rng() * 6.28, span),
    bird(160 - 3 * vx, 120 + 3 * vy, vx, -vy, 4 + rng(), rng() * 6.28, span),
  ];
};
crossing('2 birds, 90 deg X, 25 px/s, span 5', meet(90, 25), { seeds, crossT: 3 });
crossing('2 birds, 30 deg (shallow) X, 25 px/s, span 5', meet(30, 25), { seeds, crossT: 3 });
crossing('2 birds, 10 deg (nearly parallel), 25 px/s', meet(10, 25), { seeds, crossT: 3 });
crossing('2 tiny birds, 90 deg X, span 2', meet(90, 25, 2), { seeds, crossT: 3 });
crossing('2 birds head-on (180 deg), 25 px/s', (rng) => [
  bird(85, 120, 25, 0, 4 + rng(), rng() * 6.28, 5), bird(235, 120.5, -25, 0, 4 + rng(), rng() * 6.28, 5)], { seeds, crossT: 3 });
crossing('2 fast birds, 90 deg X, 10 px/frame (300 px/s)', (rng) => [
  bird(160 - 212 * 2, 120 - 212 * 2, 212, 212, 6, rng() * 6.28, 5),
  bird(160 - 212 * 2, 120 + 212 * 2, 212, -212, 6, rng() * 6.28, 5)], { seeds, crossT: 2, seconds: 2.7, beforeDt: 0.25, afterDt: 0.25 });
crossing('4 birds crossing at one point (star), 25 px/s', (rng) => [0, 45, 90, 135].map((deg) => {
  const a = deg * Math.PI / 180, vx = 25 * Math.cos(a), vy = 25 * Math.sin(a);
  return bird(160 - 3 * vx, 120 - 3 * vy, vx, vy, 4 + rng(), rng() * 6.28, 5);
}), { seeds, crossT: 3 });
crossing('drone crossing a bird, 90 deg X', (rng) => [
  bird(160 - 3 * 17.7, 120 - 3 * 17.7, 17.7, 17.7, 4 + rng(), rng() * 6.28, 5),
  drone(160 - 3 * 17.7, 120 + 3 * 17.7, 17.7, -17.7)], { seeds, crossT: 3 });
crossing('drone crossing a bird, 20 deg (shallow)', (rng) => [
  bird(160 - 3 * 24.6, 120 - 3 * 4.3, 24.6, 4.3, 4 + rng(), rng() * 6.28, 5),
  drone(160 - 3 * 24.6, 120 + 3 * 4.3, 24.6, -4.3)], { seeds, crossT: 3 });
crossing('drone overtaking a bird on the same line', (rng) => [
  bird(100, 120, 15, 0, 4 + rng(), rng() * 6.28, 5),
  drone(40, 120.5, 35, 0)], { seeds, crossT: 3 });

log('');
log('done.');
