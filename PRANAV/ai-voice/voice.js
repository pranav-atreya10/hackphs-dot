// Based on SHREYANSH/voice.js: the spoken alert sentence and scoped cooldowns.
// The tower speaks the sentence with the browser's own voice (speechSynthesis).
const { numberWords, directionPhrase } = require('./describe');
const ALERT_COOLDOWN_MS = 12000;
const RANK = { green: 0, yellow: 1, red: 2 };
function buildAlertText(event) {
  if (event.type === 'drone') return event.direction === 'heard, not seen'
    ? 'Warning, drone heard near the runway.' : 'Warning, drone detected near the runway.';
  const n = Math.max(1, Math.round(Number(event.flock_size || event.object_count) || 1));
  const kind = event.type === 'unknown' ? 'object' : 'bird';
  const objects = n > 1 ? `${n >= 5 ? 'flock of ' : ''}${numberWords(n)} ${kind}s` : `one ${kind}`;
  const direction = String(event.direction || '');
  const toward = direction.includes('toward') && !direction.includes('not toward');
  const phrase = toward ? 'heading toward the runway' : directionPhrase(direction);
  const eta = Number.isFinite(event.eta_seconds) && event.eta_seconds > 0
    ? `, ${numberWords(event.eta_seconds)} seconds out` : '';
  return `${event.risk === 'yellow' ? 'Advisory' : 'Caution'}, ${objects} ${phrase}${eta}.`;
}
function createRateLimit() {
  const previous = new Map();
  return (event, now = Date.now()) => {
    const key = `${event.airport || '*'}|${event.cameraId || event.camera_id || 'unknown'}|${event.type}`;
    const last = previous.get(key);
    if (last && now - last.at < ALERT_COOLDOWN_MS && RANK[event.risk] <= RANK[last.risk]) return false;
    previous.set(key, { at: now, risk: event.risk });
    if (previous.size > 2000) for (const [key, row] of previous) if (now - row.at > ALERT_COOLDOWN_MS) previous.delete(key);
    return true;
  };
}
module.exports = { buildAlertText, createRateLimit, ALERT_COOLDOWN_MS };
