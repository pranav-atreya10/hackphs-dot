const test = require('node:test');
const assert = require('node:assert/strict');
const judge = require('../ai-voice/bird-judge');
const { BIRD_RUBRIC } = require('../ai-voice/ai');

test('one rubric for every model: ai.js uses the spec file', () => {
  assert.equal(BIRD_RUBRIC, judge.spec.rubric.join('\n'));
  assert.deepEqual(judge.GEMINI_SCHEMA.properties.verdict.enum, ['bird', 'not_bird', 'uncertain']);
  assert.deepEqual(judge.GEMINI_SCHEMA.propertyOrdering, ['verdict', 'confidence', 'object', 'evidence']);
});

test('local judge sends the rubric, the image and a JSON schema to an OpenAI-compatible server', async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"bird","confidence":0.92,"object":"gull","evidence":"beak and wings"}' } }] }));
  };
  const v = await judge.askLocalIsBird('AAAA', 'bird, 1 object(s)', { url: 'http://localhost:11434/v1/', model: 'qwen2.5vl:7b', fetchImpl });
  assert.equal(sent.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(sent.body.model, 'qwen2.5vl:7b');
  assert.equal(sent.body.temperature, 0);
  assert.equal(sent.body.messages[0].content, judge.BIRD_RUBRIC);
  assert.equal(sent.body.messages[1].content[0].image_url.url, 'data:image/jpeg;base64,AAAA');
  assert.match(sent.body.messages[1].content[1].text, /Detector context \(may be wrong\): bird, 1 object/);
  assert.deepEqual(sent.body.response_format.json_schema.schema, judge.spec.answer_schema);
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(v.verdict, 'bird'); assert.equal(v.source, 'local'); assert.equal(v.model, 'qwen2.5vl:7b');
});

test('local judge copes with chatty replies and still applies the confidence floor', async () => {
  const reply = (content) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  const fenced = await judge.askLocalIsBird('AAAA', '', { url: 'http://x/v1', model: 'm', fetchImpl: reply('Sure!\n```json\n{"verdict":"not_bird","confidence":0.9,"object":"drone","evidence":"rotors"}\n```') });
  assert.equal(fenced.verdict, 'not_bird');
  const unsure = await judge.askLocalIsBird('AAAA', '', { url: 'http://x/v1', model: 'm', fetchImpl: reply('{"verdict":"bird","confidence":0.4}') });
  assert.equal(unsure.verdict, 'uncertain');
});

test('local judge errors are thrown, not turned into a made-up answer', async () => {
  await assert.rejects(judge.askLocalIsBird('AAAA', '', { url: 'http://x/v1', model: 'm', fetchImpl: async () => new Response('busy', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(judge.askLocalIsBird('AAAA', '', { url: 'http://x/v1', model: 'm', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'no idea' } }] })) }), /no JSON/);
});
