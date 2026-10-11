// test-pipeline.js: runs handleEvent with a fake tower that records every message and when it arrived.
// No server needed. Run from inside SHREYANSH/:
//   node test-pipeline.js            real APIs
//   node test-pipeline.js --offline  fake (invalid) keys, to prove the tower still gets an alert when APIs fail
const fs = require('fs');
const path = require('path');

const OFFLINE = process.argv.includes('--offline');
if (OFFLINE) {
  // Must be set before config.js loads; config never overrides variables that are already set.
  process.env.GEMINI_API_KEY = 'invalid-gemini-key-for-test';
  process.env.ELEVENLABS_API_KEY = 'sk_invalid_elevenlabs_key_for_test';
}
const { handleEvent } = require('./pipeline');

const snapshot = fs.readFileSync(path.join(__dirname, 'fixtures', 'sky-birds.jpg')).toString('base64');
let failures = 0;
const check = (ok, what) => { if (!ok) failures++; console.log(`  ${ok ? 'OK    ' : 'FAILED'}  ${what}`); };

// A stand-in for io.of('/tower'): records each emit with its time since the event was handled.
function fakeTower() {
  const start = Date.now();
  const messages = [];
  return { messages, emit: (name, payload) => messages.push({ ms: Date.now() - start, name, payload }) };
}

// Short, readable version of a message (audio is too long to print).
function show(m) {
  const p = { ...m.payload };
  if (p.audio) p.audio = `<${Buffer.from(p.audio, 'base64').length} byte mp3>`;
  if (p.report) p.report = p.report.slice(0, 70) + '...';
  const fields = Object.entries(p).filter(([k, v]) => k !== 'id' && v !== null).map(([k, v]) => `${k}: ${v}`).join(', ');
  return `+${String(m.ms).padStart(5)} ms  ${m.name.padEnd(12)} ${fields}`;
}

async function run(name, event, expect) {
  console.log(`\n=== ${name} ===`);
  const tower = fakeTower();
  let saved = null;
  const result = await handleEvent(event, tower, { onDone: r => { saved = r; } });
  tower.messages.forEach(m => console.log('  ' + show(m)));

  if (!expect.alert) {
    check(result === null && tower.messages.length === 0, 'no alert and nothing sent to the tower');
    return;
  }
  const [first, ...updates] = tower.messages;
  const all = tower.messages.map(m => m.payload);
  check(first && first.name === 'alert' && first.ms < 50, `"alert" sent first, immediately (+${first ? first.ms : '?'} ms)`);
  check(first && first.payload.text && first.payload.audio === null && first.payload.report === null, 'alert has template text; audio/report start as null');
  check(all.every(p => p.id === first.payload.id), `same id on every message (${first.payload.id.slice(0, 8)})`);

  const audio = updates.find(m => 'audio' in m.payload);
  if (expect.spoken === 'audio') check(audio && audio.payload.audio, 'ElevenLabs audio arrived in an alert_update');
  if (expect.spoken === 'failed') check(audio && audio.payload.audio_failed === true, 'audio_failed sent, so the tower can use its own voice');
  if (expect.spoken === 'no') check(!audio, 'not spoken (yellow alerts are on-screen only)');

  const report = updates.find(m => 'report' in m.payload);
  check(report && report.payload.label && report.payload.report, `label and report arrived (source: ${report ? report.payload.report_source : '?'})`);
  check(saved && saved.id === first.payload.id && saved.report, 'onDone got the result for MongoDB');
}

async function main() {
  console.log(OFFLINE ? 'Mode: OFFLINE (invalid keys; every API should fail gracefully)' : 'Mode: real APIs');
  const base = { camera_id: 'runway-east', confidence: 0.85, time: new Date().toISOString(), snapshot };
  const spoken = OFFLINE ? 'failed' : 'audio';

  await run('green event', { ...base, type: 'bird', object_count: 0, direction: 'unknown', risk: 'green', snapshot: undefined }, { alert: false });
  await run('yellow: 3 birds crossing', { ...base, id: 'test-yellow-1', type: 'bird', object_count: 3, direction: 'crossing', risk: 'yellow' }, { alert: true, spoken: 'no' });
  await run('red: 8 birds toward runway (risk went up, so not rate-limited)', { ...base, id: 'test-red-1', type: 'bird', object_count: 8, direction: 'toward runway', risk: 'red' }, { alert: true, spoken });
  await run('red again 1 second later (rate-limited)', { ...base, id: 'test-red-2', type: 'bird', object_count: 8, direction: 'toward runway', risk: 'red' }, { alert: false });
  await run('drone (Solana stamp appears once the devnet wallet has SOL)', { ...base, id: 'test-drone-1', type: 'drone', object_count: 1, direction: 'unknown', risk: 'red' }, { alert: true, spoken });

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL OK');
  process.exitCode = failures ? 1 : 0;
}

main();
