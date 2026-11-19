// Builds the JSON messages the camera sends to the server (see CONTRACT.md).
// Everything here is plain data: no DOM, no network.

const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

export function isoAt(wallSec) {
  return new Date(wallSec * 1000).toISOString();
}

// primary: the most important group right now (see DetectionEngine.pickPrimary), or null.
export function buildEvent({ cfg, risk, primary, groups, wallNow, evidence, crop, forecast }) {
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
    eta_seconds: primary?.eta_basis ? r1(primary.eta_seconds) : null,
    eta_range: primary?.eta_basis ? primary.eta_range || null : null,
    eta_basis: primary?.eta_basis ?? null,
    corridor_survey_id: primary?.eta_basis === 'image_space_corridor' ? cfg.corridor.surveyId : null,
    bearing_deg: primary ? r1(primary.bearing_deg) : null,
    classification: primary ? primary.classification : null,
    flap_hz: primary ? r1(primary.flap_hz) : null,
    // Extra context
    track_id: primary && primary.kind === 'track' ? primary.id : null,
    flock_id: primary && primary.kind === 'flock' ? primary.id : null,
    heading: primary && primary.heading ? primary.heading.name : null,
    reasons: risk.reasons,
    // Bird-count trend: { trend: 'rising'|'steady'|'falling'|'learning'|'off', birds_now, per_min, predicted, horizon_sec }
    forecast: forecast ? { trend: forecast.trend, birds_now: forecast.birds_now, per_min: forecast.per_min,
      predicted: forecast.predicted, horizon_sec: forecast.horizon_sec } : null,
    camera: { lat: cam.lat, lon: cam.lon, heading_deg: cam.heading_deg, hfov_deg: cam.hfov_deg },
    needs_snapshot: !!crop,
    crop_box: crop || null,   // normalized {x, y, w, h}; the browser adapter fills `snapshot`
    snapshot: null,
    evidence: evidence || null,
  };
  return ev;
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
  if (g.eta_basis && g.eta_seconds === 0) parts.push('inside the image-space corridor mask');
  else if (g.eta_basis && g.eta_seconds !== null) {
    parts.push(`projected image-space corridor entry in ${Math.round(g.eta_seconds)} s`);
  }
  return parts.join(', ');
}

export function buildTrackBatch(cfg, points, wallNow) {
  return { camera_id: cfg.camera_id, time: isoAt(wallNow), points };
}

export { r1, r3 };
