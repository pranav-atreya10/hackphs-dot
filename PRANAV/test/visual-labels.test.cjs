const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CameraBot } = require('../bot');

test('server fuses a matching trained bird label and rejects stale or invalid labels', async () => {
  const { SyntheticSky } = await import(pathToFileURL(path.join(__dirname, '../public/detection/index.js')));
  const sky = new SyntheticSky({ width: 640, height: 480, scenario: 'drone_silent', seed: 7 });
  const bot = new CameraBot({ cameraId: 'label-test', onState() {}, onStatus() {}, onEvent() {} });
  bot.configure({ preset: ['phone_15fps'], corridor: [] });
  async function frame(i) {
    const raw = sky.render(i / 15);
    const jpg = await sharp(raw.data, { raw: { width: 640, height: 480, channels: 4 } }).jpeg({ quality: 60 }).toBuffer();
    return bot.frame(jpg, i / 15);
  }
  for (let i = 0; i < 45; i++) await frame(i);
  const track = bot.state.tracks.find(t => t.classification === 'unknown');
  assert.ok(track, 'a silent steady object should remain unknown before a trained label');
  const valid = { trackId: track.id, label: 'bird', score: .84, source: 'coco', bbox: { ...track.bbox }, frameT: bot.engine.lastT };
  const before = bot.engine.stats.cocoChecks;
  for (const patch of [
    { trackId: 999999 }, { source: 'untrusted' }, { score: NaN }, { score: 1.01 },
    { label: 'drone' }, { frameT: valid.frameT - 10 }, { bbox: { x: .9, y: .9, w: .02, h: .02 } },
    { bbox: { x: 0, y: 0, w: -1, h: .1 } }, { label: null, score: .8 },
  ]) assert.equal(bot.applyLabel({ ...valid, ...patch }), false);
  assert.equal(bot.engine.stats.cocoChecks, before, 'invalid labels must not influence the engine');
  assert.equal(bot.applyLabel(valid), true);
  await frame(45);
  assert.equal(bot.state.tracks.find(t => t.id === track.id)?.classification, 'bird');
  assert.match(bot.engine.state.tracks.find(t => t.id === track.id)?.reason || '', /COCO-SSD: bird/);
});
