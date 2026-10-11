// Production adapter for SHREYANSH/config.js. Native Node support keeps the server's install small.
const path = require('path');
if (process.env.NODE_ENV !== 'production') {
  const existing = { ...process.env };
  try { process.loadEnvFile(path.join(__dirname, '../../SHREYANSH/.env')); } catch {}
  Object.assign(process.env, existing);
}
const isPlaceholder = value => /^(paste|your|change|replace|todo)[_-]/i.test(value) || /^\[\s*\]$/.test(value);
const value = (name, fallback = '') => {
  const v = (process.env[name] || '').trim();
  return v && !isPlaceholder(v) ? v : fallback;
};
const config = {
  GEMINI_API_KEY: value('GEMINI_API_KEY'),
  GEMINI_MODEL: value('GEMINI_MODEL', 'gemini-3.5-flash'),
  GEMINI_BACKUP_MODEL: value('GEMINI_BACKUP_MODEL', 'gemini-3.5-flash-lite'),
  ELEVENLABS_API_KEY: value('ELEVENLABS_API_KEY'),
  ELEVENLABS_VOICE_ID: value('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM'),
  ELEVENLABS_MODEL: value('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
  SOLANA_SECRET_KEY: value('SOLANA_SECRET_KEY'),
  SOLANA_RPC_URL: value('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
  AIRPORT_NAME: value('AIRPORT_NAME', 'Princeton Airport'),
};
function redact(text) {
  let result = String(text);
  for (const name of ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'SOLANA_SECRET_KEY', 'CAMERA_API_KEY', 'TOWER_API_KEY']) {
    const secret = config[name] || process.env[name];
    if (secret) result = result.split(secret).join('[hidden]');
  }
  return result;
}
module.exports = { ...config, redact };
