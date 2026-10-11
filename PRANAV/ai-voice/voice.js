// Based on SHREYANSH/voice.js: immediate template text, cached ElevenLabs speech and scoped cooldowns.
const config = require('./config');
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
function createVoice({ settings = config, fetchImpl = (...args) => fetch(...args), timeoutMs = 4000 } = {}) {
  const audioCache = new Map(), pending = new Map();
  const state = { configured: Boolean(settings.ELEVENLABS_API_KEY), lastError: null, lastSuccess: null };
  async function speak(text) {
    if (!settings.ELEVENLABS_API_KEY || !text?.trim()) return null;
    text = text.slice(0, 300);
    if (audioCache.has(text)) return audioCache.get(text);
    if (pending.has(text)) return pending.get(text);
    const work = (async () => {
      try {
        const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(settings.ELEVENLABS_VOICE_ID)}?output_format=mp3_22050_32`, {
          method: 'POST', headers: { 'xi-api-key': settings.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: settings.ELEVENLABS_MODEL || 'eleven_flash_v2_5' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
        if (!/audio\/(mpeg|mp3)/i.test(res.headers.get('content-type') || '')) throw new Error('ElevenLabs returned a non-audio response');
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!bytes.length) throw new Error('ElevenLabs returned empty audio');
        const audio = bytes.toString('base64');
        audioCache.set(text, audio);
        if (audioCache.size > 100) audioCache.delete(audioCache.keys().next().value);
        state.lastError = null; state.lastSuccess = new Date().toISOString();
        return audio;
      } catch (err) {
        state.lastError = config.redact(err.message).slice(0, 160);
        console.warn(`[voice] ${state.lastError}; using browser voice`);
        return null;
      } finally { pending.delete(text); }
    })();
    pending.set(text, work);
    return work;
  }
  return { speak, health: () => ({ ...state, cachedClips: audioCache.size }) };
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
module.exports = { buildAlertText, createVoice, createRateLimit, ALERT_COOLDOWN_MS };
