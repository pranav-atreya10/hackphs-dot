'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  buildDeployDiagnostics,
  createDeployDiagnosticsHandler,
} = require('../deploy-diagnostics');

const pranavRoot = path.join(__dirname, '..');
const realAppYamlPath = path.join(pranavRoot, '.do', 'app.yaml');
const preflightModuleUrl = pathToFileURL(path.join(pranavRoot, 'scripts', 'do-deploy-preflight.mjs')).href;
const adminDiagModuleUrl = pathToFileURL(path.join(pranavRoot, 'public', 'js', 'admin-diagnostics.mjs')).href;

/* ---------- Minimal serializable DOM harness for admin-diagnostics.mjs ---------- */

function escapeHtmlText(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(str) {
  return escapeHtmlText(str).replace(/"/g, '&quot;');
}

function createTestDocument() {
  function createNode(tagName) {
    const tag = String(tagName).toUpperCase();
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    let textValue = '';

    const node = {
      nodeType: 1,
      tagName: tag,
      ownerDocument: null,
      hidden: false,
      disabled: false,
      type: '',
      children: [],
      get firstChild() {
        return this.children[0] || null;
      },
      get className() {
        return [...classes].join(' ');
      },
      set className(val) {
        classes.clear();
        for (const token of String(val || '').split(/\s+/).filter(Boolean)) {
          classes.add(token);
        }
      },
      classList: {
        add(...names) { for (const n of names) if (n) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); },
      },
      get textContent() {
        if (this.children.length === 0) return textValue;
        return this.children.map(c => c.textContent).join('');
      },
      set textContent(val) {
        this.children = [];
        textValue = String(val ?? '');
      },
      setAttribute(name, val) {
        attrs.set(String(name).toLowerCase(), String(val));
      },
      getAttribute(name) {
        return attrs.get(String(name).toLowerCase()) ?? null;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) this.children.splice(idx, 1);
        return child;
      },
      replaceChildren(...nodes) {
        this.children = [...nodes];
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      listenerCount(type) {
        return listeners.get(type)?.size || 0;
      },
      click() {
        if (this.disabled) return;
        for (const fn of [...(listeners.get('click') || [])]) {
          fn({ type: 'click', preventDefault() {} });
        }
      },
      findAll(predicate, acc = []) {
        if (predicate(this)) acc.push(this);
        for (const child of this.children) {
          child.findAll(predicate, acc);
        }
        return acc;
      },
      findFirst(predicate) {
        return this.findAll(predicate)[0] || null;
      },
      get innerHTML() {
        if (this.children.length === 0) return escapeHtmlText(textValue);
        return this.children.map(c => c.outerHTML).join('');
      },
      get outerHTML() {
        const lowerTag = tag.toLowerCase();
        const attrPairs = [];
        if (classes.size > 0) attrPairs.push(`class="${escapeHtmlAttr(this.className)}"`);
        if (this.type) attrPairs.push(`type="${escapeHtmlAttr(this.type)}"`);
        if (this.disabled) attrPairs.push('disabled');
        if (this.hidden) attrPairs.push('hidden');
        for (const [k, v] of attrs.entries()) {
          attrPairs.push(`${k}="${escapeHtmlAttr(v)}"`);
        }
        const open = attrPairs.length ? `<${lowerTag} ${attrPairs.join(' ')}>` : `<${lowerTag}>`;
        return `${open}${this.innerHTML}</${lowerTag}>`;
      },
    };
    node.ownerDocument = doc;
    return node;
  }

  const doc = {
    createElement: tag => createNode(tag),
  };
  return doc;
}

/* ========================================================================== *
 *  1. do-deploy-preflight.mjs: App Spec, Env, Generator, Probe & CLI         *
 * ========================================================================== */

describe('do-deploy-preflight.mjs', () => {
  test('validateAppYaml passes the real PRANAV/.do/app.yaml and catches synthetic broken specs', async () => {
    const { validateAppYaml } = await import(preflightModuleUrl);

    const realReport = validateAppYaml(realAppYamlPath);
    assert.equal(realReport.ok, true, `Expected real .do/app.yaml to pass: ${JSON.stringify(realReport.blockers)}`);
    assert.deepEqual(realReport.blockers, []);
    assert.equal(realReport.service, 'web');

    // Broken spec: instance_count: 2, wrong health path /ready, missing SECRET on CAMERA_API_KEY, plaintext secret value
    const brokenYaml = `
name: hackphs-broken
services:
  - name: web
    source_dir: WRONG_DIR
    http_port: 3000
    instance_count: 2
    health_check:
      http_path: /ready
    envs:
      - key: NODE_ENV
        value: production
      - key: CAMERA_API_KEY
        value: plaintext-leaked-camera-secret
        scope: RUN_TIME
      - key: CAMERA_API_AIRPORT
        scope: RUN_TIME
      - key: AIRPORT_CODES
        scope: RUN_TIME
      - key: RECEIPT_SPOOL_FILE
        value: /opt/skysentry/ephemeral.spool
`;
    const brokenReport = validateAppYaml(brokenYaml);
    assert.equal(brokenReport.ok, false);
    assert.ok(brokenReport.blockers.some(b => b.includes('source_dir')));
    assert.ok(brokenReport.blockers.some(b => b.includes('instance_count must be 1')));
    assert.ok(brokenReport.blockers.some(b => b.includes('http_port must be 8080')));
    assert.ok(brokenReport.blockers.some(b => b.includes('"/health"')));
    assert.ok(brokenReport.blockers.some(b => b.includes('"CAMERA_API_KEY" must declare "type: SECRET"')));
    assert.ok(brokenReport.blockers.some(b => b.includes('"CAMERA_API_KEY" must not hardcode a plaintext value')));
    assert.ok(brokenReport.blockers.some(b => b.includes('"AIRPORT_CODES" must declare "type: SECRET"')));
    assert.ok(brokenReport.blockers.some(b => b.includes('TOWER_API_KEY') && b.includes('CLERK_SECRET_KEY')));
    assert.ok(brokenReport.blockers.some(b => b.includes('RECEIPT_SPOOL_FILE')));
  });

  test('validateDeployEnv catches PR #56 CAMERA_API_AIRPORT blocker, duplicate keys, missing MONGODB_URI with Clerk, placeholders, and passes valid configs', async () => {
    const { validateDeployEnv } = await import(preflightModuleUrl);

    // 1. Exact PR #56 DigitalOcean blocker: CAMERA_API_KEY set without matching CAMERA_API_AIRPORT in AIRPORT_CODES
    const pr56Blocker = validateDeployEnv({
      NODE_ENV: 'production',
      AIRPORT_CODES: 'KPCT=kpct-4821-9310',
      CAMERA_API_KEY: 'a'.repeat(64),
      CAMERA_API_AIRPORT: '',
      TOWER_API_KEY: 'b'.repeat(64),
      TOWER_API_AIRPORT: 'KPCT',
    });
    assert.equal(pr56Blocker.ok, false);
    assert.ok(
      pr56Blocker.blockers.includes('CAMERA_API_AIRPORT must name a registered AIRPORT_CODES entry when CAMERA_API_KEY is set'),
      `Expected exact PR #56 blocker, got: ${JSON.stringify(pr56Blocker.blockers)}`
    );

    // 2. Duplicate camera and tower keys
    const duplicateKeys = validateDeployEnv({
      NODE_ENV: 'production',
      AIRPORT_CODES: 'KPCT=kpct-4821-9310',
      CAMERA_API_KEY: 'c'.repeat(64),
      CAMERA_API_AIRPORT: 'KPCT',
      TOWER_API_KEY: 'c'.repeat(64),
      TOWER_API_AIRPORT: 'KPCT',
    });
    assert.equal(duplicateKeys.ok, false);
    assert.ok(duplicateKeys.blockers.includes('camera and tower keys must be distinct'));

    // 3. Partial Clerk keys
    const partialClerk = validateDeployEnv({
      NODE_ENV: 'production',
      AIRPORT_CODES: 'KPCT=kpct-4821-9310',
      CAMERA_API_KEY: 'a'.repeat(64),
      CAMERA_API_AIRPORT: 'KPCT',
      CLERK_SECRET_KEY: 'sk_test_validClerkSecretKey99',
    });
    assert.equal(partialClerk.ok, false);
    assert.ok(partialClerk.blockers.includes('configure both Clerk keys or neither'));

    // 4. Clerk configured without MONGODB_URI
    const clerkWithoutMongo = validateDeployEnv({
      AIRPORT_CODES: 'KPCT=kpct-4821-9310',
      CAMERA_API_KEY: 'a'.repeat(64),
      CAMERA_API_AIRPORT: 'KPCT',
      CLERK_PUBLISHABLE_KEY: 'pk_test_validClerkPubKey99',
      CLERK_SECRET_KEY: 'sk_test_validClerkSecretKey99',
    });
    assert.equal(clerkWithoutMongo.ok, false);
    assert.ok(clerkWithoutMongo.blockers.some(b => b.includes('MONGODB_URI')));

    // 5. Placeholder values from .env.example rejected
    const placeholders = validateDeployEnv({
      NODE_ENV: 'production',
      AIRPORT_CODES: 'KPCT=change-me-pct-code',
      CAMERA_API_KEY: 'change-me-camera-key',
      CAMERA_API_AIRPORT: 'KPCT',
      CLERK_PUBLISHABLE_KEY: 'pk_test_...',
      CLERK_SECRET_KEY: 'sk_test_...',
      MONGODB_URI: 'mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/?appName=Cluster0',
    });
    assert.equal(placeholders.ok, false);
    assert.ok(placeholders.blockers.some(b => b.includes('placeholder')));

    // 6. Valid production config with bound tower key
    const validTowerKey = validateDeployEnv({
      NODE_ENV: 'production',
      AIRPORT_CODES: 'KPCT=kpct-4821-9310,KTTN=kttn-7712-3391',
      CAMERA_API_KEY: '1'.repeat(64),
      CAMERA_API_AIRPORT: 'KPCT',
      TOWER_API_KEY: '2'.repeat(64),
      TOWER_API_AIRPORT: 'KTTN',
    });
    assert.equal(validTowerKey.ok, true, JSON.stringify(validTowerKey.blockers));
    assert.deepEqual(validTowerKey.blockers, []);

    // 7. Valid production config with Clerk + MongoDB
    const validClerkMongo = validateDeployEnv({
      NODE_ENV: 'production',
      AIRPORT_CODES: 'KPCT=kpct-4821-9310',
      CAMERA_API_KEY: '3'.repeat(64),
      CAMERA_API_AIRPORT: 'KPCT',
      CLERK_PUBLISHABLE_KEY: 'pk_test_9876543210abcdef',
      CLERK_SECRET_KEY: 'sk_test_9876543210abcdef',
      MONGODB_URI: 'mongodb+srv://skysentry:prodpass@prod-cluster.abc12.mongodb.net/skysentry',
      ADMIN_EMAILS: 'ops@example.org',
    });
    assert.equal(validClerkMongo.ok, true, JSON.stringify(validClerkMongo.blockers));
    assert.deepEqual(validClerkMongo.blockers, []);
  });

  test('generateAirportEnvBundle produces distinct 64-hex keys that immediately pass validateDeployEnv without touching disk', async () => {
    const { generateAirportEnvBundle, validateDeployEnv, runPreflightCli } = await import(preflightModuleUrl);

    let diskWrites = 0;
    const origWriteSync = fs.writeFileSync;
    const origAppendSync = fs.appendFileSync;
    const origPromiseWrite = fs.promises.writeFile;
    fs.writeFileSync = () => { diskWrites++; throw new Error('Forbidden disk write'); };
    fs.appendFileSync = () => { diskWrites++; throw new Error('Forbidden disk append'); };
    fs.promises.writeFile = async () => { diskWrites++; throw new Error('Forbidden async disk write'); };

    try {
      const bundle = generateAirportEnvBundle('kpct');
      assert.equal(bundle.airport, 'KPCT');
      assert.match(bundle.CAMERA_API_KEY, /^[0-9a-f]{64}$/);
      assert.match(bundle.TOWER_API_KEY, /^[0-9a-f]{64}$/);
      assert.notEqual(bundle.CAMERA_API_KEY, bundle.TOWER_API_KEY);
      assert.match(bundle.joinCode, /^kpct-\d{4}-\d{4}$/);
      assert.equal(bundle.AIRPORT_CODES, `KPCT=${bundle.joinCode}`);

      assert.equal(validateDeployEnv(bundle).ok, true);
      assert.equal(validateDeployEnv(bundle.env).ok, true);

      const cliOut = await runPreflightCli(['--generate', 'KTTN']);
      assert.equal(cliOut.exitCode, 0);
      assert.match(cliOut.output, /CAMERA_API_KEY=[0-9a-f]{64}/);
      assert.match(cliOut.output, /TOWER_API_KEY=[0-9a-f]{64}/);
      assert.equal(diskWrites, 0);

      assert.throws(() => generateAirportEnvBundle('bad-code!'), /Airport code/);
    } finally {
      fs.writeFileSync = origWriteSync;
      fs.appendFileSync = origAppendSync;
      fs.promises.writeFile = origPromiseWrite;
    }
  });

  test('probeLiveDeployment distinguishes HTTP 404 stale pre-PR-#56 deploy vs 200 ready vs 503 not_ready', async () => {
    const { probeLiveDeployment, runPreflightCli } = await import(preflightModuleUrl);

    const makeMockFetch = routes => async url => {
      const pathname = new URL(url).pathname;
      const hit = routes[pathname];
      if (!hit) return { status: 404, text: async () => '' };
      return {
        status: hit.status,
        text: async () => (hit.body !== undefined ? JSON.stringify(hit.body) : ''),
      };
    };

    // 1. Stale pre-PR-#56 deploy: /health is 200, /ready is 404
    const stale = await probeLiveDeployment('https://lancerhacks-rvs8r.ondigitalocean.app', {
      fetch: makeMockFetch({
        '/health': { status: 200, body: { status: 'ok' } },
        '/ready': { status: 404 },
      }),
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.stalePrePr56, true);
    assert.equal(stale.status, 'stale_pre_pr56');
    assert.ok(stale.blockers.some(b => b.includes('404') && b.includes('pre-PR-#56')));

    // 2. Healthy new deploy: /health 200, /ready 200
    const healthy = await probeLiveDeployment('https://lancerhacks-rvs8r.ondigitalocean.app', {
      fetch: makeMockFetch({
        '/health': { status: 200, body: { status: 'ok' } },
        '/ready': {
          status: 200,
          body: {
            status: 'ready',
            checks: {
              video_detector: 'ready',
              airport_registry: 'ready',
              camera_access: 'ready',
              tower_access: 'ready',
              receipt_storage: 'ready',
              receipt_recovery: 'ready',
            },
          },
        },
      }),
    });
    assert.equal(healthy.ok, true);
    assert.equal(healthy.stalePrePr56, false);
    assert.equal(healthy.status, 'ready');
    assert.deepEqual(healthy.blockers, []);

    // 3. Post-PR-#56 deploy running with /ready 503 (e.g. App Platform ephemeral spool)
    const bootingOrDegraded = await probeLiveDeployment('https://lancerhacks-rvs8r.ondigitalocean.app', {
      fetch: makeMockFetch({
        '/health': { status: 200, body: { status: 'ok' } },
        '/ready': {
          status: 503,
          body: {
            status: 'not_ready',
            checks: {
              video_detector: 'ready',
              airport_registry: 'ready',
              camera_access: 'ready',
              tower_access: 'ready',
              receipt_storage: 'ready',
              receipt_recovery: 'unavailable',
            },
          },
        },
      }),
    });
    assert.equal(bootingOrDegraded.ok, false);
    assert.equal(bootingOrDegraded.stalePrePr56, false);
    assert.equal(bootingOrDegraded.livenessOk, true);
    assert.equal(bootingOrDegraded.status, 'not_ready');
    assert.deepEqual(bootingOrDegraded.degradedChecks, [{ name: 'receipt_recovery', state: 'unavailable' }]);

    // 4. CLI --app-yaml and --probe integration
    const cliYaml = await runPreflightCli(['--app-yaml', realAppYamlPath]);
    assert.equal(cliYaml.exitCode, 0);

    const cliProbe = await runPreflightCli(
      ['--probe', 'https://lancerhacks-rvs8r.ondigitalocean.app'],
      {
        fetch: makeMockFetch({
          '/health': { status: 200, body: { status: 'ok' } },
          '/ready': { status: 404 },
        }),
      }
    );
    assert.equal(cliProbe.exitCode, 1);
    assert.match(cliProbe.output, /404/);
  });
});

/* ========================================================================== *
 *  2. deploy-diagnostics.js: Zero Secret Leakage & Express Handler           *
 * ========================================================================== */

describe('deploy-diagnostics.js', () => {
  test('buildDeployDiagnostics and createDeployDiagnosticsHandler guarantee zero secret leakage across all canary credentials', async () => {
    const canaries = {
      CAMERA_API_KEY: 'CANARY_CAM_SECRET_f8a19c02d4e67788',
      TOWER_API_KEY: 'CANARY_TOWER_SECRET_99b31e44c2a18877',
      MONGODB_URI: 'mongodb+srv://canaryUser:CANARY_MONGO_PASS_7721@canary-cluster.xyz.mongodb.net/skysentry',
      CLERK_SECRET_KEY: 'sk_test_CANARY_CLERK_SECRET_55443322',
      CLERK_PUBLISHABLE_KEY: 'pk_test_CANARY_CLERK_PUB_11223344',
      GEMINI_API_KEY: 'AIzaSy_CANARY_GEMINI_SECRET_99887766',
      OPENAI_API_KEY: 'sk-proj-CANARY_OPENAI_SECRET_44556677',
      SOLANA_SECRET_KEY: '[101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,162,163,164]',
      LOCAL_JUDGE_KEY: 'CANARY_LOCAL_JUDGE_SECRET_314159',
      JOIN_CODE: 'kpct-canary-join-8472',
      ADMIN_EMAIL: 'secret-admin-canary@private-airport.org',
      SPOOL_PATH: '/var/private-canary-spool/skysentry-secret.spool',
    };

    const env = {
      NODE_ENV: 'production',
      AIRPORT_CODES: `KPCT=${canaries.JOIN_CODE}`,
      CAMERA_API_KEY: canaries.CAMERA_API_KEY,
      CAMERA_API_AIRPORT: 'KPCT',
      TOWER_API_KEY: canaries.TOWER_API_KEY,
      TOWER_API_AIRPORT: 'KPCT',
      MONGODB_URI: canaries.MONGODB_URI,
      CLERK_PUBLISHABLE_KEY: canaries.CLERK_PUBLISHABLE_KEY,
      CLERK_SECRET_KEY: canaries.CLERK_SECRET_KEY,
      GEMINI_API_KEY: canaries.GEMINI_API_KEY,
      OPENAI_API_KEY: canaries.OPENAI_API_KEY,
      SOLANA_SECRET_KEY: canaries.SOLANA_SECRET_KEY,
      LOCAL_JUDGE_KEY: canaries.LOCAL_JUDGE_KEY,
      ADMIN_EMAILS: canaries.ADMIN_EMAIL,
      RECEIPT_SPOOL_FILE: canaries.SPOOL_PATH,
      DURABLE_INCIDENT_EVIDENCE: '1',
      BIRD_JUDGE: 'local',
    };

    // Even when readiness() throws an error echoing raw secrets + URIs + Gemini brand name, nothing leaks!
    const failingPayload = await buildDeployDiagnostics({
      env,
      readiness: async () => {
        throw new Error(
          `Auth error for ${canaries.MONGODB_URI} keys=${canaries.CAMERA_API_KEY},${canaries.CLERK_SECRET_KEY},${canaries.GEMINI_API_KEY},${canaries.OPENAI_API_KEY},${canaries.SOLANA_SECRET_KEY} admin=${canaries.ADMIN_EMAIL} spool=${canaries.SPOOL_PATH} Gemini failed`
        );
      },
    });

    const serializedFailing = JSON.stringify(failingPayload);
    for (const [label, secretValue] of Object.entries(canaries)) {
      assert.equal(
        serializedFailing.includes(secretValue),
        false,
        `Secret canary ${label} leaked into diagnostics payload: ${serializedFailing}`
      );
    }
    assert.equal(serializedFailing.includes('CANARY_MONGO_PASS_7721'), false);
    assert.equal(serializedFailing.includes('private-canary-spool'), false);
    assert.equal(/gemini/i.test(serializedFailing), false, 'Provider-neutral copy must not expose Gemini');
    assert.equal(failingPayload.envChecklist.BIRD_JUDGE.detail.includes('Local AI Model'), true);
    assert.ok(failingPayload.remediation.length > 0);

    // Express handler headers + 200 vs 503 status codes
    const capturedHeaders = new Map();
    let capturedStatus = 0;
    let capturedJson = null;
    const mockRes = {
      set(k, v) { capturedHeaders.set(k.toLowerCase(), v); return this; },
      status(code) { capturedStatus = code; return this; },
      json(body) { capturedJson = body; return this; },
    };

    const degradedHandler = createDeployDiagnosticsHandler({
      env,
      readiness: async () => ({
        ready: false,
        checks: {
          video_detector: 'ready',
          airport_registry: 'ready',
          camera_access: 'ready',
          tower_access: 'ready',
          receipt_storage: 'ready',
          receipt_recovery: 'unavailable',
        },
      }),
    });
    await degradedHandler({}, mockRes);
    assert.equal(capturedStatus, 503);
    assert.equal(capturedHeaders.get('cache-control'), 'private, no-store');
    assert.equal(capturedHeaders.get('x-content-type-options'), 'nosniff');
    assert.equal(capturedJson.status, 'degraded');
    assert.equal(capturedJson.readiness.checks.receipt_recovery, 'unavailable');

    const serializedDegraded = JSON.stringify(capturedJson);
    for (const [label, secretValue] of Object.entries(canaries)) {
      assert.equal(serializedDegraded.includes(secretValue), false, `Canary ${label} leaked in handler response`);
    }

    const readyHandler = createDeployDiagnosticsHandler({
      env,
      readiness: async () => ({
        ready: true,
        checks: {
          video_detector: 'ready',
          airport_registry: 'ready',
          camera_access: 'ready',
          tower_access: 'ready',
          receipt_storage: 'ready',
          receipt_recovery: 'ready',
        },
      }),
    });
    await readyHandler({}, mockRes);
    assert.equal(capturedStatus, 200);
    assert.equal(capturedJson.status, 'ready');
    assert.equal(capturedJson.ok, true);
  });
});

/* ========================================================================== *
 *  3. admin-diagnostics.mjs: 200/503 Rendering, Refresh, XSS & Node Guards   *
 * ========================================================================== */

describe('admin-diagnostics.mjs', () => {
  test('returns safe noop handle when called in Node with optionsBag or mockCanvas without window/document', async () => {
    const { mountAdminDiagnostics, renderDiagnosticsSnapshot } = await import(adminDiagModuleUrl);
    const optionsBag = { container: {}, tracks: [], risk: 'yellow' };
    const mockCanvas = { nodeType: 1, tagName: 'CANVAS', appendChild() {}, replaceChildren() {} };

    for (const fn of [mountAdminDiagnostics, renderDiagnosticsSnapshot]) {
      const resA = fn(optionsBag, optionsBag);
      assert.equal(resA.element, null);
      assert.equal(await resA.refresh(), null);
      assert.doesNotThrow(() => resA.destroy());

      const resB = fn(mockCanvas, optionsBag);
      assert.equal(resB.element, null);
      assert.equal(await resB.refresh(), null);
      assert.doesNotThrow(() => resB.destroy());
    }
  });

  test('mounts #diagPanel, renders HTTP 503 degraded checks and HTTP 200 READY on Refresh, escapes XSS, and strips Gemini copy', async () => {
    const { mountAdminDiagnostics } = await import(adminDiagModuleUrl);
    const doc = createTestDocument();
    const diagPanel = doc.createElement('section');
    diagPanel.hidden = true;

    let callCount = 0;
    const payloads = [
      {
        status: 503,
        body: {
          generatedAt: '2026-11-21T14:00:00.000Z',
          nodeVersion: 'v22.11.0',
          uptimeSec: 125,
          environment: 'production',
          status: 'degraded',
          readiness: {
            ready: false,
            checks: {
              video_detector: 'ready',
              airport_registry: 'ready',
              camera_access: 'ready',
              tower_access: 'ready',
              receipt_storage: 'ready',
              receipt_recovery: 'unavailable',
            },
          },
          envChecklist: {
            AIRPORT_CODES: { label: 'Airport Registry', required: true, configured: true, valid: true, detail: '1 airport configured' },
            BIRD_JUDGE: { label: 'Gemini Legacy Title <img src=x onerror=alert(1)>', required: false, configured: true, valid: true, mode: 'gemini', detail: 'Gemini 3.5 model' },
          },
          remediation: [
            'Restart spool unavailable <script>window.__xss=1</script> on ephemeral disk.',
          ],
        },
      },
      {
        status: 200,
        body: {
          generatedAt: '2026-11-21T14:01:00.000Z',
          nodeVersion: 'v22.11.0',
          uptimeSec: 185,
          environment: 'production',
          status: 'ready',
          readiness: {
            ready: true,
            checks: {
              video_detector: 'ready',
              airport_registry: 'ready',
              camera_access: 'ready',
              tower_access: 'ready',
              receipt_storage: 'ready',
              receipt_recovery: 'ready',
            },
          },
          envChecklist: {
            AIRPORT_CODES: { label: 'Airport Registry', required: true, configured: true, valid: true, detail: '1 airport configured' },
            BIRD_JUDGE: { label: 'Local AI Model & Bird Judge', required: false, configured: true, valid: true, mode: 'local_ai_model', detail: 'Local AI Model active' },
          },
          remediation: [],
        },
      },
    ];

    const mockFetch = async (_url, opts) => {
      const next = payloads[Math.min(callCount, payloads.length - 1)];
      callCount++;
      assert.equal(opts.headers.authorization, 'Bearer test-admin-jwt');
      return {
        status: next.status,
        ok: next.status >= 200 && next.status < 300,
        json: async () => next.body,
      };
    };

    const controller = mountAdminDiagnostics(diagPanel, {
      document: doc,
      immediate: false,
      fetch: mockFetch,
      getToken: async () => 'test-admin-jwt',
    });

    assert.equal(diagPanel.hidden, false);

    // First refresh receives HTTP 503 degraded JSON and renders full subsystem details (not a generic error)
    await controller.refresh();
    assert.equal(callCount, 1);

    const badge503 = diagPanel.findFirst(n => n.classList.contains('diag-badge'));
    assert.ok(badge503);
    assert.equal(badge503.textContent, 'DEGRADED');
    assert.equal(badge503.getAttribute('data-state'), 'degraded');

    const recoveryItem = diagPanel.findFirst(n => n.getAttribute('data-check') === 'receipt_recovery');
    assert.ok(recoveryItem);
    assert.equal(recoveryItem.getAttribute('data-status'), 'unavailable');

    const html503 = diagPanel.outerHTML;
    // XSS payloads must be HTML-escaped text, never live elements
    assert.equal(diagPanel.findAll(n => n.tagName === 'SCRIPT' || n.tagName === 'IMG').length, 0);
    assert.equal(html503.includes('<script>'), false);
    assert.equal(html503.includes('<img'), false);
    assert.equal(html503.includes('&lt;script&gt;'), true);
    // Zero "gemini" strings anywhere in rendered HTML
    assert.equal(/gemini/i.test(html503), false, `Expected zero "gemini" strings in HTML, got: ${html503}`);

    // Click Refresh button -> transitions to HTTP 200 READY
    const refreshBtn = diagPanel.findFirst(n => n.classList.contains('diag-refresh-btn'));
    assert.ok(refreshBtn);
    refreshBtn.click();
    // Wait for async click handler completion
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(callCount, 2);
    const badge200 = diagPanel.findFirst(n => n.classList.contains('diag-badge'));
    assert.equal(badge200.textContent, 'READY');
    assert.equal(badge200.getAttribute('data-state'), 'ready');
    assert.equal(/gemini/i.test(diagPanel.outerHTML), false);

    // destroy() detaches click listeners and stops subsequent refreshes
    const btnAfter200 = diagPanel.findFirst(n => n.classList.contains('diag-refresh-btn'));
    assert.equal(btnAfter200.listenerCount('click'), 1);
    controller.destroy();
    assert.equal(btnAfter200.listenerCount('click'), 0);
    btnAfter200.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callCount, 2);
    assert.equal(await controller.refresh(), null);
  });
});

/* ========================================================================== *
 *  4. DigitalOcean Production Boot Resilience & Container Isolation          *
 * ========================================================================== */

const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { runInNewContext } = require('node:vm');

async function getFreePort() {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  await new Promise(resolve => srv.close(resolve));
  return port;
}

async function bootServerInVm(t, envOverrides, moduleOverrides = {}) {
  const timers = new Set();
  const logs = [];
  let server;
  let boundPort;
  let boundHost;
  let shutdown;
  let stopping;

  const capture = (...args) => logs.push(args.map(String).join(' '));
  const overrides = {
    http: {
      ...http,
      createServer(app) {
        server = http.createServer(app);
        const origListen = server.listen.bind(server);
        server.listen = (port, host, callback) => {
          boundPort = port;
          boundHost = host;
          return origListen(0, '127.0.0.1', callback);
        };
        return server;
      },
    },
    './ai-voice/pipeline': {
      createPipeline: () => ({
        health: () => ({ gemini: { state: 'not_configured', failure: null, lastSuccess: null } }),
        status: () => ({ solana: 'not_configured' }),
      }),
    },
    './ai-voice/solana': {
      createSolana: () => ({
        stampReport: async () => ({ hash: '0'.repeat(64), tx: null, status: 'hash only', error: null }),
        verifyReport: async () => { throw new Error('unused'); },
        health: () => ({ configured: false }),
      }),
    },
    ...moduleOverrides,
  };

  const serverSource = await fs.promises.readFile(path.join(pranavRoot, 'server.js'), 'utf8');
  const childEnv = { ...envOverrides };

  // Clear cachedai-voice/config so redact() reads childEnv cleanly when loaded with childEnv
  const origProcessEnv = process.env;
  process.env = childEnv;
  delete require.cache[require.resolve('../ai-voice/config')];
  try {
    runInNewContext(serverSource, {
      __dirname: pranavRoot,
      require: name => overrides[name] ?? require(name.startsWith('.') ? path.join(pranavRoot, name) : name),
      process: {
        env: childEnv,
        platform: process.platform,
        version: process.version,
        loadEnvFile() {},
        uptime: () => 1,
        once(name, fn) { if (name === 'SIGTERM') shutdown = fn; },
        exit() {},
      },
      Buffer,
      URL,
      performance,
      setTimeout,
      clearTimeout,
      clearInterval,
      setInterval(fn, ms) {
        const timer = setInterval(fn, ms);
        timers.add(timer);
        return timer;
      },
      console: { log: capture, warn: capture, error: capture },
    });
  } finally {
    process.env = origProcessEnv;
    delete require.cache[require.resolve('../ai-voice/config')];
  }

  t.after(() => stopping ??= (async () => {
    for (const timer of timers) clearInterval(timer);
    if (shutdown) await shutdown();
    else if (server?.listening) await new Promise(resolve => server.close(resolve));
  })());

  if (!server.address()) await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    boundPort,
    boundHost,
    logs,
    request: (routePath, init = {}) => fetch(baseUrl + routePath, { signal: AbortSignal.timeout(8000), ...init }),
  };
}

describe('DigitalOcean production startup resilience & source_dir isolation', () => {
  test('real server.js subprocess boots in isolated source_dir: PRANAV (no ../Shreyansh Local Ai Model) under PR #57 unbound-key env and fails closed', async t => {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skysentry-do-iso-'));
    const isolatedPranav = path.join(tmpRoot, 'PRANAV');
    await fs.promises.mkdir(path.join(isolatedPranav, 'ai-voice'), { recursive: true });

    // Copy runtime files into isolated PRANAV/ while keeping ../Shreyansh Local Ai Model absent.
    for (const entry of await fs.promises.readdir(pranavRoot, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:js|mjs|cjs|json)$/.test(entry.name)) {
        await fs.promises.copyFile(path.join(pranavRoot, entry.name), path.join(isolatedPranav, entry.name));
      }
    }
    for (const entry of await fs.promises.readdir(path.join(pranavRoot, 'ai-voice'), { withFileTypes: true })) {
      if (entry.isFile()) {
        await fs.promises.copyFile(
          path.join(pranavRoot, 'ai-voice', entry.name),
          path.join(isolatedPranav, 'ai-voice', entry.name)
        );
      }
    }
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.promises.symlink(path.join(pranavRoot, 'node_modules'), path.join(isolatedPranav, 'node_modules'), symlinkType);
    await fs.promises.symlink(path.join(pranavRoot, 'public'), path.join(isolatedPranav, 'public'), symlinkType);

    assert.equal(fs.existsSync(path.join(tmpRoot, 'Shreyansh Local Ai Model')), false);

    const port = await getFreePort();
    const canaryCamSecret = 'DO57_UNBOUND_CAM_SECRET_8899aabbccdd';
    const canaryClerkSecret = 'sk_test_DO57_CLERK_SECRET_11223344';
    let combinedLogs = '';

    const child = spawn(process.execPath, ['server.js'], {
      cwd: isolatedPranav,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT || '',
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        CAMERA_API_KEY: canaryCamSecret,
        CAMERA_API_AIRPORT: '',
        AIRPORT_CODES: '',
        CLERK_SECRET_KEY: canaryClerkSecret,
        CLERK_PUBLISHABLE_KEY: 'pk_test_DO57_CLERK_PUB_11223344',
        MONGODB_URI: 'mongodb://127.0.0.1:1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    t.after(async () => {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit').catch(() => {});
      }
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for server boot. Logs:\n${combinedLogs}`)), 10_000);
      const onChunk = chunk => {
        combinedLogs += chunk.toString('utf8');
        if (combinedLogs.includes(`server listening on http://127.0.0.1:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`server.js exited prematurely with code ${code}. Logs:\n${combinedLogs}`));
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const healthRes = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8000) });
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.status, 'ok');

    const readyRes = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(8000) });
    assert.equal(readyRes.status, 503);
    const readyBody = await readyRes.json();
    assert.equal(readyBody.status, 'not_ready');
    assert.equal(readyBody.checks.camera_access, 'degraded');

    // Public pages and isolated model tier routes all work without ../Shreyansh Local Ai Model
    for (const pagePath of ['/', '/app.html', '/tower.html', '/camera.html', '/admin.html']) {
      const res = await fetch(`${baseUrl}${pagePath}`, { signal: AbortSignal.timeout(8000) });
      assert.equal(res.status, 200, `Expected 200 for ${pagePath}, got ${res.status}`);
    }

    const tiersRes = await fetch(`${baseUrl}/api/models/local-tiers`, { signal: AbortSignal.timeout(8000) });
    assert.equal(tiersRes.status, 200);
    const tiersBody = await tiersRes.json();
    const v41 = tiersBody.tiers.find(tier => tier.id === 'v4.1');
    const v5 = tiersBody.tiers.find(tier => tier.id === 'v5');
    assert.equal(v41.available, true);
    assert.equal(v5.available, false);
    assert.equal(v5.reason, 'missing');

    const onnxRes = await fetch(`${baseUrl}/ai-models/skysentry_v5.onnx`, { signal: AbortSignal.timeout(8000) });
    assert.equal(onnxRes.status, 404);

    // Unbound CAMERA_API_KEY must NEVER authenticate for any airport (100% fail-closed)
    for (const airportHeader of ['KPCT', '']) {
      const camRes = await fetch(`${baseUrl}/api/camera-config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': canaryCamSecret,
          'x-airport': airportHeader,
          'x-camera-source': 'live',
          'x-camera-device': crypto.randomUUID(),
          'x-camera-session': crypto.randomUUID(),
        },
        body: JSON.stringify({ source: 'live' }),
        signal: AbortSignal.timeout(8000),
      });
      assert.equal(camRes.status, 403);
    }

    assert.equal(combinedLogs.includes(canaryCamSecret), false, 'Startup logs must not leak CAMERA_API_KEY');
    assert.equal(combinedLogs.includes(canaryClerkSecret), false, 'Startup logs must not leak CLERK_SECRET_KEY');
  });

  test('zero-env production boot binds 0.0.0.0:8080, serves / and /health 200, /ready 503, and fails closed on protected routes', async t => {
    const srv = await bootServerInVm(t, { NODE_ENV: 'production' });
    assert.equal(srv.boundHost, '0.0.0.0');
    assert.equal(Number(srv.boundPort), 8080);

    const [healthRes, readyRes, homeRes, camRes, hourlyRes, authCfgRes] = await Promise.all([
      srv.request('/health'),
      srv.request('/ready'),
      srv.request('/'),
      srv.request('/api/camera-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'live' }),
      }),
      srv.request('/api/hourly?airport=KPCT'),
      srv.request('/api/auth/config'),
    ]);

    assert.equal(healthRes.status, 200);
    assert.equal(readyRes.status, 503);
    const readyJson = await readyRes.json();
    assert.equal(readyJson.checks.camera_access, 'not_configured');
    assert.equal(readyJson.checks.tower_access, 'not_configured');
    assert.equal(homeRes.status, 200);
    assert.equal(camRes.status, 403);
    assert.equal(hourlyRes.status, 403);
    assert.deepEqual(await authCfgRes.json(), { publishableKey: null, demoTower: false });
  });

  test('duplicate keys, partial Clerk key, malformed MONGODB_URI, and malformed SURVEYED_CORRIDORS_JSON never crash startup and stay fail-closed', async t => {
    const dupSecret = 'DUP_KEY_SECRET_998877665544';
    const badMongoSecret = 'not-a-valid-mongo-uri-secret-token-777';
    const partialClerkSecret = 'sk_test_SINGLE_CLERK_SECRET_555';

    const srv = await bootServerInVm(t, {
      NODE_ENV: 'production',
      AIRPORT_CODES: 'KPCT=kpct-join-4821',
      CAMERA_API_KEY: dupSecret,
      CAMERA_API_AIRPORT: 'KPCT',
      TOWER_API_KEY: dupSecret,
      TOWER_API_AIRPORT: 'KPCT',
      CLERK_SECRET_KEY: partialClerkSecret,
      MONGODB_URI: badMongoSecret,
      SURVEYED_CORRIDORS_JSON: '{bad json',
    });

    const joinedLogs = srv.logs.join('\n');
    assert.equal(joinedLogs.includes(dupSecret), false);
    assert.equal(joinedLogs.includes(badMongoSecret), false);
    assert.equal(joinedLogs.includes(partialClerkSecret), false);

    const healthRes = await srv.request('/health');
    assert.equal(healthRes.status, 200);

    const readyRes = await srv.request('/ready');
    assert.equal(readyRes.status, 503);
    const readyBody = await readyRes.json();
    assert.equal(readyBody.checks.camera_access, 'not_configured');
    assert.equal(readyBody.checks.tower_access, 'not_configured');
    assert.equal(readyBody.checks.receipt_storage, 'not_configured');

    // Duplicate key must be rejected on both camera and tower routes
    const camRes = await srv.request('/api/camera-config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': dupSecret,
        'x-airport': 'KPCT',
        'x-camera-source': 'live',
        'x-camera-device': crypto.randomUUID(),
        'x-camera-session': crypto.randomUUID(),
      },
      body: JSON.stringify({ source: 'live' }),
    });
    assert.equal(camRes.status, 403);

    const towerRes = await srv.request('/api/hourly?airport=KPCT', {
      headers: { 'x-api-key': dupSecret },
    });
    assert.equal(towerRes.status, 403);
  });

  test('properly bound CAMERA_API_KEY and TOWER_API_KEY report camera_access and tower_access ready and enforce single-airport scope', async t => {
    const camSecret = 'BOUND_CAM_SECRET_111122223333';
    const towerSecret = 'BOUND_TOWER_SECRET_444455556666';

    const srv = await bootServerInVm(t, {
      NODE_ENV: 'production',
      AIRPORT_CODES: 'KPCT=kpct-join-4821,KTTN=kttn-join-9310',
      CAMERA_API_KEY: camSecret,
      CAMERA_API_AIRPORT: 'KPCT',
      TOWER_API_KEY: towerSecret,
      TOWER_API_AIRPORT: 'KPCT',
    });

    const readyRes = await srv.request('/ready');
    assert.equal(readyRes.status, 503); // ephemeral container has no RECEIPT_SPOOL_FILE or MongoDB
    const readyBody = await readyRes.json();
    assert.equal(readyBody.checks.video_detector, 'ready');
    assert.equal(readyBody.checks.airport_registry, 'ready');
    assert.equal(readyBody.checks.camera_access, 'ready');
    assert.equal(readyBody.checks.tower_access, 'ready');

    const okTowerRes = await srv.request('/api/hourly?airport=KPCT', {
      headers: { 'x-api-key': towerSecret },
    });
    assert.equal(okTowerRes.status, 200);

    const wrongAirportTowerRes = await srv.request('/api/hourly?airport=KTTN', {
      headers: { 'x-api-key': towerSecret },
    });
    assert.equal(wrongAirportTowerRes.status, 403);

    const wrongAirportCamRes = await srv.request('/api/camera-config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': camSecret,
        'x-airport': 'KTTN',
        'x-camera-source': 'live',
        'x-camera-device': crypto.randomUUID(),
        'x-camera-session': crypto.randomUUID(),
      },
      body: JSON.stringify({ source: 'live' }),
    });
    assert.equal(wrongAirportCamRes.status, 403);

    const okCamRes = await srv.request('/api/camera-config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': camSecret,
        'x-airport': 'KPCT',
        'x-camera-source': 'live',
        'x-camera-device': crypto.randomUUID(),
        'x-camera-session': crypto.randomUUID(),
      },
      body: JSON.stringify({ source: 'live' }),
    });
    assert.equal(okCamRes.status, 200);
    assert.equal((await okCamRes.json()).ok, true);
  });

  test('production Clerk pair without MONGODB_URI keeps /api/auth/config sign-in active while /api/auth/join, /ready, unbound keys, and malformed MONGODB_URI fail closed', async t => {
    const pubKey = 'pk_test_live_do_clerk_98765';
    const secKey = 'sk_test_live_do_clerk_98765';
    const unboundCamKey = 'UNBOUND_DO_CAM_SECRET_445566';

    const mockClerkModule = {
      createClerkClient: () => ({
        users: {
          getCount: async () => 1,
          getUser: async sub => sub === 'admin-1'
            ? {
                publicMetadata: {},
                emailAddresses: [{ emailAddress: 'admin@skysentry.org', verification: { status: 'verified' } }],
              }
            : {
                publicMetadata: { role: 'dashboard', airport: 'KPCT' },
                emailAddresses: [{ emailAddress: 'tower@skysentry.org', verification: { status: 'verified' } }],
              },
        },
        sessions: {
          getSession: async sid => ({ status: 'active', userId: sid }),
        },
      }),
      verifyToken: async token => ({ sub: token, sid: token }),
    };

    // 1. Live DigitalOcean shape: CLERK_* set, MONGODB_URI="" (unset), CAMERA_API_KEY unbound
    const liveDoSrv = await bootServerInVm(
      t,
      {
        NODE_ENV: 'production',
        AIRPORT_CODES: 'KPCT=kpct-join-4821',
        CAMERA_API_KEY: unboundCamKey,
        CAMERA_API_AIRPORT: '',
        CLERK_PUBLISHABLE_KEY: pubKey,
        CLERK_SECRET_KEY: secKey,
        ADMIN_EMAILS: 'admin@skysentry.org',
        MONGODB_URI: '',
      },
      { '@clerk/express': mockClerkModule }
    );

    const authConfigRes = await liveDoSrv.request('/api/auth/config');
    assert.equal(authConfigRes.status, 200);
    assert.deepEqual(await authConfigRes.json(), { publishableKey: pubKey, demoTower: false });

    // Verified admin and fixed-airport Clerk users can sign in when MONGODB_URI is unset
    const adminMeRes = await liveDoSrv.request('/api/auth/me', {
      headers: { authorization: 'Bearer admin-1' },
    });
    assert.equal(adminMeRes.status, 200);
    assert.equal((await adminMeRes.json()).admin, true);

    const dashHourlyRes = await liveDoSrv.request('/api/hourly?airport=KPCT', {
      headers: { authorization: 'Bearer tower-1' },
    });
    assert.equal(dashHourlyRes.status, 200);

    // /api/auth/join refuses with 503 because MongoDB is not configured
    const joinRes = await liveDoSrv.request('/api/auth/join', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tower-1',
      },
      body: JSON.stringify({ role: 'dashboard', code: 'kpct-join-4821' }),
    });
    assert.equal(joinRes.status, 503);

    // /ready returns 503 and unbound CAMERA_API_KEY fails closed with 403
    const readyRes = await liveDoSrv.request('/ready');
    assert.equal(readyRes.status, 503);
    const readyBody = await readyRes.json();
    assert.equal(readyBody.checks.camera_access, 'not_configured');
    assert.equal(readyBody.checks.tower_access, 'not_configured');

    const camRes = await liveDoSrv.request('/api/camera-config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': unboundCamKey,
        'x-airport': 'KPCT',
        'x-camera-source': 'live',
        'x-camera-device': crypto.randomUUID(),
        'x-camera-session': crypto.randomUUID(),
      },
      body: JSON.stringify({ source: 'live' }),
    });
    assert.equal(camRes.status, 403);

    // 2. If MONGODB_URI IS set but malformed (mongo === null), clerkAccess fails closed (401) so role_requests cannot be bypassed
    const brokenMongoSrv = await bootServerInVm(
      t,
      {
        NODE_ENV: 'production',
        AIRPORT_CODES: 'KPCT=kpct-join-4821',
        CLERK_PUBLISHABLE_KEY: pubKey,
        CLERK_SECRET_KEY: secKey,
        ADMIN_EMAILS: 'admin@skysentry.org',
        MONGODB_URI: 'not-a-valid-mongo-uri',
      },
      { '@clerk/express': mockClerkModule }
    );

    const brokenMeRes = await brokenMongoSrv.request('/api/auth/me', {
      headers: { authorization: 'Bearer admin-1' },
    });
    assert.equal(brokenMeRes.status, 401);
  });
});
