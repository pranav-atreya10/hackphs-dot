// 5-frame v4.1 browser-vote progress ring + compact advisory pill renderer for 2D overlay canvases.
// Visual/advisory only: never mutates caller inputs, track classifications, risk levels, or alerts.

export const VOTE_RING_COLORS = Object.freeze({
  bird: '#4f9cff',
  drone: '#ff5a4a',
  other: '#a1a1aa',
  gathering: '#f2b705',
  unfilled: 'rgba(255,255,255,0.24)',
});

const MONO_FONT_STACK = '"Geist Mono", ui-monospace, Menlo, monospace';
const START_ANGLE = -Math.PI / 2;
const SEGMENT_GAP_RAD = 0.22;
const PULSE_PERIOD_MS = 900;
const PULSE_MIN_ALPHA = 0.30;
const PULSE_MAX_ALPHA = 0.74;

function clamp(value, min, max) {
  if (max < min) return (min + max) * 0.5;
  return Math.min(max, Math.max(min, value));
}

function normalizeLabel(label) {
  if (typeof label !== 'string') return null;
  const normalized = label.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function resolveVoteColor(label) {
  const key = normalizeLabel(label);
  if (key === 'bird') return VOTE_RING_COLORS.bird;
  if (key === 'drone') return VOTE_RING_COLORS.drone;
  if (key === 'other') return VOTE_RING_COLORS.other;
  return VOTE_RING_COLORS.gathering;
}

function formatConfidencePercent(confidence) {
  if (
    confidence === null ||
    confidence === undefined ||
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 100
  ) {
    return null;
  }
  const pct = confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);
  return `${clamp(pct, 0, 100)}%`;
}

export function formatVoteAdvisoryText(voteState) {
  if (!voteState || typeof voteState !== 'object') return null;
  const ready = voteState.ready !== undefined ? Boolean(voteState.ready) : voteState.status === 'ready';
  const normalized = normalizeLabel(voteState.label);
  if (!ready || !normalized) return null;
  const rawConfidence = voteState.confidence !== undefined ? voteState.confidence : voteState.score;
  const pct = formatConfidencePercent(rawConfidence);
  return pct ? `v4.1 ${normalized.toUpperCase()} ${pct}` : `v4.1 ${normalized.toUpperCase()}`;
}

export function toVoteRingState(voteResult, { pending = false, total = 5 } = {}) {
  if (!voteResult || typeof voteResult !== 'object' || voteResult.status === 'rejected') {
    return pending ? { count: 0, total, ready: false, label: null, confidence: null, pending: true } : null;
  }
  const ready = voteResult.ready !== undefined ? Boolean(voteResult.ready) : voteResult.status === 'ready';
  const count = Number.isFinite(voteResult.count) ? voteResult.count : 0;
  const confidence = voteResult.confidence !== undefined ? voteResult.confidence : (voteResult.score ?? null);
  return {
    count,
    total,
    ready,
    label: voteResult.label ?? null,
    confidence,
    pending: Boolean(pending) && !ready,
  };
}

function computePulseAlpha(nowMs) {
  const t = Number.isFinite(nowMs) ? nowMs : 0;
  const phase = ((t % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
  const wave = 0.5 + 0.5 * Math.sin((phase / PULSE_PERIOD_MS) * Math.PI * 2);
  const alpha = PULSE_MIN_ALPHA + (PULSE_MAX_ALPHA - PULSE_MIN_ALPHA) * wave;
  return Number(alpha.toFixed(3));
}

function tracePillRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  if (typeof ctx.arcTo === 'function' && typeof ctx.moveTo === 'function' && typeof ctx.lineTo === 'function') {
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    if (typeof ctx.closePath === 'function') ctx.closePath();
    return;
  }
  if (typeof ctx.rect === 'function') {
    ctx.rect(x, y, w, h);
  }
}

/**
 * Renders a 5-segment radial progress arc at the top-right corner of `anchor`
 * (`x + w + 11 * dpr, y + 7 * dpr`), clamped inside canvas bounds, with an
 * optional `v4.1 <LABEL> <CONF>%` advisory pill when `ready && label`.
 */
export function drawVoteProgressRing(
  ctx,
  anchor,
  voteState,
  { dpr = 1, reducedMotion = false, nowMs = 0 } = {},
) {
  if (
    !ctx ||
    typeof ctx.beginPath !== 'function' ||
    typeof ctx.arc !== 'function' ||
    typeof ctx.stroke !== 'function'
  ) {
    return false;
  }
  if (
    !anchor ||
    typeof anchor !== 'object' ||
    !Number.isFinite(anchor.x) ||
    !Number.isFinite(anchor.y) ||
    !Number.isFinite(anchor.w) ||
    !Number.isFinite(anchor.h) ||
    anchor.w < 0 ||
    anchor.h < 0
  ) {
    return false;
  }
  if (!voteState || typeof voteState !== 'object') return false;

  const rawTotal = voteState.total ?? 5;
  if (!Number.isFinite(rawTotal) || rawTotal < 1) return false;
  const total = Math.max(1, Math.trunc(rawTotal));

  const numericCount = Number.isFinite(voteState.count) ? voteState.count : 0;
  const pending = Boolean(voteState.pending);
  if (numericCount <= 0 && !pending) return false;

  const filledCount = clamp(Math.floor(numericCount), 0, total);
  const ready = voteState.ready !== undefined ? Boolean(voteState.ready) : voteState.status === 'ready';
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

  const radius = 7 * scale;
  const strokeWidth = 2 * scale;
  const ringOuter = radius + strokeWidth * 0.5;
  const edgePad = 2 * scale;

  const targetCx = anchor.x + anchor.w + 11 * scale;
  const targetCy = anchor.y + 7 * scale;

  const canvasW = Number.isFinite(ctx.canvas?.width) && ctx.canvas.width > 0 ? ctx.canvas.width : null;
  const canvasH = Number.isFinite(ctx.canvas?.height) && ctx.canvas.height > 0 ? ctx.canvas.height : null;

  const advisoryText = formatVoteAdvisoryText(voteState);
  const activeColor = resolveVoteColor(voteState.label);

  if (typeof ctx.save === 'function') ctx.save();
  try {
    const fontSize = Math.max(9, Math.round(10 * scale));
    const font = `600 ${fontSize}px ${MONO_FONT_STACK}`;
    const pillPadX = 5 * scale;
    const pillHeight = Math.round(16 * scale);
    const pillGap = 5 * scale;
    let pillWidth = 0;

    if (advisoryText) {
      ctx.font = font;
      if ('fontVariantNumeric' in ctx) ctx.fontVariantNumeric = 'tabular-nums';
      const measured = typeof ctx.measureText === 'function' ? ctx.measureText(advisoryText)?.width : NaN;
      const textWidth = Number.isFinite(measured) && measured > 0
        ? measured
        : advisoryText.length * fontSize * 0.62;
      pillWidth = Math.ceil(textWidth + pillPadX * 2);
    }

    let cx = targetCx;
    let cy = targetCy;

    if (canvasW !== null) {
      const minCx = ringOuter + edgePad;
      const rightAllowance = advisoryText
        ? ringOuter + pillGap + pillWidth + edgePad
        : ringOuter + edgePad;
      const maxCxWithPill = canvasW - rightAllowance;
      const maxCx = maxCxWithPill >= minCx
        ? maxCxWithPill
        : Math.max(minCx, canvasW - ringOuter - edgePad);
      cx = clamp(targetCx, minCx, maxCx);
    }

    if (canvasH !== null) {
      const halfExtentY = advisoryText ? Math.max(ringOuter, pillHeight * 0.5) : ringOuter;
      const minCy = halfExtentY + edgePad;
      const maxCy = canvasH - halfExtentY - edgePad;
      cy = clamp(targetCy, minCy, maxCy);
    }

    const stepAngle = (Math.PI * 2) / total;
    const gapAngle = total > 1 ? Math.min(SEGMENT_GAP_RAD, stepAngle * 0.25) : 0;
    const shouldPulseNext = pending && !ready && !reducedMotion && filledCount < total;
    const pulseStyle = shouldPulseNext
      ? `rgba(255,255,255,${computePulseAlpha(nowMs)})`
      : VOTE_RING_COLORS.unfilled;

    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;

    for (let i = 0; i < total; i++) {
      const segStart = START_ANGLE + i * stepAngle + gapAngle * 0.5;
      const segEnd = START_ANGLE + (i + 1) * stepAngle - gapAngle * 0.5;
      if (i < filledCount) {
        ctx.strokeStyle = activeColor;
      } else if (i === filledCount && shouldPulseNext) {
        ctx.strokeStyle = pulseStyle;
      } else {
        ctx.strokeStyle = VOTE_RING_COLORS.unfilled;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, radius, segStart, segEnd);
      ctx.stroke();
    }

    if (advisoryText) {
      let pillX = cx + ringOuter + pillGap;
      if (canvasW !== null && pillX + pillWidth + edgePad > canvasW) {
        pillX = Math.max(edgePad, canvasW - edgePad - pillWidth);
      }
      const pillY = cy - pillHeight * 0.5;
      const pillRadius = 4 * scale;

      ctx.beginPath();
      tracePillRect(ctx, pillX, pillY, pillWidth, pillHeight, pillRadius);
      ctx.fillStyle = 'rgba(10,10,10,0.84)';
      if (typeof ctx.fill === 'function') ctx.fill();
      ctx.lineWidth = Math.max(1, 1 * scale);
      ctx.strokeStyle = activeColor;
      ctx.stroke();

      ctx.font = font;
      if ('fontVariantNumeric' in ctx) ctx.fontVariantNumeric = 'tabular-nums';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fafafa';
      if (typeof ctx.fillText === 'function') {
        ctx.fillText(advisoryText, pillX + pillPadX, cy);
      }
    }

    return true;
  } finally {
    if (typeof ctx.restore === 'function') ctx.restore();
  }
}
