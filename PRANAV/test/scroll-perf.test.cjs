const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cssPath = path.join(__dirname, '../public/css/perf-scroll.css');
const jsPath = path.join(__dirname, '../public/js/scroll-perf-guard.js');
const indexHtmlPath = path.join(__dirname, '../public/index.html');
const towerHtmlPath = path.join(__dirname, '../public/tower.html');

const { initScrollPerfGuard, SCROLL_IDLE_MS } = require('../public/js/scroll-perf-guard.js');

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseCssBlocks(css) {
  const clean = stripCssComments(css);
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(clean)) !== null) {
    blocks.push({
      selector: match[1].trim().replace(/\s+/g, ' '),
      body: match[2].trim().replace(/\s+/g, ' '),
    });
  }
  return blocks;
}

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    get now() { return now; },
    get pendingCount() { return tasks.size; },
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      tasks.set(id, { fn, runAt: now + delay });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        let earliestId = null;
        let earliest = null;
        for (const [id, task] of tasks) {
          if (task.runAt <= target && (!earliest || task.runAt < earliest.runAt)) {
            earliest = task;
            earliestId = id;
          }
        }
        if (!earliest) break;
        tasks.delete(earliestId);
        now = earliest.runAt;
        earliest.fn();
      }
      now = target;
    },
  };
}

function createMockVideo({ paused = false, autoplay = false, ended = false, srcObject = null, closedDetails = false, rejectPlay = false } = {}) {
  let pauseCalls = 0;
  let playCalls = 0;
  return {
    tagName: 'VIDEO',
    nodeType: 1,
    dataset: {},
    autoplay,
    paused,
    ended,
    srcObject,
    get pauseCalls() { return pauseCalls; },
    get playCalls() { return playCalls; },
    hasAttribute(attr) { return attr === 'autoplay' ? autoplay : false; },
    closest(sel) {
      return closedDetails && sel === 'details:not([open])' ? {} : null;
    },
    pause() {
      pauseCalls++;
      this.paused = true;
    },
    play() {
      playCalls++;
      if (rejectPlay) return Promise.reject(new Error('Autoplay prevented'));
      this.paused = false;
      return Promise.resolve();
    },
  };
}

function createHarness({ readyState = 'complete', initialElements = [] } = {}) {
  const timers = createFakeTimers();
  const winListeners = new Map();
  const docListeners = new Map();
  const elements = [...initialElements];
  const observers = [];
  const mutationObservers = [];

  class MockIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() {
      this.disconnected = true;
      this.observed.clear();
    }
    trigger(entries) {
      this.callback(entries, this);
    }
  }

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      mutationObservers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
    emit(records) {
      this.callback(records, this);
    }
  }

  let datasetWrites = 0;
  const rawDataset = {};
  const dataset = new Proxy(rawDataset, {
    set(target, prop, value) {
      datasetWrites++;
      target[prop] = String(value);
      return true;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      return true;
    },
  });

  const documentElement = {
    nodeType: 1,
    dataset,
    getBoundingClientRect() {
      assert.fail('getBoundingClientRect must never be called');
    },
  };

  for (const layoutProp of ['offsetHeight', 'offsetTop', 'clientHeight', 'scrollTop', 'scrollHeight']) {
    Object.defineProperty(documentElement, layoutProp, {
      get() {
        assert.fail(`Layout property ${layoutProp} must never be read`);
      },
    });
  }

  const root = {
    readyState,
    documentElement,
    body: { nodeType: 1 },
    addEventListener(type, fn, opts) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push({ fn, opts });
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      docListeners.set(type, list.filter(item => item.fn !== fn));
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'video, [data-pause-offscreen]');
      return elements.slice();
    },
    getBoundingClientRect() {
      assert.fail('getBoundingClientRect must never be called');
    },
  };

  const win = {
    IntersectionObserver: MockIntersectionObserver,
    MutationObserver: MockMutationObserver,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    addEventListener(type, fn, opts) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push({ fn, opts });
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type) || [];
      winListeners.set(type, list.filter(item => item.fn !== fn));
    },
    getComputedStyle() {
      assert.fail('getComputedStyle must never be called inside scroll perf guard');
    },
  };

  for (const winLayoutProp of ['scrollY', 'pageYOffset', 'innerHeight', 'innerWidth']) {
    Object.defineProperty(win, winLayoutProp, {
      get() {
        assert.fail(`Window geometry property ${winLayoutProp} must never be read`);
      },
    });
  }

  return {
    root,
    win,
    timers,
    elements,
    observers,
    mutationObservers,
    winListeners,
    docListeners,
    get datasetWrites() { return datasetWrites; },
    dispatchScroll() {
      for (const { fn } of winListeners.get('scroll') || []) fn();
    },
  };
}

test('perf-scroll.css applies offscreen content-visibility only to below-the-fold static landing sections', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const blocks = parseCssBlocks(css);
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const towerHtml = fs.readFileSync(towerHtmlPath, 'utf8');

  // Confirm landing and tower targets match real DOM hooks in read-only HTML files.
  for (const landingHook of ['id="risk"', 'id="stack"', 'id="faq"', 'class="foot"', 'header class="bar"', 'class="hero"', 'id="film"']) {
    assert.ok(indexHtml.includes(landingHook), `index.html contains ${landingHook}`);
  }
  assert.ok(towerHtml.includes('id="map"') && towerHtml.includes('.tile'), 'tower.html contains #map and .tile');

  const offscreenBlock = blocks.find(b => b.body.includes('content-visibility: auto'));
  assert.ok(offscreenBlock, 'defines a content-visibility: auto rule');
  assert.match(offscreenBlock.body, /contain-intrinsic-size:\s*auto\s+560px/);

  const offscreenSelectors = offscreenBlock.selector.split(',').map(s => s.trim());
  assert.deepEqual(offscreenSelectors, ['#risk', '#stack', '#faq', '.foot']);

  for (const block of blocks) {
    if (block.body.includes('content-visibility: auto') || block.body.includes('560px')) {
      for (const forbidden of ['header.bar', '.bar', '.hero', '#film']) {
        assert.equal(block.selector.includes(forbidden), false, `${forbidden} must never get content-visibility: auto`);
      }
    }
  }

  const appRiskReset = blocks.find(b => b.selector.includes('body.app #risk'));
  assert.ok(appRiskReset, 'resets live operational #risk cards on body.app pages');
  assert.match(appRiskReset.body, /content-visibility:\s*visible/);
  assert.match(appRiskReset.body, /contain-intrinsic-size:\s*none/);
});

test('perf-scroll.css isolates .tile, #map, and .live-ai-card and suppresses non-header scroll GPU spikes', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const blocks = parseCssBlocks(css);

  const containBlock = blocks.find(b => b.body.includes('contain: layout paint'));
  assert.ok(containBlock, 'defines contain: layout paint rule');
  assert.deepEqual(containBlock.selector.split(',').map(s => s.trim()), ['.tile', '#map', '.live-ai-card']);

  const backdropDisable = blocks.find(
    b => b.selector.includes(':root[data-scrolling="1"]') && /backdrop-filter:\s*none/.test(b.body)
  );
  assert.ok(backdropDisable, 'disables non-essential backdrop-filter during active scroll');
  assert.match(backdropDisable.selector, /:not\(header\.bar \*\)/, 'excludes header.bar descendants');

  const hoverShadowDisable = blocks.find(
    b => b.selector.includes(':root[data-scrolling="1"]') && b.selector.includes(':hover') && /box-shadow:\s*none/.test(b.body)
  );
  assert.ok(hoverShadowDisable, 'disables hover box-shadow recalculations during active scroll');
  assert.match(hoverShadowDisable.selector, /:not\(header\.bar \*\)/);

  const headerCrisp = blocks.find(b => b.selector === ':root[data-scrolling="1"] header.bar');
  assert.ok(headerCrisp, 'keeps sticky header.bar crisp during scroll');
  assert.match(headerCrisp.body, /backdrop-filter:\s*saturate\(1\.4\)\s*blur\(10px\)/);
});

test('passive scroll listener toggles data-scrolling="1" with a 140 ms idle debounce and zero layout reads', () => {
  assert.equal(SCROLL_IDLE_MS, 140);
  const h = createHarness();
  const guard = initScrollPerfGuard(h.root, { win: h.win });

  const scrollListeners = h.winListeners.get('scroll') || [];
  assert.equal(scrollListeners.length, 1);
  assert.deepEqual(scrollListeners[0].opts, { passive: true });
  assert.equal(h.root.documentElement.dataset.scrolling, undefined);

  // Burst of high-refresh-rate scroll events spaced 80 ms apart (< 140 ms):
  h.dispatchScroll();
  assert.equal(h.root.documentElement.dataset.scrolling, '1');
  assert.equal(guard.isScrolling(), true);
  assert.equal(h.datasetWrites, 1);

  h.timers.advance(80);
  h.dispatchScroll();
  assert.equal(h.root.documentElement.dataset.scrolling, '1');
  assert.equal(h.datasetWrites, 1, 'sustained scroll frames do not redundantly mutate DOM dataset');

  h.timers.advance(80);
  h.dispatchScroll();
  assert.equal(h.root.documentElement.dataset.scrolling, '1');

  // 139 ms after the final scroll event: still marked scrolling.
  h.timers.advance(139);
  assert.equal(h.root.documentElement.dataset.scrolling, '1');

  // At 140 ms idle: cleared cleanly.
  h.timers.advance(1);
  assert.equal(h.root.documentElement.dataset.scrolling, undefined);
  assert.equal(guard.isScrolling(), false);

  guard.destroy();
  assert.equal((h.winListeners.get('scroll') || []).length, 0);
});

test('shared IntersectionObserver pauses offscreen preview videos and [data-pause-offscreen] containers and resumes cleanly', async () => {
  const loopingPromo = createMockVideo({ paused: false, rejectPlay: true });
  const unplayedDemo = createMockVideo({ paused: true });
  const liveCameraStream = createMockVideo({ paused: false, srcObject: { id: 'live-webcam' } });
  const closedTowerDemo = createMockVideo({ paused: false, closedDetails: true });
  const nestedClip = createMockVideo({ paused: false });
  const pauseContainer = {
    tagName: 'DIV',
    nodeType: 1,
    dataset: { pauseOffscreen: '' },
    querySelectorAll(sel) {
      assert.equal(sel, 'video');
      return [nestedClip];
    },
  };

  const h = createHarness({
    initialElements: [loopingPromo, unplayedDemo, liveCameraStream, closedTowerDemo, pauseContainer],
  });
  const guard = initScrollPerfGuard(h.root, { win: h.win });

  assert.equal(h.observers.length, 1, 'creates a single shared IntersectionObserver');
  const [io] = h.observers;
  assert.equal(io.observed.size, 5);

  // Scroll all elements completely out of view (intersectionRatio === 0).
  io.trigger([
    { target: loopingPromo, intersectionRatio: 0, isIntersecting: false },
    { target: unplayedDemo, intersectionRatio: 0, isIntersecting: false },
    { target: liveCameraStream, intersectionRatio: 0, isIntersecting: false },
    { target: closedTowerDemo, intersectionRatio: 0, isIntersecting: false },
    { target: pauseContainer, intersectionRatio: 0, isIntersecting: false },
  ]);

  assert.equal(loopingPromo.paused, true, 'playing preview video pauses offscreen');
  assert.equal(loopingPromo.pauseCalls, 1);
  assert.equal(unplayedDemo.paused, true);
  assert.equal(unplayedDemo.pauseCalls, 0, 'already-paused video is not touched');
  assert.equal(liveCameraStream.paused, false, 'live MediaStream camera feed is never paused offscreen');
  assert.equal(nestedClip.paused, true, 'nested video inside [data-pause-offscreen] pauses');
  assert.equal(pauseContainer.dataset.offscreen, '1');

  // Scroll all elements back into view: only active guard-paused videos resume; rejected play() promises do not throw.
  io.trigger([
    { target: loopingPromo, intersectionRatio: 0.35, isIntersecting: true },
    { target: unplayedDemo, intersectionRatio: 0.5, isIntersecting: true },
    { target: closedTowerDemo, intersectionRatio: 0.4, isIntersecting: true },
    { target: pauseContainer, intersectionRatio: 0.25, isIntersecting: true },
  ]);
  await Promise.resolve();

  assert.equal(loopingPromo.playCalls, 1, 'guard-paused video resumes when visible again');
  assert.equal(unplayedDemo.playCalls, 0, 'unplayed/user-paused video never auto-starts on scroll');
  assert.equal(closedTowerDemo.playCalls, 0, 'video inside closed <details> does not play');
  assert.equal(nestedClip.paused, false, 'nested video inside [data-pause-offscreen] resumes');
  assert.equal(pauseContainer.dataset.offscreen, undefined);

  // Dynamically added video (e.g. demo.js catalog card) joins the same shared observer.
  const dynamicClip = createMockVideo({ paused: true, autoplay: true });
  h.mutationObservers[0].emit([{ addedNodes: [dynamicClip], removedNodes: [] }]);
  assert.equal(h.observers.length, 1);
  assert.equal(io.observed.has(dynamicClip), true);

  // Initially-offscreen autoplay preview pauses pending load and starts when scrolled into view,
  // then respects a manual user pause on subsequent scroll cycles.
  io.trigger([{ target: dynamicClip, intersectionRatio: 0, isIntersecting: false }]);
  assert.equal(dynamicClip.pauseCalls, 1);
  io.trigger([{ target: dynamicClip, intersectionRatio: 0.6, isIntersecting: true }]);
  assert.equal(dynamicClip.paused, false);
  assert.equal(dynamicClip.playCalls, 1);

  dynamicClip.pause(); // User manually pauses while onscreen.
  io.trigger([{ target: dynamicClip, intersectionRatio: 0, isIntersecting: false }]);
  io.trigger([{ target: dynamicClip, intersectionRatio: 0.6, isIntersecting: true }]);
  assert.equal(dynamicClip.paused, true, 'manual user pause while onscreen is respected across scroll cycles');
  assert.equal(dynamicClip.playCalls, 1);

  guard.destroy();
  assert.equal(io.disconnected, true);
});

test('supports ESM dynamic import, browser IIFE auto-init during loading state, and idempotent re-init', async () => {
  const esm = await import('../public/js/scroll-perf-guard.js');
  assert.equal(typeof esm.initScrollPerfGuard, 'function');

  const h = createHarness({ readyState: 'loading', initialElements: [createMockVideo({ paused: false })] });
  const scriptSource = fs.readFileSync(jsPath, 'utf8');
  const browserContext = {
    window: h.win,
    document: h.root,
    IntersectionObserver: h.win.IntersectionObserver,
    MutationObserver: h.win.MutationObserver,
    setTimeout: h.win.setTimeout,
    clearTimeout: h.win.clearTimeout,
  };
  browserContext.globalThis = browserContext;
  h.win.document = h.root;

  vm.runInNewContext(scriptSource, browserContext);
  assert.equal(typeof h.win.initScrollPerfGuard, 'function');
  assert.equal((h.winListeners.get('scroll') || []).length, 1, 'auto-initializes passive scroll listener in browser IIFE');

  // Fire DOMContentLoaded and re-run initScrollPerfGuard on the same root: must remain a single listener.
  for (const { fn } of h.docListeners.get('DOMContentLoaded') || []) fn();
  const second = h.win.initScrollPerfGuard(h.root, { win: h.win });
  assert.equal((h.winListeners.get('scroll') || []).length, 1, 're-init replaces prior guard without duplicate listeners');
  second.destroy();
});
