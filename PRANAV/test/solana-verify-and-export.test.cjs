'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createSolanaVerifyHandler } = require('../solana-verify-route');
const {
  createSolana,
  hashReport,
  explorerUrl,
  DEVNET_GENESIS,
  MEMO_PROGRAM,
} = require('../ai-voice/solana');

const PROOF_DRAWER_URL = pathToFileURL(
  path.join(__dirname, '../public/js/solana-proof-drawer.mjs'),
).href;
const EXPORT_URL = pathToFileURL(
  path.join(__dirname, '../public/js/shift-report-export.mjs'),
).href;

let esmPromise = null;
function loadEsmModules() {
  if (!esmPromise) {
    esmPromise = Promise.all([import(PROOF_DRAWER_URL), import(EXPORT_URL)]).then(
      ([proofMod, exportMod]) => ({ proofMod, exportMod }),
    );
  }
  return esmPromise;
}

const VALID_SIG = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d123456789ABCDEFGHJKLMNPQRS';

/* ---------- Mock Express req/res & lightweight DOM helpers ---------- */

function createMockRes() {
  const headers = new Map();
  const res = {
    statusCode: 200,
    body: undefined,
    headers,
    set(key, val) {
      headers.set(String(key).toLowerCase(), String(val));
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function createMockDom() {
  function createElement(tag) {
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      ownerDocument: null,
      parentNode: null,
      className: '',
      textContent: '',
      href: '',
      download: '',
      target: '',
      rel: '',
      type: '',
      hidden: false,
      disabled: false,
      dataset: {},
      children: [],
      classList: {
        add(...names) { for (const n of names) if (n) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); },
      },
      setAttribute(name, val) {
        const k = String(name).toLowerCase();
        const v = String(val);
        attrs.set(k, v);
        if (k === 'class') {
          classes.clear();
          for (const part of v.split(/\s+/).filter(Boolean)) classes.add(part);
          this.className = v;
        }
      },
      getAttribute(name) {
        return attrs.get(String(name).toLowerCase()) ?? null;
      },
      removeAttribute(name) {
        attrs.delete(String(name).toLowerCase());
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      listenerCount(type) {
        return listeners.get(type)?.size ?? 0;
      },
      click() {
        const set = listeners.get('click');
        if (set) for (const fn of [...set]) fn({ type: 'click', target: this });
      },
      append(...nodes) {
        for (const n of nodes) {
          if (n && typeof n === 'object') {
            n.parentNode = this;
            this.children.push(n);
          }
        }
      },
      appendChild(node) {
        if (node && typeof node === 'object') {
          node.parentNode = this;
          this.children.push(node);
        }
        return node;
      },
      replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
      },
      remove() {
        if (this.parentNode && Array.isArray(this.parentNode.children)) {
          const idx = this.parentNode.children.indexOf(this);
          if (idx !== -1) this.parentNode.children.splice(idx, 1);
        }
        this.parentNode = null;
      },
    };
    return el;
  }

  const doc = {
    body: null,
    createElement(tag) {
      const el = createElement(tag);
      el.ownerDocument = doc;
      return el;
    },
  };
  doc.body = doc.createElement('body');
  return doc;
}

function findNode(root, predicate) {
  if (!root || typeof root !== 'object') return null;
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

/* ========================================================================== *
 *  1. PRANAV/solana-verify-route.js Suite                                    *
 * ========================================================================== */

describe('solana-verify-route.js (createSolanaVerifyHandler)', () => {
  test('validates required handler dependencies', () => {
    assert.throws(() => createSolanaVerifyHandler({}), TypeError);
    assert.throws(
      () => createSolanaVerifyHandler({ findIncident: async () => null, hashReport: null }),
      TypeError,
    );
    assert.throws(
      () => createSolanaVerifyHandler({ findIncident: async () => null, explorerUrl: null }),
      TypeError,
    );
  });

  test('enforces Cache-Control: private, no-store, airport scoping (403/404), invalid IDs (404), and store errors (503)', async () => {
    const incidents = new Map([
      ['inc_jfk_1', { _id: 'inc_jfk_1', airport: 'KJFK', report: 'Drone hovering near 04L.' }],
      ['inc_ewr_1', { _id: 'inc_ewr_1', airport: 'KEWR', report: 'Flock of geese.' }],
    ]);

    const handler = createSolanaVerifyHandler({
      findIncident: async id => {
        if (id === 'db_boom') throw new Error('mongo down');
        return incidents.get(id) || null;
      },
    });

    // Missing req.airport -> 403
    const res403 = createMockRes();
    await handler({ airport: '  ', params: { id: 'inc_jfk_1' }, ip: '10.0.0.1' }, res403);
    assert.equal(res403.statusCode, 403);
    assert.equal(res403.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(res403.body, { error: 'airport authorization required' });

    // Invalid ID characters -> 404 (also verify setHeader fallback)
    const setHeaderCalls = {};
    const resSetHeader = {
      statusCode: 200,
      body: null,
      setHeader(k, v) { setHeaderCalls[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await handler({ airport: 'KJFK', params: { id: '../etc/passwd' }, ip: '10.0.0.1' }, resSetHeader);
    assert.equal(resSetHeader.statusCode, 404);
    assert.equal(setHeaderCalls['cache-control'], 'private, no-store');

    // Cross-airport query (KJFK caller asking for KEWR incident) -> 404
    const resCross = createMockRes();
    await handler({ airport: 'KJFK', params: { id: 'inc_ewr_1' }, ip: '10.0.0.1' }, resCross);
    assert.equal(resCross.statusCode, 404);
    assert.deepEqual(resCross.body, { error: 'incident not found' });

    // Store exception -> 503
    const res503 = createMockRes();
    await handler({ airport: 'KJFK', params: { id: 'db_boom' }, ip: '10.0.0.1' }, res503);
    assert.equal(res503.statusCode, 503);
    assert.deepEqual(res503.body, { error: 'incident store unavailable' });
  });

  test('enforces per-airport-and-IP rate limiting (429)', async () => {
    const counts = new Map();
    const handler = createSolanaVerifyHandler({
      findIncident: async () => ({ _id: 'inc_1', airport: 'KJFK', report: 'Test report' }),
      rateLimit: key => {
        const next = (counts.get(key) || 0) + 1;
        counts.set(key, next);
        return next <= 2;
      },
    });

    const mkReq = (airport, ip) => ({
      airport,
      params: { id: 'inc_1' },
      headers: { 'do-connecting-ip': ip },
    });

    const r1 = createMockRes();
    const r2 = createMockRes();
    const r3 = createMockRes();
    await handler(mkReq('KJFK', '203.0.113.5'), r1);
    await handler(mkReq('KJFK', '203.0.113.5'), r2);
    await handler(mkReq('KJFK', '203.0.113.5'), r3);

    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    assert.equal(r3.statusCode, 429);
    assert.equal(r3.body.status, 'rate_limited');

    // Different IP remains unaffected
    const rOtherIp = createMockRes();
    await handler(mkReq('KJFK', '203.0.113.9'), rOtherIp);
    assert.equal(rOtherIp.statusCode, 200);
  });

  test('handles missing report (409), hash_only, verified_on_chain, tampered hash_mismatch, invalid sig, and RPC timeout fallback', async () => {
    const cleanReport = 'RED UAS alert at KJFK approach corridor.';
    const expectedHash = hashReport(cleanReport);
    const tamperedChainHash = hashReport('ORIGINAL UNMODIFIED REPORT BEFORE DB TAMPER');

    // Also verify real createSolana.verifyReport integration against a mocked Devnet RPC connection
    const solanaLive = createSolana({
      settings: { SOLANA_SECRET_KEY: '', SOLANA_RPC_URL: 'https://api.devnet.solana.com', redact: s => String(s) },
      timeoutMs: 200,
      connection: {
        getGenesisHash: async () => DEVNET_GENESIS,
        getParsedTransaction: async sig => ({
          meta: { err: null },
          transaction: {
            message: {
              instructions: [
                {
                  programId: MEMO_PROGRAM,
                  parsed: sig === VALID_SIG ? expectedHash : tamperedChainHash,
                },
              ],
            },
          },
        }),
      },
    });

    const secondValidSig = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T123456789ABCDEFGHJKLMNPQRS';

    const store = new Map([
      ['no_report', { _id: 'no_report', airport: 'KJFK', report: '   ' }],
      ['hash_only_inc', { _id: 'hash_only_inc', airport: 'KJFK', report: cleanReport, solana_tx: null }],
      ['verified_inc', { _id: 'verified_inc', airport: 'KJFK', report: cleanReport, solana_tx: VALID_SIG }],
      ['tampered_inc', { _id: 'tampered_inc', airport: 'KJFK', report: cleanReport, solana_tx: secondValidSig }],
      ['bad_sig_inc', { _id: 'bad_sig_inc', airport: 'KJFK', report: cleanReport, solana_tx: '0OIl_invalid_base58_sig' }],
    ]);

    const handler = createSolanaVerifyHandler({
      findIncident: async id => store.get(id) || null,
      solana: solanaLive,
      rateLimit: null,
    });

    // 1. Missing report -> 409
    const res409 = createMockRes();
    await handler({ airport: 'KJFK', params: { id: 'no_report' } }, res409);
    assert.equal(res409.statusCode, 409);
    assert.equal(res409.body.status, 'report_unavailable');
    assert.equal(res409.body.reportHash, null);

    // 2. hash_only -> 200
    const resHashOnly = createMockRes();
    await handler({ airport: 'KJFK', params: { id: 'hash_only_inc' } }, resHashOnly);
    assert.equal(resHashOnly.statusCode, 200);
    assert.deepEqual(resHashOnly.body, {
      status: 'hash_only',
      matches: null,
      reportHash: expectedHash,
      onChainHash: null,
      tx: null,
    });

    // 3. verified_on_chain -> 200
    const resVerified = createMockRes();
    await handler({ airport: 'KJFK', params: { id: 'verified_inc' } }, resVerified);
    assert.equal(resVerified.statusCode, 200);
    assert.deepEqual(resVerified.body, {
      status: 'verified_on_chain',
      matches: true,
      chainStatus: 'confirmed',
      reportHash: expectedHash,
      onChainHash: expectedHash,
      tx: VALID_SIG,
      explorer: explorerUrl(VALID_SIG),
    });

    // 4. Tampered report -> hash_mismatch -> 200
    const resMismatch = createMockRes();
    await handler({ airport: 'KJFK', params: { id: 'tampered_inc' } }, resMismatch);
    assert.equal(resMismatch.statusCode, 200);
    assert.equal(resMismatch.body.status, 'hash_mismatch');
    assert.equal(resMismatch.body.matches, false);
    assert.equal(resMismatch.body.reportHash, expectedHash);
    assert.equal(resMismatch.body.onChainHash, tamperedChainHash);

    // 5. Invalid signature -> rpc_unavailable with chainStatus: 'invalid_signature' and null tx/explorer
    const resBadSig = createMockRes();
    await handler({ airport: 'KJFK', params: { id: 'bad_sig_inc' } }, resBadSig);
    assert.equal(resBadSig.statusCode, 200);
    assert.deepEqual(resBadSig.body, {
      status: 'rpc_unavailable',
      matches: false,
      chainStatus: 'invalid_signature',
      reportHash: expectedHash,
      onChainHash: null,
      tx: null,
      explorer: null,
    });

    // 6. RPC timeout / exception -> rpc_unavailable fallback with preserved devnet explorer link
    const timeoutHandler = createSolanaVerifyHandler({
      findIncident: async () => store.get('verified_inc'),
      solana: {
        verifyReport: async () => {
          const err = new Error('Solana request timed out');
          err.code = 'SOLANA_TIMEOUT';
          throw err;
        },
      },
      rateLimit: null,
    });
    const resTimeout = createMockRes();
    await timeoutHandler({ airport: 'KJFK', params: { id: 'verified_inc' } }, resTimeout);
    assert.equal(resTimeout.statusCode, 200);
    assert.deepEqual(resTimeout.body, {
      status: 'rpc_unavailable',
      matches: false,
      chainStatus: 'unavailable',
      reportHash: expectedHash,
      onChainHash: null,
      tx: VALID_SIG,
      explorer: explorerUrl(VALID_SIG),
    });
  });
});

/* ========================================================================== *
 *  2. PRANAV/public/js/solana-proof-drawer.mjs Suite                         *
 * ========================================================================== */

describe('solana-proof-drawer.mjs', () => {
  test('computes WebCrypto SHA-256 and validates Devnet Explorer URLs strictly', async () => {
    const { proofMod } = await loadEsmModules();
    const { computeReportSha256Hex, buildDevnetExplorerUrl } = proofMod;

    const sample = 'UAS quadcopter observed 400m SW of threshold 22R.';
    const expected = crypto.createHash('sha256').update(sample, 'utf8').digest('hex');
    const actual = await computeReportSha256Hex(sample, { subtle: crypto.webcrypto.subtle });
    assert.equal(actual, expected);

    assert.equal(await computeReportSha256Hex(sample, { subtle: null }), null);
    assert.equal(
      await computeReportSha256Hex(sample, {
        subtle: { digest: async () => { throw new Error('unavailable'); } },
      }),
      null,
    );

    assert.equal(
      buildDevnetExplorerUrl(VALID_SIG),
      `https://explorer.solana.com/tx/${VALID_SIG}?cluster=devnet`,
    );
    assert.equal(buildDevnetExplorerUrl('javascript:alert(1)'), null);
    assert.equal(buildDevnetExplorerUrl('shortSig123'), null);
    assert.equal(buildDevnetExplorerUrl('0'.repeat(64)), null); // '0' is excluded from base58
  });

  test('renders verified_on_chain, client-side & server hash_mismatch, hash_only, rpc_unavailable, and aborts on destroy()', async () => {
    const { proofMod } = await loadEsmModules();
    const { mountSolanaProofDrawer } = proofMod;
    const doc = createMockDom();
    const subtle = crypto.webcrypto.subtle;

    const authenticReport = 'Confirmed drone alert near KJFK Runway 31L.';
    const authenticHash = hashReport(authenticReport);

    // 1. verified_on_chain + Devnet Explorer link
    const container1 = doc.createElement('div');
    const drawer1 = mountSolanaProofDrawer(
      container1,
      {
        _id: 'inc_v1',
        airport: 'KJFK',
        report: authenticReport,
        report_hash: authenticHash,
        solana_tx: VALID_SIG,
      },
      {
        subtle,
        fetchImpl: async url => {
          assert.match(url, /\/api\/incidents\/inc_v1\/verify-solana\?airport=KJFK$/);
          return {
            ok: true,
            json: async () => ({
              status: 'verified_on_chain',
              matches: true,
              reportHash: authenticHash,
              onChainHash: authenticHash,
              tx: VALID_SIG,
            }),
          };
        },
      },
    );

    const state1 = await drawer1.verify();
    assert.equal(state1.status, 'verified_on_chain');
    assert.equal(state1.matches, true);
    assert.equal(state1.localHash, authenticHash);
    assert.equal(drawer1.card.getAttribute('data-proof-status'), 'verified_on_chain');

    const linkNode = findNode(drawer1.card, n => n.classList?.contains('sky-proof-link'));
    assert.ok(linkNode, 'expected Solana Devnet Explorer anchor');
    assert.equal(linkNode.href, `https://explorer.solana.com/tx/${VALID_SIG}?cluster=devnet`);
    assert.equal(linkNode.rel, 'noopener noreferrer');
    assert.equal(linkNode.target, '_blank');

    // 2. Client-side tamper detection: server claims verified_on_chain for original hash,
    //    but local incident.report text in the browser was altered!
    const containerTampered = doc.createElement('div');
    const drawerTampered = mountSolanaProofDrawer(
      containerTampered,
      {
        _id: 'inc_tamper',
        airport: 'KJFK',
        report: 'TAMPERED IN CLIENT MEMORY: bird instead of drone.',
        report_hash: authenticHash,
        solana_tx: VALID_SIG,
      },
      {
        subtle,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            status: 'verified_on_chain',
            matches: true,
            reportHash: authenticHash,
            onChainHash: authenticHash,
            tx: VALID_SIG,
          }),
        }),
      },
    );

    const stateTampered = await drawerTampered.verify();
    assert.equal(stateTampered.status, 'hash_mismatch');
    assert.equal(stateTampered.matches, false);
    assert.notEqual(stateTampered.localHash, authenticHash);
    assert.equal(drawerTampered.card.getAttribute('data-proof-status'), 'hash_mismatch');

    // 3. hash_only (no Solana transaction stamped)
    const containerHashOnly = doc.createElement('div');
    const drawerHashOnly = mountSolanaProofDrawer(
      containerHashOnly,
      { _id: 'inc_ho', airport: 'KJFK', report: authenticReport },
      {
        subtle,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            status: 'hash_only',
            matches: null,
            reportHash: authenticHash,
            onChainHash: null,
            tx: null,
          }),
        }),
      },
    );
    const stateHashOnly = await drawerHashOnly.verify();
    assert.equal(stateHashOnly.status, 'hash_only');
    assert.equal(stateHashOnly.matches, true);
    assert.equal(stateHashOnly.explorerUrl, null);
    assert.equal(findNode(drawerHashOnly.card, n => n.classList?.contains('sky-proof-link')), null);

    // 4. rpc_unavailable on network failure + abort/teardown on destroy()
    const containerAbort = doc.createElement('div');
    let capturedSignal = null;
    let resolveFetch = null;
    const drawerAbort = mountSolanaProofDrawer(
      containerAbort,
      { _id: 'inc_abort', airport: 'KJFK', report: authenticReport, solana_tx: VALID_SIG },
      {
        subtle,
        fetchImpl: (_url, init) => {
          capturedSignal = init.signal;
          return new Promise(resolve => { resolveFetch = resolve; });
        },
      },
    );

    const pendingVerify = drawerAbort.verify();
    // Wait a microtask so fetchServerProof registers its signal
    await Promise.resolve();
    assert.ok(capturedSignal, 'expected AbortSignal passed to fetch');
    assert.equal(capturedSignal.aborted, false);

    drawerAbort.destroy();
    assert.equal(capturedSignal.aborted, true);
    assert.equal(containerAbort.children.length, 0);
    assert.equal(drawerAbort.button.listenerCount('click'), 0);

    resolveFetch({ ok: false });
    await pendingVerify;
  });
});

/* ========================================================================== *
 *  3. PRANAV/public/js/shift-report-export.mjs Suite                         *
 * ========================================================================== */

describe('shift-report-export.mjs', () => {
  test('neutralizes OWASP CSV formula triggers (=, +, -, @, \\t, \\r), quotes RFC 4180 cells, and scopes by airport', async () => {
    const { exportMod } = await loadEsmModules();
    const {
      neutralizeCsvFormula,
      encodeCsvCell,
      buildIncidentsCsv,
      exportIncidentsCsv,
    } = exportMod;

    // OWASP formula-trigger prefixes
    assert.equal(neutralizeCsvFormula('=HYPERLINK("http://evil.test","x")'), '\'=HYPERLINK("http://evil.test","x")');
    assert.equal(neutralizeCsvFormula('+SUM(A1:A2)'), "'+SUM(A1:A2)");
    assert.equal(neutralizeCsvFormula('-2+3+cmd'), "'-2+3+cmd");
    assert.equal(neutralizeCsvFormula('@SUM(1,2)'), "'@SUM(1,2)");
    assert.equal(neutralizeCsvFormula('\t=1+1'), "'\t=1+1");
    assert.equal(neutralizeCsvFormula('\r=1+1'), "'\r=1+1");
    assert.equal(neutralizeCsvFormula('Normal report text'), 'Normal report text');

    // RFC 4180 quoting combined with formula neutralization
    assert.equal(encodeCsvCell('=CMD("calc"),test\nline2'), '"\'=CMD(""calc""),test\nline2"');

    const incidents = [
      {
        _id: 'inc-jfk-1',
        time: '2026-11-21T14:00:00.000Z',
        airport: 'KJFK',
        camera_id: '=cam_inject',
        risk: 'red',
        type: 'drone',
        object_count: 1,
        direction: 'NE',
        confidence: 0.92,
        eta_seconds: 14,
        eta_basis: 'image_space_corridor',
        advisory_label: '+quadcopter',
        report: '@alert, "critical"\nsecond line',
        report_hash: 'a'.repeat(64),
        solana_status: 'confirmed',
        solana_tx: VALID_SIG,
      },
      {
        _id: 'inc-jfk-unverified-eta',
        time: '2026-11-21T14:05:00.000Z',
        airport: 'KJFK',
        camera_id: 'cam-2',
        risk: 'yellow',
        type: 'bird',
        eta_seconds: 9,
        eta_basis: 'uncalibrated_guess', // must NOT appear in CSV corridor ETA columns
        report: 'Gulls moving east',
      },
      {
        _id: 'inc-ewr-other',
        time: '2026-11-21T14:10:00.000Z',
        airport: 'KEWR',
        camera_id: 'cam-ewr',
        risk: 'red',
        type: 'drone',
        report: 'Should be excluded from KJFK export',
      },
    ];

    const csv = buildIncidentsCsv(incidents, { airport: 'KJFK' });
    assert.ok(csv.endsWith('\r\n'));
    const rows = csv.trimEnd().split('\r\n');
    // Header + 2 KJFK rows (KEWR excluded; embedded \n inside quoted report stays in row 1)
    assert.equal(rows.length, 2 + 1); // Wait: split('\r\n') keeps \n inside quoted cell intact!
    assert.ok(!csv.includes('inc-ewr-other'));
    assert.ok(csv.includes("'=cam_inject"));
    assert.ok(csv.includes("'+quadcopter"));
    assert.ok(csv.includes('"\'@alert, ""critical""\nsecond line"'));
    assert.ok(csv.includes(',14,image_space_corridor,'));
    assert.ok(!csv.includes('uncalibrated_guess'));

    // Verify Blob download lifecycle & URL revocation
    const doc = createMockDom();
    const revokedUrls = [];
    const result = exportIncidentsCsv(incidents, {
      airport: 'KJFK',
      now: '2026-11-21T15:00:00Z',
      doc,
      urlApi: {
        createObjectURL: () => 'blob:skysentry-shift-csv',
        revokeObjectURL: href => { revokedUrls.push(href); },
      },
    });
    assert.equal(result.rowCount, 2);
    assert.equal(result.filename, 'skysentry-shift-incidents-kjfk-2026-11-21.csv');
    assert.deepEqual(revokedUrls, ['blob:skysentry-shift-csv']);
  });

  test('escapes XSS in buildShiftSummaryHtml, sets noopener in openPrintShiftReport, and wires mountIncidentExportToolbar', async () => {
    const { exportMod } = await loadEsmModules();
    const {
      buildShiftSummaryHtml,
      openPrintShiftReport,
      mountIncidentExportToolbar,
    } = exportMod;

    const xssIncidents = [
      {
        _id: '<script>alert("id")</script>',
        time: '2026-11-21T14:00:00Z',
        airport: 'KJFK',
        camera_id: '<img src=x onerror=alert(1)>',
        risk: 'red',
        type: 'drone',
        object_count: 2,
        confidence: 0.88,
        direction: 'N<script>evil()</script>',
        eta_seconds: 12.5,
        eta_basis: 'image_space_corridor',
        advisory_label: '<b>rogue drone</b>',
        report: '</script><script>window.pwned=1</script>',
        report_hash: 'f'.repeat(64),
        solana_tx: VALID_SIG,
      },
      {
        _id: 'inc-other-airport',
        airport: 'KBOS',
        risk: 'yellow',
        type: 'bird',
        report: 'Excluded airport incident',
      },
    ];

    const hourlyRows = [
      { hour: '2026-11-21T14:00:00Z', airport: 'KJFK', type: '<svg onload=alert(2)>', events: 4, total_objects: 7 },
      { hour: '2026-11-21T14:00:00Z', airport: 'KBOS', type: 'bird', events: 99, total_objects: 99 },
    ];

    const html = buildShiftSummaryHtml(xssIncidents, hourlyRows, {
      airport: 'KJFK',
      generatedAt: '2026-11-21T15:30:00Z',
    });

    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<svg onload='));
    assert.ok(html.includes('&lt;script&gt;window.pwned=1&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html.includes('inc-other-airport'));
    assert.ok(html.includes('ETA 12.5s (image_space_corridor)'));

    // openPrintShiftReport sets popup.opener = null (noopener) and calls print()
    let writtenHtml = '';
    let printed = false;
    let focused = false;
    const fakePopup = {
      opener: { secret: true },
      document: {
        open() {},
        write(str) { writtenHtml += str; },
        close() {},
      },
      focus() { focused = true; },
      print() { printed = true; },
    };
    const printRes = openPrintShiftReport(xssIncidents, hourlyRows, {
      airport: 'KJFK',
      win: { open: (_url, target) => (target === '_blank' ? fakePopup : null) },
    });
    assert.equal(printRes.opened, true);
    assert.equal(fakePopup.opener, null);
    assert.equal(focused, true);
    assert.equal(printed, true);
    assert.ok(writtenHtml.includes('SKYSENTRY TOWER'));

    // Popup blocker graceful fallback
    const blockedRes = openPrintShiftReport(xssIncidents, hourlyRows, {
      airport: 'KJFK',
      win: { open: () => null },
    });
    assert.equal(blockedRes.opened, false);

    // mountIncidentExportToolbar mounts buttons, triggers CSV & Print callbacks, and cleans up on destroy()
    const doc = createMockDom();
    const host = doc.createElement('div');
    let printPopupOpened = 0;
    const toolbarWin = {
      open: () => {
        printPopupOpened++;
        return {
          opener: {},
          document: { open() {}, write() {}, close() {} },
          focus() {},
          print() {},
        };
      },
    };

    const toolbar = mountIncidentExportToolbar(host, {
      doc,
      win: toolbarWin,
      getAirport: () => 'KJFK',
      getIncidents: () => xssIncidents,
      getHourlyRows: () => hourlyRows,
    });

    assert.equal(host.children.length, 1);
    assert.equal(toolbar.element.className, 'sky-incident-toolbar');
    const [csvBtn, printBtn] = toolbar.element.children;
    assert.equal(csvBtn.textContent, 'Export CSV');
    assert.equal(printBtn.textContent, 'Print Shift PDF');

    printBtn.click();
    assert.equal(printPopupOpened, 1);

    toolbar.destroy();
    assert.equal(host.children.length, 0);
    assert.equal(csvBtn.listenerCount('click'), 0);
    assert.equal(printBtn.listenerCount('click'), 0);
  });
});
