// All secrets come from environment variables (build plan, section 10: never put keys in the page or in git).
// Anything left unset runs in demo mode, so the whole pipeline works before the accounts exist.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Minimal .env loader so `npm start` works without extra packages.
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
export const config = {
  port: Number(env.PORT ?? 8080),
  airportName: env.AIRPORT_NAME ?? 'Princeton Airport',
  tigerUrl: env.TIGER_DATABASE_URL || null,
  mongoUri: env.MONGODB_URI || null,
  mongoDb: env.MONGODB_DB ?? 'skysentry',
  geminiKey: env.GEMINI_API_KEY || null,
  geminiModel: env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  elevenKey: env.ELEVENLABS_API_KEY || null,
  elevenVoice: env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM',
  elevenModel: env.ELEVENLABS_MODEL ?? 'eleven_turbo_v2_5',
  solanaSecret: env.SOLANA_SECRET_KEY || null,          // JSON array of the devnet keypair's 64 bytes
  solanaRpc: env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  heartbeatMs: Number(env.CAMERA_HEARTBEAT_MS ?? 2000)
};

export function modeSummary() {
  const on = (v, name) => `${name}: ${v ? 'live' : 'demo'}`;
  return [on(config.tigerUrl, 'Tiger Data'), on(config.mongoUri, 'MongoDB'), on(config.geminiKey, 'Gemini'),
          on(config.elevenKey, 'ElevenLabs'), on(config.solanaSecret, 'Solana')].join(' · ');
}
