// Tamper-proof stamp for drone reports (prompt A3): hash the report and write the hash to
// Solana devnet with the Memo program. Devnet uses free test tokens; no real money is involved.
import { createHash } from 'node:crypto';
import { config } from './config.js';

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export const hashReport = report => createHash('sha256').update(report).digest('hex');

/** @returns {Promise<{hash:string, tx:string|null, explorer:string|null}>} */
export async function stampReport(report, incidentId) {
  const hash = hashReport(report);
  if (!config.solanaSecret) return { hash, tx: null, explorer: null };
  try {
    const web3 = await import('@solana/web3.js');
    const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(config.solanaSecret)));
    const conn = new web3.Connection(config.solanaRpc, 'confirmed');
    const ix = new web3.TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      programId: new web3.PublicKey(MEMO_PROGRAM),
      data: Buffer.from(`skysentry:${incidentId}:${hash}`, 'utf8')
    });
    const tx = await web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(ix), [payer]);
    return { hash, tx, explorer: `https://explorer.solana.com/tx/${tx}?cluster=devnet` };
  } catch (err) {
    console.warn('[solana] stamp failed:', err.message);
    return { hash, tx: null, explorer: null };
  }
}
