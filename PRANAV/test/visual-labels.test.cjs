const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CameraBot } = require('../bot');

test('a steady visual track remains unverified on the video-only server', async () => {
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
  const state = bot.freshState();
  assert.ok(state.tracks.some(t => t.classification === 'unknown'));
  assert.equal(state.risk, 'yellow');
  assert.equal(state.tracks.some(t => t.classification === 'drone'), false);
  assert.equal(bot.status().capabilities.drone_audio, false);
});
