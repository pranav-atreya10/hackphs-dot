// Polygon helpers. Polygons are arrays of [x, y] points.

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Smallest t >= 0 at which the ray p + t*d crosses a polygon edge, or Infinity.
export function rayPolygonHit(px, py, dx, dy, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const ex = poly[i][0] - ax;
    const ey = poly[i][1] - ay;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue; // parallel
    const qx = ax - px;
    const qy = ay - py;
    const t = (qx * ey - qy * ex) / denom;
    const u = (qx * dy - qy * dx) / denom;
    if (t >= 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

// Seconds until a point moving at constant velocity enters the polygon.
// 0 if already inside, null if it never does within horizonSec.
export function etaToPolygon(x, y, vx, vy, poly, horizonSec) {
  if (!poly || poly.length < 3) return null;
  if (pointInPolygon(x, y, poly)) return 0;
  if (Math.hypot(vx, vy) < 1e-6) return null;
  const t = rayPolygonHit(x, y, vx, vy, poly);
  return t <= horizonSec ? t : null;
}

// Fill out[w*h] with 1 inside the normalized polygon and 0 outside (scanline, even-odd).
// An empty polygon means "everything".
export function rasterizePolygon(poly, w, h, out) {
  if (!poly || poly.length < 3) {
    out.fill(1);
    return out;
  }
  out.fill(0);
  const pts = poly.map(([x, y]) => [x * w, y * h]);
  const xs = [];
  for (let row = 0; row < h; row++) {
    const yc = row + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x1, y1] = pts[j];
      const [x2, y2] = pts[i];
      if ((y1 > yc) !== (y2 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      if (to >= from) out.fill(1, row * w + from, row * w + to + 1);
    }
  }
  return out;
}

export function angleDiffDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
