const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let VisualBirdVerifier;

before(async () => {
  // The evidence module has its own tests; supply one already-paired candidate here.
  const source = await fs.readFile(path.join(__dirname, '../public/js/visual-ai.js'), 'utf8');
  const helper = `export const chooseBirdCandidate = feeds => [...feeds.values()].find(t => !t.offline)?.candidate;
    export const captureBirdEvidence = () => ({canvas: {}, bbox: {}});
    export const validBox = () => true;
    export const pruneBirdAttempts = () => {};`;
  const code = source.replaceAll('./bird-evidence.js', `data:text/javascript;base64,${Buffer.from(helper).toString('base64')}`);
  ({ VisualBirdVerifier } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`));
});

function feed(cameraId = 'iphone', source = 'server') {
  const tr = { id: 1, classification: 'unknown' }, streamId = `${cameraId}-stream`;
  const t = { cameraId, mode: source, lastFrameAt: Date.now(), streamId, botState: { generation: 1, tracks: [tr] },
    engine: { applyLabel() { assert.fail('advisory checks cannot affect engine state'); } } };
  t.candidate = { t, tr, key: cameraId, source, streamId, frameId: 5, frameT: .5, frameReceivedAt: t.lastFrameAt, generation: 1 };
  return t;
}
function setup({ classify, load, judge } = {}) {
  const button = { textContent: '', addEventListener() {}, setAttribute() {} }, status = { dataset: {} }, reviewStatus = {};
  let calls = 0, loads = 0;
  class Adapter {
    constructor() { this.stats = { intervalMs: 900 }; }
    async load(progress) { loads++; if (load) await load(progress); }
    async classifyCaptured() { calls++; return classify ? classify() : { label: null, score: 0, ms: 30 }; }
    adapt() {}
  }
  const verifier = new VisualBirdVerifier({ button, status, reviewStatus, judge, loadAdapter: async () => ({ CocoVerifier: Adapter }) });
  return { verifier, status, reviewStatus, calls: () => calls, loads: () => loads };
}

test('model stays unloaded until enable and shows actual adapter progress', async () => {
  let finish;
  const s = setup({ load: progress => {
    progress('Downloading weights…');
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal(s.loads(), 0);
  try {
    const loading = s.verifier.enable(); await Promise.resolve();
    assert.match(s.status.textContent, /Downloading weights/);
    finish(); await loading;
    assert.equal(s.status.dataset.state, 'ready');
  } finally { s.verifier.disable(); }
});

test('slow inference never overlaps another check and disabling discards its result', async () => {
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const s = setup({ classify: () => result });
  try {
    await s.verifier.enable(); s.verifier.onFeed(feed());
    const first = s.verifier.tick(); await s.verifier.tick();
    assert.equal(s.calls(), 1);
    s.verifier.disable(); finish({ label: 'bird', score: .9, ms: 800 }); await first;
    assert.equal(s.status.dataset.state, 'off');
  } finally { s.verifier.disable(); }
});

test('unresolved cloud review does not delay local checks and a late verdict is historical', async () => {
  const t = feed();
  let finish, reference, requests = 0;
  const result = new Promise(resolve => { finish = resolve; });
  const s = setup({ judge: ref => { reference = ref; requests++; return result; } });
  try {
    await s.verifier.enable(); s.verifier.onFeed(t);
    await s.verifier.tick(); await s.verifier.tick();
    assert.equal(s.calls(), 2);
    assert.equal(requests, 1);
    assert.deepEqual(reference, { cameraId: 'iphone', streamId: 'iphone-stream', frameId: 5, trackId: 1 });
    assert.match(s.status.textContent, /Latest local check/);
    assert.match(s.reviewStatus.textContent, /pending/);
    t.candidate.frameReceivedAt -= 3000;
    finish({ status: 'verified', source: 'gemini', verdict: 'not_bird', application: 'advisory',
      evidenceRef: { ...reference, generation: 1, t: .5 } });
    await result;
    assert.match(s.reviewStatus.textContent, /Earlier cloud review.*not a bird.*Not a clearance/);
  } finally { s.verifier.disable(); }
});

for (const [verdict, text] of [['bird', /: bird\./], ['uncertain', /: uncertain\./]]) {
  test(`cloud review preserves ${verdict}`, async () => {
    const t = feed();
    const s = setup({ judge: async ref => ({ status: 'verified', source: 'gemini', verdict, application: 'advisory',
      evidenceRef: { ...ref, generation: 1, t: .5 } }) });
    try {
      await s.verifier.enable(); s.verifier.onFeed(t); await s.verifier.tick();
      assert.match(s.reviewStatus.textContent, text);
    } finally { s.verifier.disable(); }
  });
}

test('unavailable model download leaves detection usable with a retryable status', async () => {
  const s = setup({ load: async () => { throw new Error('CDN unavailable'); } });
  await s.verifier.enable(); s.verifier.onFeed(feed()); await s.verifier.tick();
  assert.equal(s.verifier.enabled, false);
  assert.equal(s.status.dataset.state, 'unavailable');
  assert.match(s.status.textContent, /Motion detection stays active/);
  assert.equal(s.calls(), 0);
});

for (const [source, multiple] of [['tower', false], ['demo', false], ['server', true]]) {
  test(`does not request cloud review for ${multiple ? 'a multi-subject crop' : source}`, async () => {
    const s = setup({ classify: () => ({ ms: 10, ...(multiple ? { relevant: [{}, {}] } : {}) }),
      judge: () => assert.fail('no cloud review expected') });
    try {
      await s.verifier.enable(); s.verifier.onFeed(feed('iphone', source)); await s.verifier.tick();
      assert.equal(s.reviewStatus.textContent, '');
      if (multiple) assert.match(s.status.textContent, /multiple detections/);
    } finally { s.verifier.disable(); }
  });
}
