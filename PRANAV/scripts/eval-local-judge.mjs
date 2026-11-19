// How often does a local model agree with the teacher (Gemini) on the held-out test split?
//
//   node scripts/eval-local-judge.mjs judge-dataset [--url http://localhost:11434/v1] [--model qwen2.5vl:7b]
//
// Sends each test image with the exact same rubric (bird-judge.spec.json) and prints agreement per label,
// how often it said "bird" when the teacher said "not_bird" (the dangerous direction is the reverse:
// "not_bird" for a real bird), and how often it gave up ("uncertain").
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const judge = require('../ai-voice/bird-judge');

const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || 'judge-dataset');
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const url = opt('url', process.env.LOCAL_JUDGE_URL || 'http://localhost:11434/v1');
const model = opt('model', process.env.LOCAL_JUDGE_MODEL || 'qwen2.5vl:7b');

const rows = readFileSync(join(dir, 'test.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const tally = {};
let n = 0, agree = 0, missedBirds = 0, falseBirds = 0, unsure = 0, failed = 0;
for (const r of rows) {
  const teacher = JSON.parse(r.messages[2].content).verdict;
  const image = readFileSync(join(dir, r.images[0])).toString('base64');
  const hint = r.messages[1].content.replace('<image>', '').replace(judge.spec.hint_prefix, '');
  let got;
  try { got = (await judge.askLocalIsBird(image, hint.startsWith('Classify') ? '' : hint, { url, model, timeoutMs: 60000 })).verdict; }
  catch (err) { failed++; console.warn(`${r.images[0]}: ${err.message}`); continue; }
  n++;
  const t = (tally[teacher] ||= { n: 0, agree: 0 }); t.n++;
  if (got === teacher) { agree++; t.agree++; }
  if (got === 'uncertain') unsure++;
  if (teacher === 'bird' && got === 'not_bird') missedBirds++;
  if (teacher === 'not_bird' && got === 'bird') falseBirds++;
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
console.log(`model ${model}: ${n} answered, ${failed} failed`);
console.log(`agreement with teacher: ${pct(agree, n)}`);
for (const [k, t] of Object.entries(tally)) console.log(`  teacher "${k}": ${pct(t.agree, t.n)} of ${t.n}`);
console.log(`real birds called not_bird (dangerous): ${missedBirds}   not_birds called bird: ${falseBirds}   uncertain: ${pct(unsure, n)}`);
