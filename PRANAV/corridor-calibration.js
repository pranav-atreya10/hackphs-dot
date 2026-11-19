// Only operator-managed configuration can activate an operational mask.
const poseKeys = ["lat", "lon", "heading_deg", "hfov_deg", "pitch_deg"];

function validPolygon(poly) {
  if (!Array.isArray(poly) || poly.length < 3 || poly.length > 64 ||
      !poly.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))) return false;
  const area2 = poly.reduce((sum, [x, y], i) => {
    const [nx, ny] = poly[(i + 1) % poly.length];
    return sum + x * ny - y * nx;
  }, 0);
  return Math.abs(area2) > 1e-8;
}

function readSurveys(raw) {
  if (!raw) return [];
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error("SURVEYED_CORRIDORS_JSON must be an array");
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record.airport !== "string" || !record.airport.trim() ||
        typeof record.cameraId !== "string" || !record.cameraId.trim() ||
        typeof record.surveyId !== "string" || !record.surveyId.trim() ||
        !validPolygon(record.polygon) || !poseKeys.every((key) => Number.isFinite(record.camera?.[key])) ||
        Math.abs(record.camera.lat) > 90 || Math.abs(record.camera.lon) > 180 ||
        record.camera.heading_deg < 0 || record.camera.heading_deg >= 360 ||
        record.camera.hfov_deg <= 0 || record.camera.hfov_deg >= 180 || Math.abs(record.camera.pitch_deg) > 90) {
      throw new Error("Invalid surveyed corridor record");
    }
    const id = JSON.stringify([record.airport, record.cameraId]);
    if (ids.has(id)) throw new Error("Duplicate surveyed corridor for airport and camera");
    ids.add(id);
  }
  return records;
}

function surveyedCorridor(records, { airport, cameraId }, camera, source) {
  if (source !== "webcam") return null;
  return records.find((r) => r.airport === airport && r.cameraId === cameraId &&
    poseKeys.every((key) => camera?.[key] === r.camera[key])) || null;
}

function sanitizeMetrics(payload, surveyId) {
  const { target_geo, path_geo, ...event } = payload;
  const eta = event.eta_basis === "image_space_corridor" && !!surveyId &&
    event.corridor_survey_id === surveyId && Number.isFinite(event.eta_seconds) && event.eta_seconds >= 0;
  if (!eta) {
    event.eta_seconds = null;
    event.eta_range = null;
    event.eta_basis = null;
    event.corridor_survey_id = null;
    if (typeof event.direction === "string") {
      event.direction = event.direction.split(", ").filter((part) => !/\bcorridor\b/i.test(part)).join(", ") || "unavailable";
    }
    if (Array.isArray(event.reasons)) event.reasons = event.reasons.filter((part) => typeof part === "string" && !/\bcorridor\b/i.test(part));
  }
  return event;
}

module.exports = { readSurveys, surveyedCorridor, sanitizeMetrics };
