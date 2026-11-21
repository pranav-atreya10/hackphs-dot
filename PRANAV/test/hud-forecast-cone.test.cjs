const { test } = require('node:test');
const assert = require('node:assert/strict');

function createMock2DContext({ width = 1280, height = 720 } = {}) {
  const ops = [];
  const gradients = [];
  const stateStack = [];
  let currentPath = [];

  const ctx = {
    canvas: { width, height },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDash: [],
    lineDashOffset: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,

    save() {
      stateStack.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        lineDash: [...this.lineDash],
        lineDashOffset: this.lineDashOffset,
        font: this.font,
        textAlign: this.textAlign,
        textBaseline: this.textBaseline,
        globalAlpha: this.globalAlpha,
      });
      ops.push({ type: 'save' });
    },
    restore() {
      const prev = stateStack.pop();
      if (prev) Object.assign(this, prev);
      ops.push({ type: 'restore' });
    },
    beginPath() {
      currentPath = [];
      ops.push({ type: 'beginPath' });
    },
    moveTo(x, y) {
      currentPath.push({ cmd: 'moveTo', x, y });
    },
    lineTo(x, y) {
      currentPath.push({ cmd: 'lineTo', x, y });
    },
    quadraticCurveTo(cpx, cpy, x, y) {
      currentPath.push({ cmd: 'quadraticCurveTo', cpx, cpy, x, y });
    },
    closePath() {
      currentPath.push({ cmd: 'closePath' });
    },
    setLineDash(segments) {
      this.lineDash = Array.isArray(segments) ? [...segments] : [];
    },
    getLineDash() {
      return [...this.lineDash];
    },
    createLinearGradient(x0, y0, x1, y1) {
      const stops = [];
      const grad = {
        kind: 'linear-gradient',
        x0,
        y0,
        x1,
        y1,
        stops,
        addColorStop(offset, color) {
          stops.push({ offset, color });
        },
      };
      gradients.push(grad);
      return grad;
    },
    fill() {
      ops.push({
        type: 'fill',
        fillStyle: this.fillStyle,
        path: [...currentPath],
      });
    },
    stroke() {
      ops.push({
        type: 'stroke',
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineDash: [...this.lineDash],
        lineDashOffset: this.lineDashOffset,
        path: [...currentPath],
      });
    },
    measureText(text) {
      return { width: String(text).length * 6.5 };
    },
    fillText(text, x, y) {
      ops.push({
        type: 'fillText',
        text,
        x,
        y,
        font: this.font,
        fillStyle: this.fillStyle,
      });
    },
  };

  return { ctx, ops, gradients, get StackDepth() { return stateStack.length; } };
}

const project1000x500 = ([nx, ny]) => [nx * 1000, ny * 500];

function sampleMovingForecast(overrides = {}) {
  return {
    x: 0.2,
    y: 0.5,
    heading: 0,
    speed: 0.01,
    cls: 'bird',
    level: 'yellow',
    pWithin: { 30: 0.22, 60: 0.476 },
    eta: { p10: 18, p50: 28, p90: 44 },
    positions: {
      30: { x: 0.5, y: 0.5, sdX: 0.02, sdY: 0.04 },
      60: { x: 0.8, y: 0.5, sdX: 0.04, sdY: 0.09 },
    },
    ...overrides,
  };
}

test('skips rendering when forecastResult is nullish or speed is below 0.004 noise floor', async () => {
  const { drawForecastCone } = await import('../public/js/hud-forecast-cone.mjs');

  for (const invalid of [
    null,
    undefined,
    sampleMovingForecast({ speed: 0 }),
    sampleMovingForecast({ speed: 0.0039 }),
    sampleMovingForecast({ speed: -0.02 }),
    sampleMovingForecast({ speed: Number.NaN }),
  ]) {
    const { ctx, ops } = createMock2DContext();
    const drawn = drawForecastCone(ctx, project1000x500, invalid);
    assert.equal(drawn, false);
    assert.equal(ops.length, 0);
  }

  // Exact threshold 0.004 is permitted and renders.
  const { ctx, ops } = createMock2DContext();
  const drawnAtThreshold = drawForecastCone(
    ctx,
    project1000x500,
    sampleMovingForecast({ speed: 0.004 })
  );
  assert.equal(drawnAtThreshold, true);
  assert.ok(ops.some(op => op.type === 'fill'));
});

test('renders widening gradient cone from [x, y] through 30s and 60s uncertainty bounds plus centerline and 30s chevron', async () => {
  const { drawForecastCone } = await import('../public/js/hud-forecast-cone.mjs');
  const { ctx, ops, gradients, StackDepth } = createMock2DContext();
  ctx.font = '12px custom-caller-font';
  ctx.lineDashOffset = 3.5;

  const drawn = drawForecastCone(ctx, project1000x500, sampleMovingForecast(), {
    dpr: 2,
    nowMs: 200,
    surveyedCorridor: false,
  });

  assert.equal(drawn, true);
  assert.equal(StackDepth, 0, 'save/restore stack must stay balanced');
  assert.equal(ctx.font, '12px custom-caller-font', 'caller canvas state must be restored');
  assert.equal(ctx.lineDashOffset, 3.5, 'caller lineDashOffset must be restored');

  // Gradient spans from projected origin (200, 250) to 60s mark (800, 250).
  assert.equal(gradients.length, 1);
  assert.equal(gradients[0].x0, 200);
  assert.equal(gradients[0].y0, 250);
  assert.equal(gradients[0].x1, 800);
  assert.equal(gradients[0].y1, 250);

  // Cone fill polygon starts at [200, 250] and widens from 30s (sdY=0.04 -> ±20px) to 60s (sdY=0.09 -> ±45px).
  const coneFill = ops.find(op => op.type === 'fill');
  assert.ok(coneFill, 'expected translucent cone polygon fill');
  assert.equal(coneFill.path[0].cmd, 'moveTo');
  assert.equal(coneFill.path[0].x, 200);
  assert.equal(coneFill.path[0].y, 250);
  assert.equal(coneFill.path[coneFill.path.length - 1].cmd, 'closePath');

  const pointsAt500 = coneFill.path.filter(p => p.cmd === 'lineTo' && Math.abs(p.x - 500) < 1e-6);
  const pointsAt800 = coneFill.path.filter(p => p.cmd === 'lineTo' && Math.abs(p.x - 800) < 1e-6);
  assert.equal(pointsAt500.length, 2, 'cone passes through left and right 30s bounds');
  assert.equal(pointsAt800.length, 2, 'cone passes through left and right 60s bounds');
  const span30 = Math.abs(pointsAt500[0].y - pointsAt500[1].y);
  const span60 = Math.abs(pointsAt800[0].y - pointsAt800[1].y);
  assert.ok(span60 > span30 && span30 > 0, `expected 60s width (${span60}) > 30s width (${span30})`);

  // Dashed centerline + solid 30s directional chevron near (500, 250).
  const strokes = ops.filter(op => op.type === 'stroke');
  const dashedStroke = strokes.find(s => s.lineDash.length === 2);
  assert.ok(dashedStroke, 'expected dashed centerline stroke');

  const solidStrokes = strokes.filter(s => s.lineDash.length === 0);
  const chevronStroke = solidStrokes.find(s =>
    s.path.length === 3 &&
    s.path[0].cmd === 'moveTo' &&
    s.path[1].cmd === 'lineTo' &&
    s.path[2].cmd === 'lineTo' &&
    Math.hypot(s.path[1].x - 500, s.path[1].y - 250) < 15
  );
  assert.ok(chevronStroke, 'expected solid 3-vertex directional chevron at 30s mark');
  assert.ok(
    chevronStroke.path[1].x > chevronStroke.path[0].x &&
    chevronStroke.path[1].x > chevronStroke.path[2].x,
    'chevron tip must point forward along +x travel direction'
  );
});

test('supports explicit fan left/right boundary points and native FlightForecaster output shapes', async () => {
  const { drawForecastCone } = await import('../public/js/hud-forecast-cone.mjs');

  const withFan = {
    x: 0.1,
    y: 0.4,
    speed: 0.008,
    cls: 'drone',
    level: 'red',
    pWithin: { 30: 0.35, 60: 0.62 },
    fan: {
      lateralLeft: [[0.35, 0.34], [0.65, 0.26]],
      lateralRight: [[0.35, 0.46], [0.65, 0.54]],
    },
  };
  const mockA = createMock2DContext();
  assert.equal(drawForecastCone(mockA.ctx, project1000x500, withFan, { surveyedCorridor: true }), true);
  const fillA = mockA.ops.find(op => op.type === 'fill');
  assert.ok(fillA.path.some(p => p.cmd === 'lineTo' && Math.abs(p.x - 650) < 1e-6 && Math.abs(p.y - 130) < 1e-6));
  assert.ok(fillA.path.some(p => p.cmd === 'lineTo' && Math.abs(p.x - 650) < 1e-6 && Math.abs(p.y - 270) < 1e-6));

  // Step-array fan shape [{ t, x, y, left, right }, ...] + curving trajectory interpolation.
  const withStepFan = {
    x: 0.2,
    y: 0.6,
    speed: 0.011,
    cls: 'bird',
    level: 'yellow',
    pWithin: { 30: 0.19, 60: 0.41 },
    fan: [
      { t: 30, x: 0.45, y: 0.4, left: [0.43, 0.35], right: [0.47, 0.45] },
      { t: 60, x: 0.75, y: 0.35, left: [0.72, 0.26], right: [0.78, 0.44] },
    ],
  };
  const mockStep = createMock2DContext();
  assert.equal(drawForecastCone(mockStep.ctx, project1000x500, withStepFan, { surveyedCorridor: true }), true);
  const centerCurve = mockStep.ops
    .find(op => op.type === 'stroke' && op.lineDash.length === 2)
    .path.find(p => p.cmd === 'quadraticCurveTo');
  assert.ok(centerCurve, 'expected smooth quadratic centerline curve');
  // At t=0.5, quadratic Bezier B(0.5) = 0.25*P0 + 0.5*CP + 0.25*P2 must equal projected 30s mark (450, 200).
  const midX = 0.25 * 200 + 0.5 * centerCurve.cpx + 0.25 * centerCurve.x;
  const midY = 0.25 * 300 + 0.5 * centerCurve.cpy + 0.25 * centerCurve.y;
  assert.ok(Math.abs(midX - 450) < 1e-6 && Math.abs(midY - 200) < 1e-6);

  // Native Shreyansh Local Ai Model/flight_forecast.js shape (now + p_enter + x_range/y_range).
  const nativeForecasterShape = {
    id: 7,
    cls: 'drone',
    level: 'red',
    now: { x: 0.15, y: 0.3, speed_per_s: 0.012, heading_deg: 0 },
    p_enter: { within_30s: 0.28, within_60s: 0.54 },
    positions: {
      30: { x: 0.51, y: 0.3, x_range: [0.46, 0.56], y_range: [0.24, 0.36] },
      60: { x: 0.87, y: 0.3, x_range: [0.78, 0.96], y_range: [0.18, 0.42] },
    },
  };
  const mockB = createMock2DContext();
  assert.equal(
    drawForecastCone(mockB.ctx, project1000x500, nativeForecasterShape, { surveyedCorridor: true }),
    true
  );
  const tagB = mockB.ops.find(op => op.type === 'fillText');
  assert.ok(tagB);
  assert.equal(tagB.text, '~54% mask 60s');
});

test('gates amber/red tint and monospace mask advisory tag strictly on surveyedCorridor === true (Audit Findings #6/#7)', async () => {
  const { drawForecastCone, HUD_NEUTRAL_CONE_FILL } = await import('../public/js/hud-forecast-cone.mjs');

  const highRiskDrone = sampleMovingForecast({
    cls: 'drone',
    level: 'red',
    pWithin: { 30: 0.65, 60: 0.88 },
  });

  // 1. Uncalibrated camera (false, omitted, or non-boolean truthy): cool HUD blue/cyan rgba(79,156,255,0.12), NO red/amber, NO advisory tag.
  for (const uncalibratedOpt of [{ surveyedCorridor: false }, {}, { surveyedCorridor: 'yes' }]) {
    const uncalibrated = createMock2DContext();
    drawForecastCone(uncalibrated.ctx, project1000x500, highRiskDrone, uncalibratedOpt);
    assert.equal(uncalibrated.gradients[0].stops[0].color, HUD_NEUTRAL_CONE_FILL);
    assert.equal(HUD_NEUTRAL_CONE_FILL, 'rgba(79,156,255,0.12)');
    for (const stop of uncalibrated.gradients[0].stops) {
      assert.doesNotMatch(stop.color, /255,\s*90|245,\s*166|242,\s*183/);
    }
    assert.equal(
      uncalibrated.ops.filter(op => op.type === 'fillText').length,
      0,
      'uncalibrated cameras must never render mask probability tags'
    );
  }

  // 2. Surveyed corridor + red + pWithin >= 0.15: red tint + monospace advisory tag.
  const surveyedRed = createMock2DContext();
  drawForecastCone(surveyedRed.ctx, project1000x500, highRiskDrone, { surveyedCorridor: true });
  assert.match(surveyedRed.gradients[0].stops[0].color, /rgba\(255,90,74,/);
  const redTag = surveyedRed.ops.find(op => op.type === 'fillText');
  assert.ok(redTag, 'surveyed corridor with pWithin >= 0.15 must render advisory tag');
  assert.equal(redTag.text, '~88% mask 60s');
  assert.match(redTag.font, /monospace/i);

  // 3. Surveyed corridor + yellow + p30 >= 0.15 (even if p60 < 0.15): amber tint + advisory tag.
  const surveyedYellow = createMock2DContext();
  drawForecastCone(
    surveyedYellow.ctx,
    project1000x500,
    sampleMovingForecast({ level: 'yellow', pWithin: { 30: 0.16, 60: 0.12 } }),
    { surveyedCorridor: true }
  );
  assert.match(surveyedYellow.gradients[0].stops[0].color, /rgba\(245,166,35,/);
  const yellowTag = surveyedYellow.ops.find(op => op.type === 'fillText');
  assert.ok(yellowTag);
  assert.equal(yellowTag.text, '~12% mask 60s');

  // 4. Surveyed corridor + green + low pWithin (< 0.15): stays cool neutral blue/cyan, no advisory tag.
  const surveyedGreen = createMock2DContext();
  drawForecastCone(
    surveyedGreen.ctx,
    project1000x500,
    sampleMovingForecast({ level: 'green', pWithin: { 30: 0.04, 60: 0.14 } }),
    { surveyedCorridor: true }
  );
  assert.equal(surveyedGreen.gradients[0].stops[0].color, 'rgba(79,156,255,0.12)');
  assert.equal(surveyedGreen.ops.filter(op => op.type === 'fillText').length, 0);
});

test('animates centerline lineDashOffset smoothly with nowMs and freezes at 0 when reducedMotion is true', async () => {
  const { drawForecastCone } = await import('../public/js/hud-forecast-cone.mjs');
  const forecast = sampleMovingForecast();

  const dashOffsetAt = (nowMs, reducedMotion) => {
    const { ctx, ops } = createMock2DContext();
    drawForecastCone(ctx, project1000x500, forecast, { dpr: 1, nowMs, reducedMotion });
    const dashed = ops.find(op => op.type === 'stroke' && op.lineDash.length === 2);
    assert.ok(dashed);
    return dashed.lineDashOffset;
  };

  const anim0 = dashOffsetAt(0, false);
  const anim150 = dashOffsetAt(150, false);
  const anim300 = dashOffsetAt(300, false);
  assert.equal(anim0, 0);
  assert.ok(anim150 < 0 && anim300 < anim150, `expected smooth forward dash progression: ${anim0}, ${anim150}, ${anim300}`);

  for (const t of [0, 150, 300, 1234.5]) {
    assert.equal(dashOffsetAt(t, true), 0, `reducedMotion must hold lineDashOffset at 0 (nowMs=${t})`);
  }
});
