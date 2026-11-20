// Live camera feeds on the tower, with the bot's overlay.
//
// Live overlays come only from fresh server results. Recorded demos are local and never alert.
import { DetectionEngine, PRESETS } from '../detection/index.js';
import { DetectorStatus } from './detector-status.mjs';
import { BirdFramePairs } from './bird-evidence.js';
import { createReticleInterpolator, drawCornerReticle, hasActiveReticleMotion } from './hud-reticles.mjs';
import { drawVoteProgressRing, toVoteRingState } from './hud-vote-ring.mjs';
import { createFlightForecaster } from './flight-forecast.mjs';
import { drawForecastCone } from './hud-forecast-cone.mjs';
import { createCanvasSizer, createFrameBudgetLoop } from './frame-budget.mjs';

const COLORS = { bird: '#4f9cff', drone: '#ff5a4a', unknown: '#f2b705', rejected: 'rgba(200,200,200,.5)', debris: '#a08c78' };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
// When a camera sends no video (or no camera is connected at all), a recorded demo clip plays in its place.
// Demo footage runs the detector locally only for the boxes: it never emits events, alerts or incidents.
const DEMO_AFTER_MS = 4000;
const DEMO_CLIPS = ['gulls-sky', 'starling-murmuration', 'geese-beach', 'padilla-birds', 'drone-hover'];
const LOCK_ON_MS = 220;
const DEFAULT_INTERP_MS = 68, MIN_INTERP_MS = 32, MAX_INTERP_MS = 140;
const MAX_TRACK_GAP_MS = 600, TELEPORT_DIST = 0.35;

const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
const isHidden = () => typeof document !== 'undefined' && Boolean(document.hidden);
const isReducedMotion = () => typeof matchMedia === 'function' && Boolean(matchMedia('(prefers-reduced-motion: reduce)')?.matches);
const canAnimateHud = () => typeof requestAnimationFrame === 'function' && !isHidden() && !isReducedMotion();
const cancelRaf = id => { if (id && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); };
const validHudBox = b => Boolean(b) && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function estimateTrackVelocity(tr, prevBox, dtSec, prevVel) {
  if (Number.isFinite(tr.vx) && Number.isFinite(tr.vy)) return { vx: tr.vx, vy: tr.vy };
  const nextCx = tr.bbox.x + tr.bbox.w / 2, nextCy = tr.bbox.y + tr.bbox.h / 2;
  if (prevBox && dtSec >= 0.02 && dtSec <= 0.6) {
    const rawVx = (nextCx - (prevBox.x + prevBox.w / 2)) / dtSec;
    const rawVy = (nextCy - (prevBox.y + prevBox.h / 2)) / dtSec;
    return prevVel
      ? { vx: prevVel.vx * 0.4 + rawVx * 0.6, vy: prevVel.vy * 0.4 + rawVy * 0.6 }
      : { vx: rawVx, vy: rawVy };
  }
  if (Array.isArray(tr.trail) && tr.trail.length >= 2) {
    const first = tr.trail[0], last = tr.trail[tr.trail.length - 1];
    const spanSec = Math.max(1 / 15, (tr.trail.length - 1) / 15);
    if (Array.isArray(first) && Array.isArray(last)) {
      return { vx: (last[0] - first[0]) / spanSec, vy: (last[1] - first[1]) / spanSec };
    }
  }
  return prevVel || { vx: 0, vy: 0 };
}

function formatVoteTag(vote) {
  if (!vote || typeof vote !== 'object') return '';
  const ready = vote.ready === true || vote.status === 'ready';
  const score = Number.isFinite(vote.confidence) ? vote.confidence : vote.score;
  if (ready && typeof vote.label === 'string' && vote.label) {
    const pct = Number.isFinite(score) ? ` ${Math.round(score <= 1 ? score * 100 : score)}%` : '';
    return ` · v4.1 ${vote.label}${pct}`;
  }
  const windowSize = Number.isFinite(vote.total) ? vote.total : (Number.isFinite(vote.windowSize) ? vote.windowSize : 5);
  if ((vote.status === 'collecting' || (!ready && (vote.count > 0 || vote.pending))) && Number.isFinite(vote.count)) {
    return ` · v4.1 ${vote.count}/${windowSize}`;
  }
  return '';
}

function defaultDrawForecast(ctx, P, tr, helpers) {
  const hasPath = typeof ctx.beginPath === 'function' && typeof ctx.moveTo === 'function' &&
    typeof ctx.lineTo === 'function' && typeof ctx.stroke === 'function';
  if (!hasPath) return;
  const cx = helpers.bbox.x + helpers.bbox.w / 2, cy = helpers.bbox.y + helpers.bbox.h / 2;
  if (tr.trail?.length > 1) {
    ctx.strokeStyle = helpers.color;
    ctx.beginPath();
    tr.trail.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(p)));
    const last = tr.trail[tr.trail.length - 1];
    if (Array.isArray(last) && Math.hypot(cx - last[0], cy - last[1]) > 1e-4) ctx.lineTo(...P([cx, cy]));
    ctx.globalAlpha = 0.6 * helpers.alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (helpers.forecast && typeof ctx.fill === 'function') {
    const drewCone = drawForecastCone(ctx, P, helpers.forecast, {
      dpr: helpers.dpr,
      nowMs: helpers.nowMs,
      reducedMotion: helpers.meta.reducedMotion,
      surveyedCorridor: Boolean(helpers.corridor?.length > 2),
    });
    if (drewCone) {
      ctx.lineWidth = 2;
      ctx.globalAlpha = 1;
      return;
    }
  }
  const { vx, vy } = helpers.velocity;
  if (Math.hypot(vx, vy) > 0.015 && typeof ctx.setLineDash === 'function') {
    const fx = clamp(cx + vx * 0.75, 0, 1), fy = clamp(cy + vy * 0.75, 0, 1);
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = helpers.color;
    ctx.lineWidth = Math.max(1.25, 1.5 * helpers.dpr);
    ctx.globalAlpha = 0.45 * helpers.lock * helpers.alpha;
    ctx.moveTo(...P([cx, cy]));
    ctx.lineTo(...P([fx, fy]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.globalAlpha = 1;
  }
}

function defaultDrawTrack(ctx, rect, tr, helpers) {
  const { color, lock, alpha, dpr, vote } = helpers;
  if (typeof ctx.arc === 'function' && typeof ctx.beginPath === 'function') {
    drawCornerReticle(ctx, rect, {
      color,
      dpr,
      lockProgress: lock,
      classification: tr.classification,
      flapHz: tr.flap_hz,
      isFlock: Boolean(tr.is_flock),
    });
    if (vote) {
      const ringState = toVoteRingState(vote, {
        pending: Boolean(vote.pending),
        total: vote.total ?? vote.windowSize ?? 5,
      });
      if (ringState) {
        drawVoteProgressRing(ctx, rect, ringState, {
          dpr,
          reducedMotion: helpers.meta.reducedMotion,
          nowMs: helpers.nowMs,
        });
      }
    }
    ctx.lineWidth = 2;
    ctx.globalAlpha = 1;
    return;
  }
  ctx.strokeStyle = color;
  if (alpha < 1) ctx.globalAlpha = alpha;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  if (typeof ctx.beginPath === 'function' && typeof ctx.moveTo === 'function' &&
      typeof ctx.lineTo === 'function' && typeof ctx.stroke === 'function') {
    const pad = (1 - lock) * 7 * dpr;
    const bx = rect.x - pad, by = rect.y - pad, bw = rect.w + pad * 2, bh = rect.h + pad * 2;
    const arm = Math.max(4, Math.min(bw, bh) * 0.28);
    ctx.beginPath();
    ctx.moveTo(bx, by + arm); ctx.lineTo(bx, by); ctx.lineTo(bx + arm, by);
    ctx.moveTo(bx + bw - arm, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + arm);
    ctx.moveTo(bx, by + bh - arm); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + arm, by + bh);
    ctx.moveTo(bx + bw - arm, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - arm);
    ctx.lineWidth = Math.max(2, 2.2 * dpr);
    ctx.globalAlpha = (0.35 + 0.65 * lock) * alpha;
    ctx.stroke();
    ctx.lineWidth = 2;
  }
  ctx.globalAlpha = 1;
  if (!tr.is_flock) {
    ctx.fillStyle = color;
    ctx.fillText(`${tr.classification}${tr.flap_hz ? ` ${tr.flap_hz} Hz` : ''}${formatVoteTag(vote)}`, rect.x, rect.y - 4);
  }
}

function stepBuiltInHud(hud, activeTracks, now, animate, isNewState) {
  const liveIds = new Set();
  let animating = false;
  for (const tr of activeTracks) {
    liveIds.add(tr.id);
    const box = { x: tr.bbox.x, y: tr.bbox.y, w: tr.bbox.w, h: tr.bbox.h };
    let entry = hud.tracks.get(tr.id);
    if (!entry) {
      entry = {
        id: tr.id,
        from: { ...box },
        target: { ...box },
        bbox: { ...box },
        vel: estimateTrackVelocity(tr, null, 0, null),
        bornMs: now,
        startMs: now,
        interpMs: 0,
        lastTargetMs: now,
        lock: animate ? 0 : 1,
        alpha: animate ? 0.55 : 1,
      };
      hud.tracks.set(tr.id, entry);
    } else if (isNewState) {
      const gapMs = Math.max(0, now - entry.lastTargetMs);
      const jump = Math.hypot(
        (box.x + box.w / 2) - (entry.bbox.x + entry.bbox.w / 2),
        (box.y + box.h / 2) - (entry.bbox.y + entry.bbox.h / 2),
      );
      const maxDelta = Math.max(
        Math.abs(box.x - entry.bbox.x), Math.abs(box.y - entry.bbox.y),
        Math.abs(box.w - entry.bbox.w), Math.abs(box.h - entry.bbox.h),
      );
      entry.vel = estimateTrackVelocity(tr, entry.target, gapMs / 1000, entry.vel);
      if (!animate || gapMs > MAX_TRACK_GAP_MS || jump > TELEPORT_DIST || maxDelta < 1e-5) {
        entry.from = { ...box };
        entry.target = { ...box };
        entry.bbox = { ...box };
        entry.startMs = now;
        entry.interpMs = 0;
      } else {
        entry.from = { ...entry.bbox };
        entry.target = { ...box };
        entry.startMs = now;
        entry.interpMs = clamp(gapMs || DEFAULT_INTERP_MS, MIN_INTERP_MS, MAX_INTERP_MS);
      }
      entry.lastTargetMs = now;
    }

    if (!animate) {
      entry.bbox = { ...entry.target };
      entry.lock = 1;
      entry.alpha = 1;
      continue;
    }

    const lockProgress = clamp((now - entry.bornMs) / LOCK_ON_MS, 0, 1);
    entry.lock = 1 - (1 - lockProgress) ** 3;
    entry.alpha = 0.55 + 0.45 * entry.lock;
    if (lockProgress < 1) animating = true;

    const elapsed = Math.max(0, now - entry.startMs);
    if (entry.interpMs <= 0 || elapsed >= entry.interpMs) {
      entry.bbox = { ...entry.target };
    } else {
      const u = clamp((elapsed + 16) / (entry.interpMs + 16), 0, 1);
      const s = 0.7 * u + 0.3 * (1 - (1 - u) * (1 - u));
      entry.bbox = {
        x: entry.from.x + (entry.target.x - entry.from.x) * s,
        y: entry.from.y + (entry.target.y - entry.from.y) * s,
        w: entry.from.w + (entry.target.w - entry.from.w) * s,
        h: entry.from.h + (entry.target.h - entry.from.h) * s,
      };
      animating = true;
    }
  }
  for (const id of hud.tracks.keys()) {
    if (!liveIds.has(id)) hud.tracks.delete(id);
  }
  return animating;
}

export function startFeeds(socket, {
  container,
  hint,
  onFeed,
  onRemove,
  onDemoState,
  demo = true,
  getTrackVote,
  hudRenderer,
} = {}) {
  const tiles = new Map();
  let demoCount = 0, evidenceStream = 0, emptyDemo = null, hudRafToken = 0;
  const hasCustomTileState = typeof hudRenderer?.createTileState === 'function';
  const canvasSizer = createCanvasSizer({
    dpr: () => Math.min(2, globalThis.devicePixelRatio || 1),
  });
  const budgetLoop = createFrameBudgetLoop({
    maxWorkMs: 8,
    raf: cb => requestAnimationFrame(cb),
    caf: id => cancelRaf(id),
    now: nowMs,
    isHidden,
  });
  // Feeds closed with ✕: ignored (no tile, no decoding) until "Show hidden feeds" brings them back.
  const dismissed = new Set();
  let emptyDemoClosed = false;
  const restore = document.createElement('button');
  restore.type = 'button'; restore.className = 'ghost feeds-restore'; restore.hidden = true;
  restore.onclick = () => { dismissed.clear(); emptyDemoClosed = false; restore.hidden = true; showEmptyDemo(); };
  container.after(restore);
  const showRestore = () => { const n = dismissed.size + (emptyDemoClosed ? 1 : 0); restore.hidden = !n; restore.textContent = `Show hidden feeds (${n})`; };
  const isTileOpen = t => Boolean(t) && (tiles.get(t.cameraId) === t || emptyDemo === t);
  const getTileHud = t => (hasCustomTileState ? t.hud.tileState : t.hud);

  function createTileHud() {
    return {
      tracks: new Map(),
      reticles: createReticleInterpolator(),
      forecaster: createFlightForecaster({ samples: 120, maxTracks: 48 }),
      forecasts: new Map(),
      corridorKey: '',
      raf: 0,
      running: false,
      scopeKey: null,
      lastState: null,
      frameT: null,
      lastStepMs: 0,
      hadActiveTracks: false,
      tileState: hasCustomTileState ? hudRenderer.createTileState() : null,
    };
  }

  function stopHudLoop(t) {
    if (!t?.hud) return;
    if (t.hud.raf) {
      budgetLoop.unsubscribe(t);
      t.hud.raf = 0;
    }
    t.hud.running = false;
  }

  function resetHud(t) {
    if (!t?.hud) return;
    stopHudLoop(t);
    t.hud.tracks.clear();
    t.hud.reticles.clear();
    t.hud.forecaster.reset();
    t.hud.forecasts.clear();
    t.hud.corridorKey = '';
    t.hud.scopeKey = null;
    t.hud.lastState = null;
    t.hud.frameT = null;
    t.hud.lastStepMs = 0;
    t.hud.hadActiveTracks = false;
    if (typeof hudRenderer?.resetTile === 'function') hudRenderer.resetTile(getTileHud(t));
    else if (hasCustomTileState) t.hud.tileState = hudRenderer.createTileState();
  }

  function closeTile(t) {
    resetHud(t);
    canvasSizer.unobserve(t?.overlay);
    if (t === emptyDemo) { removeEmptyDemo(); emptyDemoClosed = true; }
    else { dismissed.add(t.cameraId); stopDemo(t); clearBirdEvidence(t); t.el.remove(); tiles.delete(t.cameraId); onRemove?.(t.cameraId); }
    hint.hidden = tiles.size > 0 || Boolean(emptyDemo);
    showRestore();
  }

  function tile(cameraId) {
    if (tiles.has(cameraId)) return tiles.get(cameraId);
    const el = document.createElement('div'); el.className = 'tile';
    el.innerHTML = `<div class="wrap"><canvas aria-hidden="true"></canvas><canvas aria-hidden="true"></canvas></div><span class="tag"></span><span class="bot">waiting…</span>
      <div class="tools" role="toolbar" aria-label="Feed view">
        <button type="button" data-z="-" aria-label="Zoom out">−</button><span class="zl">1×</span><button type="button" data-z="+" aria-label="Zoom in">+</button>
        <button type="button" data-z="0" aria-label="Reset zoom">Fit</button><button type="button" data-fs aria-label="Full screen">Full screen</button>
        <button type="button" data-src aria-pressed="false" title="Switch between the live camera and recorded demo footage">Demo</button>
        <button type="button" data-close aria-label="Close this feed" title="Close this feed">✕</button></div>`;
    el.querySelector('.tag').textContent = cameraId;
    el.querySelector('.wrap').setAttribute('role', 'img');
    el.querySelector('.wrap').setAttribute('aria-label', `Live video from camera ${cameraId}, with the detector's boxes drawn over birds and drones`);
    container.appendChild(el); hint.hidden = true;
    const [video, overlay] = el.querySelectorAll('canvas');
    const small = document.createElement('canvas');
    const t = { cameraId, el, video, overlay, vctx: video.getContext('2d'), octx: overlay.getContext('2d'), small, sctx: small.getContext('2d', { willReadFrequently: true }),
      botState: null, detector: new DetectorStatus(), frames: 0, config: null, bitmap: null, lastFrameAt: 0,
      decoding: false, pending: null, received: 0, fps: 0, fpsAt: nowMs(), offline: false, hud: createTileHud() };
    canvasSizer.observe(overlay, () => redrawTile(t));
    t.birdPairs = new BirdFramePairs();
    t.source = demo && store.get(`skysentry.feedSource.${cameraId}`) === 'demo' ? 'demo' : 'live';
    tiles.set(cameraId, t);
    el.querySelector('[data-close]').onclick = () => closeTile(t);
    setupZoom(t);
    el.querySelector('[data-src]').hidden = !demo;
    updateSourceButton(t);
    if (t.source === 'demo') startDemo(t);
    if (demo) setTimeout(() => { if (tiles.get(cameraId) === t && !t.frames) startDemo(t); }, DEMO_AFTER_MS);
    if (emptyDemo && !emptyDemo.placeholderFor) removeEmptyDemo();
    return t;
  }

  // ---------- Demo / Live switch ----------
  // Live (default): real video when it arrives, demo footage automatically while there is none.
  // Demo: always show recorded footage in this tile, even if the camera is streaming (alerts still come from the live camera).
  function updateSourceButton(t) {
    const b = t.el.querySelector('[data-src]'); if (!b) return;
    const demoOn = t.source === 'demo';
    b.textContent = demoOn ? 'Live' : 'Demo'; b.setAttribute('aria-pressed', String(demoOn));
    b.setAttribute('aria-label', demoOn ? 'Show the live camera' : 'Show demo footage');
  }
  function setSource(t, source) {
    const changed = t.source !== source;
    t.source = source; if (!t.placeholder) store.set(`skysentry.feedSource.${t.cameraId}`, source);
    updateSourceButton(t);
    if (changed) resetHud(t);
    if (source === 'demo') startDemo(t);
    else if (t.frames && Date.now() - t.lastFrameAt < 3000) { stopDemo(t); updateServerEvidence(t, true); }   // live video is flowing: show it
    else if (!t.demo) startDemo(t);                                                                             // nothing live yet: keep demo until it arrives
    label(t);
  }

  // ---------- demo footage ----------
  function startDemo(t) {
    if (!demo || t.demo) return;
    clearBirdEvidence(t);
    resetHud(t);
    const clip = DEMO_CLIPS[demoCount++ % DEMO_CLIPS.length];
    const v = document.createElement('video');
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('aria-hidden', 'true');
    for (const [ext, type] of [['mp4', 'video/mp4'], ['webm', 'video/webm']]) { const so = document.createElement('source'); so.src = `/clips/${clip}.${ext}`; so.type = type; v.append(so); }
    const engine = new DetectionEngine({ camera_id: `demo-${clip}` });   // no .on('event'): demo never alerts
    engine.setConfig(PRESETS.laptop_30fps || {});
    const d = t.demo = { v, engine, clip, raf: 0, last: 0, frameId: 0, streamId: `demo:${++evidenceStream}` };
    t.el.classList.add('is-demo');
    t.el.querySelector('.wrap').setAttribute('aria-label', `Demo footage (${clip.replace(/-/g, ' ')}) shown because camera ${t.cameraId} is not sending video`);
    const demoFeed = d.feed = { cameraId: `demo:${t.cameraId}`, mode: 'tower', video: t.video, engine, offline: false, demo: true };
    const step = now => {
      if (t.demo !== d) return;
      d.raf = requestAnimationFrame(step);
      if (v.readyState < 2 || now - d.last < 66 || document.hidden) return;   // ~15 fps is plenty for the overlay
      d.last = now;
      const W = v.videoWidth, H = v.videoHeight; if (!W || !H) return;
      if (t.video.width !== W || t.video.height !== H) { t.video.width = W; t.video.height = H; }
      t.vctx.drawImage(v, 0, 0, W, H);
      t.small.width = 320; t.small.height = Math.round(320 * H / W);
      t.sctx.drawImage(t.video, 0, 0, t.small.width, t.small.height);
      const frameT = v.currentTime + d.loops * 1000, frameReceivedAt = Date.now();
      const state = engine.process(t.sctx.getImageData(0, 0, t.small.width, t.small.height), frameT);
      draw(t, state); label(t);
      Object.assign(demoFeed, { fallbackState: state, frameT, lastFrameAt: frameReceivedAt,
        birdEvidence: { source: 'demo', state, frame: { streamId: d.streamId, frameId: ++d.frameId,
          frameT, frameReceivedAt, bitmap: t.video } } });
      onFeed?.(demoFeed);
      onDemoState?.({ cameraId: t.cameraId, state });   // demo risk for the tower display (never an alert)
    };
    d.loops = 0; v.addEventListener('seeked', () => {
      d.loops++; d.streamId = `demo:${++evidenceStream}`; d.feed.birdEvidence = null;
      resetHud(t);
      t.octx.clearRect(0, 0, t.overlay.width, t.overlay.height);
    });   // A seek resets the engine's tracking timeline.
    v.play().catch(() => { v.controls = false; });
    d.raf = requestAnimationFrame(step);
    label(t);
  }
  function stopDemo(t) {
    resetHud(t);
    const d = t.demo; if (!d) return;
    d.feed.birdEvidence = null; d.feed.offline = true;
    onRemove?.(d.feed.cameraId);
    t.demo = null; cancelAnimationFrame(d.raf); d.v.pause(); d.v.removeAttribute('src'); d.v.replaceChildren(); d.v.load();
    t.el.classList.remove('is-demo'); t.octx.clearRect(0, 0, t.overlay.width, t.overlay.height);
    t.el.querySelector('.wrap').setAttribute('aria-label', `Live video from camera ${t.cameraId}, with the detector's boxes drawn over birds and drones`);
  }
  // No camera connected at all: one demo tile fills the feed area until a real camera appears.
  function showEmptyDemo() {
    if (!demo || emptyDemo || tiles.size || emptyDemoClosed) return;
    const id = 'Demo footage';
    emptyDemo = tile(id); emptyDemo.placeholder = true; emptyDemo.placeholderFor = null; emptyDemo.el.querySelector('[data-src]').hidden = true;
    tiles.delete(id);                       // not a real camera: never matched by socket events
    hint.hidden = false; hint.textContent = 'No camera is streaming yet, so recorded demo footage is playing. Open Camera on a phone (or scan the QR code) to go live.';
    startDemo(emptyDemo);
  }
  function removeEmptyDemo() {
    if (!emptyDemo) return;
    resetHud(emptyDemo);
    canvasSizer.unobserve(emptyDemo.overlay);
    stopDemo(emptyDemo); emptyDemo.el.remove(); emptyDemo = null;
    hint.textContent = 'When a phone streams, its live video appears here with the bot’s boxes drawn on it.';
    hint.hidden = tiles.size > 0;
  }
  if (demo) setTimeout(showEmptyDemo, DEMO_AFTER_MS);

  function refreshDetection(t) {
    const state = t.detector.current();
    if (!state && t.botState) invalidateEvidence(t);
    else if (!state && !t.demo && (t.hud?.raf || t.hud?.tracks.size)) {
      resetHud(t);
      draw(t, null);
    }
    t.botState = state;
    label(t);
  }

  function clearBirdEvidence(t, options) {
    t.birdEvidence = null;
    t.birdPairs.clear(options);
    t.displayedFrame = null;
  }

  function invalidateEvidence(t) {
    t.birdEpoch = (t.birdEpoch || 0) + 1;
    t.pending = null;
    clearBirdEvidence(t);
    resetHud(t);
    if (!t.demo) draw(t, null);
  }

  function currentOverlayState(t) {
    if (!isTileOpen(t) || t.offline) return null;
    if (t.demo) return t.demo.feed?.birdEvidence ? t.demo.feed.fallbackState : null;
    const pair = t.birdPairs.latest;
    const active = t.detector.current();
    t.birdEvidence = !t.offline && active?.generation && pair?.generation === active.generation &&
      pair.frame.streamId === t.birdStreamId ? pair : null;
    return t.birdEvidence?.frame === t.displayedFrame ? t.birdEvidence.state : null;
  }

  function updateServerEvidence(t, redraw = false) {
    const pair = t.birdPairs.latest;
    const active = t.detector.current();
    t.birdEvidence = !t.demo && !t.offline && active?.generation && pair?.generation === active.generation &&
      pair.frame.streamId === t.birdStreamId ? pair : null;
    if (redraw && !t.demo) draw(t, t.birdEvidence?.frame === t.displayedFrame ? t.birdEvidence.state : null);
  }

  function scheduleHudLoop(t) {
    if (t.hud.raf || !isTileOpen(t) || t.offline || !canAnimateHud()) return;
    t.hud.running = true;
    const token = ++hudRafToken;
    t.hud.raf = token;
    budgetLoop.schedule(t, ts => {
      if (t.hud.raf === token) {
        t.hud.raf = 0;
        t.hud.running = false;
      }
      if (!isTileOpen(t) || t.offline || !canAnimateHud()) {
        if (!isTileOpen(t) || t.offline) resetHud(t);
        return;
      }
      const state = currentOverlayState(t);
      if (!state) {
        if (!t.demo && !t.detector.current() && t.botState) refreshDetection(t);
        else draw(t, null);
        return;
      }
      draw(t, state, Number.isFinite(ts) ? ts : nowMs());
    });
  }

  function draw(t, state, now = nowMs()) {
    // ResizeObserver-backed sizer avoids clientWidth/clientHeight layout reflows inside rAF ticks.
    const o = t.overlay, zoomScale = Math.max(1, t.zoom?.z || 1);
    const sized = canvasSizer.syncCanvasSize(o, zoomScale);
    const dpr = sized.dpr || (Math.min(2, globalThis.devicePixelRatio || 1) * zoomScale);
    const W = sized.width || o.width, H = sized.height || o.height, ar = t.video.width / t.video.height || 4 / 3;
    let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
    const f = { x: (W - w) / 2, y: (H - h) / 2, w, h }, P = ([x, y]) => [f.x + x * f.w, f.y + y * f.h];
    const ctx = t.octx; ctx.clearRect(0, 0, W, H);
    const corridor = t.config?.surveyId ? t.config.corridor : null;
    if (corridor?.length > 2) {
      ctx.beginPath(); corridor.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(p))); ctx.closePath();
      ctx.fillStyle = 'rgba(194,100,63,.14)'; ctx.fill(); ctx.setLineDash([6, 5]); ctx.strokeStyle = 'rgba(242,140,90,.85)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
    if (!state) {
      t.hud.lastState = null;
      stopHudLoop(t);
      return;
    }
    const scopeKey = t.demo
      ? `demo:${t.demo.streamId}`
      : `live:${t.birdEvidence?.frame?.streamId ?? t.birdStreamId ?? ''}:${t.birdEvidence?.generation ?? t.detector.generation ?? ''}:${t.birdEpoch || 0}`;
    if (t.hud.scopeKey && t.hud.scopeKey !== scopeKey) resetHud(t);
    t.hud.scopeKey = scopeKey;

    ctx.font = `600 ${Math.round(11 * dpr)}px system-ui`; ctx.lineWidth = 2;
    for (const g of state.flocks || []) if (g.bbox) {
      const [x, y] = P([g.bbox.x, g.bbox.y]);
      ctx.setLineDash([5, 4]); ctx.strokeStyle = '#fff'; ctx.strokeRect(x - 5, y - 5, g.bbox.w * f.w + 10, g.bbox.h * f.h + 10); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.fillText(`flock of ${g.size}${g.eta_basis === 'image_space_corridor' && g.eta_seconds != null ? ` · mask entry ${Math.round(g.eta_seconds)} s` : ''}`, x - 5, y - 10);
    }

    const activeTracks = (state.tracks || []).filter(tr => !tr?.missed && validHudBox(tr?.bbox));
    const frameT = Number.isFinite(state.t) ? state.t : (t.frameT ?? 0);
    const feedCameraId = t.demo ? t.demo.feed.cameraId : t.cameraId;
    const meta = {
      cameraId: feedCameraId,
      tileCameraId: t.cameraId,
      streamId: t.demo ? t.demo.streamId : (t.birdEvidence?.frame?.streamId ?? t.birdStreamId ?? null),
      generation: t.demo ? null : (t.birdEvidence?.generation ?? t.detector.generation ?? null),
      frameId: t.demo ? t.demo.frameId : (t.birdEvidence?.frame?.frameId ?? null),
      frameT,
      demo: Boolean(t.demo),
      source: t.demo ? 'demo' : 'server',
      reducedMotion: isReducedMotion(),
      hidden: isHidden(),
      dpr,
      frame: f,
    };
    if (!activeTracks.length) {
      t.hud.tracks.clear();
      t.hud.reticles.clear();
      t.hud.forecasts.clear();
      t.hud.lastState = state;
      t.hud.frameT = Number.isFinite(state.t) ? state.t : null;
      if (t.hud.hadActiveTracks) {
        t.hud.hadActiveTracks = false;
        if (typeof hudRenderer?.resetTile === 'function') hudRenderer.resetTile(getTileHud(t));
        else if (typeof hudRenderer?.stepTile === 'function') hudRenderer.stepTile(getTileHud(t), [], frameT, now, meta);
      }
      stopHudLoop(t);
      return;
    }

    const animate = canAnimateHud();
    const isNewState = state !== t.hud.lastState || frameT !== t.hud.frameT;
    const builtInAnimating = stepBuiltInHud(t.hud, activeTracks, now, animate, isNewState);
    t.hud.reticles.step(activeTracks, now, { reducedMotion: !animate });
    if (isNewState) {
      const surveyed = Boolean(corridor?.length > 2 && t.config?.surveyId);
      const corridorKey = surveyed ? `${t.config.surveyId}:${JSON.stringify(corridor)}` : '';
      if (t.hud.corridorKey !== corridorKey) {
        t.hud.corridorKey = corridorKey;
        t.hud.forecaster.setCorridor(
          surveyed ? corridor : null,
          surveyed ? { surveyId: t.config.surveyId, surveyed: true } : { surveyed: false },
        );
      }
      t.hud.forecaster.update(activeTracks, frameT);
      t.hud.forecasts.clear();
      for (const tr of activeTracks) {
        const fan = t.hud.forecaster.coneFan(tr.id);
        if (fan) t.hud.forecasts.set(tr.id, fan);
      }
    }
    t.hud.lastState = state;
    t.hud.frameT = frameT;
    t.hud.lastStepMs = now;
    t.hud.hadActiveTracks = true;

    const tileHud = getTileHud(t);
    let hasAnimatedConeOrPulse = false;
    const votesByTrack = new Map();
    for (const tr of activeTracks) {
      const vote = typeof getTrackVote === 'function' ? (getTrackVote(feedCameraId, tr.id, meta) ?? null) : null;
      votesByTrack.set(tr.id, vote);
      if (vote?.pending && !vote?.ready && vote?.status !== 'ready') hasAnimatedConeOrPulse = true;
      if (t.hud.forecasts.has(tr.id) && typeof ctx.arc === 'function') hasAnimatedConeOrPulse = true;
    }
    const keepAnimating = typeof hudRenderer?.stepTile === 'function'
      ? Boolean(hudRenderer.stepTile(tileHud, activeTracks, frameT, now, meta))
      : (builtInAnimating || hasAnimatedConeOrPulse || (typeof ctx.arc === 'function' && hasActiveReticleMotion(t.hud.reticles, now)));

    for (const tr of activeTracks) {
      const entry = t.hud.tracks.get(tr.id);
      const customBox = hasCustomTileState
        ? (tileHud?.tracks?.get?.(tr.id)?.bbox ?? tileHud?.boxes?.get?.(tr.id) ?? null)
        : null;
      const box = validHudBox(customBox) ? customBox : (entry ? entry.bbox : tr.bbox);
      const [rx, ry] = P([box.x, box.y]);
      const rect = { x: rx, y: ry, w: Math.max(5, box.w * f.w), h: Math.max(5, box.h * f.h) };
      const color = COLORS[tr.classification] || COLORS.unknown;
      const vote = votesByTrack.get(tr.id) ?? null;
      const helpers = {
        P,
        frame: f,
        rect,
        bbox: box,
        color,
        colors: COLORS,
        dpr,
        vote,
        forecast: t.hud.forecasts.get(tr.id) ?? null,
        lock: entry ? entry.lock : 1,
        alpha: entry ? entry.alpha : 1,
        velocity: entry ? entry.vel : { vx: 0, vy: 0 },
        tileHud,
        trackHud: entry || null,
        cameraId: feedCameraId,
        tileCameraId: t.cameraId,
        demo: Boolean(t.demo),
        corridor,
        state,
        meta,
        nowMs: now,
      };
      (hudRenderer?.drawForecast || defaultDrawForecast)(ctx, P, tr, helpers);
      (hudRenderer?.drawTrack || defaultDrawTrack)(ctx, rect, tr, helpers);
    }

    if (animate && keepAnimating && !t.offline && isTileOpen(t)) scheduleHudLoop(t);
    else stopHudLoop(t);
  }

  function label(t) {
    if (t.demo) { const el = t.el.querySelector('.bot'), text = `DEMO · recorded clip${t.placeholder ? ' · alerts off' : t.source === 'demo' ? ' · press Live for the camera' : ' · waiting for this camera'}`; if (el.textContent !== text) el.textContent = text; return; }
    let text = t.offline ? 'Camera offline · detection unavailable' : !t.frames ? 'Waiting for video…' : t.detector.message();
    if (t.frames && !t.offline) text += ` · ${Math.round(t.fps)} fps`;
    const el = t.el.querySelector('.bot');
    if (el.textContent !== text) el.textContent = text;
  }

  // Zoom (buttons, wheel, double-click) and pan (drag) on one wrapper holding video + overlay, plus full screen.
  function setupZoom(t) {
    const wrap = t.el.querySelector('.wrap'), z = t.zoom = { z: 1, x: 0, y: 0 };
    const apply = () => {
      const w = t.el.clientWidth, h = t.el.clientHeight;
      z.x = Math.min(0, Math.max(w - w * z.z, z.x)); z.y = Math.min(0, Math.max(h - h * z.z, z.y));
      wrap.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.z})`;
      t.el.querySelector('.zl').textContent = `${+z.z.toFixed(1)}×`;
      t.el.classList.toggle('zoomed', z.z > 1);
    };
    const zoomAt = (nz, px, py) => {               // keep the point under (px, py) fixed while zooming
      nz = Math.min(6, Math.max(1, nz));
      const r = t.el.getBoundingClientRect(), cx = px - r.left, cy = py - r.top;
      z.x = cx - (cx - z.x) * (nz / z.z); z.y = cy - (cy - z.y) * (nz / z.z); z.z = nz; apply();
    };
    const centre = () => { const r = t.el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    t.el.querySelector('.tools').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.z === '+') zoomAt(z.z * 1.5, ...centre());
      if (b.dataset.z === '-') zoomAt(z.z / 1.5, ...centre());
      if (b.dataset.z === '0') { z.z = 1; z.x = z.y = 0; apply(); }
      if ('src' in b.dataset) { if (t.placeholder) { b.disabled = true; return; } setSource(t, t.source === 'demo' ? 'live' : 'demo'); return; }
      if ('fs' in b.dataset) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else t.el.requestFullscreen?.().catch(() => {});
      }
    });
    t.el.addEventListener('wheel', e => { e.preventDefault(); zoomAt(z.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); }, { passive: false });
    t.el.addEventListener('dblclick', e => { if (e.target.closest('.tools')) return; z.z > 1 ? (z.z = 1, z.x = z.y = 0, apply()) : zoomAt(2.5, e.clientX, e.clientY); });
    let drag = null;
    t.el.addEventListener('pointerdown', e => { if (z.z > 1 && !e.target.closest('.tools')) { drag = { x: e.clientX - z.x, y: e.clientY - z.y }; t.el.setPointerCapture(e.pointerId); } });
    t.el.addEventListener('pointermove', e => { if (drag) { z.x = e.clientX - drag.x; z.y = e.clientY - drag.y; apply(); } });
    t.el.addEventListener('pointerup', () => { drag = null; });
    document.addEventListener('fullscreenchange', () => { t.el.querySelector('[data-fs]').textContent = document.fullscreenElement === t.el ? 'Exit full screen' : 'Full screen'; apply(); });
  }

  socket.on('camera:config', cfg => {
    if (dismissed.has(cfg.cameraId)) return;
    const t = tile(cfg.cameraId);
    t.config = cfg;
    t.detector.reset();
    invalidateEvidence(t);
    t.botState = null;
    label(t);
    onFeed?.(t);
  });
  socket.on('bot:status', s => {
    if (dismissed.has(s.cameraId)) return;
    const t = tile(s.cameraId);
    if (t.detector.generation && (s.mode !== 'server' || s.generation !== t.detector.generation)) invalidateEvidence(t);
    t.detector.update(s);
    refreshDetection(t);
    onFeed?.(t);
  });
  socket.on('bot:state', result => {
    if (dismissed.has(result.cameraId)) return;
    const t = tile(result.cameraId);
    if (t.offline || !t.detector.accept(result)) return;
    t.birdStateStreamId = result.streamId;
    refreshDetection(t);
    if (!t.demo) {
      t.birdPairs.addState(result);
      updateServerEvidence(t, true);
    }
    onFeed?.(t);
  });
  socket.on('camera:status', ({ cameraId, online }) => {
    const t = tiles.get(cameraId); if (!t) return;
    t.offline = !online;
    if (!online) t.detector.reset('unavailable', 'camera offline');
    if (!online) invalidateEvidence(t);
    refreshDetection(t);
    onFeed?.(t);
    if (online) return;
    setTimeout(() => { if (tiles.get(cameraId) === t && t.offline && Date.now() - t.lastFrameAt > 9000) { resetHud(t); canvasSizer.unobserve(t.overlay); stopDemo(t); clearBirdEvidence(t); t.el.remove(); tiles.delete(cameraId); onRemove?.(cameraId); hint.hidden = tiles.size > 0; setTimeout(showEmptyDemo, DEMO_AFTER_MS); } }, 10000);
  });
  socket.on('disconnect', () => {
    for (const t of tiles.values()) {
      t.offline = true;
      t.detector.reset('unavailable', 'connection lost');
      resetHud(t);
      invalidateEvidence(t);
      refreshDetection(t);
      onFeed?.(t);
    }
  });
  const refreshTimer = setInterval(() => { for (const t of tiles.values()) refreshDetection(t); }, 500);
  socket.on('camera:frame', ({ cameraId, streamId, frameId, t: ft, jpeg }) => {
    if (dismissed.has(cameraId)) return;
    const t = tile(cameraId);
    if (t.demo && t.source !== 'demo') stopDemo(t);   // real video beats automatic demo footage immediately
    const streamChanged = t.birdStreamId !== streamId;
    if (streamChanged) {
      clearBirdEvidence(t, { keepStates: true });
      resetHud(t);
      t.birdStreamId = streamId;
      if (!t.demo) draw(t, null);
    }
    t.lastFrameAt = Date.now(); t.offline = false; t.received++;
    if (streamChanged) onFeed?.(t);
    const now = nowMs(), dt = now - t.fpsAt;
    if (dt >= 1000) { t.fps = t.received * 1000 / dt; t.received = 0; t.fpsAt = now; }
    // Keep one newest frame while a decode is running. Never build a video backlog or draw old frames out of order.
    t.pending = { ft, jpeg, streamId, frameId, frameReceivedAt: t.lastFrameAt, epoch: t.birdEpoch };
    if (!t.decoding) renderLatest(t);
  });

  function redrawTile(t) {
    if (!isTileOpen(t)) return;
    if (t.offline) {
      resetHud(t);
      draw(t, null);
      return;
    }
    draw(t, currentOverlayState(t));
  }

  function redrawAll() {
    for (const t of tiles.values()) redrawTile(t);
    if (emptyDemo) redrawTile(emptyDemo);
  }

  function redraw(target) {
    const cameraId = typeof target === 'string' ? target
      : (target && typeof target === 'object' && typeof target.cameraId === 'string' ? target.cameraId : null);
    if (cameraId) {
      const t = tiles.get(cameraId) || (emptyDemo?.cameraId === cameraId ? emptyDemo : null);
      if (t) redrawTile(t);
      return;
    }
    redrawAll();
  }

  const onEnvChange = () => {
    if (!canAnimateHud()) {
      for (const t of tiles.values()) stopHudLoop(t);
      if (emptyDemo) stopHudLoop(emptyDemo);
      if (!isHidden() && isReducedMotion()) redrawAll();
    } else {
      redrawAll();
    }
  };
  document?.addEventListener?.('visibilitychange', onEnvChange);
  const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  motionQuery?.addEventListener?.('change', onEnvChange);

  async function renderLatest(t) {
    t.decoding = true;
    try {
      while (t.pending && tiles.get(t.cameraId) === t) {
        const { ft, jpeg, streamId, frameId, frameReceivedAt, epoch } = t.pending; t.pending = null;
        let bitmap;
        try { bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })); } catch { continue; }
        if (tiles.get(t.cameraId) !== t) { bitmap.close(); break; }
        if (epoch !== t.birdEpoch || t.birdStreamId !== streamId || t.offline) { bitmap.close(); continue; }
        t.frames++; t.frameT = Number(ft);
        if (t.demo) { bitmap.close(); continue; }   // Server detection still receives the live frames.
        if (t.video.width !== bitmap.width || t.video.height !== bitmap.height) { t.video.width = bitmap.width; t.video.height = bitmap.height; }
        t.vctx.drawImage(bitmap, 0, 0);
        refreshDetection(t);
        const frame = { streamId, frameId, frameT: ft, frameReceivedAt, bitmap };
        t.displayedFrame = frame;
        t.birdPairs.addFrame(frame);
        updateServerEvidence(t, true);
        onFeed?.(t);
      }
    } finally {
      t.decoding = false;
    }
  }

  function stop() {
    clearInterval(refreshTimer);
    document?.removeEventListener?.('visibilitychange', onEnvChange);
    motionQuery?.removeEventListener?.('change', onEnvChange);
    for (const t of tiles.values()) {
      resetHud(t);
      stopDemo(t);
      clearBirdEvidence(t);
    }
    if (emptyDemo) removeEmptyDemo();
    budgetLoop.clear();
    canvasSizer.disconnect();
  }

  return { redraw, redrawAll, stop };
}
