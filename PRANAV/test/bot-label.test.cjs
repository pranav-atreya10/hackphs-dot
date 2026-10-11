const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { CameraBot } = require('../bot');

async function trackedFlock() {
  const { SyntheticSky } = await import(pathToFileURL(path.join(__dirname, '../public/detection/index.js')));
  const sky = new SyntheticSky({ width: 640, height: 480, scenario: 'flock_corridor', seed: 7 });
  const bot = new CameraBot({ cameraId: 'label-test', onStatus() {}, onState() {}, onEvent() {} });
  bot.configure({ preset: ['phone_15fps'], corridor: sky.corridor });
  for (let i = 0; i < 35; i++) {
    const frame = sky.render(i / 15);
    const jpeg = await sharp(frame.data, { raw: { width: 640, height: 480, channels: 4 } }).jpeg({ quality: 60 }).toBuffer();
    assert.equal(await bot.frame(jpeg, i / 15), true);
  }
  const track = bot.state.tracks.find(t => bot.engine.tracker.tracks.some(raw => raw.id === t.id && raw.confirmed));
  assert.ok(track, 'fixture must produce a real confirmed engine track');
  return { bot, valid: { trackId: track.id, label: 'bird', score: .91, source: 'coco', bbox: { ...track.bbox }, frameT: bot.engine.lastT } };
}

test('trained bird labels update a real confirmed server track; invalid results do not mutate it', async t => {
  const { bot, valid } = await trackedFlock();
  assert.equal(bot.applyLabel(valid), true);
  assert.deepEqual(bot.engine.cocoLabels.get(valid.trackId), { label: 'bird', score: .91, source: 'coco', t: bot.engine.lastT });
  const accepted = { ...bot.engine.cocoLabels.get(valid.trackId) };
  const checks = bot.engine.stats.cocoChecks;

  const box = valid.bbox;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const hugeWidth = Math.min(2 * cx, 2 * (1 - cx), Math.max(.4, box.w * 5));
  const hugeHeight = Math.min(2 * cy, 2 * (1 - cy), Math.max(.4, box.h * 5));
  const hugeBox = { x: cx - hugeWidth / 2, y: cy - hugeHeight / 2, w: hugeWidth, h: hugeHeight };
  // Put a small valid crop in the corner farthest from the tracked object's center.
  const farBox = { x: box.x + box.w / 2 < .5 ? .97 : 0, y: box.y + box.h / 2 < .5 ? .97 : 0, w: .02, h: .02 };
  const invalid = [
    ['null payload', null],
    ['array payload', []],
    ['missing fields', {}],
    ['missing label', { ...valid, label: undefined }],
    ['non-numeric score', { ...valid, score: '.9' }],
    ['NaN score', { ...valid, score: NaN }],
    ['infinite score', { ...valid, score: Infinity }],
    ['negative score', { ...valid, score: -.01 }],
    ['score greater than one', { ...valid, score: 1.01 }],
    ['invented model source', { ...valid, source: 'gemini' }],
    ['unsupported drone claim', { ...valid, label: 'drone' }],
    ['invented class', { ...valid, label: 'runway hazard' }],
    ['empty result with confidence', { ...valid, label: null, score: .8 }],
    ['stale result', { ...valid, frameT: valid.frameT - 3 }],
    ['future result', { ...valid, frameT: valid.frameT + 3 }],
    ['invalid frame time', { ...valid, frameT: NaN }],
    ['unknown track', { ...valid, trackId: 999999 }],
    ['string track', { ...valid, trackId: String(valid.trackId) }],
    ['fractional track', { ...valid, trackId: valid.trackId + .5 }],
    ['missing crop', { ...valid, bbox: null }],
    ['crop with NaN', { ...valid, bbox: { ...box, x: NaN } }],
    ['zero-width crop', { ...valid, bbox: { ...box, w: 0 } }],
    ['negative-height crop', { ...valid, bbox: { ...box, h: -.1 } }],
    ['crop outside the frame', { ...valid, bbox: { x: .9, y: .9, w: .2, h: .2 } }],
    ['crop of a different object', { ...valid, bbox: farBox }],
    ['same-center crop covering unrelated pixels', { ...valid, bbox: hugeBox }],
    ['same-center crop too small to cover the object', { ...valid, bbox: { x: cx - box.w / 20, y: cy - box.h / 20, w: box.w / 10, h: box.h / 10 } }],
  ];
  for (const [name, payload] of invalid) {
    await t.test(name, () => {
      assert.equal(bot.applyLabel(payload), false);
      assert.deepEqual(bot.engine.cocoLabels.get(valid.trackId), accepted, 'rejected results must not overwrite the accepted bird label');
      assert.equal(bot.engine.stats.cocoChecks, checks, 'rejected results must not count as model checks');
    });
  }
  bot.active = false;
  assert.equal(bot.applyLabel(valid), false, 'a tower result cannot change a server bot after fallback');
});

test('a label cannot start a model or create a track before any frames arrive', () => {
  const bot = new CameraBot({ cameraId: 'empty-label', onStatus() {}, onState() {}, onEvent() {} });
  assert.equal(bot.applyLabel({ trackId: 1, label: 'bird', score: .91, source: 'coco', bbox: { x: .1, y: .1, w: .1, h: .1 }, frameT: 0 }), false);
  assert.equal(bot.engine, null);
});
