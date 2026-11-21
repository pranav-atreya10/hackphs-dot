const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CSS_PATH = path.resolve(__dirname, '../public/css/beacon-risk-motion.css');
const MODULE_URL = pathToFileURL(path.resolve(__dirname, '../public/js/risk-beacon-fx.mjs')).href;

function createDomFixture(initialRisk = 'unavailable') {
  const observers = new Set();

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Map();
    }
    observe(target, options = {}) {
      this.targets.set(target, options);
      observers.add(this);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
    notify(target, attributeName) {
      const opts = this.targets.get(target);
      if (!opts || !opts.attributes) return;
      if (Array.isArray(opts.attributeFilter) && !opts.attributeFilter.includes(attributeName)) return;
      this.callback([{ type: 'attributes', target, attributeName }]);
    }
  }

  function makeElement(attrs = {}) {
    const attributes = new Map(Object.entries(attrs));
    const classes = new Set();
    const dataset = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== 'string') return undefined;
          const attrName = 'data-' + prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
          return attributes.get(attrName);
        },
        set(_target, prop, value) {
          if (typeof prop !== 'string') return false;
          const attrName = 'data-' + prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
          el.setAttribute(attrName, String(value));
          return true;
        },
        deleteProperty(_target, prop) {
          if (typeof prop !== 'string') return false;
          const attrName = 'data-' + prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
          el.removeAttribute(attrName);
          return true;
        },
      },
    );

    const el = {
      dataset,
      offsetWidth: 320,
      ownerDocument: { defaultView: { MutationObserver: FakeMutationObserver } },
      classList: {
        add(...names) { for (const n of names) classes.add(n); },
        remove(...names) { for (const n of names) classes.delete(n); },
        contains(name) { return classes.has(name); },
      },
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
        for (const obs of [...observers]) obs.notify(el, name);
      },
      removeAttribute(name) {
        attributes.delete(name);
        for (const obs of [...observers]) obs.notify(el, name);
      },
    };
    return el;
  }

  return {
    FakeMutationObserver,
    riskEl: makeElement(initialRisk === null ? {} : { 'data-risk': initialRisk }),
    beaconEl: makeElement(),
    get activeObserverCount() {
      return observers.size;
    },
  };
}

test('initial attachment syncs beacon risk immediately without firing a shockwave pulse', async () => {
  const { watchRiskTransitions } = await import(MODULE_URL);
  const { riskEl, beaconEl } = createDomFixture('unavailable');

  const handle = watchRiskTransitions(riskEl, { beaconEl });
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'unavailable');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);
  assert.equal(riskEl.classList.contains('risk-pulse'), false);
  handle.disconnect();
});

test('missing or unknown data-risk normalizes safely to unavailable', async () => {
  const { watchRiskTransitions, normalizeRiskLevel } = await import(MODULE_URL);
  assert.equal(normalizeRiskLevel(undefined), 'unavailable');
  assert.equal(normalizeRiskLevel(''), 'unavailable');
  assert.equal(normalizeRiskLevel('  YELLOW '), 'yellow');
  assert.equal(normalizeRiskLevel('unexpected'), 'unavailable');

  const { riskEl, beaconEl } = createDomFixture(null);
  const handle = watchRiskTransitions(riskEl, { beaconEl });
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'unavailable');

  riskEl.setAttribute('data-risk', 'invalid-state');
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'unavailable');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);
  handle.disconnect();
});

test('escalations and clears emit a 650 ms transient data-risk-pulse and update beacon risk', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchRiskTransitions, PULSE_DURATION_MS } = await import(MODULE_URL);
  assert.equal(PULSE_DURATION_MS, 650);

  const { riskEl, beaconEl } = createDomFixture('unavailable');
  const handle = watchRiskTransitions(riskEl, { beaconEl });

  // Initial connection unavailable -> green: syncs beacon, no false "clear" pulse since no threat was active.
  riskEl.dataset.risk = 'green';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'green');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  // Escalate green -> yellow: triggers yellow shockwave for exactly 650 ms.
  riskEl.dataset.risk = 'yellow';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'yellow');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'yellow');
  assert.equal(riskEl.classList.contains('risk-pulse'), true);

  t.mock.timers.tick(649);
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'yellow');
  t.mock.timers.tick(1);
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);
  assert.equal(riskEl.classList.contains('risk-pulse'), false);

  // Rapid escalation green/yellow -> red mid-window resets the full 650 ms timer.
  riskEl.dataset.risk = 'green'; // clears yellow -> green
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'green');
  t.mock.timers.tick(300);

  riskEl.dataset.risk = 'red';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'red');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'red');

  t.mock.timers.tick(400); // 700 ms after green pulse, only 400 ms into red pulse -> must still be active!
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'red');

  t.mock.timers.tick(250); // 650 ms into red pulse -> clears cleanly.
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  // Clear red -> green: triggers green relief shockwave for 650 ms.
  riskEl.dataset.risk = 'green';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'green');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'green');
  t.mock.timers.tick(650);
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  handle.disconnect();
});

test('non-clearing step-downs, coverage loss, and 500 ms same-level refreshes behave safely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchRiskTransitions } = await import(MODULE_URL);
  const { riskEl, beaconEl } = createDomFixture('unavailable');
  const handle = watchRiskTransitions(riskEl, { beaconEl });

  // Direct escalation from degraded/unavailable into red pulses red.
  riskEl.dataset.risk = 'degraded';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'degraded');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  riskEl.dataset.risk = 'red';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'red');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'red');

  // Repeating identical data-risk="red" (like tower.js refreshRisk every 500 ms) neither extends nor restarts pulse.
  t.mock.timers.tick(500);
  riskEl.dataset.risk = 'red';
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'red');
  t.mock.timers.tick(150);
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  // Another identical refresh after pulse ended must not re-fire a shockwave.
  riskEl.dataset.risk = 'red';
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  // Step-down red -> yellow updates beacon without claiming an escalation or a full clear.
  riskEl.dataset.risk = 'yellow';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'yellow');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  // Escalate back to red, then lose coverage mid-pulse -> pulse clears immediately, never shows false clear.
  riskEl.dataset.risk = 'red';
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'red');
  riskEl.dataset.risk = 'unavailable';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'unavailable');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  handle.disconnect();
});

test('reducedMotion suppresses transient shockwaves while keeping beacon risk state synchronized', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchRiskTransitions } = await import(MODULE_URL);
  const { riskEl, beaconEl } = createDomFixture('green');
  let reduce = true;

  const handle = watchRiskTransitions(riskEl, {
    beaconEl,
    reducedMotion: () => reduce,
  });

  riskEl.dataset.risk = 'red';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'red');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  riskEl.dataset.risk = 'green';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'green');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);

  // Toggling reduced motion off mid-session restores shockwaves.
  reduce = false;
  riskEl.dataset.risk = 'yellow';
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'yellow');
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'yellow');

  handle.disconnect();
});

test('disconnect cleans up observers, timers, and in-flight pulse attributes idempotently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { watchRiskTransitions } = await import(MODULE_URL);
  const fixture = createDomFixture('green');
  const { riskEl, beaconEl } = fixture;

  const handle = watchRiskTransitions(riskEl, { beaconEl });
  assert.equal(fixture.activeObserverCount, 1);

  riskEl.dataset.risk = 'red';
  assert.equal(riskEl.getAttribute('data-risk-pulse'), 'red');

  handle.disconnect();
  handle.disconnect(); // idempotent
  assert.equal(fixture.activeObserverCount, 0);
  assert.equal(riskEl.getAttribute('data-risk-pulse'), null);
  assert.equal(riskEl.classList.contains('risk-pulse'), false);

  // Subsequent mutations no longer touch riskEl pulse or beaconEl.
  riskEl.dataset.risk = 'green';
  assert.equal(beaconEl.getAttribute('data-risk-pulse'), null);
  assert.equal(beaconEl.getAttribute('data-beacon-risk'), 'red');

  // Null-safe when riskEl or beaconEl is missing.
  const noop = watchRiskTransitions(null);
  assert.doesNotThrow(() => noop.disconnect());

  // Fallback path when no MutationObserver exists (lightweight plain-object elements).
  const attrs = new Map([['data-risk', 'green']]);
  const plainRisk = {
    dataset: { risk: 'green' },
    getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, val) => { attrs.set(name, String(val)); },
    removeAttribute: name => { attrs.delete(name); },
  };
  const beaconAttrs = new Map();
  const plainBeacon = { setAttribute: (name, val) => { beaconAttrs.set(name, String(val)); } };
  const fallbackHandle = watchRiskTransitions(plainRisk, { beaconEl: plainBeacon });
  assert.equal(beaconAttrs.get('data-beacon-risk'), 'green');
  plainRisk.setAttribute('data-risk', 'red');
  assert.equal(beaconAttrs.get('data-beacon-risk'), 'red');
  assert.equal(plainRisk.getAttribute('data-risk-pulse'), 'red');
  plainRisk.dataset.risk = 'green';
  assert.equal(beaconAttrs.get('data-beacon-risk'), 'green');
  assert.equal(plainRisk.getAttribute('data-risk-pulse'), 'green');
  fallbackHandle.disconnect();
  assert.equal(plainRisk.getAttribute('data-risk-pulse'), null);
});

test('beacon-risk-motion.css preserves #risk red flash and covers beacon, fullscreen, and reduced-motion rules', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  // Balanced braces check.
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  assert.equal(opens, closes, 'CSS braces must be balanced');
  assert.ok(opens >= 20, 'Expected substantive rule blocks');

  // Shockwave keyframes animate pseudo-elements on .risk[data-risk-pulse], leaving .risk[data-risk="red"]'s own animation untouched.
  assert.match(css, /@keyframes\s+risk-shockwave-escalate\b/);
  assert.match(css, /@keyframes\s+risk-shockwave-clear\b/);
  assert.match(css, /@keyframes\s+risk-shockwave-ring\b/);
  assert.match(css, /\.risk\[data-risk-pulse="green"\]/);
  assert.match(css, /\.risk\[data-risk-pulse="yellow"\]/);
  assert.match(css, /\.risk\[data-risk-pulse="red"\]/);
  assert.match(css, /\.risk\[data-risk-pulse\]::after/);

  // Outside prefers-reduced-motion, .risk[data-risk-pulse] itself must never set `animation:` directly.
  const beforeReducedMotion = css.split('@media (prefers-reduced-motion: reduce)')[0];
  const directPulseBlocks = [...beforeReducedMotion.matchAll(/\.risk\[data-risk-pulse(?:="[^"]+")?\](?!::)\s*\{([^}]*)\}/g)];
  for (const [, body] of directPulseBlocks) {
    assert.doesNotMatch(body, /\banimation\s*:/, '.risk[data-risk-pulse] must not clobber #risk[data-risk="red"] animation');
  }

  // Beacon risk halo, lamp transitions, and fullscreen spare-monitor states.
  for (const state of ['green', 'yellow', 'red', 'degraded', 'unavailable']) {
    assert.match(css, new RegExp(`#beaconView\\[data-beacon-risk="${state}"\\]`));
  }
  assert.match(css, /#beaconView:fullscreen\b/);
  assert.match(css, /#beaconLamps\s+\[data-l\]/);

  // Complete static high-contrast reduced-motion fallback.
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
  const reducedSection = css.split('@media (prefers-reduced-motion: reduce)')[1] ?? '';
  assert.match(reducedSection, /animation:\s*none\s*!important/);
  assert.match(reducedSection, /transition:\s*none\s*!important/);
  assert.match(reducedSection, /#beaconView:fullscreen\[data-beacon-risk\]/);
});
