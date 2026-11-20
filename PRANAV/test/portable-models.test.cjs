// Portable model files stay in step with the code that uses them (see MODELS.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const det = path.join(__dirname, '../public/detection');

test('engine_config.json matches config.js and params.js (rerun tools/export-config.mjs if this fails)', async () => {
  const saved = JSON.parse(fs.readFileSync(path.join(det, 'models/engine_config.json'), 'utf8'));
  const { DEFAULTS } = await import(pathToFileURL(path.join(det, 'src/config.js')));
  const { PRESETS, PARAMS } = await import(pathToFileURL(path.join(det, 'src/params.js')));
  assert.deepEqual(saved.defaults, JSON.parse(JSON.stringify(DEFAULTS)));
  assert.deepEqual(saved.presets, JSON.parse(JSON.stringify(PRESETS)));
  assert.deepEqual(saved.registry.map((p) => p.path), PARAMS.map((p) => p.path));
});

test('every ONNX model matches the checksums in its model card', () => {
  const cards = fs.readdirSync(path.join(det, 'models')).filter((f) => f.endsWith('.card.json'));
  assert.ok(cards.length >= 1);
  for (const c of cards) {
    const card = JSON.parse(fs.readFileSync(path.join(det, 'models', c), 'utf8'));
    for (const [k, file] of [['onnx_sha256', card.files.onnx], ['json_sha256', card.files.json]]) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(det, 'models', file))).digest('hex');
      assert.equal(hash, card.files[k], `${c}: ${file} changed since the card was written`);
    }
  }
});

test('bird-judge spec is complete', () => {
  const spec = require('../ai-voice/bird-judge.spec.json');
  assert.deepEqual(spec.labels, spec.answer_schema.properties.verdict.enum);
  assert.ok(spec.rubric.length > 5 && spec.confidence_floor > 0 && spec.confidence_floor < 1 && Number.isInteger(spec.version));
});
