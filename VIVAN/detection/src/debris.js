// Debris check: is this a thrown rock / falling debris, or a bird?
//
// A tumbling rock's outline pulses as it turns, and that pulse can look exactly like a
// wingbeat. So instead of looking at the outline, these two tests look at physics.
//
// 1. Gravity arc: "does it fall like a thrown object?"
//    Gravity bends a thrown object's path into a parabola (steady sideways speed, steadily
//    growing downward speed). We fit a parabola to the last ~1.2 s of the path and measure
//    how hard it is pulled downward, relative to its own size:
//
//        pull = downward acceleration (px/s²) ÷ object length (px)        units: per s²
//
//    Gravity on a small object (5-30 cm) gives a pull of 30-200+. A bird is far bigger and
//    flies on its own: even a sharp turn (~1 g on a 40 cm+ bird) stays under about 25.
//    Dividing by size makes the test work at any distance with no camera calibration.
//    It is a gravity arc only if all three hold: the parabola fits the path well, the pull
//    points down, and the pull is stronger than a bird could make.
//
// 2. Spin: "does it turn end over end?"
//    A tumbling object's long axis keeps rotating the same way. A bird's body stays lined up
//    with its flight while the wings beat back and forth. If the long axis has turned more than
//    half a revolution, mostly in one direction, the object is spinning, and its size pulses
//    come from the spin, not from wings.

// Least-squares polynomial fit (degree 1 or 2) of v against tau. Returns coefficients
// [c0, c1, c2] and the RMS of the leftover error.
function polyFit(tau, v, degree) {
  const m = degree + 1;
  const A = Array.from({ length: m }, () => new Float64Array(m + 1));
  for (let i = 0; i < tau.length; i++) {
    const p = [1, tau[i], tau[i] * tau[i]];
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) A[r][c] += p[r] * p[c];
      A[r][m] += p[r] * v[i];
    }
  }
  // Gauss-Jordan elimination on the small normal-equation system.
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    if (Math.abs(d) < 1e-12) return null;
    for (let c = col; c <= m; c++) A[col][c] /= d;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = col; c <= m; c++) A[r][c] -= f * A[col][c];
    }
  }
  const coef = [A[0][m], A[1][m], m > 2 ? A[2][m] : 0];
  let ss = 0;
  for (let i = 0; i < tau.length; i++) {
    const e = v[i] - (coef[0] + coef[1] * tau[i] + coef[2] * tau[i] * tau[i]);
    ss += e * e;
  }
  return { coef, rms: Math.sqrt(ss / tau.length) };
}

// Test 1. trail: [[t, x, y], ...] in px; samples: the track's size history (for its length).
export function gravityArc(trail, samples, cfg) {
  const none = { arc: false, pull: null, accel: null, fit: null, bendPx: null, reason: 'not enough path yet' };
  if (!trail || trail.length < cfg.minPoints) return none;
  const tEnd = trail[trail.length - 1][0];
  const pts = trail.filter((p) => tEnd - p[0] <= cfg.windowSec);
  if (pts.length < cfg.minPoints || tEnd - pts[0][0] < cfg.minSpanSec) return none;

  const tm = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const tau = pts.map((p) => p[0] - tm);
  const xs = pts.map((p) => p[1]);
  const ys = pts.map((p) => p[2]);
  const yLine = polyFit(tau, ys, 1);
  const yArc = polyFit(tau, ys, 2);
  const xArc = polyFit(tau, xs, 2);
  if (!yLine || !yArc || !xArc) return none;

  const ay = 2 * yArc.coef[2];  // image y grows downward, so positive = pulled down
  const ax = 2 * xArc.coef[2];
  const length = Math.max(2, median(lastWithin(samples, tEnd, cfg.windowSec, 'major')));
  const pull = ay / length;
  const fit = yLine.rms > 0 ? yArc.rms / yLine.rms : 1; // share of the straight-line error the parabola leaves

  let reason = null;
  if (yLine.rms < cfg.minBendPx) reason = 'path is straight';
  else if (fit > cfg.maxFitRatio) reason = 'path is not a clean arc';
  else if (ay <= 0 || ay < cfg.downRatio * Math.abs(ax)) reason = 'not pulled straight down';
  else if (pull < cfg.minPull) reason = 'pull too weak for gravity on something this small';
  return {
    arc: reason === null,
    pull: +pull.toFixed(1),
    accel: +ay.toFixed(1),
    fit: +fit.toFixed(2),
    bendPx: +yLine.rms.toFixed(2),
    reason: reason || 'falls on a gravity arc',
  };
}

// Test 2. Follows the blob's long-axis angle and adds up how far it has turned.
export function spinCheck(samples, cfg) {
  const none = { spinning: false, turnDeg: 0, sameWay: null, reason: 'not enough elongated frames' };
  if (!samples || !samples.angle || samples.angle.length < 3) return none;
  const { t, angle, major, minor } = samples;
  const tEnd = t[t.length - 1];
  let total = 0, steps = 0;
  const turns = [];
  for (let i = 1; i < t.length; i++) {
    if (tEnd - t[i - 1] > cfg.spinWindowSec) continue;
    // The angle of a round blob means nothing, so only use frames where it is clearly elongated.
    const e0 = major[i - 1] / Math.max(0.5, minor[i - 1]), e1 = major[i] / Math.max(0.5, minor[i]);
    if (e0 < cfg.minElongation || e1 < cfg.minElongation) continue;
    let d = angle[i] - angle[i - 1];
    // A long axis looks the same after half a turn, so take the smallest change (±90°).
    while (d > Math.PI / 2) d -= Math.PI;
    while (d < -Math.PI / 2) d += Math.PI;
    turns.push(d);
    total += d;
    steps++;
  }
  if (steps < cfg.minSpinSteps) return none;
  const dir = Math.sign(total);
  const sameWay = turns.filter((d) => Math.sign(d) === dir && Math.abs(d) > 0.01).length / steps;
  const turnDeg = Math.abs(total) * (180 / Math.PI);
  const spinning = turnDeg >= cfg.minTurnDeg && sameWay >= cfg.spinConsistency;
  return {
    spinning,
    turnDeg: Math.round(turnDeg),
    sameWay: +sameWay.toFixed(2),
    reason: spinning ? `turned ${Math.round(turnDeg)}° one way` : turnDeg < cfg.minTurnDeg ? 'not turning' : 'turning back and forth',
  };
}

function lastWithin(samples, tEnd, windowSec, key) {
  const out = [];
  if (!samples || !samples[key]) return out;
  for (let i = 0; i < samples.t.length; i++) if (tEnd - samples.t[i] <= windowSec) out.push(samples[key][i]);
  return out;
}

function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[b.length >> 1];
}
