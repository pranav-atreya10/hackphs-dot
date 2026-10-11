// check-wallet.js: shows the Solana devnet wallet that pays for report stamps, and its balance.
// The address is public and safe to share; the secret key is never printed.
// Run from inside SHREYANSH/:  node check-wallet.js
const web3 = require('@solana/web3.js');
const { loadWallet, getConnection } = require('./solana');

const MIN_SOL = 0.01; // one stamp costs about 0.000005 SOL, so this covers about 2,000 stamps

async function main() {
  let wallet;
  try {
    wallet = loadWallet();
  } catch (err) {
    console.log(`FAILED  ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const address = wallet.publicKey.toBase58();
  console.log(`Wallet address (devnet): ${address}`);

  try {
    const lamports = await getConnection().getBalance(wallet.publicKey);
    const sol = lamports / web3.LAMPORTS_PER_SOL;
    console.log(`Devnet balance:          ${sol} SOL`);
    if (sol < MIN_SOL) {
      console.log('');
      console.log(`LOW     Below ${MIN_SOL} SOL. Get free test SOL:`);
      console.log('        1. Open https://faucet.solana.com');
      console.log('        2. Choose "devnet" and paste the wallet address above');
      console.log('        3. Request 1 SOL, then run this again');
      process.exitCode = 1;
    } else {
      console.log(`OK      Enough for about ${Math.floor(sol / 0.000005).toLocaleString('en-US')} stamps`);
    }
  } catch (err) {
    console.log(`FAILED  could not reach Solana devnet: ${err.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

main();
