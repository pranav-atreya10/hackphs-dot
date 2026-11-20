// 60 fps aviation-HUD corner reticles and frame-rate-independent bbox interpolation.
// Pure ES module with zero DOM globals required at import time so Node tests run directly.

const FRAME_MS_60FPS = 1000 / 60;
const LOCK_START_SCALE = 1.22;
const SNAP_EPSILON = 1e-6;

export const RETICLE_MOTION_EPSILON = 0.0005;

export const RETICLE_COLORS = Object.freeze({
  bird: '#4f9cff',
  drone: '#ff5a4a',
  unknown: '#f2b705',
  rejected: 'rgba(200,200,200,0.5)',
  debris: '#a08c78',
});

const INTERNAL_STATE = Symbol('hudReticleInterpolatorState');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = v => clamp(v, 0, 1);

function isValidBbox(b) {
  return Boolean(
    b &&
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.w) &&
    Number.isFinite(b.h),
  );
}

function copyBbox(b) {
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

function rectDelta(a, b) {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.w - b.w),
    Math.abs(a.h - b.h),
  );
}

// Cubic ease-out (0 -> 1), guaranteed strictly < 1 while elapsedMs < durationMs.
function computeLockProgress(elapsedMs, durationMs) {
  if (!(durationMs > 0)) return 1;
  const linear = clamp01(elapsedMs / durationMs);
  if (linear >= 1) return 1;
  if (linear <= 0) return 0;
  const inv = 1 - linear;
  return Math.min(1 - Number.EPSILON, 1 - inv * inv * inv);
}

function computeLockScale(lockProgress) {
  return 1 + (LOCK_START_SCALE - 1) * (1 - clamp01(lockProgress));
}

export function createReticleInterpolator({
  smoothing = 0.32,
  lockDurationMs = 260,
  graceMs = 180,
} = {}) {
  const baseSmoothing = Number.isFinite(smoothing) ? clamp(smoothing, 0.001, 1) : 0.32;
  const lockMs = Number.isFinite(lockDurationMs) ? Math.max(0, lockDurationMs) : 260;
  const pruneGraceMs = Number.isFinite(graceMs) ? Math.max(0, graceMs) : 180;

  const entries = new Map();
  let lastNowMs = null;

  function step(tracks, nowMs, { reducedMotion = false } = {}) {
    const now = Number.isFinite(nowMs)
      ? nowMs
      : (lastNowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const snapImmediate = Boolean(reducedMotion) || baseSmoothing >= 1;
    lastNowMs = now;

    const seenIds = new Set();
    const out = [];

    if (Array.isArray(tracks)) {
      for (const tr of tracks) {
        if (!tr || tr.id === undefined || tr.id === null || tr.missed || !isValidBbox(tr.bbox)) {
          continue;
        }
        const id = tr.id;
        seenIds.add(id);
        const target = copyBbox(tr.bbox);
        let entry = entries.get(id);

        if (!entry) {
          const current = copyBbox(target);
          const lockProgress = snapImmediate ? 1 : computeLockProgress(0, lockMs);
          entry = {
            id,
            current,
            target,
            bornAt: now,
            lastStepAt: now,
            lastSeenAt: now,
            lockDurationMs: lockMs,
            reducedMotion: snapImmediate,
            lockProgress,
            delta: 0,
            active: true,
          };
          entries.set(id, entry);
        } else {
          const prevDelta = rectDelta(entry.current, entry.target);
          const rawDtMs = Math.max(0, now - entry.lastStepAt);
          entry.target = target;
          entry.lastSeenAt = now;
          entry.lastStepAt = now;
          entry.active = true;
          entry.reducedMotion = snapImmediate;

          if (snapImmediate) {
            entry.current = copyBbox(target);
          } else if (rawDtMs > 0) {
            // Waking after an idle RAF pause (>60ms while previously settled) steps 1 frame instead of teleporting.
            const idleWake = prevDelta <= RETICLE_MOTION_EPSILON && rawDtMs > 60;
            const dtFrames = idleWake ? 1 : Math.min(4, rawDtMs / FRAME_MS_60FPS);
            const alpha = 1 - Math.pow(1 - baseSmoothing, dtFrames);
            entry.current = {
              x: entry.current.x + (target.x - entry.current.x) * alpha,
              y: entry.current.y + (target.y - entry.current.y) * alpha,
              w: entry.current.w + (target.w - entry.current.w) * alpha,
              h: entry.current.h + (target.h - entry.current.h) * alpha,
            };
            if (rectDelta(entry.current, target) <= SNAP_EPSILON) {
              entry.current = copyBbox(target);
            }
          }

          entry.lockProgress = snapImmediate
            ? 1
            : computeLockProgress(now - entry.bornAt, lockMs);
          entry.delta = rectDelta(entry.current, entry.target);
        }

        const flapVal = tr.flap_hz ?? tr.flapHz ?? null;
        const flapHz = Number.isFinite(flapVal) && flapVal > 0 ? flapVal : null;
        const isFlock = Boolean(tr.is_flock || tr.isFlock);
        const classification = tr.classification || 'unknown';
        const bbox = copyBbox(entry.current);
        const scale = computeLockScale(entry.lockProgress);

        out.push({
          id,
          x: bbox.x,
          y: bbox.y,
          w: bbox.w,
          h: bbox.h,
          bbox,
          targetBbox: copyBbox(entry.target),
          delta: entry.delta,
          lockProgress: entry.lockProgress,
          scale,
          bornAt: entry.bornAt,
          lockDurationMs: lockMs,
          reducedMotion: entry.reducedMotion,
          classification,
          flapHz,
          flap_hz: flapHz,
          isFlock,
          is_flock: isFlock,
          trail: Array.isArray(tr.trail) ? tr.trail : null,
          eta_seconds: tr.eta_seconds ?? null,
          eta_basis: tr.eta_basis ?? null,
          confidence: tr.confidence ?? null,
          track: tr,
        });
      }
    }

    // Mark unseen tracks inactive and prune any that exceeded the short grace window.
    for (const [id, entry] of entries) {
      if (seenIds.has(id)) continue;
      entry.active = false;
      if (now - entry.lastSeenAt > pruneGraceMs) {
        entries.delete(id);
      }
    }

    return out;
  }

  function clear() {
    entries.clear();
    lastNowMs = null;
  }

  return {
    step,
    clear,
    get size() {
      return entries.size;
    },
    get activeCount() {
      let n = 0;
      for (const entry of entries.values()) if (entry.active) n++;
      return n;
    },
    get(id) {
      const e = entries.get(id);
      return e
        ? {
            id: e.id,
            bbox: copyBbox(e.current),
            targetBbox: copyBbox(e.target),
            delta: e.delta,
            lockProgress: e.lockProgress,
            scale: computeLockScale(e.lockProgress),
            bornAt: e.bornAt,
            lastSeenAt: e.lastSeenAt,
            active: e.active,
          }
        : undefined;
    },
    [INTERNAL_STATE]: {
      entries,
      get graceMs() {
        return pruneGraceMs;
      },
      get lockDurationMs() {
        return lockMs;
      },
    },
  };
}

export function hasActiveReticleMotion(interpolatorState, nowMs) {
  if (!interpolatorState) return false;
  const hasNow = Number.isFinite(nowMs);

  const internal = interpolatorState[INTERNAL_STATE];
  if (internal?.entries instanceof Map) {
    for (const entry of internal.entries.values()) {
      if (!entry.active) continue;
      if (hasNow && nowMs - entry.lastSeenAt > internal.graceMs) continue;
      const delta = rectDelta(entry.current, entry.target);
      if (delta > RETICLE_MOTION_EPSILON) return true;
      const progress = entry.reducedMotion
        ? 1
        : hasNow
          ? computeLockProgress(nowMs - entry.bornAt, entry.lockDurationMs)
          : entry.lockProgress;
      if (progress < 1) return true;
    }
    return false;
  }

  const list = Array.isArray(interpolatorState)
    ? interpolatorState
    : interpolatorState instanceof Map
      ? interpolatorState.values()
      : Array.isArray(interpolatorState.tracks)
        ? interpolatorState.tracks
        : null;
  if (!list) return false;

  for (const item of list) {
    if (!item || item.active === false) continue;
    const cur = item.bbox || item.current || item;
    const tgt = item.targetBbox || item.target || cur;
    const delta = isValidBbox(cur) && isValidBbox(tgt)
      ? rectDelta(cur, tgt)
      : (Number.isFinite(item.delta) ? item.delta : 0);
    if (delta > RETICLE_MOTION_EPSILON) return true;

    let progress = Number.isFinite(item.lockProgress) ? item.lockProgress : 1;
    if (item.reducedMotion) {
      progress = 1;
    } else if (hasNow && Number.isFinite(item.bornAt) && Number.isFinite(item.lockDurationMs)) {
      progress = computeLockProgress(nowMs - item.bornAt, item.lockDurationMs);
    }
    if (progress < 1) return true;
  }
  return false;
}

function traceRoundedRect(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w * 0.5, h * 0.5));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  if (typeof ctx.quadraticCurveTo === 'function') {
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  } else {
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function formatFlapHz(flapHz) {
  if (!Number.isFinite(flapHz) || flapHz <= 0) return '';
  const rounded = Math.round(flapHz * 10) / 10;
  return `${rounded} Hz`;
}

export function drawCornerReticle(
  ctx,
  rect,
  {
    color = '#4f9cff',
    dpr = 1,
    lockProgress = 1,
    classification = 'unknown',
    flapHz = null,
    isFlock = false,
    centerTick = true,
  } = {},
) {
  if (!ctx || !isValidBbox(rect) || rect.w <= 0 || rect.h <= 0) return;

  const scaleDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const progress = clamp01(Number.isFinite(lockProgress) ? lockProgress : 1);
  const lockScale = computeLockScale(progress);
  const baseAlpha = 0.72 + 0.28 * progress;

  const cx = rect.x + rect.w * 0.5;
  const cy = rect.y + rect.h * 0.5;
  const w = rect.w * lockScale;
  const h = rect.h * lockScale;
  const x = cx - w * 0.5;
  const y = cy - h * 0.5;

  const minSide = Math.min(w, h);
  const clampedArm = clamp(minSide * 0.24, 5 * scaleDpr, 16 * scaleDpr);
  const arm = minSide < 10 * scaleDpr ? Math.min(clampedArm, minSide * 0.5) : clampedArm;

  ctx.save?.();
  try {
    // 1. Subtle translucent inner framing hairline
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.22 * baseAlpha;
    ctx.lineWidth = Math.max(0.75, 1 * scaleDpr);
    ctx.strokeRect(x, y, w, h);

    // 2. Crisp aviation-HUD L-shaped corner brackets
    ctx.globalAlpha = baseAlpha;
    ctx.lineWidth = Math.max(1.25, 1.75 * scaleDpr);
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
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

    // 3. Faint center pipper tick
    if (centerTick) {
      const tickHalf = clamp(minSide * 0.08, 1.5 * scaleDpr, 3.5 * scaleDpr);
      ctx.globalAlpha = 0.36 * baseAlpha;
      ctx.lineWidth = Math.max(0.75, 1 * scaleDpr);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(cx - tickHalf, cy);
      ctx.lineTo(cx + tickHalf, cy);
      ctx.moveTo(cx, cy - tickHalf);
      ctx.lineTo(cx, cy + tickHalf);
      ctx.stroke();
    }

    // 4. Crisp monospace label pill above top-left (skipped for flock members)
    if (!isFlock) {
      const clsText = typeof classification === 'string' ? classification.trim() : '';
      const hzText = formatFlapHz(flapHz);
      const labelText = [clsText, hzText].filter(Boolean).join(' ');
      if (labelText) {
        const fontPx = Math.max(9, Math.round(10.5 * scaleDpr));
        ctx.font = `600 ${fontPx}px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
        const measured = typeof ctx.measureText === 'function' ? ctx.measureText(labelText)?.width : NaN;
        const textW = Number.isFinite(measured) && measured > 0 ? measured : labelText.length * fontPx * 0.62;
        const padX = Math.round(5 * scaleDpr);
        const padY = Math.round(2.5 * scaleDpr);
        const pillW = Math.ceil(textW + padX * 2);
        const pillH = Math.ceil(fontPx + padY * 2);
        const gap = Math.round(4 * scaleDpr);
        const pillX = x;
        const pillY = y - gap - pillH;
        const radius = Math.min(4 * scaleDpr, pillH * 0.5);

        traceRoundedRect(ctx, pillX, pillY, pillW, pillH, radius);
        ctx.globalAlpha = 0.8 * baseAlpha;
        ctx.fillStyle = 'rgba(10, 12, 16, 0.82)';
        ctx.fill();

        ctx.globalAlpha = 0.55 * baseAlpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.75, 1 * scaleDpr);
        ctx.stroke();

        ctx.globalAlpha = baseAlpha;
        ctx.fillStyle = color;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(labelText, pillX + padX, pillY + pillH * 0.5);
      }
    }
  } finally {
    ctx.restore?.();
  }
}
