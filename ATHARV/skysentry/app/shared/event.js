// The event every camera station sends to the server (build plan, section 4).
// Shared by the browser camera page and the Node server, so it has no dependencies.

export const DETECTION_TYPES = ['bird', 'drone'];
export const RISK_LEVELS = ['green', 'yellow', 'red'];
export const DIRECTIONS = ['toward runway', 'away from runway', 'crossing', 'stationary', 'unknown'];

/**
 * @typedef {Object} DetectionEvent
 * @property {string} camera_id      e.g. "runway-east"
 * @property {'bird'|'drone'} type
 * @property {number} object_count   birds in frame, or 1 for a drone
 * @property {string} direction      one of DIRECTIONS
 * @property {number} confidence     0..1, best detection score
 * @property {'green'|'yellow'|'red'} risk
 * @property {string} [snapshot]     small JPEG as base64, only for yellow or red
 * @property {string} [time]         ISO timestamp; the server fills it in if missing
 */

export function makeEvent({ cameraId, type, count, direction, confidence, risk, snapshot, time }) {
  const event = {
    camera_id: cameraId,
    type,
    object_count: count,
    direction,
    confidence: Math.round(confidence * 100) / 100,
    risk,
    time: time ?? new Date().toISOString()
  };
  if (snapshot && risk !== 'green') event.snapshot = snapshot;
  return event;
}

/** Returns a list of problems; an empty list means the event is valid. */
export function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== 'object') return ['event must be an object'];
  if (typeof e.camera_id !== 'string' || !e.camera_id.trim()) errors.push('camera_id is required');
  if (!DETECTION_TYPES.includes(e.type)) errors.push(`type must be one of ${DETECTION_TYPES.join(', ')}`);
  if (!Number.isInteger(e.object_count) || e.object_count < 0) errors.push('object_count must be a whole number of 0 or more');
  if (!DIRECTIONS.includes(e.direction)) errors.push(`direction must be one of ${DIRECTIONS.join(', ')}`);
  if (typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1) errors.push('confidence must be between 0 and 1');
  if (!RISK_LEVELS.includes(e.risk)) errors.push(`risk must be one of ${RISK_LEVELS.join(', ')}`);
  if (e.snapshot !== undefined) {
    if (typeof e.snapshot !== 'string') errors.push('snapshot must be a base64 string');
    else if (e.risk === 'green') errors.push('snapshot is only sent for yellow or red events');
    else if (e.snapshot.length > 400_000) errors.push('snapshot is too large; keep it under about 300 KB');
  }
  if (e.time !== undefined && Number.isNaN(Date.parse(e.time))) errors.push('time must be an ISO timestamp');
  return errors;
}
