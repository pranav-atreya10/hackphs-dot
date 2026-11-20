const { test } = require('node:test');
const assert = require('node:assert/strict');

function createClock(start = 100) {
  let current = start;
  let nextId = 0;
  const pending = new Map();
  const cancelledIds = [];

  return {
    now: () => current,
    raf(cb) {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    caf(id) {
      cancelledIds.push(id);
      pending.delete(id);
    },
    step(deltaMs) {
      current += deltaMs;
      const snapshot = [...pending.entries()];
      pending.clear();
      for (const [, cb] of snapshot) {
        cb(current);
      }
    },
    get pendingCount() {
      return pending.size;
    },
    cancelledIds,
  };
}

function createMockElement(textContent = '') {
  const props = new Map();
  return {
    textContent,
    dataset: {},
    style: {
      fontVariantNumeric: '',
      setProperty(name, value) {
        props.set(name, value);
        if (name === 'font-variant-numeric') {
          this.fontVariantNumeric = value;
        }
      },
      getPropertyValue(name) {
        return props.get(name) || '';
      },
    },
  };
}

test('parses and animates embedded/suffixed/prefixed stats with cubic-ease-out and tabular-nums', async () => {
  const { animateStatValue } = await import('../public/js/stat-counter.mjs');

  const cases = [
    { initial: '0.0 MB', target: '17.0 MB', midExpected: '14.9 MB' },
    { initial: '0.0%', target: '96.1%', midExpected: '84.1%' },
    { initial: '0 fps', target: '24 fps', midExpected: '21 fps' },
    { initial: '0', target: '12', midExpected: '11' },
    { initial: '≈0', target: '≈1,000', midExpected: '≈875' },
  ];

  for (const { initial, target, midExpected } of cases) {
    const clock = createClock(0);
    const el = createMockElement(initial);

    animateStatValue(el, target, {
      durationMs: 420,
      raf: clock.raf,
      caf: clock.caf,
      now: clock.now,
    });

    assert.equal(el.style.fontVariantNumeric, 'tabular-nums');
    assert.equal(el.style.getPropertyValue('font-variant-numeric'), 'tabular-nums');
    assert.equal(clock.pendingCount, 1);

    // At 50% duration (210ms), cubic-ease-out is 1 - 0.5^3 = 0.875.
    clock.step(210);
    assert.equal(el.textContent, midExpected);
    assert.equal(clock.pendingCount, 1);

    // At 100% duration (420ms), lands on exact target text and stops scheduling RAF.
    clock.step(210);
    assert.equal(el.textContent, target);
    assert.equal(clock.pendingCount, 0);
  }
});

test('accepts numeric inputs directly and handles signed/zero-crossing values without -0.0 artifacts', async () => {
  const { animateStatValue } = await import('../public/js/stat-counter.mjs');
  const clock = createClock(1000);
  const el = createMockElement('-0.4 dB');

  animateStatValue(el, '0.0 dB', {
    durationMs: 400,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });

  clock.step(350); // eased = 1 - (0.125)^3 = 0.998 -> -0.0008 -> must render 0.0 dB, never -0.0 dB
  assert.equal(el.textContent, '0.0 dB');
  assert.doesNotMatch(el.textContent, /^-/);

  clock.step(50);
  assert.equal(el.textContent, '0.0 dB');

  const numEl = createMockElement('2');
  animateStatValue(numEl, 10, {
    durationMs: 400,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  clock.step(200);
  assert.equal(numEl.textContent, '9');
  clock.step(200);
  assert.equal(numEl.textContent, '10');
});

test('cancels in-flight RAF handle via WeakMap on rapid updates and transitions smoothly from current value', async () => {
  const { animateStatValue } = await import('../public/js/stat-counter.mjs');
  const clock = createClock(0);
  const el = createMockElement('0.0 MB');

  animateStatValue(el, '20.0 MB', {
    durationMs: 400,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  assert.equal(clock.pendingCount, 1);

  // Advance halfway: currentValue is 20 * 0.875 = 17.5 MB, raf handle 1 is queued next.
  clock.step(200);
  assert.equal(el.textContent, '17.5 MB');
  assert.equal(clock.pendingCount, 1);

  // Rapidly retarget to 30.0 MB and then immediately to 40.0 MB before the next frame fires.
  animateStatValue(el, '30.0 MB', {
    durationMs: 400,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  animateStatValue(el, '40.0 MB', {
    durationMs: 400,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });

  // Both superseded RAF handles (id 1 and id 2, including handle 0 if first was cancelled) were cancelled; only 1 active RAF remains!
  assert.deepEqual(clock.cancelledIds, [1, 2]);
  assert.equal(clock.pendingCount, 1);
  assert.equal(el.textContent, '17.5 MB');

  // Halfway through the retargeted animation: 17.5 + (40 - 17.5) * 0.875 = 37.1875 -> 37.2 MB.
  clock.step(200);
  assert.equal(el.textContent, '37.2 MB');

  clock.step(200);
  assert.equal(el.textContent, '40.0 MB');
  assert.equal(clock.pendingCount, 0);
});

test('cancels handle 0 cleanly when interrupted before first frame and ignores stale callbacks if caf is missing', async () => {
  const { animateStatValue } = await import('../public/js/stat-counter.mjs');
  const clock = createClock(0);
  const el = createMockElement('0 fps');

  // First call acquires RAF id 0; immediate non-numeric update must cancel id 0!
  animateStatValue(el, '24 fps', {
    durationMs: 420,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  animateStatValue(el, '—', {
    durationMs: 420,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });

  assert.deepEqual(clock.cancelledIds, [0]);
  assert.equal(clock.pendingCount, 0);
  assert.equal(el.textContent, '—');

  // Even without caf, stale callback token must not overwrite newer state.
  const callbacks = [];
  let t = 0;
  animateStatValue(el, '10 fps', {
    durationMs: 400,
    raf: cb => { callbacks.push(cb); return callbacks.length; },
    caf: undefined,
    now: () => t,
  });
  animateStatValue(el, 'Stopped', {
    durationMs: 400,
    raf: cb => { callbacks.push(cb); return callbacks.length; },
    caf: undefined,
    now: () => t,
  });
  t = 200;
  callbacks[0](t);
  assert.equal(el.textContent, 'Stopped');
});

test('sets textContent immediately when reducedMotion, missing raf, non-numeric text, or empty with animateInitial: false', async () => {
  const { animateStatValue } = await import('../public/js/stat-counter.mjs');
  const clock = createClock(0);

  // 1. reducedMotion: true
  const elReduced = createMockElement('0 fps');
  animateStatValue(elReduced, '24 fps', {
    reducedMotion: true,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  assert.equal(elReduced.textContent, '24 fps');
  assert.equal(elReduced.style.fontVariantNumeric, 'tabular-nums');
  assert.equal(clock.pendingCount, 0);

  // 2. !raf
  const elNoRaf = createMockElement('10.0%');
  animateStatValue(elNoRaf, '96.1%', {
    raf: null,
    caf: null,
    now: clock.now,
  });
  assert.equal(elNoRaf.textContent, '96.1%');
  assert.equal(elNoRaf.style.fontVariantNumeric, 'tabular-nums');

  // 3. Non-numeric text
  const elNonNumeric = createMockElement('12');
  animateStatValue(elNonNumeric, 'Video only', {
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  assert.equal(elNonNumeric.textContent, 'Video only');
  assert.equal(clock.pendingCount, 0);

  // 4. Initial empty value with animateInitial: false sets immediately, then animates subsequent updates!
  const elInitial = createMockElement('');
  animateStatValue(elInitial, '17.0 MB', {
    animateInitial: false,
    durationMs: 400,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  assert.equal(elInitial.textContent, '17.0 MB');
  assert.equal(clock.pendingCount, 0);

  animateStatValue(elInitial, '25.0 MB', {
    animateInitial: false,
    durationMs: 400,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });
  assert.equal(clock.pendingCount, 1);
  clock.step(200);
  assert.equal(elInitial.textContent, '24.0 MB');
  clock.step(200);
  assert.equal(elInitial.textContent, '25.0 MB');
  assert.equal(clock.pendingCount, 0);
});

test('observeLandingFacts rolls up .fact b stats once on intersection and preserves exact el.dataset.targetText', async () => {
  const { observeLandingFacts } = await import('../public/js/stat-counter.mjs');
  const clock = createClock(0);

  const factEngines = createMockElement('2 of 2');
  const factFlights = createMockElement('≈1,000');
  const factVideoOnly = createMockElement('Video only');

  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, '.fact b');
      return [factEngines, factFlights, factVideoOnly];
    },
  };

  const observed = new Set();
  const unobserved = new Set();
  let observerCallback = null;

  class MockIntersectionObserver {
    constructor(cb, opts) {
      observerCallback = cb;
      this.opts = opts;
    }
    observe(el) {
      observed.add(el);
    }
    unobserve(el) {
      unobserved.add(el);
    }
    disconnect() {
      observed.clear();
    }
  }

  const handle = observeLandingFacts(root, {
    IntersectionObserver: MockIntersectionObserver,
    durationMs: 400,
    reducedMotion: false,
    raf: clock.raf,
    caf: clock.caf,
    now: clock.now,
  });

  // Only numeric .fact b elements are observed; non-numeric "Video only" is untouched.
  assert.equal(observed.has(factEngines), true);
  assert.equal(observed.has(factFlights), true);
  assert.equal(observed.has(factVideoOnly), false);
  assert.equal(factEngines.dataset.targetText, '2 of 2');
  assert.equal(factFlights.dataset.targetText, '≈1,000');
  assert.equal(factVideoOnly.dataset.targetText, undefined);
  assert.equal(factVideoOnly.textContent, 'Video only');

  // Non-intersecting callback does not trigger roll-up.
  observerCallback([{ target: factFlights, isIntersecting: false }]);
  assert.equal(clock.pendingCount, 0);
  assert.equal(factFlights.textContent, '≈1,000');

  // Intersecting triggers roll-up from 0 and unobserves immediately.
  observerCallback([
    { target: factEngines, isIntersecting: true },
    { target: factFlights, isIntersecting: true },
  ]);
  assert.equal(unobserved.has(factEngines), true);
  assert.equal(unobserved.has(factFlights), true);
  assert.equal(factEngines.textContent, '0 of 2');
  assert.equal(factFlights.textContent, '≈0');

  clock.step(200);
  assert.equal(factEngines.textContent, '2 of 2');
  assert.equal(factFlights.textContent, '≈875');

  clock.step(200);
  assert.equal(factEngines.textContent, '2 of 2');
  assert.equal(factFlights.textContent, '≈1,000');
  assert.equal(factEngines.textContent, factEngines.dataset.targetText);
  assert.equal(factFlights.textContent, factFlights.dataset.targetText);
  assert.equal(clock.pendingCount, 0);

  // Re-firing intersection on already-animated elements is a strict no-op (rolls up once).
  observerCallback([{ target: factFlights, isIntersecting: true }]);
  assert.equal(clock.pendingCount, 0);
  assert.equal(factFlights.textContent, '≈1,000');

  handle.disconnect();
});

test('observeLandingFacts gracefully falls back when IntersectionObserver or DOM is unavailable', async () => {
  const { observeLandingFacts } = await import('../public/js/stat-counter.mjs');

  // Missing DOM / null root is a safe no-op.
  assert.doesNotThrow(() => observeLandingFacts(null));
  assert.doesNotThrow(() => observeLandingFacts());

  // Missing IntersectionObserver preserves exact targetText without throwing or zeroing text.
  const fact = createMockElement('96.1%');
  const root = { querySelectorAll: () => [fact] };
  const handle = observeLandingFacts(root, {
    IntersectionObserver: undefined,
    reducedMotion: false,
  });

  assert.equal(fact.dataset.targetText, '96.1%');
  assert.equal(fact.textContent, '96.1%');
  assert.equal(fact.style.fontVariantNumeric, 'tabular-nums');
  assert.doesNotThrow(() => handle.disconnect());
});

test('observeLandingFacts disconnect restores exact targetText if torn down mid-roll and parseStatValue preserves hyphenated prefixes', async () => {
  const { observeLandingFacts, parseStatValue, formatStatValue } = await import('../public/js/stat-counter.mjs');
  const clock = createClock(0);
  const fact = createMockElement('≈1,000');
  let observerCb = null;

  class MockIO {
    constructor(cb) { observerCb = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const handle = observeLandingFacts(
    { querySelectorAll: () => [fact] },
    {
      IntersectionObserver: MockIO,
      durationMs: 400,
      reducedMotion: false,
      raf: clock.raf,
      caf: clock.caf,
      now: clock.now,
    },
  );

  observerCb([{ target: fact, isIntersecting: true }]);
  clock.step(100);
  assert.notEqual(fact.textContent, '≈1,000');
  assert.equal(clock.pendingCount, 1);

  handle.disconnect();
  assert.equal(clock.pendingCount, 0);
  assert.equal(fact.textContent, '≈1,000');

  const hyphenated = parseStatValue('cam-2');
  assert.equal(hyphenated.prefix, 'cam-');
  assert.equal(hyphenated.value, 2);
  assert.equal(formatStatValue(hyphenated, 8), 'cam-8');
});

