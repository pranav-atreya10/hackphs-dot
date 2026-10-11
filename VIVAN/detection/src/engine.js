// DetectionEngine: the whole detection pipeline behind one object.
//
//   frame (RGBA pixels) ──► MotionDetector ──► BlobLabeler ──► Tracker
//        ──► wingbeat analysis + debris check (gravity arc, spin)
//        ──► classification (+ sound fusion, Gemini/COCO verdicts)
//        ──► FlockGrouper ──► corridor ETA + bearings ──► RiskEngine
//        ──► events / track_batch (contract format) + a state snapshot for the UI
//
// The engine never touches the DOM or the network. The frontend feeds it frames
// and draws `state`; adapters/browser.js handles camera, crops, sockets and audio.

import { DEFAULTS, mergeConfig } from './config.js';
import { MotionDetector } from './motion.js';
import { BlobLabeler } from './blobs.js';
import { Tracker } from './tracker.js';
import { analyzeWingbeat } from './wingbeat.js';
import { gravityArc, spinCheck } from './debris.js';
import { FlockGrouper } from './flocks.js';
import { RiskEngine } from './risk.js';
import { DroneAudioState } from './audio.js';
import { etaToPolygon } from './geometry.js';
import { bearingFromX, elevationFromY, angularSpeedDps, motionHeading } from './geo.js';
import { buildEvent, buildTrackBatch, isoAt, r1, r3 } from './contract.js';

const KINDS = ['flapping', 'steady', 'irregular'];
const RISK_RANK = { green: 0, yellow: 1, red: 2 };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class DetectionEngine {
  constructor(config = {}) {
    this.cfg = mergeConfig(DEFAULTS, config);
    this.motion = new MotionDetector(this.cfg.motion);
    this.labeler = new BlobLabeler();
    this.tracker = new Tracker(this.cfg.tracker);
    this.grouper = new FlockGrouper(this.cfg.flocks);
    this.risk = new RiskEngine(this.cfg.risk);
    this.audio = new DroneAudioState(this.cfg.audio);
    this.motion.setSkyMask(this.cfg.skyMask.polygon);

    this.listeners = new Map();
    this.verdicts = new Map();    // trackId -> { verdict, label, source }
    this.cocoLabels = new Map();  // trackId -> { label, score }
    this.forcedSound = null;
    this.stats = newStats();
    this.lastT = null;
    this.wallOffset = null;
    this.state = null;
    this.resetReporting();
  }

  // ---------- configuration ----------

  // Deep-merge a partial config. Sub-objects are updated in place so every module sees the change.
  setConfig(patch) {
    assignDeep(this.cfg, patch);
    if (patch.skyMask) this.motion.setSkyMask(this.cfg.skyMask.polygon);
  }
  setSkyMask(polyNorm) { this.setConfig({ skyMask: { polygon: polyNorm || [] } }); }
  setCorridor(polyNorm) { this.setConfig({ corridor: { polygon: polyNorm || [] } }); }
  setCamera(cam) { this.setConfig({ camera: cam }); }
  getConfig() { return JSON.parse(JSON.stringify(this.cfg)); }

  // ---------- events ----------

  // Names: 'event', 'track_batch', 'risk_change', 'frame'. Returns an unsubscribe function.
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name).delete(fn);
  }
  emit(name, payload) {
    const set = this.listeners.get(name);
    if (set) for (const fn of set) fn(payload);
  }

  // ---------- inputs besides frames ----------

  // Drone sound probability 0..1 from the audio model or hum detector.
  setAudioProbability(prob, source = 'model') {
    if (this.forcedSound !== null) return;
    this.audio.update(prob, this.lastT ?? 0, source);
  }

  // For testing without a drone: force drone sound on (true), off (false), or back to the mic (null).
  simulateDroneSound(on) {
    this.forcedSound = on;
    if (on !== null) this.audio.update(on ? 1 : 0, this.lastT ?? 0, 'simulated');
  }

  // Gemini (or a human) verdict from the server.
  // { track_id?, flock_id?, verdict: 'bird'|'drone'|'rejected'|'unknown', label?, source? }
  applyVerdict(v) {
    const ids = [];
    if (v.track_id !== undefined && v.track_id !== null) ids.push(Number(v.track_id));
    if (v.flock_id) {
      const members = this.grouper.prev.get(v.flock_id);
      if (members) ids.push(...members);
    }
    const verdict = String(v.verdict || '').toLowerCase();
    for (const id of new Set(ids)) {
      if (this.verdicts.has(id)) continue; // count each track once
      const tr = this.tracker.tracks.find((x) => x.id === id);
      const ours = tr ? tr.cls : null;
      this.verdicts.set(id, { verdict, label: v.label || null, source: v.source || 'gemini' });
      if (verdict === 'rejected') this.stats.rejected++;
      else this.stats.confirmed++;
      if (ours && ours === verdict) this.stats.agree++;
      else this.stats.disagree++;
    }
  }

  // Second-opinion label (e.g. COCO-SSD) for a track. label: 'bird' | 'airplane' | 'kite' | other | null (nothing seen).
  applyLabel(trackId, label, score, source = 'coco', extra = {}) {
    const id = Number(trackId);
    const tr = this.tracker.tracks.find((x) => x.id === id);
    this.cocoLabels.set(id, { label, score, source, t: this.lastT, ...extra });
    if (tr) tr.cocoCheckedAt = this.lastT;
    const st = this.stats;
    st.cocoChecks++;
    if (label === 'bird') st.cocoBirds++;
    if (!label) { st.cocoNothing++; return; }
    if (this.cfg.coco.uninformative.includes(label)) { st.cocoVague++; return; }
    // Agreement with what the engine believed at the moment COCO answered.
    if (tr && tr.cls) {
      const cocoSaysBird = label === 'bird';
      const engineSaysBird = tr.cls === 'bird';
      if (cocoSaysBird === engineSaysBird) st.cocoAgree++;
      else st.cocoDisagree++;
    }
  }

  // Which tracks are worth a COCO-SSD look right now, best first.
  // sourceWidth/Height: full camera resolution (COCO runs on full-res crops).
  cocoCandidates({ sourceWidth, sourceHeight, max = 1 } = {}) {
    const c = this.cfg.coco;
    const t = this.lastT ?? 0;
    const out = [];
    for (const tr of this.tracker.tracks) {
      if (!tr.confirmed || tr.cls === 'rejected' || tr.cls === 'debris' || this.verdicts.has(tr.id)) continue;
      if (tr.cocoCheckedAt !== undefined && t - tr.cocoCheckedAt < c.cooldownSec) continue;
      const b = tr.blob;
      const w = this.motion.w, h = this.motion.h;
      const pxW = ((b.maxX - b.minX) / w) * sourceWidth;
      const pxH = ((b.maxY - b.minY) / h) * sourceHeight;
      const longSide = Math.max(pxW, pxH);
      if (longSide < c.minPx) continue;
      // Priority: unknowns first (a second opinion helps most), then bigger objects
      // (COCO can actually see their shape), then ones never checked.
      const priority = (tr.cls === 'unknown' ? 1000 : 0) + Math.min(longSide, 400) + (tr.cocoCheckedAt === undefined ? 50 : 0);
      out.push({
        id: tr.id,
        priority,
        longSidePx: Math.round(longSide),
        bbox: { x: b.minX / w, y: b.minY / h, w: (b.maxX - b.minX) / w, h: (b.maxY - b.minY) / h },
        classification: tr.cls,
      });
    }
    out.sort((a, b) => b.priority - a.priority);
    return out.slice(0, max);
  }

  reset() {
    this.motion.reset();
    this.tracker.reset();
    this.grouper.reset();
    this.risk.reset();
    this.verdicts.clear();
    this.cocoLabels.clear();
    this.stats = newStats();
    this.lastT = null;
    this.resetReporting();
  }

  resetReporting() {
    this.rep = { lastBatch: null, lastEvent: null, lastLevel: null, crops: new Map(), sentUpTo: new Map() };
  }

  // ---------- main entry ----------

  // frame: { data: Uint8ClampedArray RGBA, width, height } (an ImageData works).
  // t: seconds on the video's own clock (mediaTime for files, capture time for webcams).
  process(frame, t) {
    const t0 = now();
    const { data, width: w, height: h } = frame;
    const cfg = this.cfg;

    // Clip looped, seeked, or stalled: start tracking fresh.
    if (this.lastT !== null && (t < this.lastT - 1e-3 || t - this.lastT > 2)) {
      this.motion.reset();
      this.tracker.reset();
      this.grouper.reset();
      this.resetReporting();
    }
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    const wallNow = Date.now() / 1000;

    // Per-stage stopwatch: tells you which station to tune when a phone is slow.
    const timing = {};
    let lap = t0;
    const mark = (name) => { const n = now(); timing[name] = n - lap; lap = n; };

    // 1. Motion
    const m = this.motion.process(data, w, h);
    mark('motion');

    // 2. Blobs (+ merge broken pieces, + drop ghosts)
    let blobs = [];
    let overflow = false;
    let lab = { components: 0, merged: 0 };
    let ghosts = 0;
    if (m.ready) {
      lab = this.labeler.label(this.motion.dil, this.motion.fg, this.motion.diff, w, h, cfg.blobs);
      overflow = lab.overflow;
      blobs = overflow ? [] : lab.blobs;
      if (cfg.ghost.enabled && blobs.length) {
        blobs = blobs.filter((b) => {
          const g = this.motion.checkGhost(b, this.labeler.labels, cfg.ghost);
          b.ghostRatio = g.ratio;
          if (g.ghost) { this.motion.absorb(b, this.labeler.labels); ghosts++; }
          return !g.ghost;
        });
        this.stats.ghosts += ghosts;
      }
    }
    mark('blobs');

    // 3. Tracking (frozen during shake so tracks coast instead of dying)
    if (!m.shake && !overflow && m.ready) this.tracker.update(blobs, t);
    const all = this.tracker.tracks;
    const confirmed = all.filter((tr) => tr.confirmed);
    mark('track');

    // 4. Wingbeat + per-track classification
    if (this.forcedSound === null) this.audio.tick(t);
    const audio = this.audioSummary();
    for (const tr of confirmed) {
      if (!tr.counted) { tr.counted = true; this.stats.tracksConfirmed++; }
      tr.frameCount++;
      if (tr.frameCount % cfg.wingbeat.evalEvery === 0) {
        this.updateFlap(tr, analyzeWingbeat(tr.samples, cfg.wingbeat));
        this.updateDebris(tr);
      }
      this.classifyTrack(tr, audio);
    }
    mark('wingbeat');

    // 5. Flocks (rejected tracks and debris are left out)
    const live = confirmed.filter((tr) => tr.cls !== 'rejected' && tr.cls !== 'debris');
    const flocks = this.grouper.group(live, w);
    for (const tr of confirmed) tr.flockId = null;
    for (const f of flocks) {
      for (const tr of f.members) tr.flockId = f.id;
      this.classifyFlock(f);
    }

    // 6. Groups (flocks + lone tracks) with ETA, bearing, heading
    const groups = [];
    for (const f of flocks) groups.push(this.describeGroup('flock', f, w, h));
    for (const tr of confirmed) if (!tr.flockId) groups.push(this.describeGroup('track', tr, w, h));
    if (audio.active && !groups.some((g) => g.classification === 'drone')) {
      groups.push({ kind: 'audio', id: 'audio', size: 1, classification: 'drone', confidence: audio.confidence === 'high' ? 0.9 : 0.6,
        why: 'drone sound, nothing steady in view', eta_seconds: null, eta_range: null, bearing_deg: null, heading: null,
        flap_hz: null, label: '(heard, not seen)', bbox: null, member_ids: [] });
    }
    mark('groups');

    // 7. Risk
    const prevLevel = this.risk.level;
    const risk = this.risk.evaluate(groups, null, t);
    if (risk.level !== prevLevel) this.emit('risk_change', { from: prevLevel, to: risk.level, reasons: risk.reasons, t });
    // The single most important thing in view (drone > soonest ETA > biggest flock).
    // Hardware beacons and dashboards point at / describe this one.
    const primary = this.pickPrimary(groups);

    // 8. Public state for the UI
    const trackById = new Map();
    const tracksOut = confirmed.map((tr) => {
      const p = this.publicTrack(tr, w, h);
      trackById.set(tr.id, p);
      return p;
    });
    for (const g of groups) {
      if (g.kind === 'track') trackById.get(g.id).eta_seconds = r1(g.eta_seconds);
    }
    const flocksOut = groups.filter((g) => g.kind === 'flock').map((g) => publicGroup(g));

    const procMs = now() - t0;
    const st = this.stats;
    st.frames++;
    st.procMs = st.procMs ? st.procMs * 0.9 + procMs * 0.1 : procMs;
    if (dt > 0) st.fps = st.fps ? st.fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;
    for (const k in timing) st.stageMs[k] = st.stageMs[k] === undefined ? timing[k] : st.stageMs[k] * 0.9 + timing[k] * 0.1;

    this.state = {
      t,
      width: w,
      height: h,
      motion: {
        ready: m.ready,
        shake: m.shake,
        fgFraction: r3(m.fgFraction),       // share of the sky that changed this frame
        threshold: Math.round(m.threshold), // current change threshold (rises on noisy cameras)
        noise: r1(this.motion.noise),       // average sensor noise in gray levels
        components: lab.components,         // raw pieces found
        merged: lab.merged,                 // pieces joined to a neighbour (wing tips)
        ghosts,                             // blobs dropped as background ghosts this frame
        blobs: blobs.length,                // objects passed to the tracker
        overflow,
      },
      tracks: tracksOut,
      tentative: all.length - confirmed.length,
      flocks: flocksOut,
      groups: groups.map(publicGroup),
      primary: primary ? publicGroup(primary) : null,
      risk,
      audio,
      stats: this.publicStats(),
    };

    // 9. Outgoing messages
    this.report(groups, risk, t, wallNow, w, h);
    this.emit('frame', this.state);
    return this.state;
  }

  // ---------- internals ----------

  audioSummary() {
    const a = this.audio.snapshot();
    const steadyVisible = this.tracker.tracks.some((tr) => tr.confirmed && tr.profile === 'steady');
    return { ...a, confidence: a.active ? (steadyVisible ? 'high' : 'medium') : null };
  }

  updateFlap(tr, a) {
    if (a.kind === 'insufficient') return;
    tr.analysis = a;
    if (a.kind === 'too_small') { tr.profile = 'too_small'; return; }
    const s = this.cfg.wingbeat.smoothing;
    tr.scores = tr.scores || { flapping: 0, steady: 0, irregular: 0 };
    // A real wingbeat keeps its rhythm. If the beat rate jumps between analyses
    // (a tumbling bag), count this reading as irregular instead.
    // It only counts once `minConsistent` readings in a row have agreed with the one before.
    let kind = a.kind;
    tr.hzHistory = tr.hzHistory || [];
    if (kind === 'flapping') {
      const prev = tr.lastHz;
      tr.lastHz = a.hz;
      tr.hzHistory.push(+a.hz.toFixed(2));
      if (tr.hzHistory.length > 5) tr.hzHistory.shift();
      const agrees = prev && Math.abs(a.hz - prev) / prev <= this.cfg.wingbeat.hzTolerance;
      tr.hzStreak = agrees ? (tr.hzStreak || 0) + 1 : 0;
      if (tr.hzStreak < this.cfg.wingbeat.minConsistent) kind = 'irregular';
    } else {
      tr.lastHz = null;
      tr.hzStreak = 0;
    }
    for (const k of KINDS) tr.scores[k] += s * ((kind === k ? 1 : 0) - tr.scores[k]);
    if (kind === 'flapping') {
      tr.flapHz = tr.flapHz ? tr.flapHz + 0.4 * (a.hz - tr.flapHz) : a.hz;
      tr.flapStrength = a.strength;
    }
    let best = 'unsure';
    let bestScore = 0.5;
    for (const k of KINDS) if (tr.scores[k] > bestScore) { best = k; bestScore = tr.scores[k]; }
    // Once a track has clearly flapped, keep calling it flapping unless another verdict clearly wins.
    if (best === 'unsure' && tr.profile === 'flapping' && tr.scores.flapping > 0.3) best = 'flapping';
    tr.profile = best;
  }

  // Debris check (debris.js). Smoothed like the wingbeat verdict so one odd reading can't flip it:
  // a verdict switches on above 0.5 and only switches off again below 0.25.
  updateDebris(tr) {
    const c = this.cfg.debris;
    if (!c.enabled) { tr.isDebris = false; tr.tumbling = false; return; }
    const arc = gravityArc(tr.trail, tr.samples, c);
    const spin = spinCheck(tr.samples, c);
    tr.debris = { arc, spin };
    tr.arcScore = (tr.arcScore || 0) + c.smoothing * ((arc.arc ? 1 : 0) - (tr.arcScore || 0));
    tr.spinScore = (tr.spinScore || 0) + c.smoothing * ((spin.spinning ? 1 : 0) - (tr.spinScore || 0));
    tr.isDebris = tr.isDebris ? tr.arcScore > 0.25 : tr.arcScore > 0.5;
    tr.tumbling = tr.tumbling ? tr.spinScore > 0.25 : tr.spinScore > 0.5;
    if (arc.arc) tr.maxPull = Math.max(tr.maxPull || 0, arc.pull);
    if (spin.spinning) tr.maxTurnDeg = Math.max(tr.maxTurnDeg || 0, spin.turnDeg);
    if (tr.isDebris && !tr.debrisCounted) { tr.debrisCounted = true; this.stats.debris++; }
  }

  // Sets tr.cls / tr.conf / tr.why. Order of trust:
  //   1. a Gemini / human verdict
  //   2. physics: falls on a gravity arc => debris; spins end over end => not a wingbeat
  //   3. steady size + drone sound => drone; wingbeat => bird; COCO-SSD second opinion
  classifyTrack(tr, audio) {
    const v = this.verdicts.get(tr.id);
    if (v && (v.verdict === 'rejected' || v.verdict === 'bird' || v.verdict === 'drone')) {
      tr.cls = v.verdict;
      tr.conf = 0.95;
      tr.why = `${v.source}${v.label ? `: ${v.label}` : ''}`;
      return;
    }
    const dc = this.cfg.debris;
    if (tr.isDebris) {
      const pull = tr.maxPull || 0;
      tr.cls = 'debris';
      tr.conf = Math.min(0.95, 0.6 + 0.35 * Math.min(1, pull / dc.minPull - 1));
      tr.why = `falls like a thrown object: gravity arc, pull ${Math.round(pull)}/s² (birds stay under ${dc.minPull})`;
      return;
    }
    if (tr.tumbling) {
      tr.cls = 'unknown';
      tr.conf = 0.4;
      tr.why = `spins end over end like debris (turned ${tr.maxTurnDeg || 0}°), so its size pulses are not a wingbeat`;
      return;
    }
    const cc = this.cfg.coco;
    const raw = this.cocoLabels.get(tr.id);
    const coco = raw && raw.label && this.lastT - raw.t <= cc.maxAgeSec ? raw : null;
    const vague = coco && cc.uninformative.includes(coco.label);
    const cocoBird = coco && coco.label === 'bird' && coco.score >= cc.birdScore;
    const cocoNonBird = coco && !vague && coco.label !== 'bird' && coco.score >= cc.disagreeScore;
    if (tr.profile === 'steady' && audio.active) {
      tr.cls = 'drone'; tr.conf = 0.9; tr.why = 'steady track + drone sound';
    } else if (tr.profile === 'flapping') {
      // Wingbeat alone caps at 0.9; independent agreement (COCO, Gemini) can add the rest.
      tr.cls = 'bird'; tr.conf = 0.55 + 0.35 * Math.min(1, tr.flapStrength || 0); tr.why = `wingbeat ${(tr.flapHz || 0).toFixed(1)} Hz`;
      if (cocoBird) { tr.conf = Math.min(0.99, tr.conf + cc.agreeBoost); tr.why += ' + COCO bird'; }
      else if (cocoNonBird) { tr.conf = Math.max(0.3, tr.conf - cc.disagreePenalty); tr.why += ` (COCO says ${coco.label})`; }
    } else if (cocoBird) {
      tr.cls = 'bird'; tr.conf = 0.5 + 0.3 * coco.score; tr.why = `COCO-SSD: bird ${(coco.score * 100).toFixed(0)}%`;
    } else {
      tr.cls = 'unknown';
      tr.conf = 0.4;
      tr.why = tr.profile === 'steady' ? 'steady, no drone sound'
        : tr.profile === 'irregular' ? 'irregular size changes'
        : tr.profile === 'too_small' ? 'too small to judge' : 'analysing';
      if (coco) tr.why += ` (COCO: ${coco.label} ${(coco.score * 100).toFixed(0)}%)`;
    }
  }

  classifyFlock(f) {
    const ms = f.members;
    let cls = 'unknown';
    // Only members the debris check has already cleared count toward "birds by numbers alone":
    // a handful of thrown gravel also moves together, so wait until each path has been checked.
    const checked = (m) => !this.cfg.debris.enabled ||
      (m.debris && m.debris.arc.pull !== null && !m.debris.arc.arc && (m.arcScore || 0) < 0.25);
    const flyers = ms.filter((m) => !m.tumbling && checked(m));
    if (ms.some((m) => m.cls === 'drone')) cls = 'drone';
    else if (ms.some((m) => m.cls === 'bird') || flyers.length >= this.cfg.flocks.inferBirdAtSize) cls = 'bird';
    if (cls === 'bird') {
      for (const m of flyers) {
        if (m.cls === 'unknown') { m.cls = 'bird'; m.conf = 0.55; m.why = `flies with flock ${f.id}`; }
      }
    }
    f.cls = cls;
    const same = ms.filter((m) => m.cls === cls);
    f.conf = same.reduce((s, m) => s + m.conf, 0) / Math.max(1, same.length);
    const flapping = ms.filter((m) => m.flapHz && m.profile === 'flapping');
    f.flapHz = flapping.length ? flapping.reduce((s, m) => s + m.flapHz, 0) / flapping.length : null;
  }

  describeGroup(kind, o, w, h) {
    const cam = this.cfg.camera;
    const isFlock = kind === 'flock';
    // Decisions use the calm, line-fit velocity (svx); flocks already average it.
    const x = o.x / w, y = o.y / h;
    const vx = (isFlock ? o.vx : o.svx) / w, vy = (isFlock ? o.vy : o.svy) / h;
    const seX = o.seX / w, seY = o.seY / h;
    const bb = isFlock ? o.bbox : o.blob;
    const poly = this.cfg.corridor.polygon;
    const horizon = this.cfg.corridor.horizonSec;
    const eta = etaToPolygon(x, y, vx, vy, poly, horizon);
    return {
      kind,
      id: o.id,
      size: isFlock ? o.size : 1,
      classification: o.cls,
      confidence: o.conf,
      why: isFlock ? `${o.size} tracks flying together` : o.why,
      x, y, vx, vy,
      eta_seconds: eta,
      eta_range: etaRange(x, y, vx, vy, seX, seY, poly, horizon, this.cfg.corridor.etaSigma),
      bearing_deg: bearingFromX(x, cam.heading_deg, cam.hfov_deg),
      heading: motionHeading(vx, vy, cam.heading_deg),
      speed_dps: angularSpeedDps(vx, vy, cam.hfov_deg, h / w),
      flap_hz: isFlock ? o.flapHz : (o.profile === 'flapping' ? o.flapHz : null),
      bbox: bb ? { x: bb.minX / w, y: bb.minY / h, w: (bb.maxX - bb.minX) / w, h: (bb.maxY - bb.minY) / h } : null,
      member_ids: isFlock ? o.members.map((m) => m.id) : [o.id],
      label: isFlock ? o.id : `#${o.id}`,
    };
  }

  publicTrack(tr, w, h) {
    const cam = this.cfg.camera;
    const b = tr.blob;
    const x = tr.x / w, y = tr.y / h, vx = tr.svx / w, vy = tr.svy / h;
    const a = tr.analysis;
    const snr = b.meanContrast / Math.max(1, this.motion.noise);
    const hitRate = tr.hits / Math.max(1, tr.hits + tr.totalMisses);
    return {
      id: tr.id,
      x: r3(x), y: r3(y), vx: r3(vx), vy: r3(vy),
      bbox: { x: b.minX / w, y: b.minY / h, w: (b.maxX - b.minX) / w, h: (b.maxY - b.minY) / h },
      area: b.area,
      classification: tr.cls,
      confidence: r3(tr.conf),
      reason: tr.why,
      profile: tr.tumbling ? 'tumbling' : tr.profile || 'unsure',
      flap_hz: tr.profile === 'flapping' ? r1(tr.flapHz) : null,
      flap_strength: a ? r3(a.strength) : null,
      size_cv: a ? r3(a.cv) : null,
      flap_series: a ? a.series : null, // normalized -1..1 for a wingbeat graph
      bearing_deg: r1(bearingFromX(x, cam.heading_deg, cam.hfov_deg)),
      elevation_deg: r1(elevationFromY(y, cam.pitch_deg, cam.hfov_deg, h / w)),
      speed_dps: r1(angularSpeedDps(vx, vy, cam.hfov_deg, h / w)),
      heading: motionHeading(vx, vy, cam.heading_deg),
      eta_seconds: null,
      flock_id: tr.flockId,
      is_flock: !!tr.flockId,
      missed: tr.misses > 0,
      age: r1(tr.t - tr.born),
      trail: tr.trail.map(([, px, py]) => [r3(px / w), r3(py / h)]),
      verdict: this.verdicts.get(tr.id) || null,
      coco: (() => { const c = this.cocoLabels.get(tr.id); return c ? { label: c.label, score: r3(c.score), age: r1(this.lastT - c.t) } : null; })(),
      // 0..1: how much to trust this track (contrast above noise x how reliably it was seen)
      quality: r3(Math.min(1, snr / 8) * hitRate),
      diag: {
        snr: r1(snr),                       // blob contrast / sensor noise (higher = clearer)
        hits: tr.hits,
        hit_rate: r3(hitRate),
        misses_now: tr.misses,
        ghost_ratio: r3(b.ghostRatio ?? null), // ~1 real object, ~0 background ghost
        hz_history: tr.hzHistory || [],     // last beat-rate readings (should agree for a bird)
        hz_streak: tr.hzStreak || 0,        // readings in a row that agreed
        scores: tr.scores ? { flapping: r3(tr.scores.flapping), steady: r3(tr.scores.steady), irregular: r3(tr.scores.irregular) } : null,
        signal: a ? a.signal : null,        // which size signal showed the rhythm best
        by_signal: a ? a.bySignal || null : null, // rhythm found in each signal {hz, strength}
        vetoed: a ? a.vetoed || null : null,      // why a rhythm was ignored, if it was
        vel_se: Number.isFinite(tr.seX) ? r3(Math.hypot(tr.seX / w, tr.seY / h)) : null,
        // Debris check: gravity_arc {arc, pull, accel, fit, bendPx, reason}, spin {spinning, turnDeg, sameWay, reason}
        gravity_arc: tr.debris ? tr.debris.arc : null,
        spin: tr.debris ? tr.debris.spin : null,
      },
    };
  }

  publicStats() {
    const s = this.stats;
    const judged = s.agree + s.disagree;
    return {
      frames: s.frames,
      fps: r1(s.fps),
      proc_ms: r1(s.procMs),
      tracks_confirmed: s.tracksConfirmed,
      gemini_confirmed: s.confirmed,
      gemini_rejected: s.rejected,
      agreement_rate: judged ? r3(s.agree / judged) : null,
      coco_checks: s.cocoChecks,
      coco_birds: s.cocoBirds,
      coco_nothing: s.cocoNothing,           // crops where COCO saw nothing relevant (small/far objects)
      coco_vague: s.cocoVague,               // answers like kite/frisbee that carry no evidence
      coco_agreement: s.cocoAgree + s.cocoDisagree ? r3(s.cocoAgree / (s.cocoAgree + s.cocoDisagree)) : null,
      ghosts_removed: s.ghosts,
      debris_ignored: s.debris,              // tracks recognised as thrown/falling debris
      stage_ms: Object.fromEntries(Object.entries(s.stageMs).map(([k, v]) => [k, r3(v)])),
    };
  }

  // Most important group: drones, then the soonest corridor ETA, then the biggest flock.
  pickPrimary(groups) {
    const score = (g) => {
      if (g.classification === 'rejected' || g.classification === 'debris') return -1;
      let s = 0;
      if (g.classification === 'drone') s += 1e6;
      if (g.classification === 'bird') s += 1e4;
      if (g.eta_seconds !== null) s += 1e3 * (1 - Math.min(g.eta_seconds, 60) / 61);
      return s + g.size;
    };
    let best = null;
    for (const g of groups) if (score(g) >= 0 && (!best || score(g) > score(best))) best = g;
    return best;
  }

  report(groups, risk, t, wallNow, w, h) {
    const rep = this.rep;
    const c = this.cfg.report;
    const cam = this.cfg.camera;
    const wallAt = (tp) => wallNow - (t - tp);

    // track_batch: every confirmed track's recent positions, decimated to pointsPerSecond.
    if (rep.lastBatch === null) rep.lastBatch = t;
    if (t - rep.lastBatch >= c.batchIntervalSec) {
      rep.lastBatch = t;
      const points = [];
      const minGap = 1 / c.pointsPerSecond;
      for (const tr of this.tracker.tracks) {
        if (!tr.confirmed) continue;
        let last = rep.sentUpTo.get(tr.id) ?? -Infinity;
        const speed = angularSpeedDps(tr.svx / w, tr.svy / h, cam.hfov_deg, h / w);
        for (const [tp, px, py] of tr.trail) {
          if (tp - last < minGap) continue;
          last = tp;
          points.push({
            time: isoAt(wallAt(tp)),
            track_id: tr.id,
            x: r3(px / w),
            y: r3(py / h),
            bearing_deg: r1(bearingFromX(px / w, cam.heading_deg, cam.hfov_deg)),
            speed: r1(speed),
            flap_hz: tr.profile === 'flapping' ? r1(tr.flapHz) : null,
            is_flock: !!tr.flockId,
            flock_id: tr.flockId,
            classification: tr.cls,
          });
        }
        rep.sentUpTo.set(tr.id, last);
      }
      if (points.length) this.emit('track_batch', buildTrackBatch(this.cfg, points, wallNow));
    }

    // event: on every risk change, then a heartbeat while yellow/red (slower when green).
    const changed = risk.level !== rep.lastLevel;
    const every = risk.level === 'green' ? c.greenHeartbeatSec : c.heartbeatSec;
    if (!changed && rep.lastEvent !== null && t - rep.lastEvent < every) return;
    rep.lastEvent = t;
    rep.lastLevel = risk.level;

    const primary = risk.level === 'green' ? null : this.pickPrimary(groups);
    let crop = null;
    let evidence = null;
    if (primary && primary.kind !== 'audio') {
      const lastCrop = rep.crops.get(primary.id);
      if (primary.bbox && (lastCrop === undefined || t - lastCrop >= c.cropMinIntervalSec)) {
        rep.crops.set(primary.id, t);
        crop = padBox(primary.bbox, c.cropPad);
      }
      evidence = this.evidenceFor(primary, t, wallNow, w);
    }
    const ev = buildEvent({ cfg: this.cfg, risk, primary, groups, wallNow, evidence, crop });
    if (RISK_RANK[risk.level] > 0 || changed) this.stats.events++;
    this.emit('event', ev);
  }

  // Track points behind an event; together with the crop this is the bundle that gets hashed for Solana.
  evidenceFor(g, t, wallNow, w) {
    const cam = this.cfg.camera;
    const ids = new Set(g.member_ids);
    const pts = [];
    for (const tr of this.tracker.tracks) {
      if (!ids.has(tr.id)) continue;
      for (const [tp, px, py] of tr.trail) pts.push({ time: isoAt(wallNow - (t - tp)), track_id: tr.id, x: r3(px / w), y: r3(py / this.motion.h), bearing_deg: r1(bearingFromX(px / w, cam.heading_deg, cam.hfov_deg)) });
    }
    pts.sort((a, b) => (a.time < b.time ? -1 : 1));
    const keep = this.cfg.report.evidencePoints;
    const step = Math.max(1, Math.ceil(pts.length / keep));
    return {
      track_points: pts.filter((_, i) => i % step === 0).slice(-keep),
      flap_hz: r1(g.flap_hz),
      classification: g.classification,
      reason: g.why,
    };
  }
}

function newStats() {
  return { frames: 0, fps: 0, procMs: 0, stageMs: {}, ghosts: 0, debris: 0, tracksConfirmed: 0, confirmed: 0, rejected: 0, agree: 0, disagree: 0, cocoChecks: 0, cocoBirds: 0, cocoNothing: 0, cocoVague: 0, cocoAgree: 0, cocoDisagree: 0, events: 0 };
}

// ETA range: redo the ETA with the velocity nudged by ±sigma standard errors in x and y
// (four corners) and report the earliest and latest arrival. Wide range = unsteady flight.
function etaRange(x, y, vx, vy, seX, seY, poly, horizon, sigma) {
  if (!poly || poly.length < 3 || !Number.isFinite(seX) || !Number.isFinite(seY)) return null;
  const etas = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const e = etaToPolygon(x, y, vx + sx * sigma * seX, vy + sy * sigma * seY, poly, horizon);
      if (e !== null) etas.push(e);
    }
  }
  if (!etas.length) return null;
  return [r1(Math.min(...etas)), r1(Math.max(...etas)), etas.length === 4 ? 'certain' : 'possible'];
}

function publicGroup(g) {
  return {
    kind: g.kind,
    id: g.id,
    size: g.size,
    classification: g.classification,
    confidence: r3(g.confidence),
    reason: g.why,
    x: r3(g.x), y: r3(g.y), vx: r3(g.vx), vy: r3(g.vy),
    eta_seconds: r1(g.eta_seconds),
    eta_range: g.eta_range,
    bearing_deg: r1(g.bearing_deg),
    heading: g.heading,
    speed_dps: r1(g.speed_dps),
    flap_hz: r1(g.flap_hz),
    bbox: g.bbox,
    member_ids: g.member_ids,
  };
}

function padBox(b, pad) {
  const side = Math.max(b.w, b.h);
  const px = b.w * pad + side * 0.25;
  const py = b.h * pad + side * 0.25;
  const x0 = Math.max(0, b.x - px), y0 = Math.max(0, b.y - py);
  const x1 = Math.min(1, b.x + b.w + px), y1 = Math.min(1, b.y + b.h + py);
  return { x: r3(x0), y: r3(y0), w: r3(x1 - x0), h: r3(y1 - y0) };
}

function assignDeep(target, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      assignDeep(target[k], v);
    } else {
      target[k] = Array.isArray(v) ? v.map((p) => (Array.isArray(p) ? [...p] : p)) : v;
    }
  }
}
