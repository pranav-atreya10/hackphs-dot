const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cjsScrubber = require('../public/js/film-scrubber.js');

// Lightweight DOM + MutationObserver harness for pure Node testing (no external packages or headless browsers).
function createMockDOM({ hasFilmCss = false, reducedMotion = false } = {}) {
  const observers = new Set();

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.add(this);
    }
    observe(target, options = {}) {
      this.targets.push({ target, options });
    }
    disconnect() {
      this.targets = [];
    }
  }

  function notifyMutation(target, record) {
    for (const obs of observers) {
      for (const reg of obs.targets) {
        if (reg.target !== target) continue;
        if (record.type === 'childList' && reg.options.childList) {
          obs.callback([record], obs);
        } else if (
          record.type === 'attributes' &&
          reg.options.attributes &&
          (!reg.options.attributeFilter || reg.options.attributeFilter.includes(record.attributeName))
        ) {
          obs.callback([record], obs);
        }
      }
    }
  }

  function createStyle(owner) {
    const props = new Map();
    const styleTarget = {
      setProperty(name, value) {
        props.set(name, String(value));
        notifyMutation(owner, { type: 'attributes', target: owner, attributeName: 'style' });
      },
      getPropertyValue(name) {
        return props.get(name) || '';
      },
      removeProperty(name) {
        const prev = props.get(name) || '';
        props.delete(name);
        notifyMutation(owner, { type: 'attributes', target: owner, attributeName: 'style' });
        return prev;
      },
    };
    return new Proxy(styleTarget, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'string') return props.get(prop) ?? '';
        return undefined;
      },
      set(target, prop, value) {
        if (typeof prop === 'string') {
          props.set(prop, String(value));
          notifyMutation(owner, { type: 'attributes', target: owner, attributeName: 'style' });
        } else {
          target[prop] = value;
        }
        return true;
      },
    });
  }

  class MockClassList {
    constructor(owner) {
      this.owner = owner;
      this.set = new Set();
    }
    _syncFromString(str) {
      this.set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    _notify() {
      this.owner.attributes.set('class', [...this.set].join(' '));
      notifyMutation(this.owner, { type: 'attributes', target: this.owner, attributeName: 'class' });
    }
    add(...names) {
      let changed = false;
      for (const n of names) {
        if (n && !this.set.has(n)) { this.set.add(n); changed = true; }
      }
      if (changed) this._notify();
    }
    remove(...names) {
      let changed = false;
      for (const n of names) {
        if (this.set.delete(n)) changed = true;
      }
      if (changed) this._notify();
    }
    toggle(name, force) {
      const shouldHave = force === undefined ? !this.set.has(name) : Boolean(force);
      if (shouldHave) this.add(name);
      else this.remove(name);
      return shouldHave;
    }
    contains(name) {
      return this.set.has(name);
    }
    toString() {
      return [...this.set].join(' ');
    }
  }

  function toDataAttr(prop) {
    return 'data-' + String(prop).replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  }
  function toCamel(attr) {
    return attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  class MockElement {
    constructor(tagName, ownerDocument) {
      this.nodeType = 1;
      this.tagName = String(tagName).toUpperCase();
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
      this.parentElement = null;
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this.classList = new MockClassList(this);
      this.style = createStyle(this);
      this._text = '';
      this._rect = { left: 0, top: 0, width: 0, height: 0 };
      this.offsetWidth = 0;
      this.dataset = new Proxy({}, {
        get: (_, prop) => typeof prop === 'string' ? this.attributes.get(toDataAttr(prop)) : undefined,
        set: (_, prop, val) => {
          if (typeof prop === 'string') this.setAttribute(toDataAttr(prop), String(val));
          return true;
        },
        deleteProperty: (_, prop) => {
          if (typeof prop === 'string') this.removeAttribute(toDataAttr(prop));
          return true;
        },
      });
    }
    get id() { return this.attributes.get('id') || ''; }
    set id(v) { if (v) this.setAttribute('id', String(v)); else this.removeAttribute('id'); }
    get className() { return this.classList.toString(); }
    set className(v) {
      this.classList._syncFromString(v);
      this.attributes.set('class', this.classList.toString());
    }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get textContent() {
      if (!this.children.length) return this._text;
      return this.children.map(c => c.textContent).join('');
    }
    set textContent(v) {
      this.children = [];
      this._text = String(v ?? '');
    }
    setRect(rect) {
      this._rect = {
        left: rect.left ?? 0,
        top: rect.top ?? 0,
        width: rect.width ?? 0,
        height: rect.height ?? 0,
        right: (rect.left ?? 0) + (rect.width ?? 0),
        bottom: (rect.top ?? 0) + (rect.height ?? 0),
      };
    }
    getBoundingClientRect() {
      return {
        left: this._rect.left,
        top: this._rect.top,
        width: this._rect.width,
        height: this._rect.height,
        right: this._rect.left + this._rect.width,
        bottom: this._rect.top + this._rect.height,
      };
    }
    setAttribute(name, value) {
      const k = String(name).toLowerCase();
      this.attributes.set(k, String(value));
      if (k === 'class') this.classList._syncFromString(value);
      notifyMutation(this, { type: 'attributes', target: this, attributeName: k });
    }
    getAttribute(name) {
      const k = String(name).toLowerCase();
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    removeAttribute(name) {
      const k = String(name).toLowerCase();
      this.attributes.delete(k);
      if (k === 'class') this.classList._syncFromString('');
      notifyMutation(this, { type: 'attributes', target: this, attributeName: k });
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      notifyMutation(this, { type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentNode = null;
        child.parentElement = null;
        notifyMutation(this, { type: 'childList', target: this, addedNodes: [], removedNodes: [child] });
      }
      return child;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    dispatchEvent(event) {
      const ev = { target: this, bubbles: true, ...event };
      if (!ev.target) ev.target = this;
      let cur = this;
      const nonBubbling = new Set(['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave', 'focus', 'blur']);
      while (cur) {
        const handlers = cur.listeners?.get(ev.type);
        if (handlers) {
          for (const fn of [...handlers]) fn({ ...ev, currentTarget: cur, target: ev.target });
        }
        if (nonBubbling.has(ev.type) || ev.bubbles === false) break;
        cur = cur.parentNode;
      }
    }
    matches(selector) {
      return selector.split(',').some(part => matchSingleSelector(this, part.trim()));
    }
    closest(selector) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    querySelectorAll(selector) {
      const results = [];
      const visit = node => {
        for (const child of node.children) {
          if (child.matches(selector)) results.push(child);
          visit(child);
        }
      };
      visit(this);
      return results;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  function matchCompound(el, token) {
    if (!el || el.nodeType !== 1 || !token) return false;
    let rest = token;
    const tagMatch = rest.match(/^[a-zA-Z0-9-]+/);
    if (tagMatch) {
      if (el.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    const idMatches = [...rest.matchAll(/#([a-zA-Z0-9_-]+)/g)];
    for (const m of idMatches) {
      if (el.id !== m[1]) return false;
    }
    const classMatches = [...rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
    for (const m of classMatches) {
      if (!el.classList.contains(m[1])) return false;
    }
    const attrMatches = [...rest.matchAll(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g)];
    for (const m of attrMatches) {
      const val = el.getAttribute(m[1]);
      if (val === null) return false;
      if (m[2] !== undefined && val !== m[2]) return false;
    }
    return true;
  }

  function matchSingleSelector(el, selector) {
    if (!selector) return false;
    if (selector.includes('>')) {
      const [parentSel, childSel] = selector.split('>').map(s => s.trim());
      return matchCompound(el, childSel) && Boolean(el.parentElement && matchCompound(el.parentElement, parentSel));
    }
    const parts = selector.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return matchCompound(el, parts[0]);
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let ancestor = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (ancestor && !matchCompound(ancestor, parts[i])) ancestor = ancestor.parentElement;
      if (!ancestor) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  }

  // MediaQueryList mock
  const mqlListeners = new Set();
  const mql = {
    matches: Boolean(reducedMotion),
    addEventListener(type, fn) { if (type === 'change') mqlListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'change') mqlListeners.delete(fn); },
    setMatches(next) {
      this.matches = Boolean(next);
      for (const fn of [...mqlListeners]) fn({ matches: this.matches });
    },
  };

  // Controllable rAF queue
  let nextRafId = 1;
  let currentNow = 1000;
  const rafCallbacks = new Map();
  const win = {
    MutationObserver: MockMutationObserver,
    matchMedia: query => (query.includes('prefers-reduced-motion') ? mql : { matches: false }),
    performance: { now: () => currentNow },
    requestAnimationFrame(cb) {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      rafCallbacks.delete(id);
    },
  };

  const doc = {
    nodeType: 9,
    defaultView: win,
    activeElement: null,
    head: null,
    body: null,
    createElement(tag) {
      return new MockElement(tag, doc);
    },
    querySelectorAll(sel) {
      return [...doc.head.querySelectorAll(sel), ...doc.body.querySelectorAll(sel)];
    },
    querySelector(sel) {
      return doc.querySelectorAll(sel)[0] || null;
    },
    getElementById(id) {
      return doc.querySelector(`#${id}`);
    },
  };
  doc.head = new MockElement('head', doc);
  doc.body = new MockElement('body', doc);

  if (hasFilmCss) {
    const link = doc.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', '/css/film.css');
    doc.head.appendChild(link);
  } else {
    const link = doc.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', '/css/site.css');
    doc.head.appendChild(link);
  }

  function flushFrame(dtMs = 16.67) {
    currentNow += dtMs;
    const batch = [...rafCallbacks.entries()];
    rafCallbacks.clear();
    for (const [, cb] of batch) cb(currentNow);
    return batch.length;
  }

  return { doc, win, mql, rafCallbacks, flushFrame, toCamel };
}

function buildSegButton(doc, { index, name, dur, rect, ariaLabel }) {
  const btn = doc.createElement('button');
  btn.className = 'seg';
  btn.setAttribute('type', 'button');
  if (dur !== undefined) btn.style.flex = String(dur);
  btn.setAttribute('aria-label', ariaLabel || `Scene ${index + 1}: ${name}`);
  const track = doc.createElement('i');
  const fill = doc.createElement('b');
  track.appendChild(fill);
  const label = doc.createElement('span');
  label.textContent = name;
  btn.appendChild(track);
  btn.appendChild(label);
  if (rect) btn.setRect(rect);
  return { btn, track, fill, label };
}

test('exports CJS and ESM symbols cleanly and keeps film.css + shared CSS in sync', async () => {
  const esmScrubber = await import('../public/js/film-scrubber.js');
  assert.equal(typeof cjsScrubber.initFilmScrubber, 'function');
  assert.equal(typeof esmScrubber.initFilmScrubber, 'function');
  assert.equal(cjsScrubber.initFilmScrubber, esmScrubber.initFilmScrubber);

  const filmCss = fs.readFileSync(path.join(__dirname, '../public/css/film.css'), 'utf8');
  for (const selector of [
    '.film-chapter-tooltip',
    '.film-scrub-ghost',
    'will-change:transform',
    '#filmPoster.film-poster-interactive',
    '@media (prefers-reduced-motion:reduce)',
    'will-change:auto!important',
  ]) {
    assert.ok(filmCss.includes(selector), `film.css missing ${selector}`);
    assert.ok(cjsScrubber.FILM_SCRUBBER_CSS.includes(selector), `FILM_SCRUBBER_CSS missing ${selector}`);
  }

  // Injects shared style tag once on index.html (site.css) and skips duplicate injection on film.html (film.css)
  const siteEnv = createMockDOM({ hasFilmCss: false });
  const wrapA = siteEnv.doc.createElement('div');
  wrapA.className = 'wrap';
  const barA = siteEnv.doc.createElement('div');
  barA.id = 'bar';
  barA.className = 'bar';
  wrapA.appendChild(barA);
  siteEnv.doc.body.appendChild(wrapA);
  cjsScrubber.initFilmScrubber(siteEnv.doc);
  cjsScrubber.initFilmScrubber(siteEnv.doc);
  assert.equal(siteEnv.doc.head.querySelectorAll('style[data-film-scrubber-styles="true"]').length, 1);

  const filmEnv = createMockDOM({ hasFilmCss: true });
  const wrapB = filmEnv.doc.createElement('div');
  wrapB.className = 'wrap';
  const barB = filmEnv.doc.createElement('div');
  barB.id = 'bar';
  barB.className = 'bar';
  wrapB.appendChild(barB);
  filmEnv.doc.body.appendChild(wrapB);
  cjsScrubber.initFilmScrubber(filmEnv.doc);
  assert.equal(filmEnv.doc.head.querySelectorAll('style[data-film-scrubber-styles="true"]').length, 0);
});

test('renders floating chapter preview pill on hover and keyboard focus without mutating .seg > i > b', () => {
  const { doc } = createMockDOM({ hasFilmCss: true });
  const headerBar = doc.createElement('header');
  headerBar.className = 'bar';
  doc.body.appendChild(headerBar);

  const filmSection = doc.createElement('section');
  filmSection.id = 'film';
  const wrap = doc.createElement('div');
  wrap.className = 'wrap';
  const timeEl = doc.createElement('span');
  timeEl.id = 'time';
  timeEl.textContent = '0:00 / 0:30';
  const bar = doc.createElement('div');
  bar.id = 'bar';
  bar.className = 'bar';
  bar.setRect({ left: 0, top: 400, width: 600, height: 24 });

  const s1 = buildSegButton(doc, {
    index: 0,
    name: 'Airfield overview',
    dur: 14,
    rect: { left: 0, top: 400, width: 280, height: 24 },
  });
  const s2 = buildSegButton(doc, {
    index: 1,
    name: 'Detection',
    dur: 16,
    rect: { left: 284, top: 400, width: 316, height: 24 },
  });
  bar.appendChild(s1.btn);
  bar.appendChild(s2.btn);
  wrap.appendChild(timeEl);
  wrap.appendChild(bar);
  filmSection.appendChild(wrap);
  doc.body.appendChild(filmSection);

  const scrubber = cjsScrubber.initFilmScrubber(doc);

  // Header navbar with class="bar" must never be touched
  assert.equal(headerBar.classList.contains('film-scrubber-bar'), false);
  assert.equal(scrubber.bar, bar);

  // Film engine contract: seg.firstChild.firstChild MUST stay the exact <b> progress fill
  assert.equal(s1.btn.firstChild, s1.track);
  assert.equal(s1.btn.firstChild.firstChild, s1.fill);
  assert.equal(s1.btn.children.length, 2);

  // Hover chapter 1 -> "01 · Airfield overview · 0:00–0:14"
  s1.btn.dispatchEvent({ type: 'pointermove', clientX: 140 });
  assert.equal(scrubber.tooltip.getAttribute('data-visible'), 'true');
  assert.equal(scrubber.tooltip.getAttribute('data-mode'), 'hover');
  assert.equal(scrubber.tooltip.textContent, '01 \u00b7 Airfield overview \u00b7 0:00\u20130:14');
  assert.equal(s1.btn.getAttribute('aria-describedby'), scrubber.tooltip.id);

  // Pointer leaves bar -> tooltip and scrub ghost hide
  bar.dispatchEvent({ type: 'pointerleave' });
  assert.equal(scrubber.tooltip.getAttribute('data-visible'), 'false');
  assert.equal(scrubber.ghost.getAttribute('data-visible'), 'false');

  // Keyboard focus on chapter 2 -> "02 · Detection · 0:14–0:30" in focus mode without scrub ghost
  doc.activeElement = s2.btn;
  s2.btn.dispatchEvent({ type: 'focus' });
  assert.equal(scrubber.tooltip.getAttribute('data-visible'), 'true');
  assert.equal(scrubber.tooltip.getAttribute('data-mode'), 'focus');
  assert.equal(scrubber.tooltip.textContent, '02 \u00b7 Detection \u00b7 0:14\u20130:30');
  assert.equal(scrubber.ghost.getAttribute('data-visible'), 'false');

  // Escape key dismisses tooltip cleanly
  bar.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(scrubber.tooltip.getAttribute('data-visible'), 'false');
});

test('computes exact hover scrub ghost timestamp (0:42) across the 100-second 8-scene timeline and clamps tooltip edges', () => {
  const { doc, flushFrame } = createMockDOM({ hasFilmCss: true });
  const wrap = doc.createElement('div');
  wrap.className = 'wrap';
  const timeEl = doc.createElement('span');
  timeEl.id = 'time';
  timeEl.textContent = '0:00 / 1:40';
  const bar = doc.createElement('div');
  bar.id = 'bar';
  bar.className = 'bar';
  bar.setRect({ left: 0, top: 500, width: 1000, height: 22 });

  const scenes = [
    { name: 'The airfield', dur: 8 },
    { name: 'Why it matters', dur: 14 },
    { name: 'The gap', dur: 10 },
    { name: 'Detection', dur: 16 },
    { name: 'Risk engine', dur: 10 },
    { name: 'Alert journey', dur: 22 },
    { name: 'The tower', dur: 12 },
    { name: 'Close', dur: 8 },
  ];
  let xCursor = 0;
  const segObjs = scenes.map((s, idx) => {
    const w = s.dur * 10;
    const obj = buildSegButton(doc, {
      index: idx,
      name: s.name,
      dur: s.dur,
      rect: { left: xCursor, top: 500, width: w, height: 22 },
    });
    xCursor += w;
    bar.appendChild(obj.btn);
    return obj;
  });
  wrap.appendChild(timeEl);
  wrap.appendChild(bar);
  doc.body.appendChild(wrap);

  const scrubber = cjsScrubber.initFilmScrubber(doc);
  scrubber.tooltip.offsetWidth = 220;

  const chapters = scrubber.getChapters();
  assert.equal(chapters.length, 8);
  assert.equal(chapters[0].pillLabel, '01 \u00b7 The airfield \u00b7 0:00\u20130:08');
  assert.equal(chapters[3].pillLabel, '04 \u00b7 Detection \u00b7 0:32\u20130:48');
  assert.equal(chapters[7].pillLabel, '08 \u00b7 Close \u00b7 1:32\u20131:40');

  // Hover at 420px (42% of 1000px = 42s -> 0:42 inside Scene 4: Detection)
  segObjs[3].btn.dispatchEvent({ type: 'pointermove', clientX: 420 });
  assert.equal(scrubber.ghost.getAttribute('data-visible'), 'true');
  assert.equal(scrubber.ghost.getAttribute('data-timestamp'), '0:42');
  assert.equal(scrubber.ghost.textContent, '0:42');
  assert.equal(scrubber.ghost.style.getPropertyValue('--scrub-x'), '420.0px');
  assert.equal(scrubber.tooltip.textContent, '04 \u00b7 Detection \u00b7 0:32\u20130:48');
  assert.equal(segObjs[3].btn.getAttribute('data-hovered'), 'true');
  assert.equal(segObjs[3].btn.style.getPropertyValue('--seg-hover-p'), '0.6250');

  // Move pointer rapidly to right edge (995px) -> tooltip target clamps to 1000 - 220 = 780px and springs smoothly
  segObjs[7].btn.dispatchEvent({ type: 'pointermove', clientX: 995 });
  assert.equal(scrubber.ghost.textContent, '1:39');
  assert.equal(scrubber.ghost.style.getPropertyValue('--scrub-badge-shift'), '-100%');
  flushFrame(16);
  const midX = parseFloat(scrubber.tooltip.style.getPropertyValue('--tooltip-x'));
  assert.ok(midX > 310 && midX < 780, `expected spring mid-flight X between 310 and 780, got ${midX}`);
  for (let i = 0; i < 40; i++) flushFrame(16);
  assert.equal(scrubber.tooltip.style.getPropertyValue('--tooltip-x'), '780.0px');
});

test('lets native style.width drive 60 fps playhead fill at zero rAF cost, pulses active chapter, and respects prefers-reduced-motion', () => {
  const { doc, mql, rafCallbacks } = createMockDOM({ hasFilmCss: true, reducedMotion: false });
  const wrap = doc.createElement('div');
  wrap.className = 'wrap';
  const bar = doc.createElement('div');
  bar.id = 'bar';
  bar.className = 'bar';
  const s1 = buildSegButton(doc, { index: 0, name: 'The airfield', dur: 8 });
  const s2 = buildSegButton(doc, { index: 1, name: 'Why it matters', dur: 14 });
  s1.btn.classList.add('cur');
  bar.appendChild(s1.btn);
  bar.appendChild(s2.btn);
  wrap.appendChild(bar);
  doc.body.appendChild(wrap);

  const scrubber = cjsScrubber.initFilmScrubber(doc);
  assert.equal(bar.getAttribute('data-reduced-motion'), 'false');
  assert.equal(s1.btn.getAttribute('aria-current'), 'step');

  // 60 fps inline width updates on <b> must NOT fire a duplicate JS spring rAF loop or override width
  s1.fill.style.width = '60%';
  assert.equal(rafCallbacks.size, 0, '60 fps playhead width updates must not schedule duplicate rAF');
  assert.equal(s1.fill.style.width, '60%');
  scrubber.syncPlayhead();
  assert.equal(s1.btn.style.getPropertyValue('--seg-progress'), '0.6000');

  // Switching .cur chapter triggers tactile active-segment pulse
  s1.btn.classList.remove('cur');
  s2.btn.classList.add('cur');
  assert.equal(s2.btn.classList.contains('is-pulsing'), true);
  assert.equal(s2.btn.getAttribute('data-pulse'), 'true');
  assert.equal(s2.btn.getAttribute('aria-current'), 'step');
  assert.equal(s1.btn.getAttribute('aria-current'), null);

  // Enabling prefers-reduced-motion clears pulse and halts any tooltip rAF immediately
  mql.setMatches(true);
  assert.equal(scrubber.isReducedMotion(), true);
  assert.equal(bar.getAttribute('data-reduced-motion'), 'true');
  assert.equal(s2.btn.classList.contains('is-pulsing'), false);

  s2.fill.style.width = '85%';
  assert.equal(rafCallbacks.size, 0, 'no rAF under prefers-reduced-motion');
  scrubber.syncPlayhead();
  assert.equal(s2.btn.style.getPropertyValue('--seg-progress'), '0.8500');
});

test('adds magnetic/parallax tilt & glow to #filmPoster before launch and binds dynamically created .seg buttons', () => {
  const { doc } = createMockDOM({ hasFilmCss: false, reducedMotion: false });
  const filmSection = doc.createElement('section');
  filmSection.id = 'film';
  const wrap = doc.createElement('div');
  wrap.className = 'wrap';
  const stage = doc.createElement('div');
  stage.id = 'stage';
  stage.className = 'stage';

  const poster = doc.createElement('div');
  poster.id = 'filmPoster';
  poster.className = 'film-poster';
  poster.setRect({ left: 100, top: 50, width: 1000, height: 500 });
  const img = doc.createElement('img');
  const launch = doc.createElement('a');
  launch.id = 'filmLaunch';
  launch.textContent = 'Play the 100-second film';
  launch.setRect({ left: 480, top: 275, width: 240, height: 50 });
  poster.appendChild(img);
  poster.appendChild(launch);
  stage.appendChild(poster);

  // Initially empty #bar before startFilm() runs on index.html
  const bar = doc.createElement('div');
  bar.id = 'bar';
  bar.className = 'bar';
  bar.setRect({ left: 100, top: 600, width: 1000, height: 24 });
  wrap.appendChild(stage);
  wrap.appendChild(bar);
  filmSection.appendChild(wrap);
  doc.body.appendChild(filmSection);

  const scrubber = cjsScrubber.initFilmScrubber(doc);
  assert.equal(poster.classList.contains('film-poster-interactive'), true);

  // Hover upper-right quadrant of #filmPoster -> glow opacity 1, non-zero tilt & magnetic pull
  poster.dispatchEvent({ type: 'pointermove', clientX: 850, clientY: 150 });
  assert.equal(poster.style.getPropertyValue('--poster-glow-opacity'), '1');
  assert.equal(poster.style.getPropertyValue('--poster-glow-x'), '75.0%');
  assert.equal(poster.style.getPropertyValue('--poster-glow-y'), '20.0%');
  assert.notEqual(poster.style.getPropertyValue('--poster-rx'), '0deg');
  assert.notEqual(poster.style.getPropertyValue('--poster-ry'), '0deg');
  assert.notEqual(poster.style.getPropertyValue('--launch-mx'), '0px');

  // Leaving #filmPoster resets tilt, magnetic offset, and glow smoothly
  poster.dispatchEvent({ type: 'pointerleave' });
  assert.equal(poster.style.getPropertyValue('--poster-glow-opacity'), '0');
  assert.equal(poster.style.getPropertyValue('--poster-rx'), '0deg');
  assert.equal(poster.style.getPropertyValue('--launch-mx'), '0px');

  // Simulate startFilm() dynamically appending .seg buttons and removing #filmPoster
  const seg1 = buildSegButton(doc, {
    index: 0,
    name: 'The airfield',
    dur: 8,
    rect: { left: 100, top: 600, width: 80, height: 24 },
  });
  bar.appendChild(seg1.btn);
  poster.remove();

  assert.equal(scrubber.getChapters().length, 1);
  seg1.btn.dispatchEvent({ type: 'pointermove', clientX: 140 });
  assert.equal(scrubber.tooltip.textContent, '01 \u00b7 The airfield \u00b7 0:00\u20130:08');
  assert.equal(scrubber.ghost.textContent, '0:04');

  // Clean teardown
  scrubber.destroy();
  assert.equal(bar.querySelector('.film-chapter-tooltip'), null);
  assert.equal(bar.querySelector('.film-scrub-ghost'), null);
  assert.equal(bar.classList.contains('film-scrubber-ready'), false);
});

test('supports data-* chapter attributes, aria-label fallback, and reducedMotion option on #filmPoster', () => {
  const { doc } = createMockDOM({ hasFilmCss: true, reducedMotion: true });
  const wrap = doc.createElement('div');
  wrap.className = 'wrap';

  const poster = doc.createElement('div');
  poster.id = 'filmPoster';
  poster.setRect({ left: 0, top: 0, width: 800, height: 450 });
  wrap.appendChild(poster);

  const bar = doc.createElement('div');
  bar.id = 'bar';
  bar.className = 'bar';

  // Segment 1: explicit data-title + data-window
  const segA = doc.createElement('button');
  segA.className = 'seg';
  segA.dataset.shot = '3';
  segA.dataset.title = 'Radar budget gap';
  segA.dataset.window = '0:22–0:32';
  segA.appendChild(doc.createElement('i')).appendChild(doc.createElement('b'));

  // Segment 2: aria-label only + data-duration
  const segB = doc.createElement('button');
  segB.className = 'seg';
  segB.setAttribute('aria-label', 'Scene 4: Runway camera POV');
  segB.dataset.duration = '16';
  segB.appendChild(doc.createElement('i')).appendChild(doc.createElement('b'));

  bar.appendChild(segA);
  bar.appendChild(segB);
  wrap.appendChild(bar);
  doc.body.appendChild(wrap);

  const scrubber = cjsScrubber.initFilmScrubber(wrap, { reducedMotion: true });
  const chapters = scrubber.getChapters();
  assert.equal(chapters[0].pillLabel, '03 \u00b7 Radar budget gap \u00b7 0:22\u20130:32');
  assert.equal(chapters[1].pillLabel, '04 \u00b7 Runway camera POV \u00b7 0:32\u20130:48');

  // Reduced motion keeps #filmPoster tilt & magnetic pull strictly zeroed while keeping subtle spotlight
  poster.dispatchEvent({ type: 'pointermove', clientX: 700, clientY: 80 });
  assert.equal(poster.style.getPropertyValue('--poster-rx'), '0deg');
  assert.equal(poster.style.getPropertyValue('--poster-ry'), '0deg');
  assert.equal(poster.style.getPropertyValue('--launch-mx'), '0px');
  assert.equal(poster.style.getPropertyValue('--poster-glow-opacity'), '1');
});

