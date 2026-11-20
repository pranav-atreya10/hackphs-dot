const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const themeSource = fs.readFileSync(path.join(__dirname, '../public/js/theme.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '../public/css/view-transitions.css'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness({
  savedTheme = null,
  storageThrows = false,
  prefersDark = false,
  reducedMotion = false,
  innerWidth = 1280,
  innerHeight = 720,
  startViewTransition = 'supported',
  buttonRect = { left: 1200, top: 16, width: 32, height: 32 },
} = {}) {
  const store = new Map();
  if (savedTheme !== null) store.set('skysentryTheme', savedTheme);

  const localStorage = {
    getItem(key) {
      if (storageThrows) throw new Error('SecurityError');
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, val) {
      if (storageThrows) throw new Error('SecurityError');
      store.set(key, String(val));
    },
  };

  const darkListeners = [];
  const mediaState = { prefersDark, reducedMotion };
  function matchMedia(query) {
    if (query === '(prefers-color-scheme: dark)') {
      return {
        get matches() { return mediaState.prefersDark; },
        addEventListener(type, fn) { if (type === 'change') darkListeners.push(fn); },
      };
    }
    if (query === '(prefers-reduced-motion: reduce)') {
      return {
        get matches() { return mediaState.reducedMotion; },
        addEventListener() {},
      };
    }
    return { matches: false, addEventListener() {} };
  }

  const themeEvents = [];
  const animations = [];
  const rootListeners = new Map();
  const root = {
    dataset: {},
    clientWidth: innerWidth,
    clientHeight: innerHeight,
    addEventListener(type, fn) {
      if (!rootListeners.has(type)) rootListeners.set(type, []);
      rootListeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      if (event.type === 'themechange') themeEvents.push(structuredClone(event.detail));
      for (const fn of rootListeners.get(event.type) || []) fn(event);
      return true;
    },
    animate(keyframes, options) {
      const record = {
        ...structuredClone({ keyframes, options }),
        themeTransitionDuringAnimate: root.dataset.themeTransition,
      };
      animations.push(record);
      return { finished: Promise.resolve() };
    },
  };

  const toggleAttrs = new Map();
  const toggleListeners = new Map();
  const toggleBtn = {
    innerHTML: '',
    title: '',
    setAttribute(name, val) { toggleAttrs.set(name, String(val)); },
    getAttribute(name) { return toggleAttrs.get(name) ?? null; },
    addEventListener(type, fn) {
      if (!toggleListeners.has(type)) toggleListeners.set(type, []);
      toggleListeners.get(type).push(fn);
    },
    getBoundingClientRect: buttonRect ? () => buttonRect : undefined,
    click(eventInit = {}) {
      const event = { currentTarget: toggleBtn, target: toggleBtn, ...eventInit };
      for (const fn of toggleListeners.get('click') || []) fn(event);
    },
  };

  const sideAttrs = new Map();
  const sidebar = {
    hasAttribute(name) { return sideAttrs.has(name); },
    toggleAttribute(name, force) {
      const next = force === undefined ? !sideAttrs.has(name) : Boolean(force);
      if (next) sideAttrs.set(name, ''); else sideAttrs.delete(name);
      return next;
    },
  };

  const sideBtnAttrs = new Map([['aria-controls', 'side'], ['aria-expanded', 'false']]);
  const sideBtnListeners = new Map();
  const sideBtn = {
    getAttribute(name) { return sideBtnAttrs.get(name) ?? null; },
    setAttribute(name, val) { sideBtnAttrs.set(name, String(val)); },
    addEventListener(type, fn) {
      if (!sideBtnListeners.has(type)) sideBtnListeners.set(type, []);
      sideBtnListeners.get(type).push(fn);
    },
    click() {
      for (const fn of sideBtnListeners.get('click') || []) fn({ currentTarget: sideBtn, target: sideBtn });
    },
  };

  let domLoaded = false;
  const docListeners = new Map();
  const transitions = [];

  const document = {
    documentElement: root,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    querySelectorAll(selector) {
      if (!domLoaded) return [];
      if (selector === '[data-theme-toggle]') return [toggleBtn];
      if (selector === '[data-side-toggle]') return [sideBtn];
      return [];
    },
    getElementById(id) {
      return id === 'side' ? sidebar : null;
    },
  };

  if (startViewTransition === 'supported') {
    document.startViewTransition = callback => {
      const ready = deferred();
      const finished = deferred();
      const stateBeforeCallback = {
        datasetTheme: root.dataset.theme,
        themeTransition: root.dataset.themeTransition,
      };
      callback();
      ready.resolve();
      const record = {
        stateBeforeCallback,
        datasetThemeAfterCallback: root.dataset.theme,
        finished,
        transition: { ready: ready.promise, finished: finished.promise },
      };
      transitions.push(record);
      return record.transition;
    };
  } else if (typeof startViewTransition === 'function') {
    document.startViewTransition = startViewTransition;
  }

  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const window = { innerWidth, innerHeight, matchMedia };
  const context = {
    window,
    document,
    localStorage,
    matchMedia,
    CustomEvent,
    innerWidth,
    innerHeight,
    Math,
    Number,
    Boolean,
    String,
    Promise,
  };

  vm.runInNewContext(themeSource, context);

  return {
    window,
    document,
    root,
    store,
    mediaState,
    themeEvents,
    animations,
    transitions,
    toggleBtn,
    sidebar,
    sideBtn,
    fireDOMContentLoaded() {
      domLoaded = true;
      for (const fn of docListeners.get('DOMContentLoaded') || []) fn();
    },
    setPrefersDark(next) {
      mediaState.prefersDark = next;
      for (const fn of darkListeners) fn({ matches: next });
    },
  };
}

test('synchronously applies saved theme in <head> before DOMContentLoaded and preserves core API', () => {
  const h = createHarness({ savedTheme: 'dark', prefersDark: false });
  assert.equal(h.root.dataset.theme, 'dark');
  assert.equal(h.window.skysentryTheme.mode(), 'dark');
  assert.equal(h.window.skysentryTheme.isDark(), true);
  assert.deepEqual(h.themeEvents, [{ dark: true }]);

  h.fireDOMContentLoaded();
  assert.equal(h.toggleBtn.getAttribute('aria-label'), 'Theme: dark');
  assert.equal(h.toggleBtn.title, 'Theme: dark');
  assert.match(h.toggleBtn.innerHTML, /<svg/);

  h.window.skysentryTheme.set('invalid-mode');
  assert.equal(h.window.skysentryTheme.mode(), 'dark');

  h.window.skysentryTheme.set('light');
  assert.equal(h.root.dataset.theme, 'light');
  assert.equal(h.window.skysentryTheme.isDark(), false);
  assert.equal(h.store.get('skysentryTheme'), 'light');
  assert.equal(h.transitions.length, 0);

  h.window.skysentryTheme.set('system');
  assert.equal('theme' in h.root.dataset, false);
  assert.equal(h.window.skysentryTheme.isDark(), false);
  h.setPrefersDark(true);
  assert.equal(h.window.skysentryTheme.isDark(), true);
  assert.equal(h.themeEvents.at(-1).dark, true);

  h.sideBtn.click();
  assert.equal(h.sidebar.hasAttribute('data-open'), true);
  assert.equal(h.sideBtn.getAttribute('aria-expanded'), 'true');
  h.sideBtn.click();
  assert.equal(h.sidebar.hasAttribute('data-open'), false);
  assert.equal(h.sideBtn.getAttribute('aria-expanded'), 'false');
});

test('survives blocked localStorage and cycles system -> light -> dark -> system', () => {
  const h = createHarness({ storageThrows: true, startViewTransition: null });
  h.fireDOMContentLoaded();
  assert.equal(h.window.skysentryTheme.mode(), 'system');
  h.toggleBtn.click();
  assert.equal(h.window.skysentryTheme.mode(), 'light');
  h.toggleBtn.click();
  assert.equal(h.window.skysentryTheme.mode(), 'dark');
  h.toggleBtn.click();
  assert.equal(h.window.skysentryTheme.mode(), 'system');
});

test('runs circular clip-path View Transition from toggle button center when dark/light state changes', async () => {
  const h = createHarness({
    savedTheme: 'light',
    prefersDark: false,
    innerWidth: 1280,
    innerHeight: 720,
    buttonRect: { left: 1200, top: 16, width: 32, height: 32 },
  });
  h.fireDOMContentLoaded();

  h.toggleBtn.click();
  assert.equal(h.transitions.length, 1);
  assert.equal(h.transitions[0].stateBeforeCallback.datasetTheme, 'light');
  assert.equal(h.transitions[0].stateBeforeCallback.themeTransition, '1');
  assert.equal(h.transitions[0].datasetThemeAfterCallback, 'dark');
  assert.equal(h.root.dataset.themeTransition, '1');

  await Promise.resolve();
  assert.equal(h.animations.length, 1);
  const expectedX = 1216;
  const expectedY = 32;
  const expectedRadius = Math.hypot(Math.max(expectedX, 1280 - expectedX), Math.max(expectedY, 720 - expectedY));
  assert.deepEqual(h.animations[0].keyframes, {
    clipPath: [
      `circle(0px at ${expectedX}px ${expectedY}px)`,
      `circle(${expectedRadius}px at ${expectedX}px ${expectedY}px)`,
    ],
  });
  assert.deepEqual(h.animations[0].options, {
    duration: 420,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    pseudoElement: '::view-transition-new(root)',
  });
  assert.equal(h.animations[0].themeTransitionDuringAnimate, '1');
  assert.equal(h.root.dataset.themeTransition, '1');

  h.transitions[0].finished.resolve();
  await h.transitions[0].transition.finished;
  await Promise.resolve();
  assert.equal('themeTransition' in h.root.dataset, false);
});

test('supports window.skysentryTheme.set(mode, { originEvent }) with pointer coordinates and cleans up on aborted finish', async () => {
  const h = createHarness({ savedTheme: 'dark', innerWidth: 1000, innerHeight: 800 });
  h.fireDOMContentLoaded();

  h.window.skysentryTheme.set('light', { originEvent: { clientX: 250, clientY: 600 } });
  assert.equal(h.transitions.length, 1);
  await Promise.resolve();

  const expectedRadius = Math.hypot(750, 600);
  assert.deepEqual(h.animations[0].keyframes, {
    clipPath: [
      'circle(0px at 250px 600px)',
      `circle(${expectedRadius}px at 250px 600px)`,
    ],
  });

  h.transitions[0].finished.reject(new Error('AbortError'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal('themeTransition' in h.root.dataset, false);
});

test('skips View Transition when visual dark/light state does not change or reduced motion is enabled', () => {
  // OS is light: cycling system -> light keeps light appearance, so no view transition should run.
  const sameVisual = createHarness({ savedTheme: 'system', prefersDark: false });
  sameVisual.fireDOMContentLoaded();
  sameVisual.toggleBtn.click();
  assert.equal(sameVisual.window.skysentryTheme.mode(), 'light');
  assert.equal(sameVisual.transitions.length, 0);
  assert.equal('themeTransition' in sameVisual.root.dataset, false);

  // Reduced motion enabled: light -> dark changes visual state, but must apply immediately without View Transition.
  const reduced = createHarness({ savedTheme: 'light', reducedMotion: true });
  reduced.fireDOMContentLoaded();
  reduced.toggleBtn.click();
  assert.equal(reduced.window.skysentryTheme.mode(), 'dark');
  assert.equal(reduced.root.dataset.theme, 'dark');
  assert.equal(reduced.transitions.length, 0);
  assert.equal(reduced.animations.length, 0);
  assert.equal('themeTransition' in reduced.root.dataset, false);
});

test('falls back immediately and cleans up dataset flag when startViewTransition is unavailable or throws', () => {
  const noApi = createHarness({ savedTheme: 'light', startViewTransition: null });
  noApi.fireDOMContentLoaded();
  noApi.toggleBtn.click();
  assert.equal(noApi.window.skysentryTheme.mode(), 'dark');
  assert.equal(noApi.root.dataset.theme, 'dark');
  assert.equal('themeTransition' in noApi.root.dataset, false);

  const throwing = createHarness({
    savedTheme: 'light',
    startViewTransition() {
      throw new Error('InvalidStateError');
    },
  });
  throwing.fireDOMContentLoaded();
  throwing.toggleBtn.click();
  assert.equal(throwing.window.skysentryTheme.mode(), 'dark');
  assert.equal(throwing.root.dataset.theme, 'dark');
  assert.equal('themeTransition' in throwing.root.dataset, false);
});

test('superseded transition finishing early does not clear data-theme-transition for an active transition', async () => {
  const h = createHarness({ savedTheme: 'light' });
  h.fireDOMContentLoaded();

  h.toggleBtn.click(); // light -> dark (transition 0)
  h.window.skysentryTheme.set('light', { originEvent: { clientX: 100, clientY: 100 } }); // dark -> light (transition 1)
  assert.equal(h.transitions.length, 2);

  h.transitions[0].finished.reject(new Error('AbortError'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.root.dataset.themeTransition, '1');

  h.transitions[1].finished.resolve();
  await h.transitions[1].transition.finished;
  await Promise.resolve();
  assert.equal('themeTransition' in h.root.dataset, false);
});

test('handles real-browser async startViewTransition callback timing without mutating old snapshot prematurely', async () => {
  const ready = deferred();
  const finished = deferred();
  let capturedOldTheme = null;
  let callbackFn = null;
  const h = createHarness({
    savedTheme: 'light',
    startViewTransition(cb) {
      capturedOldTheme = h.root.dataset.theme;
      callbackFn = cb;
      return { ready: ready.promise, finished: finished.promise };
    },
  });
  h.fireDOMContentLoaded();

  h.toggleBtn.click();
  // Before the browser invokes updateCallback, old DOM snapshot still reflects 'light' while flag is '1'.
  assert.equal(capturedOldTheme, 'light');
  assert.equal(h.root.dataset.theme, 'light');
  assert.equal(h.root.dataset.themeTransition, '1');

  callbackFn();
  assert.equal(h.root.dataset.theme, 'dark');
  assert.equal(h.window.skysentryTheme.mode(), 'dark');

  ready.resolve();
  await ready.promise;
  assert.equal(h.animations.length, 1);

  finished.resolve();
  await finished.promise;
  await Promise.resolve();
  assert.equal('themeTransition' in h.root.dataset, false);
});

test('view-transitions.css configures reduced-motion navigation, 180ms cross-fade, theme override, and sky-brand morph', () => {
  let depth = 0;
  for (const ch of cssSource) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    assert.ok(depth >= 0, 'unexpected closing brace in view-transitions.css');
  }
  assert.equal(depth, 0, 'unbalanced braces in view-transitions.css');

  assert.match(cssSource, /@media\s*\(\s*prefers-reduced-motion:\s*no-preference\s*\)\s*\{[\s\S]*?@view-transition\s*\{\s*navigation:\s*auto\s*;?\s*\}/);
  assert.match(cssSource, /::view-transition-old\(root\)[\s\S]*?180ms/);
  assert.match(cssSource, /::view-transition-new\(root\)[\s\S]*?180ms/);
  assert.match(cssSource, /:root\[data-theme-transition="1"\]::view-transition-old\(root\)[\s\S]*?animation:\s*none\s*;[\s\S]*?mix-blend-mode:\s*normal/);
  assert.match(cssSource, /:root\[data-theme-transition="1"\]::view-transition-new\(root\)/);
  assert.match(cssSource, /\.brand\s*\{[\s\S]*?view-transition-name:\s*sky-brand\s*;?/);
});
