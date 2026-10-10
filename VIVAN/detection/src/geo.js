// Turn screen positions into real-world directions using a pinhole camera model.

const RAD = Math.PI / 180;
const NAMES = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export const norm360 = (d) => ((d % 360) + 360) % 360;

export function vfovDeg(hfovDeg, aspectHoverW) {
  return (2 * Math.atan(Math.tan((hfovDeg * RAD) / 2) * aspectHoverW)) / RAD;
}

// Compass bearing of a point at normalized x (0 = left edge, 1 = right edge).
export function bearingFromX(xNorm, headingDeg, hfovDeg) {
  const f = 0.5 / Math.tan((hfovDeg * RAD) / 2);
  return norm360(headingDeg + Math.atan((xNorm - 0.5) / f) / RAD);
}

// Elevation above the horizon of a point at normalized y (0 = top).
export function elevationFromY(yNorm, pitchDeg, hfovDeg, aspectHoverW) {
  const fy = 0.5 / Math.tan((vfovDeg(hfovDeg, aspectHoverW) * RAD) / 2);
  return pitchDeg - Math.atan((yNorm - 0.5) / fy) / RAD;
}

// Angular speed in degrees per second from normalized velocity.
export function angularSpeedDps(vxNorm, vyNorm, hfovDeg, aspectHoverW) {
  return Math.hypot(vxNorm * hfovDeg, vyNorm * vfovDeg(hfovDeg, aspectHoverW));
}

// Which way a target is flying across the view. Sideways motion in the image is
// motion perpendicular to the camera's heading; up/down motion can't be mapped
// to a compass direction from one camera, so we only report the sideways part.
export function motionHeading(vxNorm, vyNorm, headingDeg, minNormSpeed = 0.01) {
  if (Math.abs(vxNorm) < minNormSpeed || Math.abs(vxNorm) < 0.5 * Math.abs(vyNorm)) return null;
  const deg = norm360(headingDeg + (vxNorm > 0 ? 90 : -90));
  return { deg, name: compassName(deg) };
}

export function compassName(deg) {
  return NAMES[Math.round(norm360(deg) / 45) % 8];
}

// Point reached by travelling `meters` from lat/lon along `bearingDeg` (great circle).
export function destination(lat, lon, bearingDeg, meters) {
  const R = 6371000;
  const d = meters / R;
  const b = bearingDeg * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((l2 / RAD + 540) % 360) - 180, p2 / RAD]; // [lon, lat] (GeoJSON order)
}
