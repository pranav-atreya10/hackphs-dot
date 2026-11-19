// Export the bird judge's confident answers as a fine-tuning dataset for a local/open vision model.
//
//   MONGODB_URI=... node scripts/export-judge-dataset.mjs [out-dir]        (default: judge-dataset/)
//
// Sources: incidents whose bird_verdict was confident (with the incident snapshot), and bird_verdicts saved
// with their crop (SAVE_JUDGE_IMAGES=on). Only answers from a real model (not "fallback") and not "uncertain".
// Output, in the chat layout local models use (system = rubric, user = image + hint, assistant = JSON answer):
//   images/<id>.jpg
//   train.jsonl, test.jsonl   {"messages":[...], "images":["images/<id>.jpg"]}   (LLaMA-Factory / ShareGPT style;
//                             "<image>" marks where the picture goes). The newest 10% is test (split by time).
//   manifest.json             counts, label balance, the spec version, and a SHA-256 for every image.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
try { require('dotenv').config({ path: resolve(import.meta.dirname, '../.env') }); } catch {}
const { MongoClient } = require('mongodb');
const judge = require('../ai-voice/bird-judge');

const out = resolve(process.argv[2] || 'judge-dataset');
if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI (PRANAV/.env works too).'); process.exit(1); }

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
await client.connect();
const db = client.db('skysentry');
const confident = { $nin: ['uncertain'] };
const fromIncidents = await db.collection('incidents').find(
  { 'bird_verdict.verdict': confident, 'bird_verdict.source': { $ne: 'fallback' }, snapshot: { $type: 'string' } },
  { projection: { snapshot: 1, time: 1, type: 1, object_count: 1, direction: 1, bird_verdict: 1 } }).toArray();
const fromChecks = await db.collection('bird_verdicts').find(
  { verdict: confident, source: { $ne: 'fallback' }, image: { $type: 'string' } }).toArray();
await client.close();

const rows = [
  ...fromIncidents.map((d) => ({ id: `inc-${d._id}`, time: new Date(d.time), image: d.snapshot, v: d.bird_verdict,
    hint: `${d.type}, ${d.object_count} object(s), ${d.direction}` })),
  ...fromChecks.map((d) => ({ id: `chk-${d._id}`, time: new Date(d.time), image: d.image, v: d, hint: '' })),
].sort((a, b) => a.time - b.time);

mkdirSync(join(out, 'images'), { recursive: true });
const hashes = {};
const lines = rows.map((r) => {
  const bytes = Buffer.from(String(r.image).replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64');
  const file = `images/${r.id}.jpg`;
  writeFileSync(join(out, file), bytes);
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
  const hint = judge.hintText(r.hint);
  const answer = { verdict: r.v.verdict, confidence: Math.round(r.v.confidence * 100) / 100, object: r.v.object || '', evidence: r.v.evidence || '' };
  return { label: r.v.verdict, json: JSON.stringify({ messages: [
    { role: 'system', content: judge.BIRD_RUBRIC },
    { role: 'user', content: `<image>${hint || 'Classify the object in this image.'}` },
    { role: 'assistant', content: JSON.stringify(answer) },
  ], images: [file], teacher: r.v.model || r.v.source }) };
});
const cut = Math.floor(lines.length * 0.9);
writeFileSync(join(out, 'train.jsonl'), lines.slice(0, cut).map((l) => l.json).join('\n') + (cut ? '\n' : ''));
writeFileSync(join(out, 'test.jsonl'), lines.slice(cut).map((l) => l.json).join('\n') + (lines.length > cut ? '\n' : ''));
const count = (ls) => ls.reduce((m, l) => ({ ...m, [l.label]: (m[l.label] || 0) + 1 }), {});
const manifest = { created: new Date().toISOString(), spec: { name: judge.spec.name, version: judge.spec.version },
  examples: lines.length, train: count(lines.slice(0, cut)), test: count(lines.slice(cut)), split: 'by time, newest 10% = test', images: hashes };
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`${lines.length} examples (${cut} train, ${lines.length - cut} test) -> ${out}`, manifest.train, manifest.test);
if (lines.length < 200) console.log('Tip: a few hundred examples per label is a sensible minimum before fine-tuning.');
