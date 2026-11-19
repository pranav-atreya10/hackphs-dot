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
  // Bird judge: 'gemini' (default), 'local' (any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, vLLM) or 'off'.
  BIRD_JUDGE: (['gemini', 'local', 'off'].includes(value('BIRD_JUDGE')) ? value('BIRD_JUDGE') : 'gemini'),
  LOCAL_JUDGE_URL: value('LOCAL_JUDGE_URL', 'http://localhost:11434/v1'),
  LOCAL_JUDGE_MODEL: value('LOCAL_JUDGE_MODEL', 'qwen2.5vl:7b'),
  LOCAL_JUDGE_KEY: value('LOCAL_JUDGE_KEY'),
  SOLANA_SECRET_KEY: value('SOLANA_SECRET_KEY'),
  SOLANA_RPC_URL: value('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
  AIRPORT_NAME: value('AIRPORT_NAME', 'Princeton Airport'),
  OPENAI_API_KEY: value('OPENAI_API_KEY'),
  OPENAI_MODEL: value('OPENAI_MODEL', 'gpt-5-mini'),
  OPENAI_GUIDE_MODEL: value('OPENAI_GUIDE_MODEL', 'gpt-5-nano'),
};
function redact(text) {
  let result = String(text);
  for (const name of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'SOLANA_SECRET_KEY', 'LOCAL_JUDGE_KEY', 'CAMERA_API_KEY', 'TOWER_API_KEY']) {
    const secret = config[name] || process.env[name];
    if (secret) result = result.split(secret).join('[hidden]');
  }
  return result;
}
module.exports = { ...config, redact };
