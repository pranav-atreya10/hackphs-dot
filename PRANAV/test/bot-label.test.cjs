const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CameraBot } = require('../bot');

test('a tower cannot modify server tracks through CameraBot', () => {
  const bot = new CameraBot({ cameraId: 'legacy-label', onStatus() {}, onState() {}, onEvent() {} });
  assert.equal(typeof bot.applyLabel, 'undefined');
});
