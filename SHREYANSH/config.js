// config.js: the ONLY place in SHREYANSH/ that reads API keys.
//
// Locally, keys come from SHREYANSH/.env (git-ignored, never committed).
// On DigitalOcean, keys come from real environment variables set in the dashboard.
// dotenv never overrides a variable that is already set, so the deployed server
// always uses its real environment variables, even if a stray .env file exists.
const path = require('path');

require('dotenv').config({
  path: path.join(__dirname, '.env'),
  override: false, // keep variables that are already set (DigitalOcean)
  quiet: true      // don't print anything about the .env file
});

const config = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  // gemini-2.5-flash now returns 404 for new users; 3.5-flash answered in ~1 s in testing.
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || '',
  SOLANA_SECRET_KEY: process.env.SOLANA_SECRET_KEY || ''
};

// Optional, only for the test tools (fake-events.js, mock-server.js). They must match the
// server's CAMERA_API_KEY / TOWER_API_KEY. Not part of keyStatus(), since the pipeline doesn't need them.
const testKeys = {
  CAMERA_API_KEY: process.env.CAMERA_API_KEY || '',
  TOWER_API_KEY: process.env.TOWER_API_KEY || ''
};

// Names of the values that are secrets. Their contents must never be logged.
const SECRET_NAMES = ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'SOLANA_SECRET_KEY', 'CAMERA_API_KEY', 'TOWER_API_KEY'];

// Template values like "PASTE_VOICE_ID_HERE", "your-key" or an empty "[]" count as not set.
const isPlaceholder = value => /^(paste|your|change|replace|todo)[_-]/i.test(value) || /^\[\s*\]$/.test(value);

// Returns { NAME: true/false } so we can report which keys are set without showing them.
function keyStatus() {
  const status = {};
  for (const [name, value] of Object.entries(config)) status[name] = Boolean(value) && !isPlaceholder(value);
  return status;
}

// Safety net for error messages: replaces any secret value with "[hidden]"
// before a message is printed, in case an API ever echoes a key back.
function redact(text) {
  let out = String(text);
  for (const name of SECRET_NAMES) {
    const value = config[name] || testKeys[name];
    if (value && value.length >= 8) out = out.split(value).join('[hidden]');
  }
  return out;
}

module.exports = { ...config, ...testKeys, keyStatus, redact };
