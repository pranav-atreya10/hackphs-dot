// solana.js: tamper-proof stamp for drone incident reports (build plan prompt A3).
//
// How it works:
//   1. SHA-256 turns the report text into a 64-character fingerprint (hash). Change even one letter
//      of the report and the fingerprint becomes completely different.
//   2. We write that fingerprint to the Solana blockchain as a memo (Memo program). Once a transaction
//      is confirmed, nobody can change it, and it carries a timestamp.
//   3. Later, anyone can hash the stored report again and compare it with the memo on-chain.
//      Same hash = the report is exactly what was stamped. Different hash = it was edited.
// Devnet only: free test tokens, no real money.
const crypto = require('crypto');
const web3 = require('@solana/web3.js');
const config = require('./config');

const MEMO_PROGRAM_ID = new web3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DEVNET_URL = web3.clusterApiUrl('devnet');
const STAMP_TIMEOUT_MS = 20000; // give up if devnet hasn't confirmed by then

let connection = null;
let wallet = null;

// One shared connection to devnet.
function getConnection() {
  if (!connection) connection = new web3.Connection(DEVNET_URL, 'confirmed');
  return connection;
}

// The wallet that signs and pays for stamps, from SOLANA_SECRET_KEY (a JSON array of 64 numbers,
// the same format as a Solana CLI keypair file). Loaded once, on first use.
function loadWallet() {
  if (wallet) return wallet;
  if (!config.SOLANA_SECRET_KEY) throw new Error('SOLANA_SECRET_KEY is missing from SHREYANSH/.env');
  let bytes;
  try {
    bytes = JSON.parse(config.SOLANA_SECRET_KEY);
  } catch {
    throw new Error('SOLANA_SECRET_KEY is not a JSON array. It should look like [12,34,...] with 64 numbers.');
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`SOLANA_SECRET_KEY should be a JSON array of 64 numbers (found ${Array.isArray(bytes) ? bytes.length : 'not an array'}).`);
  }
  wallet = web3.Keypair.fromSecretKey(Uint8Array.from(bytes));
  return wallet;
}

// SHA-256 fingerprint of the report, as 64 hex characters.
function hashReport(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Rejects after `ms` milliseconds, so a slow devnet can never hang the pipeline.
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Writes the SHA-256 hash of the report to Solana devnet as a memo.
 * Throws with a clear message on failure (the pipeline catches it and carries on without a stamp).
 * @param {string} text  the report text
 * @returns {Promise<string>}  the transaction signature
 */
async function stampReport(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to stamp (empty report)');
  const payer = loadWallet();
  const memo = hashReport(text);

  const instruction = new web3.TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], // the wallet signs the memo
    data: Buffer.from(memo, 'utf8')
  });
  const transaction = new web3.Transaction().add(instruction);

  try {
    return await withTimeout(
      web3.sendAndConfirmTransaction(getConnection(), transaction, [payer], { commitment: 'confirmed' }),
      STAMP_TIMEOUT_MS,
      'Solana devnet'
    );
  } catch (err) {
    if (/no record of a prior credit|insufficient/i.test(err.message)) {
      throw new Error('the wallet has no devnet SOL to pay the fee. Run: node check-wallet.js');
    }
    throw new Error(config.redact(err.message).split('\n')[0]);
  }
}

// Link to the transaction on the public Solana explorer (devnet).
function explorerUrl(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/**
 * Checks a report against its stamp: reads the memo back from the blockchain and compares hashes.
 * @returns {Promise<{matches: boolean, onChainHash: string|null, reportHash: string}>}
 */
async function verifyReport(text, signature) {
  const reportHash = hashReport(text);
  const tx = await getConnection().getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const memoInstruction = tx && tx.transaction.message.instructions.find(ix => ix.programId.equals(MEMO_PROGRAM_ID));
  const onChainHash = memoInstruction && typeof memoInstruction.parsed === 'string' ? memoInstruction.parsed : null;
  return { matches: onChainHash === reportHash, onChainHash, reportHash };
}

module.exports = { stampReport, explorerUrl, hashReport, verifyReport, loadWallet, getConnection };
