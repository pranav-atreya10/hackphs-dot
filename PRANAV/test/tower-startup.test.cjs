const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/js/tower.js'), 'utf8').replace(/^import .*;\r?$/gm, '');

test('tower markup keeps the local advisory and Gemini consent separately off', () => {
  const html = fs.readFileSync(require.resolve('../public/tower.html'), 'utf8');
  assert.match(html, /id="birdCheck"[^>]+aria-pressed="false"[^>]*>Enable local video advisory/);
  assert.match(html, /live video stream still goes through the server/);
  assert.match(html, /id="birdCloudReviewControl" hidden/);
  const consent = html.match(/<input id="birdCloudReview"[^>]*>/)?.[0] ?? '';
  assert.match(consent, /type="checkbox"[^>]+disabled/);
  assert.doesNotMatch(consent, /\schecked\b/);
  assert.match(html, /allow the server to send eligible camera crops to the Local AI Model/);
});

async function towerStartup(policy) {
  const incidentHistory = await import('../public/js/incident-history.mjs');
  const monitoring = await import('../public/js/tower-monitoring.mjs');
  const byId = new Map(), events = new Map(), assetPaths = [], reviewRequests = [];
  const el = () => ({ hidden: true, dataset: {}, listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); }, replaceChildren() {}, append() {}, remove() {} });
  const document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, el()); return byId.get(id); },
    createElement: el, addEventListener() {},
    head: { append(node) { assetPaths.push(node.src || node.href); node.onerror(); } },
  };
  document.getElementById('birdCloudReview').checked = true; // Simulate a browser-restored form value.
  let releaseAuth, socketStarted, verifier, feedOptions, policyReads = 0;
  const started = new Promise(resolve => { socketStarted = resolve; });
  const socket = {
    connected: false,
    on(name, fn) { events.set(name, fn); },
    connect() { socketStarted(); },
  };
  const withFeedImports = source.replace(/import\(('\/js\/(?:feeds|visual-ai)\.js')\)/g, 'loadFeedFixture($1)');
  vm.runInNewContext(withFeedImports, {
    ...monitoring, refreshSocketAuth() {},
    document, location: { origin: 'https://test.invalid', search: '', protocol: 'https:' },
    signIn: () => new Promise(resolve => { releaseAuth = resolve; }),
    loadFeedFixture: async path => path === '/js/feeds.js' ? {
      startFeeds(_events, options) { feedOptions = options; },
    } : {
      VisualBirdVerifier: class {
        constructor(options) { this.options = options; this.judge = null; verifier = this; }
        setJudge(judge) { this.judge = judge; }
        onRemove(id) { this.removedCamera = id; }
        reset() { this.resetCount = (this.resetCount ?? 0) + 1; }
      },
    },
    io: (name, options) => {
      assert.equal(name, '/tower');
      assert.equal(options.autoConnect, false);
      return socket;
    },
    fetch: async (path, opts) => {
      if (['/api/cloud-evidence-policy', '/api/verify-bird'].includes(path)) reviewRequests.push({ path, opts });
      if (path === '/api/cloud-evidence-policy') {
        const answer = typeof policy === 'function' ? policy(++policyReads) : policy;
        return { ok: true, json: async () => answer };
      }
      return { ok: true, json: async () => path === '/api/airports' ? { airports: [] } : [] };
    },
    createAlertPlayer: () => ({ receive() {}, clear() {} }), ...incidentHistory,
    AbortController, AbortSignal, DOMException, URLSearchParams, setTimeout, clearTimeout, setInterval() {}, window: {},
    console: { warn() {} },
  });
  return { document, events, assetPaths, reviewRequests, socket, started, releaseAuth,
    get verifier() { return verifier; }, get feedOptions() { return feedOptions; } };
}

const authFixture = {
  airport: 'TEST', socketAuth: async () => ({ token: 'test' }), headers: async () => ({ 'x-api-key': 'test' }),
};
const cloudPolicy = { birdJudge: 'gemini', cloudEvidenceEnabled: true, reviewEnabled: true, providerBinding: true };
const localPolicy = { birdJudge: 'local', cloudEvidenceEnabled: false, reviewEnabled: true, providerBinding: true };

test('only an authorized socket reveals tower data and starts optional loads', async t => {
  const tower = await towerStartup(cloudPolicy);
  const { document, events, assetPaths, reviewRequests, socket, started, releaseAuth } = tower;

  await t.test('only an opted-in fresh warning speaks; recovery is visible without changing risk', async () => {
    const { createAlertPlayer } = await import('../public/js/alert-player.mjs');
    const incidentHistory = await import('../public/js/incident-history.mjs');
    const monitoring = await import('../public/js/tower-monitoring.mjs');
    const elements = new Map(), events = new Map(), spoken = [];
    const element = () => ({
      dataset: {}, listeners: new Map(), children: [], hidden: true,
      addEventListener(name, fn) { this.listeners.set(name, fn); },
      setAttribute() {}, append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
    });
    const document = {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element, addEventListener() {},
      head: { append(node) { node.onerror(); } },
    };
    let started;
    const connected = new Promise(resolve => { started = resolve; });
    const scope = 'KAAA', now = Date.now();
    const alert = (id, fields = {}) => ({ id, text: id, airport: scope, time: now, risk: 'red', ...fields });
    const socket = {
      connected: true,
      on(name, fn) { events.set(name, fn); },
      connect: started,
      timeout() { return this; },
      emit(name, _arg, respond) {
        assert.equal(name, 'alert:replay');
        respond(null, { ok: false, pending: [{ alert: alert('recovered pending'), state: 'retrying' }] });
      },
    };
    const gain = { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } };
    const speechSynthesis = { speak(utterance) { spoken.push(utterance.text); } };
    vm.runInNewContext(source, {
      ...monitoring, createAlertPlayer, ...incidentHistory, refreshSocketAuth() {},
      document, location: { origin: 'https://test.invalid', search: '', protocol: 'https:' },
      signIn: async () => ({ airport: scope, socketAuth: async () => ({ token: 'test' }), headers: async () => ({}) }),
      io: () => socket,
      fetch: async path => ({ ok: true, json: async () => path === '/api/airports' ? { scoped: true, airports: [{ code: scope }] } : [] }),
      AudioContext: class {
        currentTime = 0;
        resume() {}
        createOscillator() { return { frequency: {}, connect: () => gain, start() {}, stop() {} }; }
        createGain() { return gain; }
      },
      SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
      window: { speechSynthesis }, speechSynthesis,
      AbortController, AbortSignal, URLSearchParams, clearTimeout, setInterval() {},
      setTimeout: (fn, ms) => setTimeout(fn, ms === 900 ? 0 : ms),
      console: { warn() {} },
    });
    await connected;
    events.get('connect')();
    assert.match(elements.get('alertSync').textContent, /unavailable/);
    const [recovery] = elements.get('unacknowledgedAlerts').children;
    assert.match(recovery.children[1].textContent, /Saved for retry/);
    assert.equal(recovery.children[2].hidden, true);
    events.get('alert_pending')(alert('recovered pending', { storage_state: 'unavailable' }));
    events.get('connect')();
    assert.match(recovery.children[1].textContent, /No retry scheduled/);
    events.get('alert_pending')(alert('sound off', { fresh: true }));
    elements.get('sound').listeners.get('click')();
    events.get('alert')(alert('recovered pending'));
    assert.equal(recovery.children[2].hidden, false);
    events.get('alert_pending')(alert('old', { fresh: true, time: now - 60_000 }));
    events.get('alert_pending')(alert('late confirmation', { storage_state: 'retrying' }));
    events.get('alert_pending')(alert('other airport', { fresh: true, airport: 'KBBB' }));
    events.get('alert_pending')(alert('fresh', { fresh: true }));
    events.get('alert_pending')(alert('fresh', { fresh: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(spoken, ['fresh']);
    assert.equal(elements.get('risk').dataset.risk, 'unavailable', 'history and alert messages do not set detector risk');
  });
  assert.equal(events.size, 0);
  releaseAuth(authFixture);
  await started;
  assert.equal(document.getElementById('dashboard').hidden, true);
  assert.deepEqual(assetPaths, []);
  assert.deepEqual(reviewRequests, []);
  assert.equal(tower.verifier, undefined);
  socket.connected = true;
  events.get('connect')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.getElementById('dashboard').hidden, false);
  assert.equal(document.getElementById('conn').textContent, 'Live');
  assert.ok(assetPaths.includes('/vendor/leaflet/leaflet.js'));
  assert.ok(assetPaths.includes('/js/walkthrough.js'));
  assert.match(document.getElementById('mapNote').textContent, /Loading|unavailable/);
  assert.equal(assetPaths.includes('/vendor/chart.umd.min.js'), false);

  await t.test('Gemini review needs a separate opt-in and reuses tower scope', async () => {
    const { verifier } = tower;
    const cloudReview = document.getElementById('birdCloudReview');
    assert.equal(verifier.options.button, document.getElementById('birdCheck'));
    assert.equal(cloudReview.disabled, false);
    assert.equal(document.getElementById('birdCloudReviewControl').hidden, false);
    assert.equal(cloudReview.checked, false);
    assert.equal(verifier.judge, null);
    assert.deepEqual(reviewRequests.map(({ path }) => path), ['/api/cloud-evidence-policy']);

    cloudReview.checked = true;
    cloudReview.listeners.get('change')();
    const ref = { cameraId: 'CAM', streamId: 'live', frameId: 4, trackId: 2 };
    const review = new AbortController();
    await verifier.judge({ ...ref, image: 'ignored-fixture' }, review.signal);
    const { path, opts } = reviewRequests.at(-1);
    assert.equal(path, '/api/verify-bird');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['x-api-key'], 'test');
    assert.equal(opts.headers['x-airport'], 'TEST');
    assert.equal(opts.headers['x-bird-review-provider'], 'gemini');
    assert.deepEqual(JSON.parse(opts.body), ref);

    cloudReview.checked = false;
    cloudReview.listeners.get('change')();
    assert.equal(verifier.judge, null);
    review.abort();
    assert.equal(opts.signal.aborted, true);

    tower.feedOptions.onRemove(ref.cameraId);
    assert.equal(verifier.removedCamera, ref.cameraId);
  });

  for (const [reason, status] of [
    ['transport close', 'Reconnecting…'],
    ['io client disconnect', 'Access ended; reload to reconnect'],
    ['io server disconnect', 'Access ended; reload to reconnect'],
  ]) {
    const resets = tower.verifier.resetCount ?? 0;
    socket.connected = false;
    events.get('disconnect')(reason);
    assert.equal(tower.verifier.resetCount, resets + 1);
    assert.equal(document.getElementById('conn').textContent, status);
    assert.equal(document.getElementById('risk').dataset.risk, 'unavailable');
    socket.connected = true;
    events.get('connect')();
  }
});

test('server review policy keeps the local judge separate and never enables a disallowed cloud review', async t => {
  for (const [name, policy, hasLocalJudge, showsConsent] of [
    ['explicit local server judge', localPolicy, true, false],
    ['no cloud evidence permission', { ...cloudPolicy, cloudEvidenceEnabled: false }, false, false],
    ['server review veto', { ...cloudPolicy, reviewEnabled: false }, false, false],
    ['server judge off', { ...cloudPolicy, birdJudge: 'off' }, false, false],
    ['legacy cloud evidence policy', { ...cloudPolicy, providerBinding: undefined }, false, false],
  ]) {
    await t.test(name, async () => {
      const tower = await towerStartup(policy);
      tower.releaseAuth(authFixture);
      await tower.started;
      tower.socket.connected = true;
      tower.events.get('connect')();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof tower.verifier.judge === 'function', hasLocalJudge);
      assert.equal(tower.document.getElementById('birdCloudReviewControl').hidden, !showsConsent);
      assert.deepEqual(tower.reviewRequests.map(({ path }) => path), ['/api/cloud-evidence-policy']);
      if (hasLocalJudge) {
        await tower.verifier.judge({ cameraId: 'CAM', streamId: 'live', frameId: 4, trackId: 2 }, new AbortController().signal);
        assert.equal(tower.reviewRequests.at(-1).path, '/api/verify-bird');
        assert.equal(tower.reviewRequests.at(-1).opts.headers['x-bird-review-provider'], 'local');
      }
    });
  }
});

test('reconnect discards a pending old policy and never carries Gemini consent to a new connection', async () => {
  let releaseOldPolicy;
  const oldPolicy = new Promise(resolve => { releaseOldPolicy = resolve; });
  const tower = await towerStartup(read => read === 1 ? oldPolicy : cloudPolicy);
  tower.releaseAuth(authFixture);
  await tower.started;
  const { events, socket, reviewRequests } = tower;
  const checkbox = tower.document.getElementById('birdCloudReview');
  const connect = async () => {
    socket.connected = true;
    events.get('connect')();
    await new Promise(resolve => setImmediate(resolve));
  };
  const disconnect = () => {
    socket.connected = false;
    events.get('disconnect')('transport close');
  };
  await connect();
  assert.equal(checkbox.disabled, true);
  assert.equal(reviewRequests.length, 1);
  disconnect();
  assert.equal(reviewRequests[0].opts.signal.aborted, true);
  await connect();
  releaseOldPolicy(localPolicy);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tower.verifier.judge, null, 'a late local policy cannot replace the active connection consent');
  assert.equal(checkbox.disabled, false);
  assert.equal(checkbox.checked, false);

  checkbox.checked = true;
  checkbox.listeners.get('change')();
  const staleJudge = tower.verifier.judge;
  assert.equal(typeof staleJudge, 'function');
  disconnect();
  assert.equal(checkbox.disabled, true);
  assert.equal(checkbox.checked, false);
  await connect();
  assert.equal(checkbox.disabled, false);
  assert.equal(checkbox.checked, false);
  assert.equal(tower.verifier.judge, null);
  const ref = { cameraId: 'CAM', streamId: 'live', frameId: 4, trackId: 2 };
  await assert.rejects(() => staleJudge(ref, new AbortController().signal), { name: 'AbortError' });
  assert.deepEqual(reviewRequests.map(({ path }) => path), Array(3).fill('/api/cloud-evidence-policy'));
});
