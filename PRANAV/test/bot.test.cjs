const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { CameraBot } = require('../bot');

for (const scenario of ['empty', 'flock_corridor']) {
  test(`phone startup and alerts: ${scenario}`, async () => {
    const { SyntheticSky } = await import(pathToFileURL(path.join(__dirname, '../public/detection/index.js')));
    const sky = new SyntheticSky({ width: 640, height: 480, scenario, seed: 7 });
    let readyAt = null, maxTracks = 0, reds = 0;
    const snapshots = [];
    const bot = new CameraBot({ cameraId: 'test', onStatus: () => {}, onState: s => {
      if (!s.learning && !s.shake && readyAt === null) readyAt = s.t;
      maxTracks = Math.max(maxTracks, s.tracks.length);
      if (s.risk === 'red') reds++;
    }, onEvent: e => { if (e.snapshot) snapshots.push(Buffer.from(e.snapshot, 'base64')); } });
    bot.configure({ preset: ['phone_15fps'], corridor: sky.corridor });
    for (let i = 0; i < 75; i++) {
      const frame = sky.render(i / 15);
      const buf = await sharp(frame.data, { raw: { width: 640, height: 480, channels: 4 } }).jpeg({ quality: 60 }).toBuffer();
      assert.equal(await bot.frame(buf, i / 15), true);
    }
    assert.ok(readyAt !== null && readyAt < 1, 'phone detector should become ready within a second at 15 fps');
    if (scenario === 'empty') {
      assert.equal(maxTracks, 0, 'faster background learning must not create ghost tracks');
      assert.equal(reds, 0, 'empty sky must not trigger alerts');
    } else {
      assert.ok(maxTracks >= 5, 'flock should still be detected');
      assert.ok(reds > 0, 'inbound flock should still trigger danger');
      assert.ok(snapshots.length > 0, 'alerts should retain image evidence');
      for (const buf of snapshots) {
        const image = await sharp(buf).metadata();
        assert.ok(image.width >= 4 && image.height >= 4, 'alert crops must be valid JPEGs');
      }
    }
  });
}

test('bad images hand over without leaving the uploader busy', async () => {
  const bot = new CameraBot({ cameraId: 'invalid', onEvent: () => {}, onState: () => {}, onStatus: () => {} });
  assert.equal(await bot.frame(Buffer.from('invalid jpeg'), 0), false);
  assert.equal(bot.busy, false);
  assert.equal(bot.status().mode, 'tower');
});
