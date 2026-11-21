// Bird judge: model-independent parts (rubric, answer format, confidence floor) plus the local-model provider.
// Everything that defines the judge lives in bird-judge.spec.json, so Gemini and a local/open model get identical
// instructions. Which one runs is one setting: BIRD_JUDGE=gemini (default) | local | off.
//
// "local" talks to any OpenAI-compatible chat endpoint with image support, which is what Ollama, LM Studio,
// llama.cpp's server and vLLM all expose, e.g. LOCAL_JUDGE_URL=http://localhost:11434/v1 LOCAL_JUDGE_MODEL=qwen2.5vl:7b
const spec = require('./bird-judge.spec.json');

const BIRD_RUBRIC = spec.rubric.join('\n');
const BIRD_CONFIDENCE_FLOOR = spec.confidence_floor;

// Gemini's responseSchema dialect: upper-case types, no additionalProperties, explicit property order.
function toGeminiSchema(s) {
  if (s.type === 'object') {
    const props = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    return { type: 'OBJECT', properties: props, required: s.required, propertyOrdering: Object.keys(s.properties) };
  }
  const out = { type: s.type.toUpperCase() };
  if (s.enum) out.enum = s.enum;
  if (s.description) out.description = s.description;
  return out;
}
const GEMINI_SCHEMA = toGeminiSchema(spec.answer_schema);

// The detector's one-line hint, appended to the user turn (the model may overrule it).
const hintText = (context) => (context ? `${spec.hint_prefix}${String(context).slice(0, 200)}` : '');

// Check any model's answer strictly (wrong shape = invalid_response error, so it is never mistaken for a verdict),
// then treat a low-confidence yes/no as "uncertain". Same rules for Gemini and local models.
function normalizeBirdVerdict(parsed, model, source = 'gemini') {
  if (!spec.labels.includes(parsed?.verdict) || !Number.isFinite(parsed.confidence)
      || parsed.confidence < 0 || parsed.confidence > 1 || typeof parsed.object !== 'string'
      || typeof parsed.evidence !== 'string') {
    throw Object.assign(new Error('The model did not return a usable result.'), { reason: 'invalid_response' });
  }
  let verdict = parsed.verdict;
  const confidence = parsed.confidence;
  if (verdict !== 'uncertain' && confidence < BIRD_CONFIDENCE_FLOOR) verdict = 'uncertain';
  return {
    status: 'verified', verdict, isBird: verdict === 'uncertain' ? null : verdict === 'bird', confidence,
    object: parsed.object.trim().slice(0, 80), evidence: parsed.evidence.trim().slice(0, 200),
    source, model,
  };
}

// Small local models sometimes wrap the JSON in prose or ``` fences; take the first {...} block.
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('reply contained no JSON');
  return JSON.parse(m[0]);
}

// The chat messages for an OpenAI-compatible model. The fine-tuning export uses this exact layout.
function localMessages(image, context) {
  const hint = hintText(context);
  return [
    { role: 'system', content: BIRD_RUBRIC },
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
      { type: 'text', text: hint || 'Classify the object in this image.' },
    ] },
  ];
}

const localState = { lastError: null, lastErrorAt: 0, lastSuccessAt: 0 };

// Ask a local/open model. Throws on failure (the caller turns that into "uncertain").
async function askLocalIsBird(image, context, { url, model, key, timeoutMs = 10000, fetchImpl = (...a) => fetch(...a) }) {
  const res = await fetchImpl(`${url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model, messages: localMessages(image, context),
      temperature: spec.sampling.temperature, top_p: spec.sampling.top_p,
      response_format: { type: 'json_schema', json_schema: { name: 'bird_verdict', schema: spec.answer_schema, strict: true } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('local model returned no text');
  return normalizeBirdVerdict(parseJsonLoose(text), model, 'local');
}

module.exports = { spec, BIRD_RUBRIC, BIRD_CONFIDENCE_FLOOR, GEMINI_SCHEMA, hintText, normalizeBirdVerdict, parseJsonLoose, localMessages, askLocalIsBird, localState };
