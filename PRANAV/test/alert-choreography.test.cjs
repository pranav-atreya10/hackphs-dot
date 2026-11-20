const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function mockElement(tag = 'div') {
  const classes = new Set();
  const listeners = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    textContent: '',
    className: '',
    dataset: {},
    style: {
      setProperty(k, v) { this[k] = v; },
    },
    offsetHeight: 44,
    children: [],
    get firstElementChild() { return this.children[0] ?? null; },
    get firstChild() { return this.children[0] ?? null; },
    classList: {
      add(...names) {
        for (const n of names) if (n) classes.add(n);
        el.className = [...classes].join(' ');
      },
      remove(...names) {
        for (const n of names) classes.delete(n);
        el.className = [...classes].join(' ');
      },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) {
      const str = String(value);
      if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = str;
      } else if (name === 'title') {
        this.title = str;
      }
    },
    removeAttribute(name) {
      if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        delete this.dataset[camel];
      }
    },
    getAttribute(name) {
      if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return this.dataset[camel] ?? null;
      }
      return null;
    },
    insertBefore(node, ref) {
      const existingIdx = this.children.indexOf(node);
      if (existingIdx !== -1) this.children.splice(existingIdx, 1);
      node.parentNode = this;
      if (ref === null || ref === undefined) {
        this.children.push(node);
      } else {
        const refIdx = this.children.indexOf(ref);
        if (refIdx === -1) this.children.push(node);
        else this.children.splice(refIdx, 0, node);
      }
      this._wireSiblings();
      return node;
    },
    removeChild(node) {
      const idx = this.children.indexOf(node);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        node.parentNode = null;
        this._wireSiblings();
      }
      return node;
    },
    replaceChildren(...nodes) {
      for (const c of this.children) c.parentNode = null;
      this.children = [...nodes];
      for (const n of this.children) n.parentNode = this;
      this._wireSiblings();
    },
    _wireSiblings() {
      for (let i = 0; i < this.children.length; i++) {
        this.children[i].nextElementSibling = this.children[i + 1] ?? null;
        this.children[i].nextSibling = this.children[i + 1] ?? null;
      }
    },
    remove() {
      this.parentNode?.removeChild(this);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      const event = { target: el, ...ev };
      for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
    },
    ownerDocument: {
      createElement: t => mockElement(t),
    },
  };
  return el;
}

test('animateRowEnter uses .sky-row-enter for live rows, .sky-row-replay for historical replay, and cleans up transient classes', async () => {
  const { animateRowEnter, ROW_REPLAY_MS } = await import('../public/js/alert-choreography.mjs');

  const liveRow = mockElement('li');
  const childBadge = mockElement('span');
  assert.equal(animateRowEnter(liveRow), liveRow);
  assert.equal(liveRow.classList.contains('sky-row-enter'), true);
  assert.equal(liveRow.classList.contains('sky-row-replay'), false);

  // Bubbled animationend from a child node must NOT strip the row's own entrance class early.
  liveRow.dispatchEvent({ type: 'animationend', target: childBadge });
  assert.equal(liveRow.classList.contains('sky-row-enter'), true);

  // Row's own animationend cleans up immediately.
  liveRow.dispatchEvent({ type: 'animationend', target: liveRow });
  assert.equal(liveRow.classList.contains('sky-row-enter'), false);

  // Replay burst uses subtle .sky-row-replay fade and cleans up via fallback timer in mock DOMs without animationend.
  const replayRow = mockElement('li');
  animateRowEnter(replayRow, { replay: true });
  assert.equal(replayRow.classList.contains('sky-row-replay'), true);
  assert.equal(replayRow.classList.contains('sky-row-enter'), false);

  await new Promise(resolve => setTimeout(resolve, ROW_REPLAY_MS + 90));
  assert.equal(replayRow.classList.contains('sky-row-replay'), false);

  // Reduced motion skips transient animation classes altogether.
  const quietRow = mockElement('li');
  animateRowEnter(quietRow, { reducedMotion: true });
  assert.equal(quietRow.classList.contains('sky-row-enter'), false);
  assert.equal(quietRow.classList.contains('sky-row-replay'), false);
});

test('animateRowDismiss runs immediately under reducedMotion and guarantees onDone via fallback timer without transitionend', async () => {
  const { animateRowDismiss, animateRowEnter } = await import('../public/js/alert-choreography.mjs');

  // Reduced motion calls onDone synchronously without starting timers.
  const immediateRow = mockElement('li');
  let syncDone = 0;
  animateRowDismiss(immediateRow, () => { syncDone++; }, { reducedMotion: true });
  assert.equal(syncDone, 1);
  assert.equal(immediateRow.classList.contains('sky-row-exit'), false);

  // Minimal mock DOM without addEventListener/transitionend still resolves within bounded ~180-220ms window.
  const bareRow = { className: 'existing' };
  const startedAt = Date.now();
  await new Promise(resolve => {
    animateRowDismiss(bareRow, resolve);
    assert.match(bareRow.className, /\bsky-row-exit\b/);
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 150 && elapsed < 1000, `expected bounded fallback ~180-220ms, got ${elapsed}ms`);

  // When transitionend fires on the row, onDone runs once and ignores subsequent fallback timer or duplicate events.
  const liveRow = mockElement('li');
  animateRowEnter(liveRow);
  let calls = 0;
  animateRowDismiss(liveRow, () => { calls++; });
  assert.equal(liveRow.classList.contains('sky-row-enter'), false);
  assert.equal(liveRow.classList.contains('sky-row-exit'), true);
  assert.equal(liveRow.style['--sky-row-h'], '44px');

  // Child transitionend bubble must not prematurely complete row dismissal.
  liveRow.dispatchEvent({ type: 'transitionend', target: mockElement('button') });
  assert.equal(calls, 0);

  liveRow.dispatchEvent({ type: 'transitionend', target: liveRow });
  liveRow.dispatchEvent({ type: 'animationend', target: liveRow });
  assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(calls, 1);

  // Concurrent dismiss calls on the same row coalesce and deliver both callbacks once.
  const sharedRow = mockElement('li');
  const order = [];
  animateRowDismiss(sharedRow, () => order.push('click-ack'));
  animateRowDismiss(sharedRow, () => order.push('socket-ack'));
  sharedRow.dispatchEvent({ type: 'transitionend', target: sharedRow });
  assert.deepEqual(order, ['click-ack', 'socket-ack']);

  // Automatic matchMedia('(prefers-reduced-motion: reduce)') detection works when option is omitted.
  const prevMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = query => ({ matches: query.includes('reduce') });
  try {
    const osQuietRow = mockElement('li');
    let osDone = 0;
    animateRowEnter(osQuietRow);
    assert.equal(osQuietRow.classList.contains('sky-row-enter'), false);
    animateRowDismiss(osQuietRow, () => { osDone++; });
    assert.equal(osDone, 1);
  } finally {
    globalThis.matchMedia = prevMatchMedia;
  }
});

test('applyEnrichmentBadges progresses from shimmering pending pills to confirmed/ready, Solana pop-in, and advisory bird chips', async () => {
  const { applyEnrichmentBadges } = await import('../public/js/alert-choreography.mjs');
  const box = mockElement('div');

  // 1. Provisional live incident: both storage and report shimmer; no Solana or bird chips.
  const v0 = { _id: 'inc-1', type: 'drone', persistence: 'pending', receipt_state: 'pending', report_state: 'pending' };
  const pills0 = applyEnrichmentBadges(box, v0);
  assert.deepEqual(pills0.map(p => p.textContent), ['Syncing receipt…', 'Drafting report…']);
  assert.equal(pills0[0].classList.contains('sky-shimmer-pill'), true);
  assert.equal(pills0[1].classList.contains('sky-shimmer-pill'), true);

  // 2. Durable storage confirmed while report is still drafting: report node is preserved in-place so shimmer does not reset.
  const reportNodeBefore = pills0[1];
  const v1 = { _id: 'inc-1', type: 'drone', persistence: 'stored', revision: 1, report_state: 'pending' };
  const pills1 = applyEnrichmentBadges(box, v1, { previous: v0 });
  assert.deepEqual(pills1.map(p => p.textContent), ['Storage confirmed', 'Drafting report…']);
  assert.equal(pills1[0].classList.contains('sky-shimmer-pill'), false);
  assert.equal(pills1[0].dataset.verified, 'true');
  assert.equal(pills1[1], reportNodeBefore);
  assert.equal(pills1[1].classList.contains('sky-shimmer-pill'), true);

  // 3. Report ready + Solana signature reserved (pending reconciliation): still NOT confirmed on Solana!
  const v2 = {
    _id: 'inc-1', type: 'drone', persistence: 'stored', revision: 3,
    report: 'Observed quadcopter hover.', report_state: 'stored',
    solana_tx: '5xReservedSig', solana_status: 'pending', stamp_state: 'reconciliation_required',
  };
  const pills2 = applyEnrichmentBadges(box, v2, { previous: v1 });
  assert.deepEqual(pills2.map(p => p.textContent), ['Storage confirmed', 'Report ready', 'Stamping devnet…']);
  assert.equal(pills2[2].classList.contains('sky-shimmer-pill'), true);
  assert.equal(pills2[2].dataset.verified, undefined);

  // 4. Solana devnet transitions to confirmed -> renders ✓ Solana devnet WITH .sky-badge-pop!
  const v3 = {
    _id: 'inc-1', type: 'drone', persistence: 'stored', revision: 4,
    report: 'Observed quadcopter hover.', report_state: 'stored',
    solana_tx: '5xReservedSig', solana_status: 'confirmed', stamp_state: 'stored',
  };
  const pills3 = applyEnrichmentBadges(box, v3, { previous: v2 });
  assert.deepEqual(pills3.map(p => p.textContent), ['Storage confirmed', 'Report ready', '✓ Solana devnet']);
  assert.equal(pills3[2].classList.contains('sky-badge-pop'), true);
  assert.equal(pills3[2].dataset.verified, 'true');

  // 5. Re-rendering already-confirmed incident removes transient .sky-badge-pop; historical render with previous: null also does not pop.
  const pills4 = applyEnrichmentBadges(box, v3, { previous: v3 });
  assert.equal(pills4[2].classList.contains('sky-badge-pop'), false);

  const historyBox = mockElement('div');
  const historyPills = applyEnrichmentBadges(historyBox, v3, { previous: null });
  assert.equal(historyPills[2].textContent, '✓ Solana devnet');
  assert.equal(historyPills[2].classList.contains('sky-badge-pop'), false);

  // 6. Advisory bird_verdict chips distinguish local v4.1 vs cloud Bird review and stay strictly advisory.
  const v41Box = mockElement('div');
  const v41Pills = applyEnrichmentBadges(v41Box, {
    _id: 'inc-bird-1', type: 'bird', persistence: 'stored', report: 'Gulls near threshold.',
    bird_verdict: { status: 'verified', verdict: 'bird', confidence: 0.93, source: 'local', model: 'v4.1' },
  });
  const v41Chip = v41Pills.find(p => p.dataset.badge === 'bird-review');
  assert.ok(v41Chip);
  assert.match(v41Chip.textContent, /v4\.1/);
  assert.match(v41Chip.textContent, /advisory/i);
  assert.match(v41Chip.textContent, /bird \(93%\)/);
  assert.equal(v41Chip.dataset.advisory, 'true');
  assert.equal(v41Chip.dataset.verified, undefined);

  const geminiBox = mockElement('div');
  const geminiPills = applyEnrichmentBadges(geminiBox, {
    _id: 'inc-bird-2', type: 'bird', persistence: 'stored', report: 'Possible raptor.',
    bird_verdict: { status: 'verified', verdict: 'not_bird', confidence: 0.81, source: 'gemini' },
  });
  const geminiChip = geminiPills.find(p => p.dataset.badge === 'bird-review');
  assert.ok(geminiChip);
  assert.match(geminiChip.textContent, /Bird review/);
  assert.match(geminiChip.textContent, /not bird \(81%\)/);
  assert.equal(geminiChip.dataset.advisory, 'true');
});

test('applyEnrichmentBadges never fabricates verification when persistence is unavailable or solana_tx is absent', async () => {
  const { applyEnrichmentBadges, isSolanaConfirmed } = await import('../public/js/alert-choreography.mjs');

  // Even if forged/stale fields claim revision, report, or solana_tx, persistence === "unavailable" blocks all verification.
  const unconfirmedBox = mockElement('div');
  const unavailablePills = applyEnrichmentBadges(unconfirmedBox, {
    _id: 'inc-unavail',
    persistence: 'unavailable',
    receipt_state: 'unavailable',
    revision: 3,
    report: 'Unpersisted text',
    solana_tx: '5xFakeTx',
    solana_status: 'confirmed',
  }, { previous: { _id: 'inc-unavail', persistence: 'pending' } });

  for (const pill of unavailablePills) {
    assert.notEqual(pill.textContent, 'Storage confirmed');
    assert.notEqual(pill.textContent, '✓ Solana devnet');
    assert.equal(pill.dataset.verified, undefined);
    assert.equal(pill.classList.contains('sky-shimmer-pill'), false);
    assert.equal(pill.classList.contains('sky-badge-pop'), false);
  }
  assert.equal(unavailablePills[0].textContent, 'Storage unavailable');
  assert.equal(unavailablePills[1].textContent, 'Report unavailable');

  // Missing, null, or blank solana_tx must NEVER render ✓ Solana devnet even when solana_status === "confirmed".
  for (const badTx of [undefined, null, '', '   ', 123]) {
    const candidate = {
      _id: 'inc-no-tx',
      persistence: 'stored',
      report: 'Drone report',
      solana_tx: badTx,
      solana_status: 'confirmed',
    };
    assert.equal(isSolanaConfirmed(candidate), false);
    const box = mockElement('div');
    const pills = applyEnrichmentBadges(box, candidate, { previous: { _id: 'inc-no-tx', persistence: 'stored' } });
    assert.equal(pills.some(p => p.textContent.includes('Solana devnet')), false);
    assert.equal(pills.some(p => p.classList.contains('sky-badge-pop')), false);
  }
});

test('alerts-motion.css defines required choreography classes, keyframes, and prefers-reduced-motion overrides', () => {
  const css = readFileSync(path.join(__dirname, '../public/css/alerts-motion.css'), 'utf8');
  for (const selector of [
    '#unacknowledgedAlerts li',
    '.sky-row-enter',
    '.sky-row-replay',
    '.sky-row-exit',
    '.sky-shimmer-pill',
    '.sky-badge-pop',
  ]) {
    assert.ok(css.includes(selector), `missing CSS rule for ${selector}`);
  }
  assert.match(css, /180ms/);
  const reducedMotionBlock = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}/)?.[1] ?? '';
  for (const selector of ['.sky-row-enter', '.sky-row-exit', '.sky-shimmer-pill', '.sky-badge-pop', '#unacknowledgedAlerts li']) {
    assert.ok(reducedMotionBlock.includes(selector), `missing ${selector} inside prefers-reduced-motion block`);
  }
  assert.match(reducedMotionBlock, /animation:\s*none\s*!important/);
  assert.match(reducedMotionBlock, /transition:\s*none\s*!important/);
});
