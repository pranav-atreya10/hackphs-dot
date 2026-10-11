// test-solana.js: stamps a sample drone report on Solana devnet, then proves the stamp works:
//   1. the original report matches the hash stored on-chain
//   2. an edited copy of the report does NOT match
// Needs a funded devnet wallet (node check-wallet.js). Run from inside SHREYANSH/:  node test-solana.js
const { stampReport, explorerUrl, hashReport, verifyReport } = require('./solana');

const report = 'At 4:32 PM, the microphone at camera runway-east detected a drone near the runway. ' +
  'Detector confidence was 91 percent and the risk level is red. ' +
  'The snapshot does not show the drone, which matches an audio-only detection.';
const edited = report.replace('4:32 PM', '4:52 PM'); // someone quietly changes the time

let failures = 0;
const check = (ok, what) => { if (!ok) failures++; console.log(`${ok ? 'OK    ' : 'FAILED'}  ${what}`); };

async function main() {
  console.log(`Report hash (SHA-256): ${hashReport(report)}\n`);

  let signature;
  const started = Date.now();
  try {
    signature = await stampReport(report);
  } catch (err) {
    check(false, `stamp: ${err.message}`);
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
    return;
  }
  check(true, `stamped in ${Date.now() - started} ms`);
  console.log(`        ${explorerUrl(signature)}`);

  const original = await verifyReport(report, signature);
  check(original.matches, `original report matches the on-chain hash (${original.onChainHash})`);

  const tampered = await verifyReport(edited, signature);
  check(!tampered.matches, `edited report (4:32 changed to 4:52) does NOT match: its hash is ${tampered.reportHash.slice(0, 16)}...`);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL OK');
  process.exitCode = failures ? 1 : 0;
}

main();
