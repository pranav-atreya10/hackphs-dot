// Interactive 10-second incident replay scrubber for SkySentry #detail panel.
// Advisory/read-only replay UI: renders buffered frames & tracks without mutating clip or detector state.

export const PLAYBACK_SPEEDS = Object.freeze([1, 0.5, 0.25]);
export const DEFAULT_ALERT_BADGE_THRESHOLD_MS = 250;
export const EMPTY_REPLAY_MESSAGE =
  'No live 10-second replay clip was captured in this browser session (incident occurred before this tab connected or camera stream was inactive).';

const TRACK_COLORS = Object.freeze({
  drone: '#ff5a4a',
  bird: '#4f9cff',
  unknown: '#f2b705',
});

const DEFAULT_CANVAS_WIDTH = 320;
const DEFAULT_CANVAS_HEIGHT = 240;
const DEFAULT_FRAME_STEP_MS = 500;
const MIN_FRAME_STEP_MS = 80;
const MAX_FRAME_STEP_MS = 2000;
const LOOP_WRAP_HOLD_MS = 650;

const mountedReplays = new WeakMap();

function createUnmountedReplayController() {
  return {
    element: null,
    canvas: null,
    badge: null,
    scrubber: null,
    playButton: null,
    prevButton: null,
    nextButton: null,
    speedButton: null,
    emptyEl: null,
    statusEl: null,
    play() { return false; },
    pause() {},
    togglePlay() { return false; },
    stepFrame() { return -1; },
    prevFrame() { return -1; },
    nextFrame() { return -1; },
    seekFrame() { return -1; },
    cycleSpeed() { return 1; },
    setSpeed() { return 1; },
    updateClip() {},
    getState() {
      return {
        status: 'unmounted',
        hasFrames: false,
        frameCount: 0,
        frameIndex: -1,
        playing: false,
        speed: 1,
        reducedMotion: false,
        sealed: true,
        offsetMs: null,
        isAlert: false,
      };
    },
    destroy() {},
  };
}

function setClasses(el, ...names) {
  if (!el) return;
  const clean = names.filter(Boolean);
  const joined = clean.join(' ');
  if (typeof el.setAttribute === 'function') {
    el.setAttribute('class', joined);
  }
  if ('className' in el && el.className !== joined) {
    el.className = joined;
  }
  if (el.classList && typeof el.classList.add === 'function') {
    if (typeof el.classList.remove === 'function' && Array.isArray(el.classList.values)) {
      for (const existing of [...el.classList.values]) {
        if (!clean.includes(existing)) el.classList.remove(existing);
      }
    }
    for (const cls of clean) {
      if (typeof el.classList.contains !== 'function' || !el.classList.contains(cls)) {
        el.classList.add(cls);
      }
    }
  }
}

function setData(el, key, value) {
  if (!el) return;
  const attr = `data-${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;
  if (value === null || value === undefined) {
    if (el.dataset) delete el.dataset[key];
    if (typeof el.removeAttribute === 'function') el.removeAttribute(attr);
    return;
  }
  const str = String(value);
  if (el.dataset) el.dataset[key] = str;
  if (typeof el.setAttribute === 'function') el.setAttribute(attr, str);
}

function setHidden(el, hidden) {
  if (!el) return;
  const flag = Boolean(hidden);
  el.hidden = flag;
  if (flag) {
    if (typeof el.setAttribute === 'function') el.setAttribute('hidden', '');
  } else if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('hidden');
  }
}

function setDisabled(el, disabled) {
  if (!el) return;
  const flag = Boolean(disabled);
  el.disabled = flag;
  if (flag) {
    if (typeof el.setAttribute === 'function') el.setAttribute('disabled', '');
  } else if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('disabled');
  }
}

function appendNodes(parent, ...nodes) {
  if (!parent) return;
  const valid = nodes.filter(Boolean);
  if (!valid.length) return;
  const syncMockParent = node => {
    if (node && typeof node === 'object' && 'parentNode' in node && !node.parentNode) {
      try { node.parentNode = parent; } catch {}
    }
  };
  if (typeof parent.append === 'function') {
    parent.append(...valid);
    for (const node of valid) syncMockParent(node);
    return;
  }
  if (typeof parent.appendChild === 'function') {
    for (const node of valid) {
      parent.appendChild(node);
      syncMockParent(node);
    }
    return;
  }
  if (Array.isArray(parent.children)) {
    parent.children.push(...valid);
    for (const node of valid) syncMockParent(node);
  }
}

function detachFromContainer(containerEl, childEl) {
  if (!childEl) return;
  if (typeof childEl.remove === 'function') {
    childEl.remove();
  } else if (childEl.parentNode && typeof childEl.parentNode.removeChild === 'function') {
    childEl.parentNode.removeChild(childEl);
  }
  if (containerEl && Array.isArray(containerEl.children)) {
    const idx = containerEl.children.indexOf(childEl);
    if (idx !== -1) containerEl.children.splice(idx, 1);
  }
}

function formatSpeedLabel(speed) {
  return `${speed}x`;
}

function detectReducedMotion(options, win) {
  if (options && typeof options.reducedMotion === 'boolean') {
    return options.reducedMotion;
  }
  const mm =
    (win && typeof win.matchMedia === 'function' ? win.matchMedia.bind(win) : null) ||
    (typeof matchMedia === 'function' ? matchMedia : null);
  if (!mm) return false;
  try {
    return Boolean(mm('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

export function formatRelativeOffsetMs(offsetMs, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const includeAlertPrefix = opts.includeAlertPrefix !== false;
  const numericOffset = typeof offsetMs === 'number' && Number.isFinite(offsetMs) ? offsetMs : 0;
  const roundedTenths = Math.round((numericOffset / 1000) * 10) / 10;

  if (Math.abs(roundedTenths) < 0.05) {
    return includeAlertPrefix ? 'ALERT 0.0s' : '0.0s';
  }

  const sign = roundedTenths > 0 ? '+' : '-';
  const formatted = `${sign}${Math.abs(roundedTenths).toFixed(1)}s`;
  if (opts.isAlert === true && includeAlertPrefix) {
    return `ALERT ${formatted}`;
  }
  return formatted;
}

function isFrameNearAlert(frame, alertThresholdMs) {
  if (!frame || typeof frame !== 'object') return false;
  const offset = typeof frame.offsetMs === 'number' && Number.isFinite(frame.offsetMs)
    ? frame.offsetMs
    : Infinity;
  if (Math.abs(offset) <= alertThresholdMs) return true;
  if (frame.isAlertFrame === true && Math.abs(offset) <= Math.max(alertThresholdMs, 500)) {
    return true;
  }
  return false;
}

function extractClipFrames(clip) {
  if (!clip || typeof clip !== 'object' || !Array.isArray(clip.frames)) {
    return [];
  }
  return clip.frames.filter(frame => frame && typeof frame === 'object');
}

function resolveAlertIndex(clip, frames) {
  if (!frames.length) return -1;
  if (
    clip &&
    typeof clip.alertFrameIndex === 'number' &&
    Number.isInteger(clip.alertFrameIndex) &&
    clip.alertFrameIndex >= 0 &&
    clip.alertFrameIndex < frames.length
  ) {
    return clip.alertFrameIndex;
  }
  const explicitIdx = frames.findIndex(f => f.isAlertFrame === true);
  if (explicitIdx !== -1) return explicitIdx;
  let bestIdx = 0;
  let bestAbs = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const abs = Math.abs(Number.isFinite(frames[i].offsetMs) ? frames[i].offsetMs : Infinity);
    if (abs < bestAbs) {
      bestAbs = abs;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function positiveDim(val, fallback) {
  return typeof val === 'number' && Number.isFinite(val) && val > 0
    ? Math.max(1, Math.round(val))
    : fallback;
}

function projectBoxToCanvas(box, canvasW, canvasH) {
  if (!box || typeof box !== 'object') return null;
  const { x, y, w, h } = box;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }
  if (w <= 0 || h <= 0) return null;

  const isNormalized =
    Math.abs(x) <= 1.0001 &&
    Math.abs(y) <= 1.0001 &&
    w <= 1.0001 &&
    h <= 1.0001;

  const rx = isNormalized ? x * canvasW : x;
  const ry = isNormalized ? y * canvasH : y;
  const rw = isNormalized ? w * canvasW : w;
  const rh = isNormalized ? h * canvasH : h;
  return { x: rx, y: ry, w: rw, h: rh };
}

function paintSnapshotSurface(ctx, snapshot, canvasW, canvasH) {
  if (!ctx) return;

  if (snapshot && typeof snapshot === 'object') {
    if (snapshot.kind === 'rgba' && ArrayBuffer.isView(snapshot.data)) {
      const snapW = positiveDim(snapshot.width, canvasW);
      const snapH = positiveDim(snapshot.height, canvasH);
      const expectedLen = snapW * snapH * 4;
      const rawBytes = new Uint8ClampedArray(
        snapshot.data.buffer,
        snapshot.data.byteOffset,
        Math.min(snapshot.data.byteLength, expectedLen),
      );
      const pixels = rawBytes.length === expectedLen
        ? rawBytes
        : (() => {
            const padded = new Uint8ClampedArray(expectedLen);
            padded.set(rawBytes);
            return padded;
          })();

      if (typeof ImageData === 'function' && typeof ctx.putImageData === 'function') {
        try {
          const imgData = new ImageData(new Uint8ClampedArray(pixels), snapW, snapH);
          ctx.putImageData(imgData, 0, 0);
          return;
        } catch {
          // Fall through to createImageData / object fallback.
        }
      }
      if (typeof ctx.createImageData === 'function' && typeof ctx.putImageData === 'function') {
        try {
          const imgData = ctx.createImageData(snapW, snapH);
          if (imgData?.data && typeof imgData.data.set === 'function') {
            imgData.data.set(pixels);
            ctx.putImageData(imgData, 0, 0);
            return;
          }
        } catch {
          // Fall through to direct putImageData fallback.
        }
      }
      if (typeof ctx.putImageData === 'function') {
        try {
          ctx.putImageData({ width: snapW, height: snapH, data: pixels }, 0, 0);
          return;
        } catch {
          // Fall through to solid backdrop.
        }
      }
    }

    if (snapshot.kind === 'canvas' && snapshot.canvas && typeof ctx.drawImage === 'function') {
      try {
        if (typeof ctx.clearRect === 'function') ctx.clearRect(0, 0, canvasW, canvasH);
        ctx.drawImage(snapshot.canvas, 0, 0, canvasW, canvasH);
        return;
      } catch {
        // Fall through to solid backdrop.
      }
    }
  }

  const bg = snapshot && typeof snapshot.color === 'string' && snapshot.color.trim()
    ? snapshot.color.trim()
    : '#0a0a0a';
  ctx.fillStyle = bg;
  if (typeof ctx.fillRect === 'function') {
    ctx.fillRect(0, 0, canvasW, canvasH);
  }

  const caption = snapshot && typeof snapshot === 'object'
    ? (typeof snapshot.label === 'string' && snapshot.label.trim()
        ? snapshot.label.trim()
        : snapshot.tag !== null && snapshot.tag !== undefined
          ? String(snapshot.tag)
          : '')
    : '';

  if (caption && typeof ctx.fillText === 'function') {
    if (typeof ctx.save === 'function') ctx.save();
    ctx.fillStyle = 'rgba(250, 250, 250, 0.55)';
    ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText(caption, 10, canvasH - 10);
    if (typeof ctx.restore === 'function') ctx.restore();
  }
}

function paintTrackOverlays(ctx, rawTracks, canvasW, canvasH) {
  if (!ctx || !Array.isArray(rawTracks) || rawTracks.length === 0) return;

  for (let i = 0; i < rawTracks.length; i++) {
    const item = rawTracks[i];
    if (!item || typeof item !== 'object' || item.missed) continue;
    const clsName = typeof item.classification === 'string' ? item.classification : 'unknown';
    if (clsName === 'rejected') continue;

    const rect = projectBoxToCanvas(item.bbox, canvasW, canvasH);
    if (!rect) continue;

    const color = TRACK_COLORS[clsName] || TRACK_COLORS.unknown;
    const idPart = item.id !== null && item.id !== undefined ? ` #${item.id}` : '';
    const flapPart = typeof item.flap_hz === 'number' && Number.isFinite(item.flap_hz)
      ? ` ${item.flap_hz.toFixed(1)}Hz`
      : '';
    const labelText = `${clsName.toUpperCase()}${idPart}${flapPart}`;

    if (typeof ctx.save === 'function') ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (typeof ctx.strokeRect === 'function') {
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }

    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const measured = typeof ctx.measureText === 'function' ? ctx.measureText(labelText) : null;
    const textWidth = measured && Number.isFinite(measured.width) ? measured.width : labelText.length * 6.8;
    const pillW = Math.min(canvasW, Math.ceil(textWidth) + 8);
    const pillH = 16;
    const pillX = Math.max(0, Math.min(canvasW - pillW, rect.x));
    const pillY = rect.y >= pillH + 2 ? rect.y - pillH - 2 : Math.min(canvasH - pillH, Math.max(0, rect.y + 2));

    ctx.fillStyle = 'rgba(10, 10, 10, 0.84)';
    if (typeof ctx.fillRect === 'function') {
      ctx.fillRect(pillX, pillY, pillW, pillH);
    }
    ctx.fillStyle = color;
    if (typeof ctx.fillText === 'function') {
      ctx.fillText(labelText, pillX + 4, pillY + 12);
    }
    if (typeof ctx.restore === 'function') ctx.restore();
  }
}

function computeBaseFrameDelayMs(frames, index) {
  if (!Array.isArray(frames) || frames.length < 2) return DEFAULT_FRAME_STEP_MS;
  if (index + 1 < frames.length) {
    const curAt = frames[index]?.atMs;
    const nextAt = frames[index + 1]?.atMs;
    if (Number.isFinite(curAt) && Number.isFinite(nextAt)) {
      const delta = nextAt - curAt;
      if (delta > 0) {
        return Math.max(MIN_FRAME_STEP_MS, Math.min(MAX_FRAME_STEP_MS, delta));
      }
    }
    return DEFAULT_FRAME_STEP_MS;
  }
  return LOOP_WRAP_HOLD_MS;
}

export function mountIncidentReplay(containerEl, options = {}) {
  const isDomContainer = Boolean(
    containerEl &&
    typeof containerEl === 'object' &&
    !Array.isArray(containerEl) &&
    (typeof containerEl.append === 'function' || typeof containerEl.appendChild === 'function'),
  );
  if (!isDomContainer) {
    return createUnmountedReplayController();
  }

  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const doc = opts.doc || containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') {
    return createUnmountedReplayController();
  }

  const win = opts.win || doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const rafFn =
    opts.requestAnimationFrame ||
    (win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null) ||
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
  const cancelRafFn =
    opts.cancelAnimationFrame ||
    (win && typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null) ||
    (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);
  const setTimeoutFn =
    opts.setTimeout ||
    (win && typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : null) ||
    (typeof setTimeout === 'function' ? setTimeout : null);
  const clearTimeoutFn =
    opts.clearTimeout ||
    (win && typeof win.clearTimeout === 'function' ? win.clearTimeout.bind(win) : null) ||
    (typeof clearTimeout === 'function' ? clearTimeout : null);
  const nowFn = typeof opts.now === 'function'
    ? opts.now
    : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now());

  const alertThresholdMs =
    typeof opts.alertThresholdMs === 'number' && Number.isFinite(opts.alertThresholdMs) && opts.alertThresholdMs >= 0
      ? opts.alertThresholdMs
      : DEFAULT_ALERT_BADGE_THRESHOLD_MS;
  const emptyMessage =
    typeof opts.emptyMessage === 'string' && opts.emptyMessage.trim()
      ? opts.emptyMessage.trim()
      : EMPTY_REPLAY_MESSAGE;

  const previous = mountedReplays.get(containerEl);
  if (previous) {
    previous.destroy();
    detachFromContainer(containerEl, previous.element);
    mountedReplays.delete(containerEl);
  }

  const root = doc.createElement('section');
  setClasses(root, 'incident-replay');
  if (typeof root.setAttribute === 'function') {
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', '10-second incident replay');
    root.setAttribute('tabindex', '0');
  }

  const viewport = doc.createElement('div');
  setClasses(viewport, 'incident-replay-viewport');

  const canvas = doc.createElement('canvas');
  setClasses(canvas, 'incident-replay-canvas');
  canvas.width = DEFAULT_CANVAS_WIDTH;
  canvas.height = DEFAULT_CANVAS_HEIGHT;

  const badge = doc.createElement('span');
  setClasses(badge, 'incident-replay-badge');
  setData(badge, 'alert', 'false');
  badge.textContent = '0.0s';

  appendNodes(viewport, canvas, badge);

  const controls = doc.createElement('div');
  setClasses(controls, 'incident-replay-controls');

  const playButton = doc.createElement('button');
  setClasses(playButton, 'incident-replay-btn', 'incident-replay-play');
  playButton.type = 'button';
  if (typeof playButton.setAttribute === 'function') {
    playButton.setAttribute('type', 'button');
    playButton.setAttribute('aria-pressed', 'false');
    playButton.setAttribute('aria-label', 'Play incident replay');
  }
  playButton.textContent = 'Play';

  const prevButton = doc.createElement('button');
  setClasses(prevButton, 'incident-replay-btn', 'incident-replay-prev');
  prevButton.type = 'button';
  if (typeof prevButton.setAttribute === 'function') {
    prevButton.setAttribute('type', 'button');
    prevButton.setAttribute('aria-label', 'Previous frame');
  }
  prevButton.textContent = '\u25C0';

  const scrubber = doc.createElement('input');
  setClasses(scrubber, 'incident-replay-scrubber');
  scrubber.type = 'range';
  scrubber.min = '0';
  scrubber.max = '0';
  scrubber.step = '1';
  scrubber.value = '0';
  if (typeof scrubber.setAttribute === 'function') {
    scrubber.setAttribute('type', 'range');
    scrubber.setAttribute('min', '0');
    scrubber.setAttribute('max', '0');
    scrubber.setAttribute('step', '1');
    scrubber.setAttribute('value', '0');
    scrubber.setAttribute('aria-label', 'Incident replay timeline');
  }

  const nextButton = doc.createElement('button');
  setClasses(nextButton, 'incident-replay-btn', 'incident-replay-next');
  nextButton.type = 'button';
  if (typeof nextButton.setAttribute === 'function') {
    nextButton.setAttribute('type', 'button');
    nextButton.setAttribute('aria-label', 'Next frame');
  }
  nextButton.textContent = '\u25B6';

  const speedButton = doc.createElement('button');
  setClasses(speedButton, 'incident-replay-btn', 'incident-replay-speed');
  speedButton.type = 'button';
  if (typeof speedButton.setAttribute === 'function') {
    speedButton.setAttribute('type', 'button');
    speedButton.setAttribute('aria-label', 'Playback speed 1x');
  }
  speedButton.textContent = '1x';

  appendNodes(controls, playButton, prevButton, scrubber, nextButton, speedButton);

  const statusEl = doc.createElement('p');
  setClasses(statusEl, 'incident-replay-status');
  statusEl.style.margin = '0';
  statusEl.style.fontSize = '0.76rem';
  statusEl.style.opacity = '0.78';
  setHidden(statusEl, true);

  const emptyEl = doc.createElement('p');
  setClasses(emptyEl, 'incident-replay-empty');
  emptyEl.textContent = emptyMessage;
  setHidden(emptyEl, true);

  appendNodes(root, viewport, controls, statusEl, emptyEl);

  let currentClip = opts.clip ?? null;
  let frames = extractClipFrames(currentClip);
  let speedIndex = 0;
  let speed = PLAYBACK_SPEEDS[0];
  let reducedMotion = detectReducedMotion(opts, win);
  let playing = false;
  let frameIndex = -1;
  let rafId = null;
  let timerId = null;
  let lastTickAt = 0;
  let destroyed = false;

  if (typeof opts.speed === 'number' && PLAYBACK_SPEEDS.includes(opts.speed)) {
    speedIndex = PLAYBACK_SPEEDS.indexOf(opts.speed);
    speed = opts.speed;
    speedButton.textContent = formatSpeedLabel(speed);
    if (typeof speedButton.setAttribute === 'function') {
      speedButton.setAttribute('aria-label', `Playback speed ${formatSpeedLabel(speed)}`);
    }
  }

  function cancelScheduledTick() {
    if (rafId !== null) {
      if (cancelRafFn) {
        try { cancelRafFn(rafId); } catch {}
      }
      rafId = null;
    }
    if (timerId !== null) {
      if (clearTimeoutFn) {
        try { clearTimeoutFn(timerId); } catch {}
      }
      timerId = null;
    }
  }

  function syncPlayButton() {
    const active = playing && frames.length > 1;
    playButton.textContent = active ? 'Pause' : 'Play';
    if (typeof playButton.setAttribute === 'function') {
      playButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      playButton.setAttribute('aria-label', active ? 'Pause incident replay' : 'Play incident replay');
    }
  }

  function syncStatusNote() {
    if (!frames.length) {
      statusEl.textContent = '';
      setData(statusEl, 'state', 'empty');
      setHidden(statusEl, true);
      return;
    }
    const isSealed = currentClip ? Boolean(currentClip.sealed ?? currentClip.complete ?? true) : true;
    if (!isSealed) {
      statusEl.textContent = `Capturing post-alert window (+2.0s)… · ${frames.length} frames buffered`;
      setData(statusEl, 'state', 'capturing');
      setHidden(statusEl, false);
    } else {
      statusEl.textContent = `Advisory 10s replay · Frame ${frameIndex + 1} of ${frames.length}`;
      setData(statusEl, 'state', 'sealed');
      setHidden(statusEl, false);
    }
  }

  function renderCurrentFrame() {
    const hasFrames = frames.length > 0;
    const isSealed = currentClip ? Boolean(currentClip.sealed ?? currentClip.complete ?? true) : true;
    setData(root, 'sealed', isSealed ? 'true' : 'false');
    setData(root, 'empty', hasFrames ? 'false' : 'true');

    if (!hasFrames) {
      setHidden(viewport, true);
      setHidden(controls, true);
      setHidden(emptyEl, false);
      setDisabled(playButton, true);
      setDisabled(prevButton, true);
      setDisabled(nextButton, true);
      setDisabled(speedButton, true);
      setDisabled(scrubber, true);
      setData(badge, 'alert', 'false');
      badge.textContent = '0.0s';
      syncPlayButton();
      syncStatusNote();
      return;
    }

    setHidden(emptyEl, true);
    setHidden(viewport, false);
    setHidden(controls, false);

    const canScrubMultiple = frames.length > 1;
    setDisabled(playButton, !canScrubMultiple);
    setDisabled(prevButton, !canScrubMultiple);
    setDisabled(nextButton, !canScrubMultiple);
    setDisabled(speedButton, false);
    setDisabled(scrubber, !canScrubMultiple);

    frameIndex = Math.max(0, Math.min(frames.length - 1, frameIndex < 0 ? 0 : frameIndex));
    const maxStr = String(Math.max(0, frames.length - 1));
    const valStr = String(frameIndex);
    scrubber.max = maxStr;
    scrubber.value = valStr;
    if (typeof scrubber.setAttribute === 'function') {
      scrubber.setAttribute('max', maxStr);
      scrubber.setAttribute('value', valStr);
    }

    const frame = frames[frameIndex];
    const nearAlert = isFrameNearAlert(frame, alertThresholdMs);
    setData(badge, 'alert', nearAlert ? 'true' : 'false');
    badge.textContent = formatRelativeOffsetMs(frame.offsetMs, { isAlert: nearAlert });

    const frameW = positiveDim(frame.width ?? frame.snapshot?.width, DEFAULT_CANVAS_WIDTH);
    const frameH = positiveDim(frame.height ?? frame.snapshot?.height, DEFAULT_CANVAS_HEIGHT);
    if (canvas.width !== frameW) canvas.width = frameW;
    if (canvas.height !== frameH) canvas.height = frameH;

    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (ctx) {
      paintSnapshotSurface(ctx, frame.snapshot, frameW, frameH);
      paintTrackOverlays(ctx, frame.tracks, frameW, frameH);
    }

    syncPlayButton();
    syncStatusNote();

    if (typeof opts.onFrameChange === 'function') {
      opts.onFrameChange({
        frameIndex,
        frameCount: frames.length,
        offsetMs: frame.offsetMs,
        isAlert: nearAlert,
        playing,
        speed,
      });
    }
  }

  function scheduleNextTick() {
    cancelScheduledTick();
    if (destroyed || !playing || frames.length < 2) return;

    const effectiveDelay = Math.max(20, computeBaseFrameDelayMs(frames, frameIndex) / speed);

    if (rafFn) {
      const onRaf = ts => {
        rafId = null;
        if (destroyed || !playing || frames.length < 2) return;
        const currentTs = typeof ts === 'number' && Number.isFinite(ts) ? ts : nowFn();
        if (lastTickAt <= 0) {
          lastTickAt = currentTs;
        }
        const needed = Math.max(20, computeBaseFrameDelayMs(frames, frameIndex) / speed);
        if (currentTs - lastTickAt >= needed) {
          lastTickAt = currentTs;
          frameIndex = (frameIndex + 1) % frames.length;
          renderCurrentFrame();
        }
        scheduleNextTick();
      };
      rafId = rafFn(onRaf);
      return;
    }

    if (setTimeoutFn) {
      timerId = setTimeoutFn(() => {
        timerId = null;
        if (destroyed || !playing || frames.length < 2) return;
        lastTickAt = nowFn();
        frameIndex = (frameIndex + 1) % frames.length;
        renderCurrentFrame();
        scheduleNextTick();
      }, effectiveDelay);
    }
  }

  function play() {
    if (destroyed || frames.length < 2) return false;
    if (playing) return true;
    playing = true;
    lastTickAt = nowFn();
    syncPlayButton();
    scheduleNextTick();
    return true;
  }

  function pause() {
    playing = false;
    cancelScheduledTick();
    syncPlayButton();
  }

  function togglePlay() {
    if (playing) {
      pause();
      return false;
    }
    return play();
  }

  function seekFrame(targetIndex) {
    if (destroyed || !frames.length) return -1;
    const numeric = Number(targetIndex);
    if (!Number.isFinite(numeric)) return frameIndex;
    frameIndex = Math.max(0, Math.min(frames.length - 1, Math.trunc(numeric)));
    renderCurrentFrame();
    return frameIndex;
  }

  function stepFrame(delta) {
    if (destroyed || !frames.length) return -1;
    pause();
    const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    frameIndex = Math.max(0, Math.min(frames.length - 1, frameIndex + step));
    renderCurrentFrame();
    return frameIndex;
  }

  function setSpeed(nextRate) {
    const idx = PLAYBACK_SPEEDS.indexOf(nextRate);
    if (idx === -1) return speed;
    speedIndex = idx;
    speed = PLAYBACK_SPEEDS[idx];
    const label = formatSpeedLabel(speed);
    speedButton.textContent = label;
    if (typeof speedButton.setAttribute === 'function') {
      speedButton.setAttribute('aria-label', `Playback speed ${label}`);
    }
    if (playing) {
      lastTickAt = nowFn();
      scheduleNextTick();
    }
    return speed;
  }

  function cycleSpeed() {
    const nextIdx = (speedIndex + 1) % PLAYBACK_SPEEDS.length;
    return setSpeed(PLAYBACK_SPEEDS[nextIdx]);
  }

  function updateClip(nextClip) {
    if (destroyed) return;
    const prevHadFrames = frames.length > 0;
    const prevFrame = prevHadFrames && frameIndex >= 0 && frameIndex < frames.length ? frames[frameIndex] : null;
    const prevIncidentId = currentClip?.incidentId ?? null;

    currentClip = nextClip ?? null;
    frames = extractClipFrames(currentClip);

    if (!frames.length) {
      pause();
      frameIndex = -1;
      renderCurrentFrame();
      return;
    }

    const nextIncidentId = currentClip?.incidentId ?? null;
    const sameIncident = prevIncidentId === null || nextIncidentId === null || prevIncidentId === nextIncidentId;

    if (prevHadFrames && sameIncident && prevFrame) {
      let matchedIndex = -1;
      if (prevFrame.frameId !== null && prevFrame.frameId !== undefined) {
        matchedIndex = frames.findIndex(f => f.frameId === prevFrame.frameId);
      }
      if (matchedIndex === -1 && Number.isFinite(prevFrame.atMs)) {
        matchedIndex = frames.findIndex(f => f.atMs === prevFrame.atMs);
      }
      frameIndex = matchedIndex !== -1
        ? matchedIndex
        : Math.max(0, Math.min(frames.length - 1, frameIndex));
    } else {
      reducedMotion = detectReducedMotion(opts, win);
      const shouldAutoPlay = !reducedMotion && opts.autoPlay !== false && frames.length > 1;
      frameIndex = shouldAutoPlay ? 0 : Math.max(0, resolveAlertIndex(currentClip, frames));
      playing = shouldAutoPlay;
    }

    if (frames.length < 2) {
      playing = false;
      cancelScheduledTick();
    }

    renderCurrentFrame();
    if (playing && rafId === null && timerId === null) {
      lastTickAt = nowFn();
      scheduleNextTick();
    }
  }

  const onPlayClick = () => { togglePlay(); };
  const onPrevClick = () => { stepFrame(-1); };
  const onNextClick = () => { stepFrame(1); };
  const onSpeedClick = () => { cycleSpeed(); };
  const onScrubberInput = event => {
    pause();
    const rawVal = event?.target?.value ?? scrubber.value;
    seekFrame(Number(rawVal));
  };
  const onRootKeyDown = event => {
    if (!event || !frames.length) return;
    if (event.key === 'ArrowLeft') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      stepFrame(-1);
    } else if (event.key === 'ArrowRight') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      stepFrame(1);
    }
  };

  if (typeof playButton.addEventListener === 'function') playButton.addEventListener('click', onPlayClick);
  if (typeof prevButton.addEventListener === 'function') prevButton.addEventListener('click', onPrevClick);
  if (typeof nextButton.addEventListener === 'function') nextButton.addEventListener('click', onNextClick);
  if (typeof speedButton.addEventListener === 'function') speedButton.addEventListener('click', onSpeedClick);
  if (typeof scrubber.addEventListener === 'function') scrubber.addEventListener('input', onScrubberInput);
  if (typeof root.addEventListener === 'function') root.addEventListener('keydown', onRootKeyDown);

  if (frames.length > 0) {
    const hasExplicitIndex = Number.isInteger(opts.initialFrameIndex);
    const shouldAutoPlay = !reducedMotion && opts.autoPlay !== false && frames.length > 1;
    if (hasExplicitIndex) {
      frameIndex = Math.max(0, Math.min(frames.length - 1, opts.initialFrameIndex));
    } else if (shouldAutoPlay) {
      frameIndex = 0;
    } else {
      frameIndex = Math.max(0, resolveAlertIndex(currentClip, frames));
    }
    playing = shouldAutoPlay;
  }

  appendNodes(containerEl, root);
  renderCurrentFrame();
  if (playing) {
    lastTickAt = nowFn();
    scheduleNextTick();
  }

  function getState() {
    const activeFrame = frames.length > 0 && frameIndex >= 0 && frameIndex < frames.length
      ? frames[frameIndex]
      : null;
    const isSealed = currentClip ? Boolean(currentClip.sealed ?? currentClip.complete ?? true) : true;
    return {
      status: destroyed ? 'destroyed' : (frames.length > 0 ? 'ready' : 'empty'),
      hasFrames: frames.length > 0,
      frameCount: frames.length,
      frameIndex: frames.length > 0 ? frameIndex : -1,
      playing,
      speed,
      reducedMotion,
      sealed: isSealed,
      offsetMs: activeFrame ? activeFrame.offsetMs : null,
      isAlert: activeFrame ? isFrameNearAlert(activeFrame, alertThresholdMs) : false,
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    playing = false;
    cancelScheduledTick();

    if (typeof playButton.removeEventListener === 'function') playButton.removeEventListener('click', onPlayClick);
    if (typeof prevButton.removeEventListener === 'function') prevButton.removeEventListener('click', onPrevClick);
    if (typeof nextButton.removeEventListener === 'function') nextButton.removeEventListener('click', onNextClick);
    if (typeof speedButton.removeEventListener === 'function') speedButton.removeEventListener('click', onSpeedClick);
    if (typeof scrubber.removeEventListener === 'function') scrubber.removeEventListener('input', onScrubberInput);
    if (typeof root.removeEventListener === 'function') root.removeEventListener('keydown', onRootKeyDown);

    detachFromContainer(containerEl, root);
    if (mountedReplays.get(containerEl) === handle) {
      mountedReplays.delete(containerEl);
    }
  }

  const handle = {
    element: root,
    canvas,
    badge,
    scrubber,
    playButton,
    prevButton,
    nextButton,
    speedButton,
    emptyEl,
    statusEl,
    play,
    pause,
    togglePlay,
    stepFrame,
    prevFrame: () => stepFrame(-1),
    nextFrame: () => stepFrame(1),
    seekFrame,
    cycleSpeed,
    setSpeed,
    updateClip,
    getState,
    destroy,
  };

  mountedReplays.set(containerEl, handle);
  return handle;
}
