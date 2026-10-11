// test-ai.js: runs analyzeEvent on a fake red bird event, first with a snapshot (Gemini path),
// then without one (fallback path).
// Usage, from inside SHREYANSH/:  node test-ai.js [path/to/photo.jpg]
// Default image: fixtures/sky-birds.jpg (eight drawn birds over a runway).
const fs = require('fs');
const path = require('path');
const { analyzeEvent } = require('./ai');

const imagePath = process.argv[2] || path.join(__dirname, 'fixtures', 'sky-birds.jpg');
// Keep the data-URL prefix on purpose, to prove analyzeEvent strips it.
const snapshot = 'data:image/jpeg;base64,' + fs.readFileSync(imagePath).toString('base64');

const fakeRedBirdEvent = {
  camera_id: 'runway-east',
  type: 'bird',
  object_count: 8,
  direction: 'toward runway',
  confidence: 0.82,
  risk: 'red',
  time: new Date().toISOString(),
  snapshot
};

const countSentences = text => (text.match(/[^.!?]+[.!?]+/g) || []).length;

async function run(name, event, expectedSource) {
  const started = Date.now();
  const result = await analyzeEvent(event);
  const ok = result.source === expectedSource && Boolean(result.label) && Boolean(result.report);
  const via = result.model ? `, model: ${result.model}` : '';
  console.log(`${ok ? 'OK    ' : 'FAILED'}  ${name}  (${Date.now() - started} ms, source: ${result.source}${via})`);
  console.log(`        label:  ${result.label}`);
  console.log(`        report: ${result.report}`);
  console.log(`        sentences: ${countSentences(result.report)}`);
  console.log('');
  return ok;
}

async function main() {
  console.log(`Snapshot: ${path.relative(__dirname, imagePath)}\n`);
  const withImage = await run('red bird event WITH snapshot (Gemini)', fakeRedBirdEvent, 'gemini');
  const noImage = await run('red bird event WITHOUT snapshot (fallback)', { ...fakeRedBirdEvent, snapshot: null }, 'fallback');
  console.log(withImage && noImage ? 'ALL OK' : 'SOME CHECKS FAILED (see above)');
  process.exitCode = withImage && noImage ? 0 : 1;
}

main();
