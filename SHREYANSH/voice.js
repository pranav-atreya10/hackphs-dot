// voice.js: the spoken tower alert (build plan prompt A2).
//   buildAlertText(event) -> a plain sentence, built from a template (no AI, so it is instant)
//   speak(text)           -> ElevenLabs MP3 as base64, or null if it fails
//   shouldAlert(type)     -> rate limit: one alert per event type every 12 seconds
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const config = require('./config');
const { directionPhrase, numberWords } = require('./describe');

const ALERT_COOLDOWN_MS = 12000;   // at most one alert per type (bird / drone) in this window
const SPEAK_TIMEOUT_SECONDS = 4;   // give up on ElevenLabs after this; the tower then uses its own voice
const MAX_CACHED_CLIPS = 100;      // keep memory small; the oldest clip is dropped first
const RISK_RANK = { green: 0, yellow: 1, red: 2 };

// One shared ElevenLabs client. Without a key or voice, speak() returns null.
const elevenlabs = config.ELEVENLABS_API_KEY && config.ELEVENLABS_VOICE_ID
  ? new ElevenLabsClient({ apiKey: config.ELEVENLABS_API_KEY })
  : null;

/**
 * Template sentence for the tower, e.g. "Caution, flock of eight birds heading toward the runway."
 * Numbers are spelled out and only letters, commas and periods are used, so the voice reads it cleanly.
 */
function buildAlertText(event) {
  if (event.type === 'drone') return 'Warning, drone detected near the runway.';

  const n = Math.max(0, Math.round(Number(event.object_count) || 0));
  const opener = event.risk === 'red' ? 'Caution' : 'Advisory';
  let birds;
  if (n === 0) birds = 'birds';
  else if (n === 1) birds = 'one bird';
  else if (n >= 5) birds = `flock of ${numberWords(n)} birds`;
  else birds = `${numberWords(n)} birds`;

  const sentence = `${opener}, ${birds} ${directionPhrase(event.direction)}.`;
  return sentence.replace(/[^A-Za-z ,.]/g, ''); // safety net: no digits or symbols
}

// Finished clips, keyed by the exact sentence. Alert sentences repeat a lot
// ("Warning, drone detected near the runway."), so most alerts after the first are instant and free.
const audioCache = new Map();

/**
 * Turns text into speech with ElevenLabs.
 * @returns {Promise<string|null>} base64 MP3, or null if ElevenLabs is not set up or fails
 */
async function speak(text) {
  if (!elevenlabs || typeof text !== 'string' || !text.trim()) return null;
  if (audioCache.has(text)) return audioCache.get(text);

  try {
    const stream = await elevenlabs.textToSpeech.convert(
      config.ELEVENLABS_VOICE_ID,
      { text: text.slice(0, 300), modelId: 'eleven_flash_v2_5', outputFormat: 'mp3_22050_32' },
      { timeoutInSeconds: SPEAK_TIMEOUT_SECONDS, maxRetries: 0 }
    );
    // The SDK returns a web stream; read all of it, then encode as base64 for Socket.IO.
    const audio = Buffer.from(await new Response(stream).arrayBuffer());
    if (audio.length === 0) throw new Error('empty audio');
    const base64 = audio.toString('base64');

    audioCache.set(text, base64);
    if (audioCache.size > MAX_CACHED_CLIPS) audioCache.delete(audioCache.keys().next().value); // drop oldest
    return base64;
  } catch (err) {
    const status = err.statusCode ? `HTTP ${err.statusCode} ` : '';
    console.warn(`[voice] ElevenLabs failed: ${status}${config.redact(err.message).slice(0, 160)}`);
    return null;
  }
}

// When the last alert for each type went out, and at what risk.
const lastAlert = new Map(); // type -> { at, risk }

/**
 * Rate limit. The camera re-sends an event every 2 seconds while birds or a drone are present,
 * so without this the tower would hear the same alert over and over.
 * Allows one alert per type every 12 seconds, except that a HIGHER risk than the last alert
 * (yellow -> red) always goes through at once.
 * @param {'bird'|'drone'} type
 * @param {'yellow'|'red'} [risk='red']
 * @param {number} [now=Date.now()]  only tests pass this, to simulate time passing
 */
function shouldAlert(type, risk = 'red', now = Date.now()) {
  const last = lastAlert.get(type);
  const cooledDown = !last || now - last.at >= ALERT_COOLDOWN_MS;
  const escalated = last && (RISK_RANK[risk] ?? 0) > (RISK_RANK[last.risk] ?? 0);
  if (!cooledDown && !escalated) return false;
  lastAlert.set(type, { at: now, risk });
  return true;
}

module.exports = { buildAlertText, speak, shouldAlert, ALERT_COOLDOWN_MS };
