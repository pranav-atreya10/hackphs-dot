// SHREYANSH's report fingerprint, confirmed on Solana devnet with bounded, cancellable RPC calls.
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { setTimeout: pause } = require('timers/promises');
const config = require('./config');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const hashReport = text => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const explorerUrl = tx => `https://explorer.solana.com/tx/${encodeURIComponent(tx)}?cluster=devnet`;
function encode58(bytes) {
  const raw = Buffer.from(bytes); let number = BigInt(`0x${raw.toString('hex') || '0'}`), out = '';
  while (number) { out = ALPHABET[Number(number % 58n)] + out; number /= 58n; }
  for (const byte of raw) { if (byte !== 0) break; out = '1' + out; }
  return out;
}
function decode58(text) {
  let number = 0n;
  for (const char of text) { const digit = ALPHABET.indexOf(char); if (digit < 0) throw new Error('Invalid memo encoding'); number = number * 58n + BigInt(digit); }
  let hex = number ? number.toString(16) : ''; if (hex.length % 2) hex = '0' + hex;
  const zeroes = text.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(zeroes), Buffer.from(hex, 'hex')]);
}
function parseSecret(secret) {
  let bytes;
  try { bytes = JSON.parse(secret); } catch { throw new Error('Solana key must be a JSON array of 64 bytes'); }
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('Solana key must contain exactly 64 integers between 0 and 255');
  return Uint8Array.from(bytes);
}
function createSolana({ settings = config, web3: suppliedWeb3, connection: suppliedConnection, timeoutMs = 20000, pollMs = 800, sleep = (ms, signal) => pause(ms, undefined, { signal }) } = {}) {
  let conn = suppliedConnection, payer, web3;
  const requests = new AsyncLocalStorage();
  const state = { configured: Boolean(settings.SOLANA_SECRET_KEY), network: 'devnet', lastError: null, lastSuccess: null, wallet: null, lastTx: null, lastStatus: null };
  function getWeb3() { return web3 ||= suppliedWeb3 || require('@solana/web3.js'); }
  function getConnection() {
    if (!conn) conn = new (getWeb3().Connection)(settings.SOLANA_RPC_URL || 'https://api.devnet.solana.com', {
      commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.any([opts.signal, requests.getStore(), AbortSignal.timeout(4000)].filter(Boolean)) }),
    });
    return conn;
  }
  function loadWallet() {
    if (!payer) { payer = getWeb3().Keypair.fromSecretKey(parseSecret(settings.SOLANA_SECRET_KEY)); state.wallet = payer.publicKey.toBase58(); }
    return payer;
  }
  async function bounded(action) {
    const controller = new AbortController();
    const error = new Error('Solana request timed out'); error.code = 'SOLANA_TIMEOUT';
    let timer;
    try {
      return await requests.run(controller.signal, () => Promise.race([
        action(controller.signal),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(error); reject(error); }, timeoutMs); }),
      ]));
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function onDevnet(connection, signal) {
    const network = await connection.getGenesisHash(); signal.throwIfAborted();
    if (network !== DEVNET_GENESIS) throw new Error('Solana RPC must connect to devnet');
  }
  function terminal(message) { const err = new Error(message); err.code = 'SOLANA_FAILED'; return err; }
  async function stampReport(text) {
    const hash = hashReport(text);
    if (!settings.SOLANA_SECRET_KEY) return { hash, tx: null, status: 'hash only', error: null };
    let signature = null, submitted = false;
    try {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Cannot stamp an empty report');
      const lib = getWeb3(), signer = loadWallet(), connection = getConnection();
      await bounded(async signal => {
        await onDevnet(connection, signal);
        const block = await connection.getLatestBlockhash('confirmed'); signal.throwIfAborted();
        // web3's blockheight-aware constructor requires `blockhash`, not `recentBlockhash`.
        const tx = new lib.Transaction({ feePayer: signer.publicKey, blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight });
        tx.add(new lib.TransactionInstruction({ programId: new lib.PublicKey(MEMO_PROGRAM), keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(hash, 'utf8') }));
        const fee = (await connection.getFeeForMessage(tx.compileMessage(), 'confirmed')).value; signal.throwIfAborted();
        if (!Number.isFinite(fee) || fee < 0) throw new Error('Solana could not estimate the memo fee; try again');
        const balance = await connection.getBalance(signer.publicKey, 'confirmed'); signal.throwIfAborted();
        if (balance < fee) throw new Error('Wallet needs devnet SOL for memo fees; fund the public wallet using the Solana faucet');
        tx.sign(signer);
        signature = tx.signature ? encode58(tx.signature) : null;
        signal.throwIfAborted(); submitted = true;
        const returned = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 1 }); signal.throwIfAborted();
        if (signature && returned !== signature) throw terminal('Solana returned a different transaction signature');
        signature = returned;
        while (true) {
          const row = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value?.[0]; signal.throwIfAborted();
          if (row?.err) throw terminal('Solana rejected the memo transaction');
          if (row?.confirmationStatus === 'confirmed' || row?.confirmationStatus === 'finalized') return;
          const height = await connection.getBlockHeight('confirmed'); signal.throwIfAborted();
          if (height > block.lastValidBlockHeight) throw terminal('Solana transaction expired; try again');
          await sleep(pollMs, signal); signal.throwIfAborted();
        }
      });
      state.lastError = null; state.lastSuccess = new Date().toISOString(); state.lastTx = signature; state.lastStatus = 'confirmed';
      return { hash, tx: signature, status: 'confirmed', error: null, explorer: explorerUrl(signature) };
    } catch (err) {
      const definitelyFailed = err.code === 'SOLANA_FAILED' || err.name === 'SendTransactionError' || /simulation failed|insufficient funds|Blockhash not found/i.test(err.message);
      const status = submitted && signature && !definitelyFailed ? 'pending' : 'failed';
      state.lastError = err.code === 'MODULE_NOT_FOUND' ? 'Solana package is unavailable; install optional dependencies' : config.redact(err.message).split('\n')[0].slice(0, 200);
      state.lastTx = signature; state.lastStatus = status;
      console.warn(`[solana] ${state.lastError}`);
      return { hash, tx: signature, status, error: state.lastError, explorer: signature ? explorerUrl(signature) : null };
    }
  }
  // Verification reads public chain data only; no private wallet or secret key is needed.
  async function verifyReport(text, signature) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('A report is required to verify its fingerprint');
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) throw new Error('A valid Solana transaction signature is required');
    const reportHash = hashReport(text), connection = getConnection();
    return bounded(async signal => {
      await onDevnet(connection, signal);
      const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); signal.throwIfAborted();
      const status = !tx ? 'not found' : !tx.meta ? 'unavailable' : tx.meta.err ? 'failed' : 'confirmed';
      const memos = status === 'confirmed' ? (tx.transaction?.message?.instructions || []).filter(ix => (typeof ix.programId === 'string' ? ix.programId : ix.programId?.toBase58?.()) === MEMO_PROGRAM) : [];
      const hashes = memos.map(ix => typeof ix.parsed === 'string' ? ix.parsed : typeof ix.data === 'string' ? decode58(ix.data).toString('utf8') : null).filter(hash => /^[a-f0-9]{64}$/.test(hash || ''));
      const onChainHash = hashes.find(hash => hash === reportHash) || hashes[0] || null;
      return { matches: status === 'confirmed' && onChainHash === reportHash, status, onChainHash, reportHash, tx: signature, explorer: explorerUrl(signature) };
    });
  }
  return { stampReport, verifyReport, health: () => ({ ...state }) };
}
module.exports = { createSolana, hashReport, parseSecret, explorerUrl, DEVNET_GENESIS, MEMO_PROGRAM };
