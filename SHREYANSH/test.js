// test.js: smoke test for the AI + voice keys.
// Makes one tiny Gemini call and one ElevenLabs call, saves the audio to test.mp3,
// and prints OK or a clear error for each. Run from inside SHREYANSH/:  node test.js
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const config = require('./config');

// 1. Show which keys are present (set/missing only, never the values).
function printKeyStatus() {
  console.log('Key status:');
  for (const [name, isSet] of Object.entries(config.keyStatus())) {
    console.log(`  ${name.padEnd(20)} ${isSet ? 'set' : 'MISSING'}`);
  }
  console.log('');
}

// 2. Gemini: ask for a one-word reply.
async function testGemini() {
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing from SHREYANSH/.env');
  const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: config.GEMINI_MODEL,
    contents: 'Reply with exactly one word: OK',
    config: { httpOptions: { timeout: 10000 } } // give up after 10 seconds
  });
  const text = (response.text || '').trim();
  if (!text) throw new Error('Gemini answered, but the reply was empty');
  return `model ${config.GEMINI_MODEL} replied "${text.slice(0, 40)}"`;
}

// 3. ElevenLabs: turn one sentence into speech and save it as test.mp3.
async function testElevenLabs() {
  if (!config.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is missing from SHREYANSH/.env');
  if (!config.ELEVENLABS_VOICE_ID) throw new Error('ELEVENLABS_VOICE_ID is missing from SHREYANSH/.env');
  const client = new ElevenLabsClient({ apiKey: config.ELEVENLABS_API_KEY });
  const stream = await client.textToSpeech.convert(
    config.ELEVENLABS_VOICE_ID,
    {
      text: 'SkySentry voice test. Caution, flock of eight birds heading toward the runway.',
      modelId: 'eleven_flash_v2_5',
      outputFormat: 'mp3_22050_32'
    },
    { timeoutInSeconds: 10, maxRetries: 0 }
  );
  // The SDK returns a web stream; collect it into one Buffer.
  const audio = Buffer.from(await new Response(stream).arrayBuffer());
  if (audio.length === 0) throw new Error('ElevenLabs answered, but the audio was empty');
  const file = path.join(__dirname, 'test.mp3');
  fs.writeFileSync(file, audio);
  return `saved ${audio.length} bytes to SHREYANSH/test.mp3`;
}

// Runs one check and prints OK or FAILED with a short, key-free reason.
async function check(name, fn) {
  try {
    console.log(`OK      ${name}: ${await fn()}`);
    return true;
  } catch (err) {
    const status = err.statusCode || err.status || '';
    console.log(`FAILED  ${name}: ${status ? `HTTP ${status} ` : ''}${config.redact(err.message).slice(0, 300)}`);
    return false;
  }
}

async function main() {
  printKeyStatus();
  const geminiOk = await check('Gemini', testGemini);
  const voiceOk = await check('ElevenLabs', testElevenLabs);
  console.log('');
  console.log(geminiOk && voiceOk ? 'ALL OK' : 'SOME CHECKS FAILED (see above)');
  process.exitCode = geminiOk && voiceOk ? 0 : 1;
}

main();
