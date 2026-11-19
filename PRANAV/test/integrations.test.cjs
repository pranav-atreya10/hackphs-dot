const test = require('node:test');
const assert = require('node:assert/strict');
const { createPipeline } = require('../ai-voice/pipeline');
const { createRateLimit } = require('../ai-voice/voice');
const { createSolana, parseSecret, hashReport, DEVNET_GENESIS } = require('../ai-voice/solana');
const settings = { SOLANA_SECRET_KEY: JSON.stringify(Array(64).fill(1)), SOLANA_RPC_URL: 'https://devnet.invalid' };
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
test('red alert arrives before slow report, ready for the browser voice; report and hash preserve same ID', async () => {
  let finish; const sent = [];
  const p = createPipeline({ settings, solana: { stampReport: async text => ({ hash: hashReport(text), tx: null, status: 'hash only', error: null }), health: () => ({}) }, analyzeEvent: () => new Promise(r => { finish = r; }) });
  const done = p.processIncident(ev, { emit: (name, data) => sent.push({ name, data }), save: async () => {} });
  assert.equal(sent[1].name, 'alert'); assert.equal(sent[1].data.incident_id, ev.id);
  await new Promise(r => setImmediate(r));
  assert.equal(sent[1].data.voice_pending, false); assert.equal(sent[1].data.audio, null); // nothing to wait for: the tower speaks now
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
test('a red alert is spoken by the browser voice straight away, once', async () => {
  const { createAlertPlayer } = await import('../public/js/alert-player.mjs');
  let spoken = 0, alarms = 0, timers = 0;
  const player = createAlertPlayer({ enabled: () => true, alarm: () => { alarms++; }, showText: () => {}, speakText: () => { spoken++; }, playAudio: async () => {}, setTimer: () => { timers++; return 1; }, clearTimer: () => {} });
  player.receive({ id: 'x', text: 'Warning', audio: null, voice_pending: false }); await new Promise(r => setImmediate(r));
  player.receive({ id: 'x', text: 'Warning', audio: null, voice_pending: false }); await new Promise(r => setImmediate(r));
  assert.equal(spoken, 1); assert.equal(alarms, 1); assert.equal(timers, 0);
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

test('Solana does not send if the durable signature reservation fails', async () => {
  const f = fixture();
  f.web3.Transaction.prototype.sign = function () { this.signature = Buffer.alloc(64, 1); };
  let reservations = 0;
  const result = await createSolana({ settings, web3: f.web3 }).stampReport('Report', { beforeSubmit: async ({ signature }) => {
    assert.ok(signature);
    reservations++;
    throw new Error('simulated reservation write failure');
  } });
  assert.equal(result.status, 'failed');
  assert.equal(reservations, 1);
  assert.deepEqual(f.calls, []);
});

test('replayed alert is visible without browser speech, and duplicate receipt does not reannounce it', async () => {
  const { createAlertPlayer } = await import('../public/js/alert-player.mjs');
  const shown = [], spoken = [];
  const player = createAlertPlayer({ enabled: () => true, alarm: () => {}, showText: text => shown.push(text),
    speakText: text => spoken.push(text) });
  const replayed = { id: 'stored1', text: 'Recovered warning' };
  player.receive(replayed, { replay: true });
  player.receive(replayed);
  player.receive({ id: 'live1', text: 'New warning' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(shown, ['Recovered warning', 'New warning']);
  assert.deepEqual(spoken, ['New warning']);
});
test('late or duplicate audio updates never repeat the announcement', async () => {
  const { createAlertPlayer } = await import('../public/js/alert-player.mjs');
  let timeout, spoken = 0, played = 0, alarms = 0;
  const player = createAlertPlayer({ enabled: () => true, alarm: () => { alarms++; }, showText: () => {}, speakText: () => { spoken++; }, playAudio: async () => { played++; }, setTimer: fn => { timeout = fn; return 1; }, clearTimer: () => {} });
  player.receive({ id: ev.id, text: 'Warning', voice_pending: true }); timeout(); await new Promise(r => setImmediate(r));
  player.update({ id: ev.id, audio: 'late' }); player.receive({ id: ev.id, text: 'Warning', voice_pending: true });
  await new Promise(r => setImmediate(r)); assert.equal(spoken, 1); assert.equal(played, 0); assert.equal(alarms, 1);
});
test('only new alerts become incidents: 2-second repeats are not stored, an escalation is', async () => {
  const created = [], saved = [];
  const p = createPipeline({ settings: {}, solana: { stampReport: async () => ({}), health: () => ({}) },
    analyzeEvent: async e => ({ label: 'birds', report: `Report ${e.id}`, source: 'gemini' }) });
  const run = e => p.processIncident(e, { emit: () => {}, create: async () => created.push(e.id), save: async f => saved.push([e.id, f.report]) });
  const bird = { ...ev, type: 'bird', risk: 'yellow', object_count: 4 };
  assert.equal(await run({ ...bird, id: 'b1' }), true);
  assert.equal(await run({ ...bird, id: 'b2' }), false);            // the camera's repeat 2 s later
  assert.equal(await run({ ...bird, id: 'b3', risk: 'red' }), true); // escalation is a new incident
  assert.deepEqual(created, ['b1', 'b3']);
  assert.deepEqual(saved, [['b1', 'Report b1'], ['b3', 'Report b3']]);   // every stored incident gets its report
});
test('health reports a failing Gemini instead of just "configured"', () => {
  const ai = require('../ai-voice/ai');
  const p = createPipeline({ settings: { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm' }, solana: { health: () => ({}) } });
  const failure = { reason: 'model', httpStatus: 404, action: 'Check the configured Gemini model IDs and project availability.' };
  Object.assign(ai.geminiState, { lastError: 'm: Gemini HTTP 404', lastFailure: failure, lastErrorAt: 2, lastSuccessAt: 1 });
  assert.equal(p.status().gemini, 'failing (m: Gemini HTTP 404)');
  assert.equal(p.health().gemini.state, 'unavailable');
  assert.deepEqual(p.health().gemini.failure, failure);
  Object.assign(ai.geminiState, { lastError: null, lastFailure: null, lastSuccessAt: 3 });
  assert.equal(p.status().gemini, 'live');
  Object.assign(ai.geminiState, { lastError: null, lastErrorAt: 0, lastSuccessAt: 0 });
});
