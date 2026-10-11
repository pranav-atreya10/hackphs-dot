const test = require('node:test');
const assert = require('node:assert/strict');
const { createPipeline } = require('../ai-voice/pipeline');
const { createVoice, createRateLimit } = require('../ai-voice/voice');
const { createSolana, parseSecret, hashReport, DEVNET_GENESIS } = require('../ai-voice/solana');
const settings = { ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_VOICE_ID: 'test-voice', SOLANA_SECRET_KEY: JSON.stringify(Array(64).fill(1)), SOLANA_RPC_URL: 'https://devnet.invalid' };
const ev = { id: 'incident-a', cameraId: 'phone-a', airport: 'KPCT', receivedAt: Date.now(), risk: 'red', type: 'drone', object_count: 1 };
function fixture(overrides = {}) {
  const calls = [];
  class Connection {
    async getGenesisHash() { return DEVNET_GENESIS; }
    async getBalance() { return 100000; }
    async getFeeForMessage() { return { value: 5000 }; }
    async getLatestBlockhash() { return { blockhash: 'block', lastValidBlockHeight: 100 }; }
    async sendRawTransaction() { calls.push('send'); return 'signature-test'; }
    async getSignatureStatuses() { return { value: [{ confirmationStatus: 'confirmed', err: null }] }; }
    async getBlockHeight() { return 50; }
  }
  Object.assign(Connection.prototype, overrides);
  class Transaction { add() { return this; } compileMessage() { return {}; } sign() {} serialize() { return Buffer.from('tx'); } }
  class PublicKey { constructor(value) { this.value = value; } toBase58() { return this.value; } }
  return { calls, web3: { Connection, Transaction, PublicKey, TransactionInstruction: class {}, Keypair: { fromSecretKey: () => ({ publicKey: new PublicKey('public-wallet') }) } } };
}
test('red alert and voice arrive before slow report; report and hash preserve same ID', async () => {
  let finish; const sent = [];
  const p = createPipeline({ settings, voice: { speak: async () => null, health: () => ({}) }, solana: { stampReport: async text => ({ hash: hashReport(text), tx: null, status: 'hash only', error: null }), health: () => ({}) }, analyzeEvent: () => new Promise(r => { finish = r; }) });
  const done = p.processIncident(ev, { emit: (name, data) => sent.push({ name, data }), save: async () => {} });
  assert.equal(sent[1].name, 'alert'); assert.equal(sent[1].data.incident_id, ev.id);
  await new Promise(r => setImmediate(r));
  assert.ok(sent.some(m => m.data.audio_failed));
  finish({ label: 'drone', report: 'Report', source: 'fallback' }); await done;
  assert.equal(sent.filter(m => m.name === 'alert').length, 1);
  assert.ok(sent.some(m => m.name === 'incident' && m.data.report_hash === hashReport('Report')));
});
test('cooldown scopes cameras and airports and permits escalation', () => {
  const allow = createRateLimit();
  assert.equal(allow({ ...ev, risk: 'yellow' }, 1000), true);
  assert.equal(allow({ ...ev, risk: 'yellow' }, 1001), false);
  assert.equal(allow(ev, 1002), true);
  assert.equal(allow({ ...ev, cameraId: 'other' }, 1002), true);
  assert.equal(allow({ ...ev, airport: 'KTTN' }, 1002), true);
});
test('ElevenLabs deduplicates requests and rejects a nonaudio response', async () => {
  let calls = 0;
  const voice = createVoice({ settings, fetchImpl: async () => { calls++; return new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }); } });
  const audio = await Promise.all([voice.speak('Warning'), voice.speak('Warning')]);
  assert.equal(audio[0], audio[1]); assert.equal(await voice.speak('Warning'), audio[0]); assert.equal(calls, 1);
  const broken = createVoice({ settings, fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
  assert.equal(await broken.speak('Warning'), null); assert.match(broken.health().lastError, /non-audio/);
});
test('Solana validates byte ranges and hashes reports without a wallet', async () => {
  assert.throws(() => parseSecret(JSON.stringify(Array(64).fill(256))), /integers/);
  assert.throws(() => parseSecret('[]'), /64/);
  const result = await createSolana({ settings: {} }).stampReport('Report');
  assert.equal(result.status, 'hash only'); assert.equal(result.hash, hashReport('Report'));
});
test('Solana refuses wrong networks and unfunded wallets before sending', async () => {
  for (const [override, error] of [[{ getGenesisHash: async () => 'mainnet' }, /devnet/], [{ getBalance: async () => 0 }, /devnet SOL/]]) {
    const f = fixture(override), result = await createSolana({ settings, web3: f.web3 }).stampReport('Report');
    assert.equal(result.status, 'failed'); assert.match(result.error, error); assert.equal(f.calls.length, 0);
  }
});
test('Solana confirmed stamp returns a verified-state signature and hash', async () => {
  const f = fixture(), result = await createSolana({ settings, web3: f.web3 }).stampReport('Report');
  assert.equal(result.status, 'confirmed'); assert.equal(result.hash, hashReport('Report'));
  assert.equal(result.tx, 'signature-test'); assert.match(result.explorer, /cluster=devnet/); assert.equal(f.calls.length, 1);
});
test('Solana timeout is bounded before submission', async () => {
  const f = fixture({ getGenesisHash: () => new Promise(() => {}) });
  const result = await createSolana({ settings, web3: f.web3, timeoutMs: 20 }).stampReport('Report');
  assert.equal(result.status, 'failed'); assert.match(result.error, /timed out/); assert.equal(f.calls.length, 0);
});
test('late or duplicate ElevenLabs updates never repeat the browser fallback', async () => {
  const { createAlertPlayer } = await import('../public/js/alert-player.mjs');
  let timeout, spoken = 0, played = 0, alarms = 0;
  const player = createAlertPlayer({ enabled: () => true, alarm: () => { alarms++; }, showText: () => {}, speakText: () => { spoken++; }, playAudio: async () => { played++; }, setTimer: fn => { timeout = fn; return 1; }, clearTimer: () => {} });
  player.receive({ id: ev.id, text: 'Warning', voice_pending: true }); timeout(); await new Promise(r => setImmediate(r));
  player.update({ id: ev.id, audio: 'late' }); player.receive({ id: ev.id, text: 'Warning', voice_pending: true });
  await new Promise(r => setImmediate(r)); assert.equal(spoken, 1); assert.equal(played, 0); assert.equal(alarms, 1);
});
