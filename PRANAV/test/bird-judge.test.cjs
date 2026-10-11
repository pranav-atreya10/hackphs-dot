// Gemini bird judge: verdict normalisation and the no-key fallback (no network calls).
const test = require('node:test');
const assert = require('node:assert');
delete process.env.GEMINI_API_KEY;
const { normalizeBirdVerdict, verifyBird, BIRD_RUBRIC } = require('../ai-voice/ai');

test('confident bird stays a bird', () => {
  const v = normalizeBirdVerdict({ verdict: 'bird', confidence: 0.93, object: 'gull', evidence: 'beak and flapping wings' }, 'm');
  assert.equal(v.verdict, 'bird'); assert.equal(v.isBird, true); assert.equal(v.source, 'gemini');
});

test('low confidence answers become uncertain instead of guessing', () => {
  assert.equal(normalizeBirdVerdict({ verdict: 'bird', confidence: 0.5 }, 'm').verdict, 'uncertain');
  assert.equal(normalizeBirdVerdict({ verdict: 'not_bird', confidence: 0.69 }, 'm').verdict, 'uncertain');
});

test('invalid verdicts and out-of-range confidence are clamped', () => {
  const v = normalizeBirdVerdict({ verdict: 'maybe', confidence: 7 }, 'm');
  assert.equal(v.verdict, 'uncertain'); assert.equal(v.confidence, 1); assert.equal(v.isBird, false);
  assert.equal(normalizeBirdVerdict(null, 'm').verdict, 'uncertain');
});

test('drone look-alike is a non-bird', () => {
  const v = normalizeBirdVerdict({ verdict: 'not_bird', confidence: 0.88, object: 'quadcopter drone' }, 'm');
  assert.equal(v.isBird, false); assert.equal(v.verdict, 'not_bird');
});

test('rubric names the main look-alikes', () => {
  for (const w of ['drone', 'airplane', 'insect', 'leaf', 'kite', 'lens flare']) assert.match(BIRD_RUBRIC, new RegExp(w));
});

test('without a Gemini key the judge says uncertain, never a made-up answer', async () => {
  const v = await verifyBird('data:image/jpeg;base64,AAAA');
  assert.equal(v.verdict, 'uncertain'); assert.equal(v.source, 'fallback'); assert.match(v.evidence, /not configured/);
});
