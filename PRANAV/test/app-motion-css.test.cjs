const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const cssPath = path.join(__dirname, '..', 'public', 'css', 'app.css');
const revealPath = path.join(__dirname, '..', 'public', 'js', 'reveal.js');
const towerHtmlPath = path.join(__dirname, '..', 'public', 'tower.html');

const rawCss = fs.readFileSync(cssPath, 'utf8');
const revealSource = fs.readFileSync(revealPath, 'utf8');
const towerHtml = fs.readFileSync(towerHtmlPath, 'utf8');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Splits top-level CSS blocks into rules outside vs inside @media (prefers-reduced-motion: no-preference).
function partitionMotionBlocks(css) {
  const clean = stripComments(css);
  const outside = [];
  const motionBlocks = [];
  let i = 0;
  while (i < clean.length) {
    while (i < clean.length && /\s/.test(clean[i])) i++;
    if (i >= clean.length) break;
    const brace = clean.indexOf('{', i);
    if (brace === -1) {
      outside.push(clean.slice(i));
      break;
    }
    const header = clean.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') depth--;
      j++;
    }
    const body = clean.slice(brace + 1, j - 1);
    if (/^@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)$/i.test(header)) {
      motionBlocks.push(body);
    } else {
      outside.push(`${header}{${body}}`);
    }
    i = j;
  }
  return { outside: outside.join('\n'), motion: motionBlocks.join('\n') };
}

function splitSelectors(selectorList) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selectorList.length; i++) {
    const ch = selectorList[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(selectorList.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = selectorList.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function parseRules(cssChunk) {
  const rules = [];
  let i = 0;
  while (i < cssChunk.length) {
    while (i < cssChunk.length && /\s/.test(cssChunk[i])) i++;
    if (i >= cssChunk.length) break;
    const brace = cssChunk.indexOf('{', i);
    if (brace === -1) break;
    const header = cssChunk.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < cssChunk.length && depth > 0) {
      if (cssChunk[j] === '{') depth++;
      else if (cssChunk[j] === '}') depth--;
      j++;
    }
    const body = cssChunk.slice(brace + 1, j - 1).trim();
    if (header.startsWith('@keyframes')) {
      rules.push({ atRule: header, body, selectors: [] });
    } else if (header.startsWith('@')) {
      rules.push(...parseRules(body));
    } else {
      rules.push({ selectors: splitSelectors(header), body });
    }
    i = j;
  }
  return rules;
}

test('all CSS motion, transitions, transforms, and keyframes live strictly inside prefers-reduced-motion: no-preference', () => {
  const { outside, motion } = partitionMotionBlocks(rawCss);
  assert.ok(motion.length > 0, 'expected a @media (prefers-reduced-motion: no-preference) block');
  assert.doesNotMatch(outside, /@keyframes\b/i, 'no @keyframes outside no-preference block');
  assert.doesNotMatch(outside, /\banimation(?:-[a-z-]+)?\s*:/i, 'no animation declarations outside no-preference block');
  assert.doesNotMatch(outside, /\btransition(?:-[a-z-]+)?\s*:/i, 'no transition declarations outside no-preference block');
  assert.doesNotMatch(outside, /\btransform\s*:/i, 'no transform declarations outside no-preference block');

  // Ensure balanced braces across the entire stylesheet.
  let balance = 0;
  for (const ch of stripComments(rawCss)) {
    if (ch === '{') balance++;
    else if (ch === '}') balance--;
    assert.ok(balance >= 0, 'unexpected closing brace in app.css');
  }
  assert.equal(balance, 0, 'unbalanced braces in app.css');
});

test('tactile buttons & cards lift on hover, press to scale(0.97), and preserve commit 937d471 aria-pressed contrast', () => {
  const { outside, motion } = partitionMotionBlocks(rawCss);
  const outsideRules = parseRules(outside);
  const motionRules = parseRules(motion);

  // Commit 937d471 contrast invariant: pressed buttons (including .ghost on hover and active) keep --accent / --on-accent.
  const requiredPressedSelectors = [
    'button[aria-pressed="true"]',
    'button[aria-pressed="true"]:hover',
    'button.ghost[aria-pressed="true"]',
    'button.ghost[aria-pressed="true"]:hover',
    'button[aria-pressed="true"]:active',
    'button.ghost[aria-pressed="true"]:active',
  ];
  for (const sel of requiredPressedSelectors) {
    const matching = outsideRules.filter(r => r.selectors.includes(sel));
    assert.ok(matching.length > 0, `expected ${sel} contrast rule outside motion media query`);
    const combined = matching.map(r => r.body).join(';');
    assert.match(combined, /background\s*:\s*var\(--accent\)/);
    assert.match(combined, /color\s*:\s*var\(--on-accent\)/);
    assert.match(combined, /border-color\s*:\s*var\(--accent\)/);
  }

  // Hover lift translateY(-1px) on buttons & interactive cards.
  const liftRules = motionRules.filter(r => /transform\s*:\s*translateY\(-1px\)/.test(r.body));
  const liftSelectors = new Set(liftRules.flatMap(r => r.selectors));
  for (const sel of ['button:not(:disabled):hover', '.card.clip:hover', 'a.card:hover', '.account-tab:hover', '.side .side-risk:hover']) {
    assert.ok(liftSelectors.has(sel), `expected hover lift selector ${sel}`);
  }

  // Active press scale(0.97) feedback on buttons & interactive cards.
  const pressRules = motionRules.filter(r => /transform\s*:\s*scale\(0\.97\)/.test(r.body));
  const pressSelectors = new Set(pressRules.flatMap(r => r.selectors));
  for (const sel of ['button:not(:disabled):active', 'a.card:active', '.account-tab:active', '.side .side-risk:active']) {
    assert.ok(pressSelectors.has(sel), `expected active press selector ${sel}`);
  }
});

test('sidebar navigation has active pill elevation on [aria-current="page"], sliding highlight, and hover icon nudge', () => {
  const { outside, motion } = partitionMotionBlocks(rawCss);
  const outsideRules = parseRules(outside);
  const motionRules = parseRules(motion);

  const activePill = outsideRules
    .filter(r => r.selectors.includes('.side-nav a[aria-current="page"]'))
    .map(r => r.body)
    .join(';');
  assert.match(activePill, /background\s*:\s*var\(--card\)/);
  assert.match(activePill, /box-shadow\s*:/);

  const slidePseudo = motionRules
    .filter(r => r.selectors.includes('.side-nav a::after') || r.selectors.includes('.side-nav a::before'))
    .map(r => r.body)
    .join(';');
  assert.match(slidePseudo, /transform\s*:\s*translateX\(/, 'expected sliding highlight transform on .side-nav a pseudo-element');
  assert.match(slidePseudo, /transition\s*:[^;]*transform/, 'expected smooth transform transition on sliding highlight');

  const iconNudge = motionRules
    .filter(r => r.selectors.includes('.side-nav a:hover svg'))
    .map(r => r.body)
    .join(';');
  assert.match(iconNudge, /transform\s*:\s*translateX\(/, 'expected subtle icon nudge on .side-nav a:hover svg');
});

test('Ask SkySentry chat choreography animates user/bot entrances with pop and busy thinking pulse', () => {
  const { outside, motion } = partitionMotionBlocks(rawCss);
  const outsideRules = parseRules(outside);
  const motionRules = parseRules(motion);

  assert.ok(motionRules.some(r => r.atRule?.startsWith('@keyframes pop')), 'expected @keyframes pop');
  assert.ok(motionRules.some(r => r.atRule?.startsWith('@keyframes chat-shimmer')), 'expected @keyframes chat-shimmer');
  assert.ok(motionRules.some(r => r.atRule?.startsWith('@keyframes chat-dots')), 'expected @keyframes chat-dots');

  const popEntry = motionRules
    .filter(r => r.selectors.includes('.chat li') && r.selectors.includes('.chat li.user') && r.selectors.includes('.chat li.bot'))
    .map(r => r.body)
    .join(';');
  assert.match(popEntry, /animation\s*:\s*pop\b/);

  const busyStatic = outsideRules
    .filter(r => r.selectors.includes('.chat li.bot[aria-busy="true"]::after'))
    .map(r => r.body)
    .join(';');
  assert.match(busyStatic, /radial-gradient/, 'expected 3-dot indicator geometry on .chat li.bot[aria-busy="true"]::after');

  const busyMotion = motionRules
    .filter(r => r.selectors.includes('.chat li.bot[aria-busy="true"]'))
    .map(r => r.body)
    .join(';');
  assert.match(busyMotion, /chat-shimmer/);

  const busyDotsMotion = motionRules
    .filter(r => r.selectors.includes('.chat li.bot[aria-busy="true"]::after'))
    .map(r => r.body)
    .join(';');
  assert.match(busyDotsMotion, /chat-dots/);
});

test('feed toolbar zoom/Fit/Demo buttons have scale & tint micro-feedback that beats tower.html all:unset specificity', () => {
  const { motion } = partitionMotionBlocks(rawCss);
  const motionRules = parseRules(motion);

  // tower.html defines `.tile .tools button { all: unset; ... }` (specificity 0,2,1) after app.css.
  // Verify tower.html still uses that pattern and our transition selector `.tile .tools button:not(:disabled)` (0,3,1) outranks it.
  assert.match(towerHtml, /\.tile\s+\.tools\s+button\s*\{\s*all\s*:\s*unset/);

  const transitionRule = motionRules.find(r => r.selectors.includes('.tile .tools button:not(:disabled)'));
  assert.ok(transitionRule, 'expected .tile .tools button:not(:disabled) transition rule to beat all:unset');
  assert.match(transitionRule.body, /transition\s*:[^;]*transform/);

  const zoomHover = motionRules.find(r => r.selectors.includes('.tile .tools button[data-z]:not(:disabled):hover'));
  assert.ok(zoomHover, 'expected zoom/+/-/Fit hover rule');
  assert.match(zoomHover.body, /scale\(/);
  assert.match(zoomHover.body, /background-color\s*:/);

  const demoHover = motionRules.find(r => r.selectors.includes('.tile .tools button[data-src]:not(:disabled):hover'));
  assert.ok(demoHover, 'expected Demo button hover rule');
  assert.match(demoHover.body, /scale\(/);

  const demoPressedHover = motionRules.find(r =>
    r.selectors.includes('.tile .tools button[data-src][aria-pressed="true"]:not(:disabled):hover'));
  assert.ok(demoPressedHover, 'expected pressed Live/Demo button hover rule');
  assert.match(demoPressedHover.body, /#06210f/);

  const toolbarActive = motionRules.find(r => r.selectors.includes('.tile .tools button:not(:disabled):active'));
  assert.ok(toolbarActive, 'expected active press scale on feed toolbar buttons');
  assert.match(toolbarActive.body, /transform\s*:\s*scale\(/);
});

test('tabular-nums is set consistently on .pill, .zl, .tile .bot, and #feedsLoad and outranks font shorthands', () => {
  const { outside } = partitionMotionBlocks(rawCss);
  const outsideRules = parseRules(outside);
  const tabularRules = outsideRules.filter(r => /font-variant-numeric\s*:\s*tabular-nums/.test(r.body));
  const selectors = new Set(tabularRules.flatMap(r => r.selectors));

  for (const required of [
    '.pill',
    '.side .pill',
    '.zl',
    'body.app .tile .tools .zl',
    '.tile .bot',
    'body.app .tile .bot',
    '#feedsLoad',
  ]) {
    assert.ok(selectors.has(required), `expected tabular-nums on ${required}`);
  }
});

// Minimal DOM harness to execute reveal.js in isolated VM contexts without headless browsers.
function createDomHarness({ reduced = false, appPage = true, viewTimeline = false, innerHeight = 800 } = {}) {
  const styles = [];
  const ioObserved = [];
  const ioUnobserved = [];
  let ioCallback = null;
  let ioDisconnected = false;
  let moCallback = null;
  let moDisconnected = false;
  let mediaChange = null;
  const elements = [];

  function matchesSimple(el, singleSel) {
    const s = singleSel.trim();
    if (s === '.more-grid > *') return Boolean(el.parentElement?.classList.contains('more-grid'));
    if (s === '.sec > :not(.sec-head)') {
      return Boolean(el.parentElement?.classList.contains('sec') && !el.classList.contains('sec-head'));
    }
    if (s.startsWith('.')) return el.classList.contains(s.slice(1));
    if (s.startsWith('#')) return el.id === s.slice(1);
    return el.tagName?.toLowerCase() === s.toLowerCase();
  }

  function matchesSelectorList(el, selList) {
    return selList.split(',').some(part => matchesSimple(el, part));
  }

  function makeElement(tag, { classes = [], top = 1200, hidden = false, open = false, parent = null } = {}) {
    const classSet = new Set(classes);
    const props = new Map();
    const listeners = new Map();
    const children = [];
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: '',
      hidden,
      open,
      isConnected: true,
      parentElement: parent,
      dataset: {},
      textContent: '',
      children,
      classList: {
        add: (...names) => names.forEach(n => classSet.add(n)),
        remove: (...names) => names.forEach(n => classSet.delete(n)),
        contains: name => classSet.has(name),
      },
      style: {
        setProperty: (k, v) => props.set(k, v),
        removeProperty: k => props.delete(k),
        getPropertyValue: k => props.get(k) || '',
      },
      setTop(nextTop) { top = nextTop; },
      getBoundingClientRect: () => ({ top: el.hidden ? 0 : top, left: 0, width: 320, height: 200 }),
      matches: sel => matchesSelectorList(el, sel),
      closest(sel) {
        let cur = el;
        while (cur) {
          for (const part of sel.split(',').map(s => s.trim())) {
            if (part === '[hidden]' && cur.hidden) return cur;
            if (part === 'details:not([open])' && cur.tagName === 'DETAILS' && !cur.open) return cur;
            if (matchesSimple(cur, part)) return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const found = [];
        const visit = node => {
          for (const child of node.children) {
            if (matchesSelectorList(child, sel)) found.push(child);
            visit(child);
          }
        };
        visit(el);
        return found;
      },
      append(...nodes) {
        for (const n of nodes) {
          n.parentElement = el;
          children.push(n);
        }
      },
      remove() {
        el.removed = true;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type, event = { target: el }) {
        for (const fn of [...(listeners.get(type) || [])]) fn(event);
      },
    };
    if (parent) parent.append(el);
    elements.push(el);
    return el;
  }

  const head = makeElement('head');
  const body = makeElement('body', { classes: appPage ? ['app'] : [] });
  const mq = {
    matches: reduced,
    addEventListener(type, fn) {
      if (type === 'change') mediaChange = fn;
    },
  };

  const document = {
    readyState: 'complete',
    head: { append: node => styles.push(node) },
    body,
    documentElement: { clientHeight: innerHeight },
    createElement: tag => makeElement(tag),
    querySelectorAll: sel => body.querySelectorAll(sel),
    addEventListener() {},
  };

  class MockIntersectionObserver {
    constructor(cb) { ioCallback = cb; }
    observe(el) { ioObserved.push(el); }
    unobserve(el) { ioUnobserved.push(el); }
    disconnect() { ioDisconnected = true; }
  }

  class MockMutationObserver {
    constructor(cb) { moCallback = cb; }
    observe() {}
    disconnect() { moDisconnected = true; }
  }

  const window = {
    innerHeight,
    document,
    matchMedia: () => mq,
    CSS: { supports: expr => expr.includes('animation-timeline') && viewTimeline },
    IntersectionObserver: MockIntersectionObserver,
    MutationObserver: MockMutationObserver,
    setTimeout,
    clearTimeout,
  };

  const context = { window, document, globalThis: window, setTimeout, clearTimeout };
  vm.runInNewContext(revealSource, context);

  return {
    api: window.SkySentryReveal,
    body,
    styles,
    makeElement,
    ioObserved,
    ioUnobserved,
    isIoDisconnected: () => ioDisconnected,
    isMoDisconnected: () => moDisconnected,
    intersect: entries => ioCallback?.(entries),
    mutate: records => moCallback?.(records),
    triggerReducedMotion: next => {
      mq.matches = next;
      mediaChange?.({ matches: next });
    },
  };
}

test('reveal.js exposes clean no-op safety under prefers-reduced-motion: reduce and via CommonJS export', () => {
  const cjsExport = require(revealPath);
  assert.equal(typeof cjsExport.createReveal, 'function');
  assert.equal(cjsExport.active, false);
  assert.equal(cjsExport.reducedMotion, true);
  assert.equal(cjsExport.staggerDelay(2), 0);
  assert.doesNotThrow(() => {
    cjsExport.watch();
    cjsExport.refresh();
    cjsExport.revealAll();
    cjsExport.disconnect();
  });

  const env = createDomHarness({ reduced: true });
  const card = env.makeElement('section', { classes: ['card'], top: 1400, parent: env.body });
  assert.equal(env.api.active, false);
  assert.equal(env.api.reducedMotion, true);
  assert.equal(env.styles.length, 0, 'must not inject .rv style sheet when reduced motion is active');
  assert.equal(env.ioObserved.length, 0, 'must not observe elements when reduced motion is active');
  assert.equal(env.api.staggerDelay(1), 0);
  env.api.watch(env.body);
  assert.equal(card.classList.contains('rv'), false);
});

test('reveal.js refines tapered stagger curves, never hides above-the-fold cards, and cleans up after reveal', () => {
  const env = createDomHarness({ reduced: false, innerHeight: 800 });
  assert.equal(env.api.active, true);
  assert.equal(env.styles.length, 1);

  // Verify tapered (diminishing delta) stagger delays: 0 -> 55 -> 100 -> 135ms.
  const d0 = env.api.staggerDelay(0);
  const d1 = env.api.staggerDelay(1);
  const d2 = env.api.staggerDelay(2);
  const d3 = env.api.staggerDelay(3);
  assert.equal(d0, 0);
  assert.ok(d1 > d0 && d2 > d1 && d3 > d2, 'expected monotonically increasing stagger delays within a group');
  assert.ok((d1 - d0) > (d2 - d1) && (d2 - d1) > (d3 - d2), 'expected tapered (decelerating) stagger increments');

  const onScreen = env.makeElement('section', { classes: ['card'], top: 200, parent: env.body });
  const below1 = env.makeElement('section', { classes: ['card'], top: 900, parent: env.body });
  const below2 = env.makeElement('section', { classes: ['card'], top: 1150, parent: env.body });
  env.api.watch(env.body);

  assert.equal(onScreen.classList.contains('rv'), false, 'above-the-fold card must stay visible immediately');
  assert.equal(below1.classList.contains('rv'), true);
  assert.equal(below2.classList.contains('rv'), true);
  assert.equal(below1.style.getPropertyValue('--rv-d'), '');
  assert.equal(below2.style.getPropertyValue('--rv-d'), `${d1}ms`);

  // Even if dynamic layout pushes onScreen below the fold later, rescanning must never flicker/hide it.
  onScreen.setTop(1300);
  env.api.refresh();
  assert.equal(onScreen.classList.contains('rv'), false, 'previously visible card must never retroactively get .rv');

  // Intersecting reveals with per-batch stagger and cleans up classes/inline vars on transitionend without re-animating.
  env.intersect([
    { isIntersecting: true, target: below1 },
    { isIntersecting: true, target: below2 },
  ]);
  assert.equal(below1.classList.contains('rv-in'), true);
  assert.equal(below2.classList.contains('rv-in'), true);
  assert.deepEqual(env.ioUnobserved, [below1, below2]);

  below1.dispatch('transitionend', { target: below1 });
  assert.equal(below1.classList.contains('rv'), false);
  assert.equal(below1.classList.contains('rv-in'), false);
  assert.equal(below1.style.getPropertyValue('--rv-d'), '');

  // Subsequent rescans must never double-animate an already-revealed card.
  env.api.refresh();
  assert.equal(below1.classList.contains('rv'), false);
  assert.equal(env.ioObserved.filter(el => el === below1).length, 1);
});

test('reveal.js handles dynamic demo cards without flicker or double-animation and cleans up if reduced-motion flips on', () => {
  // Without native view() timeline: dynamically inserted below-fold demo clips get .rv synchronously on mutation.
  const fallbackEnv = createDomHarness({ reduced: false, appPage: true, viewTimeline: false, innerHeight: 800 });
  const clipVisible = fallbackEnv.makeElement('article', { classes: ['card', 'clip'], top: 280, parent: fallbackEnv.body });
  const clipOffscreen = fallbackEnv.makeElement('article', { classes: ['card', 'clip'], top: 1050, parent: fallbackEnv.body });
  const chatBubble = fallbackEnv.makeElement('li', { classes: ['bot'], top: 1050, parent: fallbackEnv.body });

  fallbackEnv.mutate([{ type: 'childList', addedNodes: [clipVisible, clipOffscreen, chatBubble] }]);
  assert.equal(clipVisible.classList.contains('rv'), false);
  assert.equal(clipOffscreen.classList.contains('rv'), true, 'dynamic offscreen clip gets .rv immediately before first paint');
  assert.equal(chatBubble.classList.contains('rv'), false, 'non-card live DOM nodes are ignored');

  // Switching OS reduced-motion on mid-session immediately reveals pending cards and becomes a safe no-op.
  fallbackEnv.triggerReducedMotion(true);
  assert.equal(clipOffscreen.classList.contains('rv'), false);
  assert.equal(fallbackEnv.api.active, false);
  assert.equal(fallbackEnv.api.reducedMotion, true);
  assert.equal(fallbackEnv.isIoDisconnected(), true);
  assert.equal(fallbackEnv.isMoDisconnected(), true);

  // With native CSS animation-timeline: view(), .clip cards are skipped so CSS scroll timelines never double-animate.
  const nativeEnv = createDomHarness({ reduced: false, appPage: true, viewTimeline: true, innerHeight: 800 });
  const nativeClip = nativeEnv.makeElement('article', { classes: ['card', 'clip'], top: 1200, parent: nativeEnv.body });
  const regularCard = nativeEnv.makeElement('section', { classes: ['card'], top: 1200, parent: nativeEnv.body });
  nativeEnv.mutate([{ type: 'childList', addedNodes: [nativeClip, regularCard] }]);
  assert.equal(nativeClip.classList.contains('rv'), false, 'native CSS view() timeline owns .clip without JS double-animation');
  assert.equal(regularCard.classList.contains('rv'), true, 'non-.clip cards on app pages still scroll-reveal');
  assert.match(nativeEnv.styles[0].textContent, /\.rv:not\(\.rv-in\):not\(\.risk\)\{animation:none\}/,
    'injected .rv rule must preserve .risk safety flash animations');
});
