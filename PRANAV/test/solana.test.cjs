const test = require('node:test');
const assert = require('node:assert/strict');
const web3 = require('@solana/web3.js');
const base58 = require('bs58');
const encode = (base58.default || base58).encode;
const { createSolana, hashReport, DEVNET_GENESIS, MEMO_PROGRAM } = require('../ai-voice/solana');
const report = 'SkySentry verification report. Drone detected near runway.';
const signature = '1'.repeat(64);
function fixture(overrides = {}) {
  const wallet = web3.Keypair.generate(); // Ephemeral offline test signer; never funded, persisted or printed.
  const calls = [];
  const connection = {
    getGenesisHash: async () => DEVNET_GENESIS,
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }),
    getFeeForMessage: async message => { assert.ok(message.recentBlockhash); calls.push('fee'); return { value: 5000 }; },
    getBalance: async () => 5000,
    sendRawTransaction: async bytes => {
      const tx = web3.Transaction.from(bytes);
      assert.equal(tx.verifySignatures(), true);
      assert.equal(tx.instructions[0].programId.toBase58(), MEMO_PROGRAM);
      assert.equal(tx.instructions[0].data.toString('utf8'), hashReport(report));
      calls.push('send'); return encode(tx.signature);
    },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    getBlockHeight: async () => 99,
    getParsedTransaction: async () => ({ meta: { err: null }, transaction: { message: { instructions: [{ programId: new web3.PublicKey(MEMO_PROGRAM), parsed: hashReport(report) }] } } }),
    ...overrides,
  };
  return { connection, calls, settings: { SOLANA_SECRET_KEY: JSON.stringify(Array.from(wallet.secretKey)) } };
}
test('real web3 signs and serializes a memo with blockheight constructor and exact fee balance', async () => {
  const f = fixture();
  const result = await createSolana(f).stampReport(report);
  assert.equal(result.status, 'confirmed'); assert.equal(result.hash, hashReport(report));
  assert.deepEqual(f.calls, ['fee', 'send']); assert.match(result.tx, /^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
});
test('public report verification needs no wallet secret and rejects edited report', async () => {
  const f = fixture(), solana = createSolana({ settings: {}, connection: f.connection });
  assert.equal((await solana.verifyReport(report, signature)).matches, true);
  assert.equal((await solana.verifyReport(report + ' edited', signature)).matches, false);
  assert.equal(solana.health().wallet, null);
});
test('public verification never accepts a failed or missing transaction', async () => {
  for (const tx of [null, { meta: { err: { InstructionError: [0, 'error'] } }, transaction: { message: { instructions: [{ programId: new web3.PublicKey(MEMO_PROGRAM), parsed: hashReport(report) }] } } }, { meta: null }]) {
    const f = fixture({ getParsedTransaction: async () => tx });
    const result = await createSolana({ settings: {}, connection: f.connection }).verifyReport(report, signature);
    assert.equal(result.matches, false); assert.notEqual(result.status, 'confirmed');
  }
});
test('rejected or expired transactions are failed rather than pending', async () => {
  for (const overrides of [{ getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, 'error'] } }] }) }, { getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 101 }]) {
    const f = fixture(overrides), result = await createSolana(f).stampReport(report);
    assert.equal(result.status, 'failed'); assert.ok(result.tx); assert.ok(result.error);
  }
});
test('timed out RPC cannot continue into signing or submission when it eventually resolves', async () => {
  let release;
  const f = fixture({ getLatestBlockhash: () => new Promise(resolve => { release = resolve; }) });
  const result = await createSolana({ ...f, timeoutMs: 15 }).stampReport(report);
  assert.equal(result.status, 'failed'); assert.deepEqual(f.calls, []);
  release({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
});
test('timeout after submission retains signature and reports pending, not confirmed', async () => {
  const f = fixture({ getSignatureStatuses: () => new Promise(() => {}) });
  const result = await createSolana({ ...f, timeoutMs: 25 }).stampReport(report);
  assert.equal(result.status, 'pending'); assert.ok(result.tx); assert.ok(result.explorer);
});
test('public verification decodes unparsed memo instructions', async () => {
  const f = fixture({ getParsedTransaction: async () => ({ meta: { err: null }, transaction: { message: { instructions: [{ programId: MEMO_PROGRAM, data: encode(Buffer.from(hashReport(report))) }] } } }) });
  assert.equal((await createSolana({ settings: {}, connection: f.connection }).verifyReport(report, signature)).matches, true);
});
