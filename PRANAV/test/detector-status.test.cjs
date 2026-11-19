const { test } = require('node:test');
const assert = require('node:assert/strict');

test('a status announcement or delayed prior result cannot claim server detection', async () => {
  const { DetectorStatus } = await import('../public/js/detector-status.mjs');
  let now = 10;
  let wall = 1000;
  const view = new DetectorStatus(() => now, () => wall);
  const result = { mode: 'server', state: { risk: 'green', generation: 'first', tracks: [] }, at: wall, remaining_ms: 100 };
  view.update({ mode: 'server', generation: 'first' });
  assert.match(view.message(), /unavailable/);
  assert.equal(view.accept({ ...result, state: { ...result.state, shake: true } }), false);
  assert.equal(view.accept(result), true);
  assert.match(view.message(), /active.*drone audio unavailable/);
  now += 100;
  assert.equal(view.current(), null);
  assert.match(view.message(), /no fresh server results/);

  view.update({ mode: 'unavailable' });
  assert.equal(view.accept(result), false);
  view.update({ mode: 'server', generation: 'second' });
  assert.equal(view.accept(result), false);
  wall += 101;
  assert.equal(view.accept({ ...result, at: wall, state: { ...result.state, generation: 'second' } }), true);
});

test('wire age shortens expiry, with monotonic time governing an accepted result', async () => {
  const { DetectorStatus } = await import('../public/js/detector-status.mjs');
  let now = 10, wall = 10_000;
  const view = new DetectorStatus(() => now, () => wall);
  const state = { risk: 'green', generation: 'instance', tracks: [] };
  const result = { mode: 'server', state, remaining_ms: 100 };
  view.update({ mode: 'server', generation: 'instance' });
  for (const at of [undefined, NaN, 0, '9950', 9900, 10001]) {
    assert.equal(view.accept({ ...result, at }), false, `timestamp ${at}`);
  }
  assert.equal(view.accept({ ...result, at: 9950 }), true);
  wall -= 500;
  now += 49;
  assert.equal(view.current(), state);
  now++;
  assert.equal(view.current(), null);
});

test('replays, reordered results and invalid generations cannot restore or replace an overlay', async () => {
  const { DetectorStatus } = await import('../public/js/detector-status.mjs');
  const view = new DetectorStatus(() => 10, () => 10_000);
  const state = { risk: 'green', generation: 'instance', tracks: [] };
  const result = { mode: 'server', state, at: 9990, remaining_ms: 100 };
  for (const generation of [undefined, '', '  ', 1, {}]) {
    view.update({ mode: 'server', generation });
    assert.equal(view.accept({ ...result, state: { ...state, generation } }), false);
  }
  view.update({ mode: 'server', generation: 'instance' });
  assert.equal(view.accept(result), true);
  assert.equal(view.accept({ ...result, at: 9989, state: { ...state, risk: 'red' } }), false);
  assert.equal(view.current(), state);
  view.update({ mode: 'starting' });
  view.update({ mode: 'server', generation: 'instance' });
  assert.equal(view.accept(result), false);
  assert.equal(view.current(), null);
  assert.equal(view.accept({ ...result, at: 9991 }), true);
});

for (const root of ['../public/detection', '../../VIVAN/detection']) {
  test(`${root}: unverified objects produce advisories without raising drone or flock danger`, async () => {
    const { RiskEngine } = await import(`${root}/src/risk.js`);
    const { DetectionEngine } = await import(`${root}/src/engine.js`);
    const { buildEvent } = await import(`${root}/src/contract.js`);
    const engine = new DetectionEngine();
    const risk = new RiskEngine(engine.cfg.risk);
    const debris = { kind: 'track', id: 1, classification: 'debris', size: 1, eta_seconds: 0, bearing_deg: null, confidence: .6 };
    const unknown = { ...debris, id: 2, classification: 'unknown', size: 5 };
    assert.equal(risk.evaluate([unknown], null, 0).raw, 'yellow');
    const advisory = risk.evaluate([debris], null, 1);
    assert.equal(advisory.raw, 'yellow');
    assert.match(advisory.reasons.join(), /unverified.*possible debris/);
    const event = buildEvent({ cfg: engine.cfg, risk: advisory, primary: engine.pickPrimary([debris]), groups: [debris], wallNow: 1 });
    assert.equal(event.type, 'unknown');
    assert.equal(event.object_count, 1);
    assert.equal(risk.evaluate([debris], null, 2, { trend: 'rising', red_ready: true, birds_now: 4, predicted: 7, horizon_sec: 15 }).raw, 'red');
  });
}
