const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cssPath = path.resolve(__dirname, '../public/css/smooth-details.css');
const jsPath = path.resolve(__dirname, '../public/js/smooth-details.js');
const { initSmoothDetails, DEFAULT_SELECTOR } = require(jsPath);

function createMockAnimation() {
  let resolveFinished, rejectFinished;
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // Prevent unhandled rejection noise when an animation is cancelled mid-flight.
  finished.catch(() => {});

  const listeners = new Map();
  const anim = {
    onfinish: null,
    oncancel: null,
    finished,
    cancelled: false,
    completed: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    finish() {
      if (this.completed || this.cancelled) return;
      this.completed = true;
      this.onfinish?.();
      for (const fn of listeners.get('finish') || []) fn();
      resolveFinished(this);
    },
    cancel() {
      if (this.completed || this.cancelled) return;
      this.cancelled = true;
      this.oncancel?.();
      for (const fn of listeners.get('cancel') || []) fn();
      rejectFinished(new Error('AbortError'));
    },
  };
  return anim;
}

function createDomFixture({
  reducedMotion = false,
  nativeCssSupport = false,
  withAnimate = true,
} = {}) {
  const animations = [];
  const computedStyles = new WeakMap();

  class MockElement {
    constructor(tagName, { id = '', className = '', parent = null } = {}) {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = className;
      this.parentElement = parent;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this._listeners = new Map();
      this._open = false;
      this._closedHeight = 52;
      this._openHeight = 260;
      this._currentHeight = null;
    }

    get classList() {
      return new Set(this.className.split(/\s+/).filter(Boolean));
    }

    append(...nodes) {
      for (const node of nodes) {
        node.parentElement = this;
        this.children.push(node);
      }
      return this;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'open') this._open = true;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === 'open') this._open = false;
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    toggleAttribute(name, force) {
      const next = force === undefined ? !this.hasAttribute(name) : Boolean(force);
      if (next) this.setAttribute(name, '');
      else this.removeAttribute(name);
      return next;
    }

    addEventListener(type, fn, opts) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push({ fn, once: Boolean(opts && opts.once) });
    }

    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (!list) return;
      this._listeners.set(type, list.filter(entry => entry.fn !== fn));
    }

    dispatchEvent(event) {
      const evt = event || {};
      if (!evt.target) evt.target = this;
      if (evt.defaultPrevented === undefined) evt.defaultPrevented = false;
      if (typeof evt.preventDefault !== 'function') {
        evt.preventDefault = () => { evt.defaultPrevented = true; };
      }
      const list = [...(this._listeners.get(evt.type) || [])];
      for (const entry of list) {
        if (entry.once) this.removeEventListener(evt.type, entry.fn);
        entry.fn.call(this, evt);
      }
      return !evt.defaultPrevented;
    }

    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    closest(selector) {
      const parts = selector.split(',').map(s => s.trim());
      let cur = this;
      while (cur) {
        if (parts.some(part => cur._matchesSingle(part))) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    matches(selector) {
      return selector.split(',').map(s => s.trim()).some(part => this._matchesSingle(part));
    }

    _matchesSingle(sel) {
      if (sel === ':scope > summary' || sel === 'summary') return this.tagName === 'SUMMARY';
      if (sel === 'details.fold') return this.tagName === 'DETAILS' && this.classList.has('fold');
      if (sel === 'details.card') return this.tagName === 'DETAILS' && this.classList.has('card');
      if (sel === '.faq details') {
        if (this.tagName !== 'DETAILS') return false;
        let p = this.parentElement;
        while (p) {
          if (p.classList && p.classList.has('faq')) return true;
          p = p.parentElement;
        }
        return false;
      }
      if (sel === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
      if (sel === 'button') return this.tagName === 'BUTTON';
      return false;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
      const out = [];
      const visit = node => {
        for (const child of node.children) {
          if (selector === ':scope > summary') {
            if (node === this && child.tagName === 'SUMMARY') out.push(child);
          } else if (child.matches(selector)) {
            out.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return out;
    }

    get open() {
      return this._open;
    }

    set open(val) {
      const next = Boolean(val);
      this._open = next;
      if (next) this.attributes.set('open', '');
      else this.attributes.delete('open');
    }

    get offsetHeight() {
      if (this._currentHeight !== null) return this._currentHeight;
      if (this.tagName === 'SUMMARY') return 28;
      if (this.tagName === 'DETAILS') return this._open ? this._openHeight : this._closedHeight;
      return 0;
    }

    getBoundingClientRect() {
      return { height: this.offsetHeight, top: 0, left: 0, width: 480 };
    }

    click(detail = 1) {
      const evt = {
        type: 'click',
        button: 0,
        detail,
        target: this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
      };
      this.dispatchEvent(evt);
      // Native browser default action for <summary>: toggle parent <details> when not prevented.
      if (!evt.defaultPrevented && this.tagName === 'SUMMARY' && this.parentElement?.tagName === 'DETAILS') {
        const d = this.parentElement;
        d.open = !d.open;
        d.dispatchEvent({ type: 'toggle', target: d });
      }
      return evt;
    }
  }

  function makeDetails({ id = '', className = '', closedHeight = 56, openHeight = 240, paddingY = 14, borderY = 1 } = {}) {
    const details = new MockElement('details', { id, className });
    details._closedHeight = closedHeight;
    details._openHeight = openHeight;
    computedStyles.set(details, {
      paddingTop: `${paddingY}px`,
      paddingBottom: `${paddingY}px`,
      borderTopWidth: `${borderY}px`,
      borderBottomWidth: `${borderY}px`,
    });

    if (withAnimate) {
      details.animate = (keyframes, options) => {
        const anim = createMockAnimation();
        animations.push({ target: details, keyframes, options, anim });
        return anim;
      };
    }

    const summary = new MockElement('summary');
    computedStyles.set(summary, { marginTop: '0px', marginBottom: '0px' });
    const content = new MockElement('div', { className: 'body' });
    details.append(summary, content);
    return { details, summary, content };
  }

  const body = new MockElement('body');
  let mutationCallback = null;

  const win = {
    matchMedia(query) {
      return {
        media: query,
        matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
      };
    },
    getComputedStyle(el) {
      return computedStyles.get(el) || {
        paddingTop: '0px',
        paddingBottom: '0px',
        borderTopWidth: '0px',
        borderBottomWidth: '0px',
        marginTop: '0px',
        marginBottom: '0px',
      };
    },
    CSS: {
      supports(...args) {
        if (!nativeCssSupport) return false;
        const joined = args.join(':');
        return joined.includes('details-content') || joined.includes('allow-keywords');
      },
    },
    Event: class MockEvent {
      constructor(type) {
        this.type = type;
        this.defaultPrevented = false;
      }
      preventDefault() {
        this.defaultPrevented = true;
      }
    },
    MutationObserver: class MockMutationObserver {
      constructor(cb) { mutationCallback = cb; }
      observe() {}
      disconnect() { mutationCallback = null; }
    },
    setTimeout,
    clearTimeout,
  };

  const doc = {
    readyState: 'complete',
    defaultView: win,
    body,
    documentElement: body,
    querySelectorAll: sel => body.querySelectorAll(sel),
    addEventListener: (...args) => body.addEventListener(...args),
  };

  return {
    doc,
    win,
    body,
    animations,
    MockElement,
    makeDetails,
    notifyAdded(nodes) {
      mutationCallback?.([{ addedNodes: nodes }]);
    },
  };
}

test('smooth-details.css defines progressive ::details-content transitions, indicators, focus-visible, and reduced-motion reset', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /interpolate-size:\s*allow-keywords/);
  assert.match(css, /::details-content/);
  assert.match(css, /height\s+0\.28s\s+cubic-bezier\(\.2,\s*\.7,\s*\.2,\s*1\)/);
  assert.match(css, /opacity\s+0\.28s\s+cubic-bezier\(\.2,\s*\.7,\s*\.2,\s*1\)/);
  assert.match(css, /allow-discrete/);
  assert.match(css, /details\.fold/);
  assert.match(css, /\.faq details/);
  assert.match(css, /details\.card/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /summary::after/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);

  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  assert.equal(opens, closes, 'CSS braces must be balanced');
});

test('smooth-details.js supports CommonJS require, ESM import(), and classic browser IIFE execution', async () => {
  assert.equal(typeof initSmoothDetails, 'function');
  assert.equal(DEFAULT_SELECTOR, 'details.fold, .faq details, details.card');

  const esmMod = await import('../public/js/smooth-details.js');
  assert.equal(esmMod.initSmoothDetails || esmMod.default?.initSmoothDetails, initSmoothDetails);

  const fixture = createDomFixture();
  const { details, summary } = fixture.makeDetails({ id: 'more', className: 'card fold more' });
  fixture.body.append(details);

  const scriptSource = fs.readFileSync(jsPath, 'utf8');
  vm.runInNewContext(scriptSource, {
    window: fixture.win,
    document: fixture.doc,
    Event: fixture.win.Event,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  });

  assert.equal(typeof fixture.win.initSmoothDetails, 'function');
  summary.click();
  assert.equal(details.open, true);
  assert.equal(fixture.animations.length, 1);

  // Also verify deferred DOMContentLoaded startup when readyState === 'loading':
  const loadingFixture = createDomFixture();
  loadingFixture.doc.readyState = 'loading';
  const delayed = loadingFixture.makeDetails({ className: 'card fold' });
  loadingFixture.body.append(delayed.details);
  vm.runInNewContext(scriptSource, {
    window: loadingFixture.win,
    document: loadingFixture.doc,
    Event: loadingFixture.win.Event,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  });
  loadingFixture.body.dispatchEvent({ type: 'DOMContentLoaded' });
  delayed.summary.click();
  assert.equal(delayed.details.open, true);
  assert.equal(loadingFixture.animations.length, 1);
});

test('WAAPI expand & collapse preserve synchronous #more toggle lazy-loading and #towerDemo close lifecycle', () => {
  const fixture = createDomFixture();
  const more = fixture.makeDetails({ id: 'more', className: 'card fold more', closedHeight: 58, openHeight: 320 });
  const demo = fixture.makeDetails({ id: 'towerDemo', className: 'card', closedHeight: 58, openHeight: 280 });
  const faqWrap = new fixture.MockElement('div', { className: 'faq' });
  const faqItem = fixture.makeDetails({ closedHeight: 70, openHeight: 160, paddingY: 0, borderY: 1 });
  faqWrap.append(faqItem.details);
  fixture.body.append(more.details, demo.details, faqWrap);

  const controller = initSmoothDetails(fixture.doc, { win: fixture.win });
  assert.equal(controller.count, 3);

  // Simulate tower.js #more lazy chart/beacon activation listener:
  let chartLoads = 0;
  more.details.addEventListener('toggle', () => {
    if (more.details.open) chartLoads++;
  });

  // 1. Expand #more: [open] and toggle MUST fire synchronously on click before animation finishes!
  more.details.style.marginTop = '8px';
  more.summary.click();
  assert.equal(more.details.open, true);
  assert.equal(more.details.hasAttribute('open'), true);
  assert.equal(chartLoads, 1, 'tower #more toggle listener fires synchronously when opening');
  assert.equal(more.details.dataset.animating, 'true');
  assert.equal(fixture.animations.length, 1);
  assert.deepEqual(fixture.animations[0].keyframes, [{ height: '58px' }, { height: '320px' }]);
  assert.equal(fixture.animations[0].options.duration, 280);
  assert.equal(fixture.animations[0].options.easing, 'cubic-bezier(.2, .7, .2, 1)');

  fixture.animations[0].anim.finish();
  assert.equal(more.details.open, true);
  assert.equal(more.details.dataset.animating, undefined);
  assert.equal(more.details.style.height, '');
  assert.equal(more.details.style.overflow, '');
  assert.equal(more.details.style.marginTop, '8px', 'unrelated inline styles are preserved');

  // 2. Collapse #towerDemo: stays [open] during collapse animation, then closes and fires toggle once at finish.
  let videoState = 'idle';
  demo.details.addEventListener('toggle', () => {
    videoState = demo.details.open ? 'loaded' : 'unloaded';
  });

  demo.summary.click();
  fixture.animations[1].anim.finish();
  assert.equal(videoState, 'loaded');

  demo.summary.click();
  assert.equal(demo.details.open, true, 'remains open while collapse animation plays');
  assert.equal(demo.details.dataset.closing, 'true');
  assert.equal(videoState, 'loaded');
  // Collapsed height = summary(28) + padding(14*2) + border(1*2) = 58px
  assert.deepEqual(fixture.animations[2].keyframes, [{ height: '280px' }, { height: '58px' }]);

  fixture.animations[2].anim.finish();
  assert.equal(demo.details.open, false);
  assert.equal(demo.details.hasAttribute('open'), false);
  assert.equal(demo.details.dataset.closing, undefined);
  assert.equal(videoState, 'unloaded');

  // 3. FAQ details expand works cleanly too.
  faqItem.summary.click();
  assert.equal(faqItem.details.open, true);
  assert.deepEqual(fixture.animations[3].keyframes, [{ height: '70px' }, { height: '160px' }]);
  fixture.animations[3].anim.finish();

  controller.destroy();
});

test('mid-flight reversal smoothly interrupts collapse or expand without corrupting [open] or toggle count', () => {
  const fixture = createDomFixture();
  const { details, summary } = fixture.makeDetails({ id: 'more', className: 'card fold', closedHeight: 58, openHeight: 300 });
  fixture.body.append(details);
  initSmoothDetails(fixture.doc, { win: fixture.win });

  let toggleEvents = 0;
  details.addEventListener('toggle', () => { toggleEvents++; });

  // Open and complete.
  summary.click();
  fixture.animations[0].anim.finish();
  assert.equal(details.open, true);
  assert.equal(toggleEvents, 1);

  // Start collapsing, then interrupt at mid-height 150px to reopen!
  summary.click();
  assert.equal(fixture.animations.length, 2);
  const collapseAnim = fixture.animations[1].anim;
  details._currentHeight = 150;

  summary.click();
  assert.equal(collapseAnim.cancelled, true, 'in-flight collapse is cancelled');
  assert.equal(details.open, true, 'remains open without spurious close');
  assert.equal(details.dataset.closing, undefined);
  assert.equal(toggleEvents, 1, 'cancelled close does not fire bogus toggle');
  assert.equal(fixture.animations.length, 3);
  assert.equal(fixture.animations[2].keyframes[0].height, '150px');

  details._currentHeight = null;
  fixture.animations[2].anim.finish();
  assert.equal(details.open, true);
});

test('keyboard Enter and Space on <summary> animate without double-toggling on synthetic click, and nested links are untouched', async () => {
  const fixture = createDomFixture();
  const { details, summary } = fixture.makeDetails({ className: 'card fold', closedHeight: 58, openHeight: 220 });
  const nestedLink = new fixture.MockElement('a');
  nestedLink.setAttribute('href', '#help');
  summary.append(nestedLink);
  fixture.body.append(details);

  initSmoothDetails(fixture.doc, { win: fixture.win });

  // Pressing Enter activates expand; a subsequent browser synthetic click (detail: 0) must not double-toggle.
  const enterDown = {
    type: 'keydown',
    key: 'Enter',
    repeat: false,
    target: summary,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  summary.dispatchEvent(enterDown);
  assert.equal(enterDown.defaultPrevented, true);
  assert.equal(details.open, true);
  assert.equal(fixture.animations.length, 1);

  // Simulate quirky browser dispatching detail:0 click right after Enter keydown:
  summary.click(0);
  assert.equal(fixture.animations.length, 1, 'synthetic click after Enter does not double-toggle');
  fixture.animations[0].anim.finish();
  await new Promise(resolve => setImmediate(resolve));

  // Pressing Space collapses smoothly; key repeat is ignored.
  const spaceRepeat = {
    type: 'keydown',
    key: ' ',
    repeat: true,
    target: summary,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  summary.dispatchEvent(spaceRepeat);
  assert.equal(fixture.animations.length, 1, 'key repeat does not toggle');

  const spaceDown = {
    type: 'keydown',
    key: ' ',
    repeat: false,
    target: summary,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  summary.dispatchEvent(spaceDown);
  assert.equal(details.dataset.closing, 'true');
  assert.equal(fixture.animations.length, 2);
  summary.dispatchEvent({ type: 'keyup', key: ' ', target: summary });
  fixture.animations[1].anim.finish();
  assert.equal(details.open, false);

  // Clicking an interactive nested link inside <summary> does not toggle <details>.
  const linkClick = {
    type: 'click',
    button: 0,
    detail: 1,
    target: nestedLink,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  summary.dispatchEvent(linkClick);
  assert.equal(linkClick.defaultPrevented, false);
  assert.equal(details.open, false);
  assert.equal(fixture.animations.length, 2);
});

test('immediately skips animation when prefers-reduced-motion matches, el.animate is absent, or native ::details-content is supported', () => {
  // 1. Reduced motion:
  const reduced = createDomFixture({ reducedMotion: true });
  const rItem = reduced.makeDetails({ id: 'more', className: 'card fold' });
  reduced.body.append(rItem.details);
  initSmoothDetails(reduced.doc, { win: reduced.win });

  let rToggles = 0;
  rItem.details.addEventListener('toggle', () => { rToggles++; });
  const rClick = rItem.summary.click();
  assert.equal(rClick.defaultPrevented, false, 'does not intercept native toggle under reduced motion');
  assert.equal(rItem.details.open, true);
  assert.equal(rToggles, 1);
  assert.equal(reduced.animations.length, 0);

  // 2. Missing el.animate:
  const noWaapi = createDomFixture({ withAnimate: false });
  const nItem = noWaapi.makeDetails({ className: 'card' });
  noWaapi.body.append(nItem.details);
  initSmoothDetails(noWaapi.doc, { win: noWaapi.win });

  const nClick = nItem.summary.click();
  assert.equal(nClick.defaultPrevented, false);
  assert.equal(nItem.details.open, true);

  // 3. Native CSS ::details-content + allow-keywords supported:
  const nativeCss = createDomFixture({ nativeCssSupport: true });
  const cItem = nativeCss.makeDetails({ className: 'card fold' });
  nativeCss.body.append(cItem.details);
  initSmoothDetails(nativeCss.doc, { win: nativeCss.win });

  const cClick = cItem.summary.click();
  assert.equal(cClick.defaultPrevented, false, 'defers to CSS ::details-content when supported');
  assert.equal(cItem.details.open, true);
  assert.equal(nativeCss.animations.length, 0);
});

test('idempotent binding and MutationObserver auto-enhancement of dynamically inserted <details>', () => {
  const fixture = createDomFixture();
  const first = fixture.makeDetails({ className: 'card fold' });
  fixture.body.append(first.details);

  const a = initSmoothDetails(fixture.doc, { win: fixture.win });
  const b = initSmoothDetails(fixture.doc, { win: fixture.win });
  assert.equal(a.count, 1);
  assert.equal(b.count, 1);

  first.summary.click();
  assert.equal(fixture.animations.length, 1, 'duplicate initSmoothDetails calls never double-bind');
  fixture.animations[0].anim.finish();

  const dynamicItem = fixture.makeDetails({ className: 'card' });
  fixture.body.append(dynamicItem.details);
  fixture.notifyAdded([dynamicItem.details]);

  dynamicItem.summary.click();
  assert.equal(dynamicItem.details.open, true);
  assert.equal(fixture.animations.length, 2, 'dynamically inserted details.card is enhanced automatically');
  fixture.animations[1].anim.finish();

  a.destroy();
  b.destroy();
});
