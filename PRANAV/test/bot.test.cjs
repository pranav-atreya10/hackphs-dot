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
    bot.configure({ preset: ['phone_15fps'], corridor: sky.corridor, surveyId: 'fixture-only' });
    for (let i = 0; i < 75; i++) {
      const frame = sky.render(i / 15);
      const buf = await sharp(frame.data, { raw: { width: 640, height: 480, channels: 4 } }).jpeg({ quality: 60 }).toBuffer();
      assert.equal(await bot.frame(buf, i / 15), readyAt !== null);
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

test('server reports unavailable, retries without a browser, and never publishes stale results', async () => {
  let now = 100;
  const statuses = [], states = [];
  const bot = new CameraBot({ cameraId: 'health', now: () => now, onEvent() {},
    onState: state => states.push(state), onStatus: () => statuses.push(bot.status().mode) });
  assert.equal(bot.status().mode, 'starting');
  assert.equal(bot.freshState(), null);
  assert.equal(await bot.frame(Buffer.from('invalid jpeg'), 0), false);
  assert.equal(bot.busy, false);
  assert.equal(bot.status().mode, 'unavailable');
  assert.deepEqual(bot.status().capabilities, { video: true, drone_audio: false });
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#99ccff' } }).jpeg().toBuffer();
  assert.equal(await bot.frame(jpeg, 1), false, 'retry delay is respected');
  now += 20_000;
  assert.equal(await bot.frame(jpeg, 2), false, 'the first retry frame is not ready');
  assert.equal(states.length, 0);
  assert.equal(bot.status().mode, 'starting');
  for (let i = 1; i < 20; i++) await bot.frame(jpeg, 2 + i / 15);
  const generation = bot.freshState()?.generation;
  assert.ok(generation);
  assert.deepEqual(statuses.slice(0, 3), ['unavailable', 'starting', 'starting']);
  assert.equal(statuses.at(-1), 'server');
  assert.equal(bot.freshState().risk, 'green');

  now += 2999;
  assert.ok(bot.freshState());
  now++;
  assert.equal(bot.freshState(), null);
  assert.equal(bot.status().mode, 'unavailable');
  bot.expire();
  assert.equal(statuses.at(-1), 'unavailable');
  assert.equal(await bot.frame(jpeg, 0), false, 'recovery does not reuse the previous background');
  for (let i = 1; i < 20; i++) await bot.frame(jpeg, i / 15);
  assert.ok(bot.freshState());
  assert.notEqual(bot.freshState().generation, generation);
});

test('a late decode cannot promote a detector to active', async () => {
  let now = 0;
  const bot = new CameraBot({ cameraId: 'slow', now: () => now, onEvent() {},
    onState: () => assert.fail('late result was published'), onStatus() {} });
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#99ccff' } }).jpeg().toBuffer();
  const processing = bot.frame(jpeg, 0);
  now = 3_000;
  bot.expire();
  assert.equal(bot.status().mode, 'unavailable', 'supervision does not wait for the pending JPEG');
  assert.equal(await processing, false);
  assert.equal(bot.status().mode, 'unavailable');
});
