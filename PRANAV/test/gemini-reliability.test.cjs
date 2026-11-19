const assert = require('node:assert/strict');
const { test } = require('node:test');

const configPath = require.resolve('../ai-voice/config');
const aiPath = require.resolve('../ai-voice/ai');
const fakeSettings = { GEMINI_API_KEY: 'synthetic-test-key', GEMINI_MODEL: 'main',
  GEMINI_BACKUP_MODEL: 'backup', AIRPORT_NAME: 'Test airport', AIRPORT_TIMEZONE: 'UTC', redact: message => message };
const fakeImage = 'AA=='; // synthetic bytes; not a photograph
const valid = { verdict: 'bird', confidence: 0.9, object: 'shape', evidence: 'Two wings.' };
const ok = value => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] }));
const error = status => new Response(JSON.stringify({ error: { message: 'never expose this' } }), { status });
const event = { id: 'test-incident', type: 'bird', object_count: 1, direction: 'crossing', risk: 'yellow', confidence: 0.75, snapshot: fakeImage };

function setup(t, { optIn, settings, responses = [] } = {}) {
  const originalPolicy = process.env.GEMINI_CLOUD_EVIDENCE_ENABLED;
  const originalConfig = require.cache[configPath];
  if (optIn === undefined) delete process.env.GEMINI_CLOUD_EVIDENCE_ENABLED;
  else process.env.GEMINI_CLOUD_EVIDENCE_ENABLED = optIn;
  require.cache[configPath] = { exports: { ...fakeSettings, ...settings } };
  delete require.cache[aiPath];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    const response = responses.shift();
    assert.ok(response, 'unexpected Gemini call');
    if (response instanceof Error) throw response;
    return response;
  });
  t.after(() => {
    if (originalPolicy === undefined) delete process.env.GEMINI_CLOUD_EVIDENCE_ENABLED;
    else process.env.GEMINI_CLOUD_EVIDENCE_ENABLED = originalPolicy;
    if (originalConfig) require.cache[configPath] = originalConfig;
    else delete require.cache[configPath];
    delete require.cache[aiPath];
  });
  return { ai: require('../ai-voice/ai'), calls };
}

test('default policy blocks both image paths but Gemini text still works', async t => {
  const { ai, calls } = setup(t, { responses: [ok('Synthetic answer.')] });
  const check = await ai.verifyBird(fakeImage);
  assert.deepEqual([check.status, check.reason, check.verdict], ['unavailable', 'policy_disabled', null]);
  const report = await ai.analyzeEvent(event);
  assert.equal(report.source, 'fallback');
  assert.equal(report.bird_verdict.reason, 'policy_disabled');
  assert.equal(calls.length, 0);
  await ai.answerQuestion('How many birds?', [{ hour: new Date(), type: 'bird', events: 1, total_objects: 1 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.body.includes('inlineData'), false);
});

test('auth and quota failures do not retry and expose safe diagnostics', async t => {
  const invalidKey = new Response(JSON.stringify({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }), { status: 400 });
  const { ai, calls } = setup(t, { optIn: 'true', responses: [error(401), error(429), invalidKey] });
  for (const [status, reason, count] of [[401, 'auth', 1], [429, 'quota', 2], [400, 'auth', 3]]) {
    const result = await ai.verifyBird(fakeImage);
    assert.deepEqual([result.status, result.reason, result.verdict, result.confidence], ['unavailable', reason, null, null]);
    assert.equal(ai.geminiState.lastFailure.httpStatus, status);
    assert.equal(ai.geminiState.lastFailure.reason, reason);
    assert.doesNotMatch(ai.geminiState.lastError, /never expose this/);
    assert.equal(calls.length, count);
  }
});

test('timeout retries a backup, and a verified uncertain verdict still counts as a provider success', async t => {
  const timeout = new DOMException('test timeout', 'TimeoutError');
  const { ai, calls } = setup(t, { optIn: 'true', responses: [timeout, ok({ ...valid, confidence: 0.3 })] });
  const result = await ai.verifyBird(fakeImage);
  assert.deepEqual([result.status, result.verdict, result.isBird, result.confidence], ['verified', 'uncertain', null, 0.3]);
  assert.match(calls[0].url, /\/main:generateContent$/);
  assert.match(calls[1].url, /\/backup:generateContent$/);
  assert.equal(ai.geminiState.lastFailure, null);
  assert.ok(ai.geminiState.lastSuccessAt);
});

test('no key, invalid model output and exhausted timeouts have no bird verdict', async t => {
  await t.test('missing key', async t => {
    const { ai, calls } = setup(t, { optIn: 'true', settings: { GEMINI_API_KEY: '' } });
    assert.equal((await ai.verifyBird(fakeImage)).reason, 'not_configured');
    assert.equal(calls.length, 0);
  });
  await t.test('invalid output then exhausted timeout', async t => {
    const timeout = new DOMException('test timeout', 'TimeoutError');
    const { ai, calls } = setup(t, { optIn: 'true', responses: [ok({ ...valid, verdict: 'maybe' }), timeout, timeout] });
    assert.equal((await ai.verifyBird(fakeImage)).reason, 'invalid_response');
    assert.equal(calls.length, 1);
    assert.equal((await ai.verifyBird(fakeImage)).reason, 'timeout');
    assert.equal(calls.length, 3);
  });
});

test('a bird report uses detector text and sends the image only to the separate advisory judge', async t => {
  const { ai, calls } = setup(t, { optIn: 'true', responses: [ok(valid)] });
  const { createPipeline } = require('../ai-voice/pipeline');
  const pipeline = createPipeline({ analyzeEvent: ai.analyzeEvent, solana: {}, shouldAlert: () => true });
  const events = [], saved = [];
  await pipeline.processIncident(event, {
    allowImageReview: true, save: fields => saved.push(fields), emit: (name, data) => events.push([name, data]),
  });
  assert.equal(saved[0]?.bird_verdict?.verdict, 'bird');
  assert.equal(saved[0]?.bird_verdict?.status, 'verified');
  assert.equal(saved[0]?.report_source, 'fallback');
  assert.equal(calls.length, 1);
  const [request] = calls;
  const body = JSON.parse(request.opts.body);
  assert.equal(body.contents[0].parts.filter(part => part.inlineData?.data === fakeImage).length, 1);
  assert.ok(body.generationConfig.responseSchema.properties.verdict);
  assert.deepEqual(events.filter(([name]) => name === 'incident').at(-1)?.[1]?.bird_verdict, saved[0].bird_verdict);
});
