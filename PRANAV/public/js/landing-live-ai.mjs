// Interactive "Live Local AI" landing-page runner (zero-login, 100% browser-local).
//
// Runs MotionDetector + Tracker (`DetectionEngine`) at ~12-15 fps on a 320px scratch
// canvas and classifies tracked crops in a Web Worker via SkyNetLite v4.1, accumulating
// 5-frame probability votes per track. Never opens Socket.IO or contacts live endpoints.

import { DetectionEngine, PRESETS } from '../detection/index.js';
import { createV41WorkerClient } from './skysentry-v41-client.mjs';
import { createV41Votes } from './skysentry-v41-vote.mjs';

const CAMERA_ID = 'landing-live-ai';
const DEFAULT_CLIP_ID = 'starling-murmuration';
const SCRATCH_WIDTH = 320;
const MIN_FRAME_INTERVAL_MS = 66; // ~12-15 fps (matches feeds.js demo cadence)
const MAX_WORKER_BOXES = 8;
const VOTE_WINDOW = 5;
const PROB_CLASSES = Object.freeze(['bird', 'drone', 'other']);

const RETICLE_COLORS = Object.freeze({
  collecting: '#f2b705',
  bird: '#4f9cff',
  drone: '#ff5a4a',
  other: '#94a3b8',
});

const CLASS_TITLES = Object.freeze({
  bird: 'Bird',
  drone: 'Drone',
  other: 'Other / sky clutter',
});

export const LANDING_CLIPS = Object.freeze([
  Object.freeze({
    id: 'starling-murmuration',
    label: 'Flock / Birds',
    title: 'Starling murmuration',
    category: 'Flock',
    mp4: '/clips/starling-murmuration.mp4',
    webm: '/clips/starling-murmuration.webm',
    poster: '/clips/starling-murmuration.jpg',
    credit: 'P K \u00b7 CC BY 2.0',
  }),
  Object.freeze({
    id: 'drone-hover',
    label: 'Hovering Quadcopter',
    title: 'Drone hovering over a field',
    category: 'Drone',
    mp4: '/clips/drone-hover.mp4',
    webm: '/clips/drone-hover.webm',
    poster: '/clips/drone-hover.jpg',
    credit: 'BLM Oregon & Washington \u00b7 Public domain',
  }),
  Object.freeze({
    id: 'gulls-sky',
    label: 'Coastal Gulls',
    title: 'Gulls in open sky',
    category: 'Birds',
    mp4: '/clips/gulls-sky.mp4',
    webm: '/clips/gulls-sky.webm',
    poster: '/clips/gulls-sky.jpg',
    credit: 'Marc Plomp / Beeld en Geluid \u00b7 CC BY-SA 3.0 NL',
  }),
]);

const CLIPS_BY_ID = new Map(LANDING_CLIPS.map(clip => [clip.id, clip]));
const mountedRoots = new WeakMap();

function validBox(box) {
  return Boolean(box) &&
    Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.w) && Number.isFinite(box.h) &&
    box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 &&
    box.x + box.w <= 1.001 && box.y + box.h <= 1.001;
}

function clampNormalizedBox(box) {
  const x = Math.min(0.999, Math.max(0, box.x));
  const y = Math.min(0.999, Math.max(0, box.y));
  const w = Math.min(1 - x, Math.max(1e-4, box.w));
  const h = Math.min(1 - y, Math.max(1e-4, box.h));
  return { x, y, w, h };
}

function usableTrack(tr) {
  return Number.isSafeInteger(tr?.id) && tr.id > 0 &&
    !tr.missed && !tr.dense &&
    tr.classification !== 'rejected' && tr.classification !== 'debris' &&
    validBox(tr.bbox);
}

function extractTracks(state) {
  if (!state || !Array.isArray(state.tracks) || state.shake || state.learning || state.overflow) {
    return [];
  }
  if (state.motion && (!state.motion.ready || state.motion.shake || state.motion.overflow)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const tr of state.tracks) {
    if (!usableTrack(tr) || seen.has(tr.id)) continue;
    seen.add(tr.id);
    out.push(tr);
  }
  return out;
}

function copyOwnedRgbaBuffer(data) {
  return new Uint8ClampedArray(data);
}

function readClipIdFromButton(btn) {
  if (!btn) return null;
  const ds = btn.dataset || {};
  return ds.clip || ds.liveAiClip || ds.aiClip ||
    btn.getAttribute?.('data-clip') ||
    btn.getAttribute?.('data-live-ai-clip') ||
    btn.getAttribute?.('data-ai-clip') ||
    null;
}

function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

function setAttr(el, name, value) {
  if (!el) return;
  if (typeof el.setAttribute === 'function') {
    if (el.getAttribute?.(name) !== value) el.setAttribute(name, value);
  } else if (el.attrs) {
    el.attrs[name] = value;
  }
}

function buildDefaultDom(rootEl, doc) {
  if (!doc?.createElement) return;
  const controls = doc.createElement('div');
  controls.className = 'live-ai-controls';

  const playBtn = doc.createElement('button');
  playBtn.type = 'button';
  playBtn.setAttribute('data-live-ai-play', '');
  playBtn.setAttribute('aria-pressed', 'false');
  playBtn.textContent = 'Run v4.1 in browser';
  controls.append(playBtn);

  const pills = doc.createElement('div');
  pills.className = 'live-ai-clips';
  pills.setAttribute('role', 'group');
  pills.setAttribute('aria-label', 'Recorded sky clips');
  for (const clip of LANDING_CLIPS) {
    const pill = doc.createElement('button');
    pill.type = 'button';
    pill.setAttribute('data-clip', clip.id);
    pill.setAttribute('aria-pressed', String(clip.id === DEFAULT_CLIP_ID));
    pill.textContent = clip.label;
    pills.append(pill);
  }
  controls.append(pills);

  const stage = doc.createElement('div');
  stage.className = 'live-ai-stage';
  stage.setAttribute('data-live-ai-stage', '');

  const video = doc.createElement('video');
  video.setAttribute('data-live-ai-video', '');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'none';

  const overlay = doc.createElement('canvas');
  overlay.setAttribute('data-live-ai-overlay', '');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.width = 854;
  overlay.height = 480;
  stage.append(video, overlay);

  const hud = doc.createElement('div');
  hud.className = 'live-ai-hud';
  for (const [attr, initial] of [
    ['data-ai-fps', '\u2014'],
    ['data-ai-ms', '\u2014'],
    ['data-ai-tracks', '0'],
    ['data-ai-verdict', 'Idle \u00b7 click to run local v4.1'],
  ]) {
    const span = doc.createElement('span');
    span.setAttribute(attr, '');
    span.textContent = initial;
    hud.append(span);
  }

  const probs = doc.createElement('div');
  probs.className = 'live-ai-probs';
  for (const cls of PROB_CLASSES) {
    const bar = doc.createElement('div');
    bar.setAttribute('data-prob', cls);
    const pct = doc.createElement('span');
    pct.setAttribute('data-prob-pct', cls);
    pct.textContent = '0%';
    probs.append(bar, pct);
  }

  rootEl.append(controls, stage, hud, probs);
}

export function mountLandingLiveAi(rootEl, deps = {}) {
  if (!rootEl || typeof rootEl !== 'object') {
    throw new TypeError('mountLandingLiveAi expects a root DOM element');
  }
  if (mountedRoots.has(rootEl)) {
    return mountedRoots.get(rootEl);
  }

  const doc = deps.document ?? globalThis.document;
  const now = deps.now ?? (() => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  ));
  const createEngine = deps.createEngine ?? (options => {
    const engine = new DetectionEngine(options);
    engine.setConfig(PRESETS.laptop_30fps || {});
    return engine;
  });
  const createWorkerClient = deps.createWorkerClient ?? (() => createV41WorkerClient());
  const createVotes = deps.createVotes ?? (options => createV41Votes(options));
  const createScratchCanvas = deps.createScratchCanvas ?? (() => doc.createElement('canvas'));
  const createObserver = deps.createObserver ?? ((callback, options) => (
    typeof IntersectionObserver === 'function' ? new IntersectionObserver(callback, options) : null
  ));
  const requestFrame = deps.requestFrame ?? (cb => globalThis.requestAnimationFrame(cb));
  const cancelFrame = deps.cancelFrame ?? (id => globalThis.cancelAnimationFrame(id));
  const isHidden = deps.isHidden ?? (() => Boolean(doc?.hidden));
  const minFrameIntervalMs = Number.isFinite(deps.minFrameIntervalMs) && deps.minFrameIntervalMs > 0
    ? deps.minFrameIntervalMs
    : MIN_FRAME_INTERVAL_MS;
  const scratchWidth = Number.isSafeInteger(deps.scratchWidth) && deps.scratchWidth >= 32
    ? deps.scratchWidth
    : SCRATCH_WIDTH;
  const getDpr = deps.getDevicePixelRatio ?? (() => Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1)));

  const hasExistingMarkup = Boolean(
    rootEl.querySelector?.('[data-live-ai-overlay]') ||
    (rootEl.children && rootEl.children.length > 0),
  );
  if (!hasExistingMarkup) {
    buildDefaultDom(rootEl, doc);
  }

  const overlay = rootEl.querySelector?.('[data-live-ai-overlay]') ?? null;
  const octx = overlay?.getContext?.('2d') ?? null;

  let video = rootEl.querySelector?.('[data-live-ai-video]') ?? rootEl.querySelector?.('video') ?? null;
  if (!video && doc?.createElement) {
    video = doc.createElement('video');
    video.setAttribute?.('data-live-ai-video', '');
    const stage = rootEl.querySelector?.('[data-live-ai-stage]');
    if (stage?.prepend) stage.prepend(video);
    else if (overlay?.before) overlay.before(video);
    else rootEl.prepend?.(video);
  }

  const playBtn = rootEl.querySelector?.('[data-live-ai-play], [data-ai-play], [data-action="play"]') ?? null;
  const playLabelEl = playBtn?.querySelector?.('[data-live-ai-play-label]') ?? null;
  const clipButtons = [...(rootEl.querySelectorAll?.('[data-clip], [data-live-ai-clip], [data-ai-clip]') ?? [])]
    .filter(btn => CLIPS_BY_ID.has(readClipIdFromButton(btn)));

  const fpsEls = [...(rootEl.querySelectorAll?.('[data-ai-fps]') ?? [])];
  const msEls = [...(rootEl.querySelectorAll?.('[data-ai-ms]') ?? [])];
  const tracksEls = [...(rootEl.querySelectorAll?.('[data-ai-tracks]') ?? [])];
  const verdictEls = [...(rootEl.querySelectorAll?.('[data-ai-verdict]') ?? [])];
  const clipTitleEls = [...(rootEl.querySelectorAll?.('[data-ai-clip-title]') ?? [])];
  const creditEls = [...(rootEl.querySelectorAll?.('[data-ai-credit]') ?? [])];

  const probEls = Object.fromEntries(
    PROB_CLASSES.map(cls => [cls, [...(rootEl.querySelectorAll?.(`[data-prob="${cls}"]`) ?? [])]]),
  );
  const probPctEls = Object.fromEntries(
    PROB_CLASSES.map(cls => [cls, [
      ...(rootEl.querySelectorAll?.(`[data-prob-pct="${cls}"], [data-prob-value="${cls}"]`) ?? []),
    ]]),
  );

  // Determine initial clip without downloading video or classifier weights.
  let currentClip = CLIPS_BY_ID.get(DEFAULT_CLIP_ID);
  for (const btn of clipButtons) {
    const id = readClipIdFromButton(btn);
    const active = btn.getAttribute?.('aria-pressed') === 'true' ||
      btn.dataset?.active === 'true' ||
      btn.classList?.contains?.('is-active');
    if (active && CLIPS_BY_ID.has(id)) {
      currentClip = CLIPS_BY_ID.get(id);
      break;
    }
  }

  if (video) {
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'none';
    video.poster = currentClip.poster;
    setAttr(video, 'aria-hidden', 'true');
  }

  let engine = null;
  let votes = null;
  let workerClient = null;
  let workerLoadPromise = null;
  let workerReady = false;
  let workerBusy = false;
  let workerFailed = false;
  let activeJob = null;

  let scratch = null;
  let sctx = null;

  let hasStarted = false;
  let destroyed = false;
  let userPaused = false;
  let autoPaused = false;
  let isOffscreen = false;
  let loadedVideoClipId = null;

  let rafId = null;
  let phaseSeq = 0;
  let frameId = 0;
  let lastMediaTime = -1;
  let lastStepAt = 0;
  let emaFps = 0;
  let emaMs = 0;
  let lastEngineMs = 0;
  let lastClassifierMs = 0;

  let lastState = null;
  let lastUsableTracks = [];
  const trackVotes = new Map();

  function setRootState(state) {
    if (rootEl.dataset) {
      rootEl.dataset.aiState = state;
      rootEl.dataset.activeClip = currentClip.id;
    }
  }

  function syncClipButtons() {
    for (const btn of clipButtons) {
      const isSelected = readClipIdFromButton(btn) === currentClip.id;
      setAttr(btn, 'aria-pressed', String(isSelected));
      if (btn.dataset) btn.dataset.active = String(isSelected);
      btn.classList?.toggle?.('is-active', isSelected);
    }
    for (const el of clipTitleEls) setText(el, currentClip.title);
    for (const el of creditEls) setText(el, currentClip.credit);
    if (rootEl.dataset) rootEl.dataset.activeClip = currentClip.id;
  }

  function syncPlayButton(state) {
    if (!playBtn) return;
    const pressed = state === 'running' || state === 'loading';
    setAttr(playBtn, 'aria-pressed', String(pressed));
    if (playBtn.dataset) playBtn.dataset.state = state;
    const labelTarget = playLabelEl || (!playBtn.children?.length ? playBtn : null);
    if (labelTarget) {
      const text = state === 'loading' ? 'Loading v4.1\u2026'
        : state === 'running' ? 'Pause v4.1'
        : state === 'paused' || state === 'offscreen' ? 'Resume v4.1'
        : state === 'error' ? 'Retry v4.1 in browser'
        : 'Run v4.1 in browser';
      setText(labelTarget, text);
    }
  }

  function renderProbabilities(probs, voteState = 'idle') {
    for (const cls of PROB_CLASSES) {
      const raw = probs && Number.isFinite(probs[cls]) ? Math.min(1, Math.max(0, probs[cls])) : 0;
      const pctInt = Math.round(raw * 100);
      const widthPct = `${(raw * 100).toFixed(1)}%`;
      const pctLabel = `${pctInt}%`;
      const probDec = raw.toFixed(3);

      for (const el of probEls[cls]) {
        if (el.dataset) {
          el.dataset.probValue = probDec;
          el.dataset.probPct = String(pctInt);
          el.dataset.voteState = voteState;
        }
        setAttr(el, 'aria-valuenow', String(pctInt));
        el.style?.setProperty?.('--prob', probDec);
        el.style?.setProperty?.('--prob-pct', widthPct);

        const tag = String(el.tagName || '').toUpperCase();
        if (tag === 'PROGRESS' || tag === 'METER') {
          el.value = Number(el.max) === 1 ? raw : pctInt;
          continue;
        }

        const innerFill = el.querySelector?.('[data-prob-fill], [data-prob-bar]');
        const innerText = el.querySelector?.('[data-prob-value], [data-prob-pct], [data-prob-label]');
        if (innerFill?.style) {
          innerFill.style.width = widthPct;
        } else if (el.style && (!el.children || el.children.length === 0)) {
          el.style.width = widthPct;
        }
        if (innerText) setText(innerText, pctLabel);
      }

      for (const pctEl of probPctEls[cls]) {
        setText(pctEl, pctLabel);
      }
    }
  }

  function pickFeaturedVote(tracks) {
    let bestReady = null;
    let bestReadyRank = -Infinity;
    let bestCollecting = null;
    let bestCollectingRank = -Infinity;

    for (const tr of tracks) {
      const vote = trackVotes.get(tr.id);
      if (!vote) continue;
      const area = Math.max(0, (tr.bbox?.w || 0) * (tr.bbox?.h || 0));
      if (vote.status === 'ready' && vote.probs) {
        const rank = (vote.label === 'drone' ? 10 : 0) + (vote.score || 0) + area;
        if (rank > bestReadyRank) {
          bestReadyRank = rank;
          bestReady = { track: tr, vote };
        }
      } else if (vote.status === 'collecting') {
        const rank = vote.count * 10 + area;
        if (rank > bestCollectingRank) {
          bestCollectingRank = rank;
          bestCollecting = { track: tr, vote };
        }
      }
    }
    return bestReady || bestCollecting;
  }

  function setVerdict(text, state, voteCount = 0) {
    for (const el of verdictEls) {
      setText(el, text);
      if (el.dataset) {
        el.dataset.verdict = state;
        el.dataset.voteCount = String(voteCount);
      }
    }
  }

  function renderTelemetry(tracks = lastUsableTracks) {
    const trackCount = tracks.length;
    for (const el of tracksEls) {
      setText(el, String(trackCount));
      if (el.dataset) el.dataset.value = String(trackCount);
    }

    if (!hasStarted) {
      for (const el of fpsEls) {
        setText(el, '\u2014');
        if (el.dataset) el.dataset.value = '0';
      }
      for (const el of msEls) {
        setText(el, '\u2014');
        if (el.dataset) el.dataset.value = '0';
      }
      setVerdict('Idle \u00b7 click to run local v4.1', 'idle', 0);
      renderProbabilities(null, 'idle');
      return;
    }

    if (emaFps > 0) {
      const fpsStr = emaFps.toFixed(1);
      for (const el of fpsEls) {
        setText(el, fpsStr);
        if (el.dataset) el.dataset.value = fpsStr;
      }
    }
    if (emaMs > 0) {
      const msNum = emaMs.toFixed(1);
      for (const el of msEls) {
        setText(el, `${msNum} ms`);
        if (el.dataset) el.dataset.value = msNum;
      }
    }

    if (userPaused || autoPaused) {
      const reason = isOffscreen ? 'Paused offscreen' : 'Paused';
      setVerdict(`${reason} \u00b7 local v4.1 idle`, 'paused', 0);
      return;
    }

    if (workerFailed && !workerReady && !workerLoadPromise) {
      setVerdict('Local v4.1 unavailable \u00b7 motion tracking active', 'error', 0);
      renderProbabilities(null, 'error');
      return;
    }

    if (!workerReady && workerLoadPromise) {
      setVerdict('Loading SkyNetLite v4.1\u2026', 'loading', 0);
      renderProbabilities(null, 'loading');
      return;
    }

    const featured = pickFeaturedVote(tracks);
    if (!featured) {
      if (trackCount === 0) {
        setVerdict('Scanning sky \u00b7 0 active tracks', 'scanning', 0);
      } else {
        setVerdict(`Acquiring track (${trackCount} in view)\u2026`, 'collecting', 0);
      }
      renderProbabilities(null, trackCount ? 'collecting' : 'scanning');
      return;
    }

    const { vote } = featured;
    if (vote.status === 'ready' && vote.probs && PROB_CLASSES.includes(vote.label)) {
      const pct = Math.round(vote.score * 100);
      const title = CLASS_TITLES[vote.label] || vote.label;
      setVerdict(`${title} \u00b7 ${pct}% (${VOTE_WINDOW}/${VOTE_WINDOW} frames \u00b7 advisory)`, vote.label, VOTE_WINDOW);
      renderProbabilities(vote.probs, 'ready');
    } else {
      const count = Math.min(VOTE_WINDOW, Math.max(1, vote.count || 1));
      setVerdict(`Collecting 5-frame vote (${count}/${VOTE_WINDOW})\u2026`, 'collecting', count);
      renderProbabilities(null, 'collecting');
    }
  }

  function clearOverlay() {
    if (!overlay || !octx) return;
    octx.clearRect(0, 0, overlay.width || 0, overlay.height || 0);
  }

  function drawCornerBrackets(ctx, x, y, w, h, arm) {
    ctx.beginPath();
    // Top-left
    ctx.moveTo(x, y + arm);
    ctx.lineTo(x, y);
    ctx.lineTo(x + arm, y);
    // Top-right
    ctx.moveTo(x + w - arm, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + arm);
    // Bottom-right
    ctx.moveTo(x + w, y + h - arm);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - arm, y + h);
    // Bottom-left
    ctx.moveTo(x + arm, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - arm);
    ctx.stroke();
  }

  function drawRadialVoteArc(ctx, cx, cy, radius, count, color, dpr) {
    const clamped = Math.min(VOTE_WINDOW, Math.max(0, count));
    ctx.save();
    ctx.lineWidth = Math.max(1.5, 2 * dpr);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    if (clamped > 0) {
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + (Math.PI * 2 * (clamped / VOTE_WINDOW));
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawOverlay(state, tracks) {
    if (!overlay || !octx) return;
    const vidW = video?.videoWidth || 854;
    const vidH = video?.videoHeight || 480;
    const dpr = getDpr();
    const cssW = overlay.clientWidth || overlay.width || vidW;
    const cssH = overlay.clientHeight || overlay.height || vidH;
    const ow = Math.max(1, Math.round(cssW * dpr));
    const oh = Math.max(1, Math.round(cssH * dpr));
    if (overlay.width !== ow || overlay.height !== oh) {
      overlay.width = ow;
      overlay.height = oh;
    }

    octx.clearRect(0, 0, ow, oh);
    if (!state) return;

    const ar = vidW / vidH || 16 / 9;
    const cover = overlay.dataset?.fit === 'cover';
    let fw = ow;
    let fh = ow / ar;
    if (cover ? fh < oh : fh > oh) {
      fh = oh;
      fw = oh * ar;
    }
    const fx = (ow - fw) / 2;
    const fy = (oh - fh) / 2;
    const mapPoint = (nx, ny) => [fx + nx * fw, fy + ny * fh];

    octx.font = `600 ${Math.round(11 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    octx.textBaseline = 'bottom';

    for (const flock of state.flocks || []) {
      if (!validBox(flock.bbox)) continue;
      const [gx, gy] = mapPoint(flock.bbox.x, flock.bbox.y);
      const gw = flock.bbox.w * fw;
      const gh = flock.bbox.h * fh;
      octx.save();
      octx.setLineDash?.([5 * dpr, 4 * dpr]);
      octx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      octx.lineWidth = Math.max(1, 1.25 * dpr);
      octx.strokeRect?.(gx - 4 * dpr, gy - 4 * dpr, gw + 8 * dpr, gh + 8 * dpr);
      octx.restore();
    }

    const minReticle = 22 * dpr;
    const ringRadius = 7.5 * dpr;

    for (const tr of tracks) {
      const vote = trackVotes.get(tr.id);
      const isReady = vote?.status === 'ready' && PROB_CLASSES.includes(vote.label);
      const voteCount = isReady ? VOTE_WINDOW : (vote?.count || 0);
      const color = isReady ? RETICLE_COLORS[vote.label] : RETICLE_COLORS.collecting;

      const [rawX, rawY] = mapPoint(tr.bbox.x, tr.bbox.y);
      const rawW = tr.bbox.w * fw;
      const rawH = tr.bbox.h * fh;
      const bw = Math.max(minReticle, rawW);
      const bh = Math.max(minReticle, rawH);
      const bx = rawX - (bw - rawW) / 2;
      const by = rawY - (bh - rawH) / 2;
      const arm = Math.max(5 * dpr, Math.min(14 * dpr, Math.min(bw, bh) * 0.3));

      if (Array.isArray(tr.trail) && tr.trail.length > 1) {
        octx.save();
        octx.strokeStyle = color;
        octx.globalAlpha = 0.45;
        octx.lineWidth = Math.max(1, 1.5 * dpr);
        octx.beginPath();
        tr.trail.forEach(([tx, ty], index) => {
          const [px, py] = mapPoint(tx, ty);
          if (index === 0) octx.moveTo(px, py);
          else octx.lineTo(px, py);
        });
        octx.stroke();
        octx.restore();
      }

      octx.save();
      octx.strokeStyle = color;
      octx.lineWidth = Math.max(1.5, 2 * dpr);
      octx.lineCap = 'square';
      drawCornerBrackets(octx, bx, by, bw, bh, arm);
      octx.restore();

      const ringX = Math.min(ow - ringRadius - 4 * dpr, Math.max(ringRadius + 4 * dpr, bx + bw + ringRadius + 4 * dpr));
      const ringY = Math.min(oh - ringRadius - 4 * dpr, Math.max(ringRadius + 4 * dpr, by + ringRadius));
      drawRadialVoteArc(octx, ringX, ringY, ringRadius, voteCount, color, dpr);

      const tag = isReady
        ? `${vote.label.toUpperCase()} ${Math.round(vote.score * 100)}% \u00b7 ${VOTE_WINDOW}/${VOTE_WINDOW}`
        : `#${tr.id} \u00b7 ${voteCount}/${VOTE_WINDOW}`;
      const labelY = by > 16 * dpr ? by - 4 * dpr : Math.min(oh - 2 * dpr, by + bh + 14 * dpr);
      octx.fillStyle = color;
      octx.fillText?.(tag, Math.max(2 * dpr, bx), labelY);
    }
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    lastStepAt = 0;
  }

  function ensureLocalPipeline() {
    if (!engine) {
      engine = createEngine({ camera_id: CAMERA_ID });
    }
    if (!votes) {
      votes = createVotes({ now });
    }
    if (!scratch) {
      scratch = createScratchCanvas();
      sctx = scratch.getContext('2d', { willReadFrequently: true });
    }
  }

  function ensureWorkerLoaded() {
    if (destroyed) return Promise.resolve(false);
    if (workerReady && workerClient) return Promise.resolve(true);
    if (workerLoadPromise) return workerLoadPromise;

    workerFailed = false;
    if (!workerClient) {
      try {
        workerClient = createWorkerClient();
      } catch {
        workerFailed = true;
        renderTelemetry();
        return Promise.resolve(false);
      }
    }

    const client = workerClient;
    let loadCall;
    try {
      loadCall = Promise.resolve(client.load());
    } catch (err) {
      loadCall = Promise.reject(err);
    }
    const pending = loadCall
      .then(() => {
        if (destroyed || workerClient !== client) return false;
        workerReady = true;
        workerFailed = false;
        if (!userPaused && !autoPaused) {
          setRootState('running');
          syncPlayButton('running');
        }
        renderTelemetry();
        return true;
      })
      .catch(err => {
        if (destroyed || workerClient !== client) return false;
        if (err?.name !== 'AbortError') {
          workerFailed = true;
          workerReady = false;
          try { client.close(); } catch {}
          workerClient = null;
          renderTelemetry();
        }
        return false;
      })
      .finally(() => {
        if (workerLoadPromise === pending) {
          workerLoadPromise = null;
        }
      });

    workerLoadPromise = pending;
    return pending;
  }

  function resetTrackPhase() {
    phaseSeq += 1;
    frameId = 0;
    lastMediaTime = -1;
    lastState = null;
    lastUsableTracks = [];
    trackVotes.clear();
    votes?.clear(CAMERA_ID);
    engine?.reset?.();
    clearOverlay();
  }

  function loadVideoSources(clip) {
    if (!video) return;
    if (loadedVideoClipId === clip.id) return;
    loadedVideoClipId = clip.id;
    video.pause?.();
    video.poster = clip.poster;
    video.preload = 'auto';

    if (doc?.createElement && typeof video.replaceChildren === 'function') {
      const mp4Source = doc.createElement('source');
      mp4Source.src = clip.mp4;
      mp4Source.type = 'video/mp4';
      const webmSource = doc.createElement('source');
      webmSource.src = clip.webm;
      webmSource.type = 'video/webm';
      video.replaceChildren(mp4Source, webmSource);
    } else {
      video.src = clip.mp4;
    }
    video.load?.();
  }

  function updateLatency(totalMs) {
    if (!Number.isFinite(totalMs) || totalMs < 0) return;
    emaMs = emaMs > 0 ? emaMs * 0.8 + totalMs * 0.2 : Math.max(0.1, totalMs);
  }

  function selectBatchTracks(tracks) {
    if (tracks.length <= MAX_WORKER_BOXES) return tracks;
    return [...tracks]
      .sort((a, b) => {
        const va = trackVotes.get(a.id);
        const vb = trackVotes.get(b.id);
        const readyA = va?.status === 'ready' ? 1 : 0;
        const readyB = vb?.status === 'ready' ? 1 : 0;
        if (readyA !== readyB) return readyA - readyB;
        const countA = va?.count || 0;
        const countB = vb?.count || 0;
        if (countA !== countB) return countB - countA;
        return (b.bbox.w * b.bbox.h) - (a.bbox.w * a.bbox.h);
      })
      .slice(0, MAX_WORKER_BOXES);
  }

  async function dispatchClassify(job) {
    workerBusy = true;
    activeJob = job;
    const t0 = now();
    try {
      const boxes = job.tracks.map(tr => clampNormalizedBox(tr.bbox));
      const results = await workerClient.classify(job.frame, boxes);
      if (destroyed || job.phaseSeq !== phaseSeq) return;
      lastClassifierMs = Math.max(0, now() - t0);
      updateLatency(lastEngineMs + lastClassifierMs);

      if (!Array.isArray(results) || results.length !== job.tracks.length) return;
      for (let i = 0; i < job.tracks.length; i += 1) {
        const tr = job.tracks[i];
        const probs = results[i]?.probs;
        if (!probs) continue;
        const vote = votes.record({ frame: job.handle, trackId: tr.id, probs });
        if (vote.status === 'collecting' || vote.status === 'ready') {
          trackVotes.set(tr.id, vote);
        }
      }
      drawOverlay(lastState, lastUsableTracks);
      renderTelemetry(lastUsableTracks);
    } catch (err) {
      if (!destroyed && job.phaseSeq === phaseSeq && err?.name !== 'AbortError') {
        workerFailed = true;
        workerReady = false;
        try { workerClient?.close(); } catch {}
        workerClient = null;
        renderTelemetry(lastUsableTracks);
      }
    } finally {
      if (activeJob === job) activeJob = null;
      workerBusy = false;
    }
  }

  function scheduleLoop() {
    if (destroyed || userPaused || autoPaused || rafId !== null) return;
    rafId = requestFrame(step);
  }

  function step(rafNow = now()) {
    rafId = null;
    if (destroyed || userPaused || autoPaused) return;
    if (isHidden()) {
      pauseAuto('hidden');
      return;
    }
    scheduleLoop();

    if (lastStepAt > 0 && rafNow - lastStepAt < minFrameIntervalMs) return;
    if (!video || !engine || !sctx) return;

    const vidW = video.videoWidth || 0;
    const vidH = video.videoHeight || 0;
    const readyState = video.readyState ?? 4;
    if (readyState < 2 || vidW <= 0 || vidH <= 0) return;

    const rawTime = Number.isFinite(video.currentTime) ? video.currentTime : null;
    if (rawTime !== null) {
      if (lastMediaTime >= 0 && rawTime < lastMediaTime - 1e-3) {
        resetTrackPhase();
      } else if (lastMediaTime >= 0 && rawTime <= lastMediaTime) {
        return;
      }
      lastMediaTime = rawTime;
    } else {
      lastMediaTime = lastMediaTime < 0 ? 0 : +(lastMediaTime + minFrameIntervalMs / 1000).toFixed(4);
    }

    const dtMs = lastStepAt > 0 ? rafNow - lastStepAt : minFrameIntervalMs;
    lastStepAt = rafNow;
    const instFps = dtMs > 0 ? 1000 / dtMs : 0;
    emaFps = emaFps > 0 ? emaFps * 0.75 + instFps * 0.25 : instFps;

    const sw = scratchWidth;
    const sh = Math.max(1, Math.round((sw * vidH) / vidW));
    if (scratch.width !== sw || scratch.height !== sh) {
      scratch.width = sw;
      scratch.height = sh;
    }
    sctx.drawImage(video, 0, 0, sw, sh);
    const imageData = sctx.getImageData(0, 0, sw, sh);

    const t0 = now();
    const state = engine.process(imageData, lastMediaTime);
    lastEngineMs = Math.max(0.05, now() - t0);
    updateLatency(lastEngineMs + lastClassifierMs);

    const tracks = extractTracks(state);
    const liveIds = tracks.map(tr => tr.id);
    const liveSet = new Set(liveIds);
    for (const id of trackVotes.keys()) {
      if (!liveSet.has(id)) trackVotes.delete(id);
    }

    lastState = state;
    lastUsableTracks = tracks;
    const currentFrameId = ++frameId;
    const streamId = `${currentClip.id}:${phaseSeq}`;
    const generation = `gen-${phaseSeq}`;

    if (activeJob && activeJob.phaseSeq === phaseSeq) {
      votes.prune({ ...activeJob.snapshot, liveTrackIds: liveIds });
    } else if (workerReady && workerClient && !workerBusy && tracks.length > 0) {
      const snapshot = {
        cameraId: CAMERA_ID,
        streamId,
        generation,
        frameId: currentFrameId,
        captureTime: lastMediaTime,
        liveTrackIds: liveIds,
      };
      const handle = votes.prune(snapshot);
      if (handle.status === 'active') {
        const batchTracks = selectBatchTracks(tracks);
        const owned = copyOwnedRgbaBuffer(imageData.data);
        void dispatchClassify({
          phaseSeq,
          handle,
          snapshot,
          tracks: batchTracks,
          frame: { data: owned, width: sw, height: sh },
        });
      }
    } else {
      votes.prune();
    }

    drawOverlay(state, tracks);
    renderTelemetry(tracks);
  }

  function startOrResume() {
    if (destroyed) return;
    hasStarted = true;
    userPaused = false;
    autoPaused = false;

    ensureLocalPipeline();
    if (phaseSeq === 0) phaseSeq = 1;
    loadVideoSources(currentClip);

    if (isOffscreen || isHidden()) {
      pauseAuto(isOffscreen ? 'offscreen' : 'hidden');
      void ensureWorkerLoaded();
      return;
    }

    const nextUiState = workerReady ? 'running' : 'loading';
    setRootState(nextUiState);
    syncPlayButton(nextUiState);
    void ensureWorkerLoaded();

    try {
      const playResult = video?.play?.();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {});
      }
    } catch {}

    renderTelemetry();
    scheduleLoop();
  }

  function pauseUser() {
    if (destroyed || !hasStarted) return;
    userPaused = true;
    autoPaused = false;
    stopLoop();
    video?.pause?.();
    setRootState('paused');
    syncPlayButton('paused');
    renderTelemetry();
  }

  function pauseAuto(reason = 'offscreen') {
    if (destroyed || !hasStarted || userPaused) return;
    autoPaused = true;
    stopLoop();
    video?.pause?.();
    const uiState = reason === 'offscreen' ? 'offscreen' : 'paused';
    setRootState(uiState);
    syncPlayButton(uiState);
    renderTelemetry();
  }

  function maybeResumeFromAutoPause() {
    if (destroyed || !hasStarted || userPaused || !autoPaused) return;
    if (isOffscreen || isHidden()) return;
    startOrResume();
  }

  function selectClip(clipId, { start = true } = {}) {
    if (destroyed || !CLIPS_BY_ID.has(clipId)) return false;
    const nextClip = CLIPS_BY_ID.get(clipId);
    const changed = nextClip.id !== currentClip.id;
    const wasStarted = hasStarted;
    currentClip = nextClip;
    syncClipButtons();

    if (!start && !wasStarted) {
      if (video) video.poster = currentClip.poster;
      return true;
    }

    if (!changed && wasStarted && !userPaused && !autoPaused && !workerFailed) {
      return true;
    }

    ensureLocalPipeline();
    if (wasStarted && changed) {
      loadedVideoClipId = null;
      resetTrackPhase();
      renderProbabilities(null, 'collecting');
    } else if (phaseSeq === 0) {
      phaseSeq = 1;
    }
    startOrResume();
    return true;
  }

  function onPlayClick(event) {
    event?.preventDefault?.();
    if (destroyed) return;
    if (!hasStarted || userPaused || autoPaused || workerFailed) {
      startOrResume();
    } else {
      pauseUser();
    }
  }

  function onVideoSeeked() {
    if (destroyed || !hasStarted || frameId === 0) return;
    resetTrackPhase();
    renderTelemetry();
  }

  function onVisibilityChange() {
    if (destroyed || !hasStarted) return;
    if (isHidden()) pauseAuto('hidden');
    else maybeResumeFromAutoPause();
  }

  const clipCleanups = [];
  if (playBtn?.addEventListener) {
    playBtn.addEventListener('click', onPlayClick);
  }
  for (const btn of clipButtons) {
    if (btn.addEventListener) {
      const handler = event => {
        event?.preventDefault?.();
        selectClip(readClipIdFromButton(btn), { start: true });
      };
      btn.addEventListener('click', handler);
      clipCleanups.push(() => btn.removeEventListener?.('click', handler));
    }
  }
  video?.addEventListener?.('seeked', onVideoSeeked);
  doc?.addEventListener?.('visibilitychange', onVisibilityChange);

  const observer = createObserver(entries => {
    if (destroyed || !Array.isArray(entries) || !entries.length) return;
    const latest = entries[entries.length - 1];
    const visible = Boolean(latest.isIntersecting) && (latest.intersectionRatio === undefined || latest.intersectionRatio > 0);
    isOffscreen = !visible;
    if (isOffscreen) pauseAuto('offscreen');
    else maybeResumeFromAutoPause();
  }, { threshold: 0 });
  observer?.observe?.(rootEl);

  // Initialize passive UI state (no downloads, no workers, no CPU/WebGL work).
  syncClipButtons();
  setRootState('idle');
  syncPlayButton('idle');
  renderTelemetry([]);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopLoop();
    observer?.disconnect?.();
    playBtn?.removeEventListener?.('click', onPlayClick);
    for (const off of clipCleanups) off();
    clipCleanups.length = 0;
    video?.removeEventListener?.('seeked', onVideoSeeked);
    doc?.removeEventListener?.('visibilitychange', onVisibilityChange);

    activeJob = null;
    workerReady = false;
    workerBusy = false;
    workerLoadPromise = null;
    if (workerClient) {
      try { workerClient.close(); } catch {}
      workerClient = null;
    }

    trackVotes.clear();
    votes?.clear();
    votes = null;
    engine?.reset?.();
    engine = null;

    if (video) {
      try { video.pause?.(); } catch {}
      video.removeAttribute?.('src');
      video.replaceChildren?.();
      try { video.load?.(); } catch {}
    }

    if (scratch) {
      scratch.width = 0;
      scratch.height = 0;
      scratch = null;
      sctx = null;
    }

    clearOverlay();
    mountedRoots.delete(rootEl);
  }

  const controller = Object.freeze({
    start: startOrResume,
    pause: pauseUser,
    resume: startOrResume,
    selectClip,
    destroy,
    getState() {
      return {
        started: hasStarted,
        destroyed,
        paused: userPaused || autoPaused,
        offscreen: isOffscreen,
        workerReady,
        clipId: currentClip.id,
        fps: +emaFps.toFixed(1),
        ms: +emaMs.toFixed(1),
        tracks: lastUsableTracks.length,
      };
    },
  });

  mountedRoots.set(rootEl, controller);
  return controller;
}

export function setupLandingLiveAiAutoMount(doc = globalThis.document) {
  if (!doc) return;
  const tryMount = () => {
    const el = doc.getElementById?.('landingLiveAi');
    if (el) mountLandingLiveAi(el, { document: doc });
  };
  if (doc.readyState === 'loading') {
    doc.addEventListener?.('DOMContentLoaded', tryMount, { once: true });
  } else {
    tryMount();
    doc.addEventListener?.('DOMContentLoaded', tryMount, { once: true });
  }
}

if (typeof document !== 'undefined') {
  setupLandingLiveAiAutoMount(document);
}
