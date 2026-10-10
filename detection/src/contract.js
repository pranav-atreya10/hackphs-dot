// Builds the JSON messages the camera sends to the server (see CONTRACT.md).
// Everything here is plain data: no DOM, no network.

import { destination } from './geo.js';

const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

export function isoAt(wallSec) {
  return new Date(wallSec * 1000).toISOString();
}

// primary: the most important group right now (see DetectionEngine.pickPrimary), or null.
export function buildEvent({ cfg, risk, primary, groups, wallNow, evidence, crop }) {
  const cam = cfg.camera;
  const active = groups.filter((g) => g.classification !== 'rejected');
  const objectCount = active.reduce((s, g) => s + g.size, 0);

  const ev = {
    camera_id: cfg.camera_id,
    time: isoAt(wallNow),
    type: primary ? typeOf(primary.classification) : 'none',
    object_count: objectCount,
    direction: primary ? describeDirection(primary) : 'clear',
    confidence: primary ? r3(primary.confidence) : 1,
    risk: risk.level,
    // Contract additions (detection lead)
    flock_size: primary ? primary.size : 0,
    eta_seconds: primary ? r1(primary.eta_seconds) : null,
    eta_range: primary ? primary.eta_range || null : null,   // [earliest, latest, 'certain'|'possible']
    bearing_deg: primary ? r1(primary.bearing_deg) : null,
    classification: primary ? primary.classification : null,
    flap_hz: primary ? r1(primary.flap_hz) : null,
    // Extra context
    track_id: primary && primary.kind === 'track' ? primary.id : null,
    flock_id: primary && primary.kind === 'flock' ? primary.id : null,
    heading: primary && primary.heading ? primary.heading.name : null,
    reasons: risk.reasons,
    camera: { lat: cam.lat, lon: cam.lon, heading_deg: cam.heading_deg, hfov_deg: cam.hfov_deg },
    needs_snapshot: !!crop,
    crop_box: crop || null,   // normalized {x, y, w, h}; the browser adapter fills `snapshot`
    snapshot: null,
    evidence: evidence || null,
    target_geo: null,
    path_geo: null,
  };

  if (primary && primary.bearing_deg !== null) {
    ev.target_geo = { type: 'Point', coordinates: destination(cam.lat, cam.lon, primary.bearing_deg, cam.assumed_range_m) };
    ev.path_geo = pathLine(cam, evidence);
  }
  return ev;
}

// GeoJSON LineString for MongoDB: the target's bearings over time, projected to the
// assumed range. Falls back to camera -> target if there's only one bearing.
function pathLine(cam, evidence) {
  const pts = [];
  if (evidence && evidence.track_points) {
    for (const p of evidence.track_points) {
      const c = destination(cam.lat, cam.lon, p.bearing_deg, cam.assumed_range_m);
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - c[0]) > 1e-7 || Math.abs(last[1] - c[1]) > 1e-7) pts.push(c);
    }
  }
  if (pts.length < 2) {
    const target = pts[0] || null;
    if (!target) return null;
    return { type: 'LineString', coordinates: [[cam.lon, cam.lat], target] };
  }
  return { type: 'LineString', coordinates: pts };
}

function typeOf(cls) {
  if (cls === 'drone') return 'drone';
  if (cls === 'bird') return 'bird';
  return 'unknown';
}

function describeDirection(g) {
  if (g.kind === 'audio') return 'heard, not seen';
  const parts = [];
  parts.push(g.heading ? `heading ${g.heading.name}` : 'hovering or climbing');
  if (g.eta_seconds === 0) parts.push('inside corridor');
  else if (g.eta_seconds !== null) parts.push(`toward corridor, ${Math.round(g.eta_seconds)} s`);
  else parts.push('not toward corridor');
  return parts.join(', ');
}

export function buildTrackBatch(cfg, points, wallNow) {
  return { camera_id: cfg.camera_id, time: isoAt(wallNow), points };
}

export { r1, r3 };
