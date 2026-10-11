// SHREYANSH's SHA-256 report memo, with bounded HTTP confirmation and actionable devnet failures.
const crypto = require('crypto');
const config = require('./config');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const hashReport = text => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const explorerUrl = tx => `https://explorer.solana.com/tx/${encodeURIComponent(tx)}?cluster=devnet`;
function parseSecret(secret) {
  let bytes;
  try { bytes = JSON.parse(secret); } catch { throw new Error('Solana key must be a JSON array of 64 bytes'); }
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error('Solana key must contain exactly 64 integers between 0 and 255');
  }
  return Uint8Array.from(bytes);
}
function createSolana({ settings = config, web3: suppliedWeb3, timeoutMs = 20000, pollMs = 800, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let conn, payer, web3;
  const state = { configured: Boolean(settings.SOLANA_SECRET_KEY), network: 'devnet', lastError: null, lastSuccess: null, wallet: null };
  function initialize() {
    if (!web3) web3 = suppliedWeb3 || require('@solana/web3.js');
    if (!payer) {
      payer = web3.Keypair.fromSecretKey(parseSecret(settings.SOLANA_SECRET_KEY));
      state.wallet = payer.publicKey.toBase58();
    }
    if (!conn) conn = new web3.Connection(settings.SOLANA_RPC_URL || 'https://api.devnet.solana.com', {
      commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(4000) }),
    });
    return { conn, payer };
  }
  // Each operation has a total deadline. Confirmation uses HTTP polling rather than fragile WebSockets.
  async function stampReport(text) {
    const hash = hashReport(text);
    if (!settings.SOLANA_SECRET_KEY) return { hash, tx: null, status: 'hash only', error: null };
    let signature = null, timer;
    const deadline = Date.now() + timeoutMs;
    try {
      if (!String(text).trim()) throw new Error('Cannot stamp an empty report');
      initialize();
      const work = (async () => {
        if (await conn.getGenesisHash() !== DEVNET_GENESIS) throw new Error('Solana RPC must connect to devnet');
        const balance = await conn.getBalance(payer.publicKey, 'confirmed');
        if (balance < 10000) throw new Error('Wallet needs devnet SOL for memo fees; fund the public wallet using the Solana faucet');
        const block = await conn.getLatestBlockhash('confirmed');
        const tx = new web3.Transaction({ feePayer: payer.publicKey, recentBlockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight });
        tx.add(new web3.TransactionInstruction({ programId: new web3.PublicKey(MEMO_PROGRAM), keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(hash, 'utf8') }));
        tx.sign(payer);
        if (Date.now() >= deadline) throw new Error('Solana deadline expired before submission');
        signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 1 });
        while (Date.now() < deadline) {
          const row = (await conn.getSignatureStatuses([signature])).value?.[0];
          if (row?.err) throw new Error('Solana rejected the memo transaction');
          if (row?.confirmationStatus === 'confirmed' || row?.confirmationStatus === 'finalized') return;
          if (await conn.getBlockHeight('confirmed') > block.lastValidBlockHeight) throw new Error('Solana transaction expired; try again');
          await sleep(pollMs);
        }
        throw new Error('Solana confirmation pending; check the transaction in the explorer');
      })();
      await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Solana confirmation timed out')), timeoutMs); })]);
      state.lastError = null; state.lastSuccess = new Date().toISOString();
      return { hash, tx: signature, status: 'confirmed', error: null, explorer: explorerUrl(signature) };
    } catch (err) {
      const missingPackage = err.code === 'MODULE_NOT_FOUND';
      state.lastError = missingPackage ? 'Solana package is unavailable; install optional dependencies' : config.redact(err.message).split('\n')[0].slice(0, 200);
      console.warn(`[solana] ${state.lastError}`);
      return { hash, tx: signature, status: signature ? 'pending' : 'failed', error: state.lastError, explorer: signature ? explorerUrl(signature) : null };
    } finally { clearTimeout(timer); }
  }
  async function verifyReport(text, signature) {
    initialize();
    const reportHash = hashReport(text);
    const tx = await conn.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const memo = tx?.transaction.message.instructions.find(ix => ix.programId.toBase58() === MEMO_PROGRAM);
    const onChainHash = typeof memo?.parsed === 'string' ? memo.parsed : null;
    return { matches: onChainHash === reportHash, onChainHash, reportHash };
  }
  return { stampReport, verifyReport, health: () => ({ ...state }) };
}
module.exports = { createSolana, hashReport, parseSecret, explorerUrl, DEVNET_GENESIS };
