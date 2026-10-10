// ElevenLabs text-to-speech: turns a red alert sentence into a spoken tower announcement (prompt A2).
// Without a key the tower falls back to the browser's built-in speech voice.
import { config } from './config.js';

/** @returns {Promise<string|null>} base64 MP3, or null in demo mode / on failure */
export async function speak(text) {
  if (!config.elevenKey) return null;
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${config.elevenVoice}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: config.elevenModel, voice_settings: { stability: 0.6, similarity_boost: 0.75 } })
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch (err) {
    console.warn('[elevenlabs] speech failed:', err.message);
    return null;
  }
}
