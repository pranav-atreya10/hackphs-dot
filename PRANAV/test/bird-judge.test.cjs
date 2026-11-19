// Gemini bird judge: verdict normalisation and the no-key fallback (no network calls).
const test = require('node:test');
const assert = require('node:assert');
delete process.env.GEMINI_API_KEY;
process.env.GEMINI_CLOUD_EVIDENCE_ENABLED = 'true';
const { normalizeBirdVerdict, verifyBird, BIRD_RUBRIC } = require('../ai-voice/ai');

test('confident bird stays a bird', () => {
  const v = normalizeBirdVerdict({ verdict: 'bird', confidence: 0.93, object: 'gull', evidence: 'beak and flapping wings' }, 'm');
  assert.equal(v.verdict, 'bird'); assert.equal(v.isBird, true); assert.equal(v.source, 'gemini');
});

test('low confidence answers become uncertain instead of guessing', () => {
  for (const verdict of ['bird', 'not_bird']) {
    const v = normalizeBirdVerdict({ verdict, confidence: 0.69, object: '', evidence: '' }, 'm');
    assert.equal(v.status, 'verified'); assert.equal(v.verdict, 'uncertain'); assert.equal(v.isBird, null);
  }
});

test('invalid verdicts and out-of-range confidence are rejected', () => {
  for (const [verdict, confidence] of [['maybe', 0.8], ['bird', 7]]) {
    assert.throws(() => normalizeBirdVerdict({ verdict, confidence, object: '', evidence: '' }, 'm'), { reason: 'invalid_response' });
  }
});

test('drone look-alike is a non-bird', () => {
  const v = normalizeBirdVerdict({ verdict: 'not_bird', confidence: 0.88, object: 'quadcopter drone', evidence: 'Rotors' }, 'm');
  assert.equal(v.isBird, false); assert.equal(v.verdict, 'not_bird');
});

test('rubric names the main look-alikes', () => {
  for (const w of ['drone', 'airplane', 'insect', 'leaf', 'kite', 'lens flare']) assert.match(BIRD_RUBRIC, new RegExp(w));
});

test('without a Gemini key the judge is unavailable, not uncertain', async () => {
  const v = await verifyBird('data:image/jpeg;base64,AAAA');
  assert.equal(v.verdict, null); assert.equal(v.status, 'unavailable'); assert.equal(v.reason, 'not_configured');
});
