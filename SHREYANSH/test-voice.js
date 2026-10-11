// test-voice.js: checks voice.js. Run from inside SHREYANSH/:  node test-voice.js
// 1. buildAlertText gives the expected sentences
// 2. shouldAlert rate-limits correctly (time is simulated, so no waiting)
// 3. speak returns ElevenLabs audio, and the second identical request comes from the cache
const fs = require('fs');
const path = require('path');
const { buildAlertText, speak, shouldAlert } = require('./voice');

let failures = 0;
function expect(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'OK    ' : 'FAILED'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`);
}

async function main() {
  console.log('--- buildAlertText ---');
  expect('red flock toward runway', buildAlertText({ type: 'bird', object_count: 8, direction: 'toward runway', risk: 'red' }),
    'Caution, flock of eight birds heading toward the runway.');
  expect('red single bird', buildAlertText({ type: 'bird', object_count: 1, direction: 'toward runway', risk: 'red' }),
    'Caution, one bird heading toward the runway.');
  expect('yellow three crossing', buildAlertText({ type: 'bird', object_count: 3, direction: 'crossing', risk: 'yellow' }),
    'Advisory, three birds crossing near the runway.');
  expect('red 23 birds, no digits', buildAlertText({ type: 'bird', object_count: 23, direction: 'unknown', risk: 'red' }),
    'Caution, flock of twenty three birds near the runway.');
  expect('drone', buildAlertText({ type: 'drone', object_count: 1, direction: 'unknown', risk: 'red' }),
    'Warning, drone detected near the runway.');

  console.log('\n--- shouldAlert (simulated seconds) ---');
  expect('0s  bird red   -> first alert', shouldAlert('bird', 'red', 0), true);
  expect('2s  bird red   -> blocked, within 12 s', shouldAlert('bird', 'red', 2000), false);
  expect('2s  drone red  -> allowed, different type', shouldAlert('drone', 'red', 2000), true);
  expect('12s bird red   -> allowed, 12 s passed', shouldAlert('bird', 'red', 12000), true);
  expect('30s bird yellow-> allowed, cooled down', shouldAlert('bird', 'yellow', 30000), true);
  expect('31s bird red   -> allowed, risk went up', shouldAlert('bird', 'red', 31000), true);
  expect('33s bird red   -> blocked, within 12 s', shouldAlert('bird', 'red', 33000), false);

  console.log('\n--- speak (ElevenLabs) ---');
  const text = buildAlertText({ type: 'bird', object_count: 8, direction: 'toward runway', risk: 'red' });
  let t = Date.now();
  const first = await speak(text);
  const firstMs = Date.now() - t;
  t = Date.now();
  const second = await speak(text);
  const secondMs = Date.now() - t;

  if (first) {
    fs.writeFileSync(path.join(__dirname, 'test.mp3'), Buffer.from(first, 'base64'));
    console.log(`OK      first call: ${Buffer.from(first, 'base64').length} bytes in ${firstMs} ms, saved to SHREYANSH/test.mp3`);
  } else {
    failures++;
    console.log('FAILED  first call returned null (see the [voice] warning above)');
  }
  expect(`second call is the cached clip (${secondMs} ms)`, Boolean(first) && second === first && secondMs < 50, true);
  expect('empty text returns null', await speak(''), null);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL OK');
  process.exitCode = failures ? 1 : 0;
}

main();
