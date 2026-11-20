// Monte Carlo trajectory cone renderer for SkySentry camera/tower HUD overlays.
// Honors Audit Findings #6/#7: uncalibrated cameras stay in cool HUD blue/cyan and
// never render corridor-clearance tinting or image-space mask entry probabilities.

export const MIN_FORECAST_SPEED = 0.004;
export const ADVISORY_PROB_THRESHOLD = 0.15;
export const HUD_NEUTRAL_CONE_FILL = 'rgba(79,156,255,0.12)';

const MONO_STACK = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const P10_P90_SIGMA_SPAN = 2.5631;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function toXY(pt) {
  if (Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
    return [pt[0], pt[1]];
  }
  if (pt && typeof pt === 'object' && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
    return [pt.x, pt.y];
  }
  return null;
}

function extractSpread(entry, distFromOrigin = 0, cls = 'bird') {
  if (!entry || typeof entry !== 'object') return [0, 0];
  const hasExplicit =
    Number.isFinite(entry.sdX) ||
    Number.isFinite(entry.sdY) ||
    Number.isFinite(entry.sd) ||
    (Array.isArray(entry.x_range) && entry.x_range.length >= 2) ||
    (Array.isArray(entry.y_range) && entry.y_range.length >= 2);
  if (!hasExplicit) {
    const defaultSd = distFromOrigin * (cls === 'drone' ? 0.08 : 0.14);
    return [defaultSd, defaultSd];
  }
  const fallbackSd = Number.isFinite(entry.sd) ? Math.abs(entry.sd) : 0;
  const sdX = Number.isFinite(entry.sdX)
    ? Math.abs(entry.sdX)
    : Array.isArray(entry.x_range) && entry.x_range.length >= 2 &&
        Number.isFinite(entry.x_range[0]) && Number.isFinite(entry.x_range[1])
      ? Math.abs(entry.x_range[1] - entry.x_range[0]) / P10_P90_SIGMA_SPAN
      : fallbackSd;
  const sdY = Number.isFinite(entry.sdY)
    ? Math.abs(entry.sdY)
    : Array.isArray(entry.y_range) && entry.y_range.length >= 2 &&
        Number.isFinite(entry.y_range[0]) && Number.isFinite(entry.y_range[1])
      ? Math.abs(entry.y_range[1] - entry.y_range[0]) / P10_P90_SIGMA_SPAN
      : fallbackSd;
  return [sdX, sdY];
}

function unitTangent(prev, next, fallbackHeading) {
  const dx = next[0] - prev[0];
  const dy = next[1] - prev[1];
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) return [dx / len, dy / len];
  if (Number.isFinite(fallbackHeading)) return [Math.cos(fallbackHeading), Math.sin(fallbackHeading)];
  return [1, 0];
}

function parseFanBoundaries(forecastResult, origin) {
  const fan = forecastResult.fan;
  let rawLeft = null;
  let rawRight = null;
  let rawCenter = null;
  let step30 = null;
  let step60 = null;

  if (Array.isArray(fan) && fan.length > 0) {
    const leftAcc = [];
    const rightAcc = [];
    const centerAcc = [];
    for (const step of fan) {
      if (!step || typeof step !== 'object') continue;
      const l = toXY(step.lateralLeft ?? step.left);
      const r = toXY(step.lateralRight ?? step.right);
      const c = toXY(step.center ?? step) ?? (l && r ? [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2] : null);
      if (l && r) {
        leftAcc.push(l);
        rightAcc.push(r);
      }
      if (c) {
        centerAcc.push(c);
        if (step.t === 30 || step.horizon === 30) step30 = c;
        if (step.t === 60 || step.horizon === 60) step60 = c;
      }
    }
    if (leftAcc.length && leftAcc.length === rightAcc.length) {
      rawLeft = leftAcc;
      rawRight = rightAcc;
      if (centerAcc.length) rawCenter = centerAcc;
    }
  } else if (fan && typeof fan === 'object') {
    const lArr = Array.isArray(fan.lateralLeft) ? fan.lateralLeft : Array.isArray(fan.left) ? fan.left : null;
    const rArr = Array.isArray(fan.lateralRight) ? fan.lateralRight : Array.isArray(fan.right) ? fan.right : null;
    if (lArr && rArr) {
      const leftPts = lArr.map(toXY).filter(Boolean);
      const rightPts = rArr.map(toXY).filter(Boolean);
      const count = Math.min(leftPts.length, rightPts.length);
      if (count > 0) {
        rawLeft = leftPts.slice(0, count);
        rawRight = rightPts.slice(0, count);
      }
    }
    if (Array.isArray(fan.center)) {
      const cPts = fan.center.map(toXY).filter(Boolean);
      if (cPts.length) rawCenter = cPts;
    }
  }

  if (!rawLeft && Array.isArray(forecastResult.lateralLeft) && Array.isArray(forecastResult.lateralRight)) {
    const leftPts = forecastResult.lateralLeft.map(toXY).filter(Boolean);
    const rightPts = forecastResult.lateralRight.map(toXY).filter(Boolean);
    const count = Math.min(leftPts.length, rightPts.length);
    if (count > 0) {
      rawLeft = leftPts.slice(0, count);
      rawRight = rightPts.slice(0, count);
    }
  }

  if (!rawLeft || !rawRight) return null;

  // Drop duplicate apex vertex if the caller included [x, y] at index 0.
  if (
    rawLeft.length > 1 &&
    Math.hypot(rawLeft[0][0] - origin[0], rawLeft[0][1] - origin[1]) < 1e-6 &&
    Math.hypot(rawRight[0][0] - origin[0], rawRight[0][1] - origin[1]) < 1e-6
  ) {
    rawLeft = rawLeft.slice(1);
    rawRight = rawRight.slice(1);
    if (rawCenter && rawCenter.length > rawLeft.length) rawCenter = rawCenter.slice(1);
  }

  return { left: rawLeft, right: rawRight, center: rawCenter, step30, step60 };
}

export function resolveConePalette({ cls, level, surveyedCorridor = false } = {}) {
  if (surveyedCorridor === true && level === 'red') {
    return {
      tier: 'red',
      coneStops: [
        [0, 'rgba(255,90,74,0.22)'],
        [0.55, 'rgba(255,90,74,0.12)'],
        [1, 'rgba(255,90,74,0.025)'],
      ],
      coneFallbackFill: 'rgba(255,90,74,0.18)',
      edgeStroke: 'rgba(255,90,74,0.32)',
      centerStroke: 'rgba(255,102,86,0.86)',
      chevronStroke: 'rgba(255,126,112,0.95)',
      tagBg: 'rgba(24,9,9,0.82)',
      tagBorder: 'rgba(255,90,74,0.60)',
      tagText: 'rgba(255,212,206,0.98)',
    };
  }

  if (surveyedCorridor === true && level === 'yellow') {
    return {
      tier: 'amber',
      coneStops: [
        [0, 'rgba(245,166,35,0.20)'],
        [0.55, 'rgba(242,183,5,0.11)'],
        [1, 'rgba(242,183,5,0.02)'],
      ],
      coneFallbackFill: 'rgba(245,166,35,0.16)',
      edgeStroke: 'rgba(245,166,35,0.28)',
      centerStroke: 'rgba(245,178,36,0.82)',
      chevronStroke: 'rgba(250,196,56,0.92)',
      tagBg: 'rgba(20,15,6,0.80)',
      tagBorder: 'rgba(245,166,35,0.55)',
      tagText: 'rgba(254,230,156,0.96)',
    };
  }

  const isDrone = cls === 'drone';
  return {
    tier: 'neutral',
    coneStops: [
      [0, HUD_NEUTRAL_CONE_FILL],
      [0.55, isDrone ? 'rgba(64,184,255,0.08)' : 'rgba(79,156,255,0.07)'],
      [1, 'rgba(56,198,255,0.015)'],
    ],
    coneFallbackFill: HUD_NEUTRAL_CONE_FILL,
    edgeStroke: 'rgba(79,156,255,0.22)',
    centerStroke: isDrone ? 'rgba(88,196,255,0.72)' : 'rgba(79,156,255,0.68)',
    chevronStroke: isDrone ? 'rgba(120,210,255,0.88)' : 'rgba(110,184,255,0.85)',
    tagBg: 'rgba(10,16,26,0.78)',
    tagBorder: 'rgba(79,156,255,0.45)',
    tagText: 'rgba(214,234,255,0.95)',
  };
}

export function extractConeGeometry(forecastResult) {
  if (!forecastResult || typeof forecastResult !== 'object') return null;

  const x0 = Number.isFinite(forecastResult.x) ? forecastResult.x : forecastResult.now?.x;
  const y0 = Number.isFinite(forecastResult.y) ? forecastResult.y : forecastResult.now?.y;
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;

  const explicitSpeed = forecastResult.speed !== undefined
    ? forecastResult.speed
    : forecastResult.now?.speed_per_s;
  if (explicitSpeed !== undefined && (!Number.isFinite(explicitSpeed) || explicitSpeed < MIN_FORECAST_SPEED)) {
    return null;
  }

  const heading = Number.isFinite(forecastResult.heading)
    ? forecastResult.heading
    : Number.isFinite(forecastResult.now?.heading_deg)
      ? (forecastResult.now.heading_deg * Math.PI) / 180
      : null;

  const origin = [x0, y0];
  const posMap = forecastResult.positions && typeof forecastResult.positions === 'object'
    ? forecastResult.positions
    : null;

  const horizonEntries = [];
  if (posMap) {
    const keys = Object.keys(posMap)
      .map(k => ({ key: k, sec: Number(k) }))
      .filter(({ sec }) => Number.isFinite(sec) && sec > 0)
      .sort((a, b) => a.sec - b.sec);
    for (const { key, sec } of keys) {
      const entry = posMap[key];
      const pt = toXY(entry);
      if (pt) horizonEntries.push({ sec, entry, pt });
    }
  }

  const fanBounds = parseFanBoundaries(forecastResult, origin);

  let centerPoints = [origin];
  let leftPoints = [];
  let rightPoints = [];
  let mark30 = null;
  let mark60 = null;

  if (horizonEntries.length > 0) {
    const centers = [origin, ...horizonEntries.map(h => h.pt)];
    centerPoints = centers;

    const e30 = horizonEntries.find(h => h.sec === 30) || horizonEntries[0];
    const e60 = horizonEntries.find(h => h.sec === 60) || horizonEntries[horizonEntries.length - 1];
    mark30 = e30.pt;
    mark60 = e60.pt;

    if (!fanBounds) {
      for (let i = 0; i < horizonEntries.length; i++) {
        const { entry, pt } = horizonEntries[i];
        const explicitL = toXY(entry.lateralLeft ?? entry.left);
        const explicitR = toXY(entry.lateralRight ?? entry.right);
        if (explicitL && explicitR) {
          leftPoints.push(explicitL);
          rightPoints.push(explicitR);
          continue;
        }
        const prev = centers[i];
        const next = i + 2 < centers.length ? centers[i + 2] : centers[i + 1];
        const [tx, ty] = unitTangent(prev, next, heading);
        const nx = -ty;
        const ny = tx;
        const distFromOrigin = Math.hypot(pt[0] - origin[0], pt[1] - origin[1]);
        const [sdX, sdY] = extractSpread(entry, distFromOrigin, forecastResult.cls);
        const r = Math.hypot(nx * sdX, ny * sdY) || Math.hypot(sdX, sdY);
        leftPoints.push([pt[0] + nx * r, pt[1] + ny * r]);
        rightPoints.push([pt[0] - nx * r, pt[1] - ny * r]);
      }
    }
  }

  if (fanBounds) {
    leftPoints = fanBounds.left;
    rightPoints = fanBounds.right;
    if (centerPoints.length < 2) {
      const derived = fanBounds.center && fanBounds.center.length
        ? fanBounds.center
        : leftPoints.map((l, idx) => {
          const r = rightPoints[idx];
          return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2];
        });
      centerPoints = [origin, ...derived];
    }
    if (!mark30) {
      mark30 = fanBounds.step30 || centerPoints[Math.max(1, Math.floor(centerPoints.length / 2))];
    }
    if (!mark60) {
      mark60 = fanBounds.step60 || centerPoints[centerPoints.length - 1];
    }
  }

  // Fallback kinematics if caller provided { x, y, heading, speed } without pre-expanded positions/fan.
  if (centerPoints.length < 2 && Number.isFinite(heading) && Number.isFinite(explicitSpeed)) {
    const tx = Math.cos(heading);
    const ty = Math.sin(heading);
    const nx = -ty;
    const ny = tx;
    const spreadRate = forecastResult.cls === 'drone' ? 0.08 : 0.14;
    mark30 = [x0 + tx * explicitSpeed * 30, y0 + ty * explicitSpeed * 30];
    mark60 = [x0 + tx * explicitSpeed * 60, y0 + ty * explicitSpeed * 60];
    const r30 = explicitSpeed * 30 * spreadRate;
    const r60 = explicitSpeed * 60 * spreadRate;
    centerPoints = [origin, mark30, mark60];
    leftPoints = [
      [mark30[0] + nx * r30, mark30[1] + ny * r30],
      [mark60[0] + nx * r60, mark60[1] + ny * r60],
    ];
    rightPoints = [
      [mark30[0] - nx * r30, mark30[1] - ny * r30],
      [mark60[0] - nx * r60, mark60[1] - ny * r60],
    ];
  }

  if (centerPoints.length < 2 || leftPoints.length === 0 || rightPoints.length === 0 || !mark30 || !mark60) {
    return null;
  }

  if (explicitSpeed === undefined) {
    const refSec = horizonEntries[0]?.sec || 30;
    const impliedSpeed = Math.hypot(mark30[0] - origin[0], mark30[1] - origin[1]) / refSec;
    if (!Number.isFinite(impliedSpeed) || impliedSpeed < MIN_FORECAST_SPEED) return null;
  }

  return { origin, centerPoints, leftPoints, rightPoints, mark30, mark60, heading };
}

function projectPoint(projectFn, pt) {
  const out = projectFn(pt);
  if (!Array.isArray(out) || out.length < 2 || !Number.isFinite(out[0]) || !Number.isFinite(out[1])) {
    return null;
  }
  return [out[0], out[1]];
}

function traceSmoothCenterline(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 2 || typeof ctx.quadraticCurveTo !== 'function') {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    return;
  }
  if (pts.length === 3) {
    // Interpolating quadratic Bezier passing exactly through pts[1] (the 30 s mark) at t = 0.5.
    const cpx = 2 * pts[1][0] - 0.5 * (pts[0][0] + pts[2][0]);
    const cpy = 2 * pts[1][1] - 0.5 * (pts[0][1] + pts[2][1]);
    ctx.quadraticCurveTo(cpx, cpy, pts[2][0], pts[2][1]);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = (pts[i][0] + pts[i + 1][0]) / 2;
    const midY = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], midX, midY);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function traceRoundedPill(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.quadraticCurveTo !== 'function' || rad <= 0) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    return;
  }
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

export function drawForecastCone(
  ctx,
  projectFn,
  forecastResult,
  { dpr = 1, nowMs = 0, reducedMotion = false, surveyedCorridor = false } = {}
) {
  if (!ctx || typeof projectFn !== 'function') return false;

  const geom = extractConeGeometry(forecastResult);
  if (!geom) return false;

  const originPx = projectPoint(projectFn, geom.origin);
  const mark30Px = projectPoint(projectFn, geom.mark30);
  const mark60Px = projectPoint(projectFn, geom.mark60);
  const centerPx = geom.centerPoints.map(p => projectPoint(projectFn, p));
  const leftPx = geom.leftPoints.map(p => projectPoint(projectFn, p));
  const rightPx = geom.rightPoints.map(p => projectPoint(projectFn, p));

  if (
    !originPx ||
    !mark30Px ||
    !mark60Px ||
    centerPx.some(p => !p) ||
    leftPx.some(p => !p) ||
    rightPx.some(p => !p)
  ) {
    return false;
  }

  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const palette = resolveConePalette({
    cls: forecastResult.cls,
    level: forecastResult.level,
    surveyedCorridor,
  });

  ctx.save?.();
  try {
    // 1. Translucent gradient uncertainty cone from [x, y] through 30 s and 60 s bounds.
    const coneSpan = Math.hypot(mark60Px[0] - originPx[0], mark60Px[1] - originPx[1]);
    if (typeof ctx.createLinearGradient === 'function' && coneSpan > 0.5) {
      const grad = ctx.createLinearGradient(originPx[0], originPx[1], mark60Px[0], mark60Px[1]);
      for (const [offset, color] of palette.coneStops) {
        grad.addColorStop(offset, color);
      }
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = palette.coneFallbackFill;
    }

    ctx.beginPath();
    ctx.moveTo(originPx[0], originPx[1]);
    for (const pt of leftPx) ctx.lineTo(pt[0], pt[1]);
    for (let i = rightPx.length - 1; i >= 0; i--) ctx.lineTo(rightPx[i][0], rightPx[i][1]);
    ctx.closePath();
    ctx.fill();

    // Subtle open lateral boundary rails so the cone remains legible against bright cloud decks.
    ctx.setLineDash?.([]);
    ctx.lineDashOffset = 0;
    ctx.strokeStyle = palette.edgeStroke;
    ctx.lineWidth = 1 * scale;
    ctx.beginPath();
    ctx.moveTo(originPx[0], originPx[1]);
    for (const pt of leftPx) ctx.lineTo(pt[0], pt[1]);
    ctx.moveTo(originPx[0], originPx[1]);
    for (const pt of rightPx) ctx.lineTo(pt[0], pt[1]);
    ctx.stroke();

    // 2. Dashed centerline trajectory curve with animated dash-offset + 30 s chevron.
    const dashOn = Math.max(3, Math.round(6 * scale));
    const dashOff = Math.max(2, Math.round(4 * scale));
    const dashPeriod = dashOn + dashOff;
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : 0;
    const dashSpeedPxPerSec = 18 * scale;
    const rawOffset = reducedMotion
      ? 0
      : -((((safeNowMs / 1000) * dashSpeedPxPerSec) % dashPeriod + dashPeriod) % dashPeriod);
    const dashOffset = rawOffset === 0 ? 0 : rawOffset;

    ctx.beginPath();
    traceSmoothCenterline(ctx, centerPx);
    ctx.setLineDash?.([dashOn, dashOff]);
    ctx.lineDashOffset = dashOffset;
    ctx.strokeStyle = palette.centerStroke;
    ctx.lineWidth = 1.5 * scale;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Directional chevron at the 30 s mark (solid stroke, oriented in canvas pixel space).
    ctx.setLineDash?.([]);
    ctx.lineDashOffset = 0;
    let vx = mark60Px[0] - originPx[0];
    let vy = mark60Px[1] - originPx[1];
    if (Math.hypot(vx, vy) < 0.5) {
      vx = mark30Px[0] - originPx[0];
      vy = mark30Px[1] - originPx[1];
    }
    const angle = Math.hypot(vx, vy) >= 0.1
      ? Math.atan2(vy, vx)
      : Number.isFinite(geom.heading)
        ? geom.heading
        : 0;
    const chevArm = 5.5 * scale;
    const wingSweep = Math.PI * 0.76;
    const tipX = mark30Px[0] + Math.cos(angle) * chevArm * 0.35;
    const tipY = mark30Px[1] + Math.sin(angle) * chevArm * 0.35;

    ctx.beginPath();
    ctx.moveTo(tipX + Math.cos(angle + wingSweep) * chevArm, tipY + Math.sin(angle + wingSweep) * chevArm);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(tipX + Math.cos(angle - wingSweep) * chevArm, tipY + Math.sin(angle - wingSweep) * chevArm);
    ctx.strokeStyle = palette.chevronStroke;
    ctx.lineWidth = 1.75 * scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 3. Monospace advisory tag when surveyedCorridor === true and p30 or p60 >= 0.15.
    const rawP30 = forecastResult.pWithin?.[30] ?? forecastResult.p_enter?.within_30s;
    const rawP60 = forecastResult.pWithin?.[60] ?? forecastResult.p_enter?.within_60s;
    const hasP30 = Number.isFinite(rawP30);
    const hasP60 = Number.isFinite(rawP60);
    const p30 = hasP30 ? clamp(rawP30, 0, 1) : 0;
    const p60 = hasP60 ? clamp(rawP60, 0, 1) : p30;

    if (surveyedCorridor === true && (p30 >= ADVISORY_PROB_THRESHOLD || p60 >= ADVISORY_PROB_THRESHOLD)) {
      const label = `~${Math.round(p60 * 100)}% mask 60s`;
      const fontPx = Math.max(9, Math.round(10.5 * scale));
      ctx.font = `600 ${fontPx}px ${MONO_STACK}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      const measured = typeof ctx.measureText === 'function' ? ctx.measureText(label)?.width : NaN;
      const textW = Number.isFinite(measured) && measured > 0 ? measured : label.length * fontPx * 0.6;
      const padX = 5 * scale;
      const padY = 3 * scale;
      const boxW = textW + padX * 2;
      const boxH = fontPx + padY * 2;

      let boxX = mark60Px[0] + 6 * scale;
      let boxY = mark60Px[1] - boxH / 2 - 4 * scale;
      const cw = ctx.canvas?.width;
      const ch = ctx.canvas?.height;
      if (Number.isFinite(cw) && cw > boxW + 8 * scale) {
        boxX = clamp(boxX, 4 * scale, cw - boxW - 4 * scale);
      }
      if (Number.isFinite(ch) && ch > boxH + 8 * scale) {
        boxY = clamp(boxY, 4 * scale, ch - boxH - 4 * scale);
      }

      traceRoundedPill(ctx, boxX, boxY, boxW, boxH, 4 * scale);
      ctx.fillStyle = palette.tagBg;
      ctx.fill();
      ctx.strokeStyle = palette.tagBorder;
      ctx.lineWidth = 1 * scale;
      ctx.stroke();

      ctx.fillStyle = palette.tagText;
      ctx.fillText(label, boxX + padX, boxY + boxH / 2);
    }
  } finally {
    ctx.restore?.();
  }

  return true;
}
