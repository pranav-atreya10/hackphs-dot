// new-wallet.js: creates a Solana DEVNET wallet for stamping reports and saves its secret key
// into SHREYANSH/.env as SOLANA_SECRET_KEY. Only the public address is printed.
// Run once, from inside SHREYANSH/:  node new-wallet.js
// It refuses to replace a wallet that is already there (it might hold test SOL) unless you add --force.
const fs = require('fs');
const path = require('path');
const web3 = require('@solana/web3.js');

const force = process.argv.includes('--force');
const envPath = process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(__dirname, '.env');

const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
const index = lines.findIndex(line => /^\s*SOLANA_SECRET_KEY\s*=/.test(line));

// Is there already a real 64-number key?
if (index !== -1 && !force) {
  let existing = [];
  try { existing = JSON.parse(lines[index].split('=').slice(1).join('=').trim()); } catch { /* not valid, ok to replace */ }
  if (Array.isArray(existing) && existing.length === 64) {
    console.log('A wallet is already saved in SOLANA_SECRET_KEY. Nothing changed.');
    console.log('Run "node check-wallet.js" to see it, or "node new-wallet.js --force" to replace it.');
    process.exit(0);
  }
}

const keypair = web3.Keypair.generate();
const newLine = `SOLANA_SECRET_KEY=${JSON.stringify(Array.from(keypair.secretKey))}`;
if (index === -1) lines.push(newLine);
else lines[index] = newLine;
fs.writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'));

console.log(`Saved a new devnet wallet to ${path.basename(envPath)} (secret key not shown).`);
console.log(`Wallet address: ${keypair.publicKey.toBase58()}`);
console.log('Next: get free test SOL at https://faucet.solana.com (choose devnet), then run: node check-wallet.js');
