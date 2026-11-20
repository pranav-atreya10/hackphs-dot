const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let initFilmPerfGovernor;
let trackScrollSmoothness;

before(async () => {
  ({ initFilmPerfGovernor, trackScrollSmoothness } = await import('../public/js/film-perf-governor.js'));
});

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(...tokens) { tokens.forEach(t => set.add(t)); },
    remove(...tokens) { tokens.forEach(t => set.delete(t)); },
    contains(token) { return set.has(token); },
    toggle(token, force) {
      const next = force === undefined ? !set.has(token) : Boolean(force);
      if (next) set.add(token);
      else set.delete(token);
      return next;
    },
  };
}

function toDatasetKey(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function createElement(id, { classes = [], textContent = '', parent = null } = {}) {
  const attrs = new Map();
  const dataset = {};
  const listeners = new Map();
  const classList = createClassList(classes);

  const el = {
    id,
    parentElement: parent,
    textContent,
    dataset,
    classList,
    open: false,
    setAttribute(name, value) {
      const str = String(value);
      attrs.set(name, str);
      if (name.startsWith('data-')) dataset[toDatasetKey(name)] = str;
    },
    getAttribute(name) {
      if (name.startsWith('data-')) {
        const key = toDatasetKey(name);
        if (key in dataset) return String(dataset[key]);
      }
      return attrs.has(name) ? attrs.get(name) : null;
    },
    removeAttribute(name) {
      attrs.delete(name);
      if (name.startsWith('data-')) delete dataset[toDatasetKey(name)];
    },
    hasAttribute(name) {
      return this.getAttribute(name) !== null;
    },
    addEventListener(type, fn, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, capture, options });
    },
    removeEventListener(type, fn, options) {
      const list = listeners.get(type);
      if (!list) return;
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const idx = list.findIndex(item => item.fn === fn && item.capture === capture);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      const list = [...(listeners.get(event.type) || [])];
      const ordered = [
        ...list.filter(item => item.capture),
        ...list.filter(item => !item.capture),
      ];
      for (const item of ordered) item.fn(event);
    },
    closest(selector) {
      let cur = el;
      while (cur) {
        if (selector === '#film' && cur.id === 'film') return cur;
        if (selector === '.film-started' && cur.classList?.contains('film-started')) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    listeners,
  };
  return el;
}

function createFilmHarness({ started = true, withFilmWrapper = true } = {}) {
  const byId = new Map();
  const film = withFilmWrapper
    ? createElement('film', { classes: started ? ['film-started'] : [] })
    : null;
  const stage = createElement('stage', { parent: film });
  const gl = createElement('gl', { parent: stage });
  if (!withFilmWrapper && started) gl.setAttribute('data-engine', 'three.js r170');

  let playing = started;
  let ended = false;
  let playClicks = 0;

  const play = createElement('play', { textContent: 'Pause', parent: film });
  const setPlaying = next => {
    playing = Boolean(next);
    stage.classList.toggle('paused', !playing);
    play.textContent = ended ? 'Replay' : (playing ? 'Pause' : 'Play');
  };
  play.onclick = () => {
    if (ended) {
      ended = false;
      setPlaying(true);
    } else {
      setPlaying(!playing);
    }
  };
  play.click = () => {
    playClicks += 1;
    // Match browser registration-order semantics: listeners registered before startFilm() run before onclick.
    play.dispatchEvent({ type: 'click', target: play });
    play.onclick?.();
  };

  const replay = createElement('replay', { textContent: 'Replay', parent: film });
  replay.click = () => {
    ended = false;
    replay.dispatchEvent({ type: 'click', target: replay });
    setPlaying(true);
  };

  const creditsToggle = createElement('creditsToggle', { parent: film });

  if (film) byId.set('film', film);
  byId.set('stage', stage);
  byId.set('gl', gl);
  byId.set('play', play);
  byId.set('replay', replay);
  byId.set('creditsToggle', creditsToggle);

  let nowMs = 1000;
  let scrollY = 0;
  let rafSeq = 0;
  let timerSeq = 0;
  const rafQueue = new Map();
  const timers = new Map();

  const win = createElement('window');
  Object.defineProperty(win, 'scrollY', { get: () => scrollY });

  const doc = createElement('document');
  doc.hidden = false;
  doc.defaultView = win;
  doc.getElementById = id => byId.get(id) ?? null;

  stage.ownerDocument = doc;

  const observers = [];
  class FakeIntersectionObserver {
    constructor(callback, options = {}) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.observed.push(target);
    }
    disconnect() {
      this.disconnected = true;
      this.observed.length = 0;
    }
    emit(entry) {
      if (!this.disconnected) {
        this.callback([{ target: stage, ...entry }], this);
      }
    }
  }

  return {
    doc,
    win,
    film,
    stage,
    gl,
    play,
    replay,
    creditsToggle,
    observers,
    FakeIntersectionObserver,
    get playing() { return playing; },
    get playClicks() { return playClicks; },
    setEnded() {
      ended = true;
      setPlaying(false);
    },
    startFilm() {
      if (film) film.classList.add('film-started');
      gl.setAttribute('data-engine', 'three.js r170');
      setPlaying(true);
    },
    scrollTo(y, dtMs = 16) {
      nowMs += dtMs;
      scrollY = y;
      win.dispatchEvent({ type: 'scroll' });
    },
    flushFrame(dtMs = 16) {
      nowMs += dtMs;
      const entries = [...rafQueue.entries()];
      rafQueue.clear();
      for (const [, cb] of entries) cb(nowMs);
    },
    advanceTimers(dtMs) {
      nowMs += dtMs;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.due <= nowMs) {
          timers.delete(id);
          timer.cb();
        }
      }
    },
    get pendingFrames() { return rafQueue.size; },
    options: {
      IntersectionObserver: FakeIntersectionObserver,
      now: () => nowMs,
      requestFrame(cb) {
        const id = ++rafSeq;
        rafQueue.set(id, cb);
        return id;
      },
      cancelFrame(id) {
        rafQueue.delete(id);
      },
      setTimer(cb, ms) {
        const id = ++timerSeq;
        timers.set(id, { cb, due: nowMs + ms });
        return id;
      },
      clearTimer(id) {
        timers.delete(id);
      },
    },
  };
}

test('observes #stage at threshold [0, 0.05], ignores unstarted poster state, and auto-pauses/resumes offscreen once started', () => {
  const h = createFilmHarness({ started: false });
  const gov = initFilmPerfGovernor(h.doc, h.options);

  assert.equal(h.observers.length, 1);
  assert.deepEqual(h.observers[0].options.threshold, [0, 0.05]);
  assert.equal(h.observers[0].observed[0], h.stage);

  // Scrolling past the unstarted poster must never click #play or mark auto-paused.
  h.observers[0].emit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(h.playClicks, 0);
  assert.equal(h.stage.dataset.autoPaused, undefined);

  // Launch the 3D film and bring stage into view.
  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 0.9 });
  h.startFilm();
  assert.equal(h.playing, true);

  // Dropping below 0.05 intersection ratio auto-pauses WebGL + CSS animations.
  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 0.04 });
  assert.equal(h.playing, false);
  assert.equal(h.stage.classList.contains('paused'), true);
  assert.equal(h.stage.dataset.autoPaused, 'offscreen');
  assert.equal(h.stage.getAttribute('data-auto-paused'), 'offscreen');
  assert.equal(h.playClicks, 1);

  // Further 0% ratio entry does not double-toggle #play back on.
  h.observers[0].emit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(h.playing, false);
  assert.equal(h.playClicks, 1);

  // Scrolling back >= 0.05 cleanly resumes playback and clears data-auto-paused.
  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 0.05 });
  assert.equal(h.playing, true);
  assert.equal(h.stage.classList.contains('paused'), false);
  assert.equal(h.stage.dataset.autoPaused, undefined);
  assert.equal(h.stage.hasAttribute('data-auto-paused'), false);
  assert.equal(h.playClicks, 2);

  gov.destroy();
});

test('supports #gl active detection when #film lacks .film-started or on standalone stage', () => {
  const h = createFilmHarness({ started: false });
  const gov = initFilmPerfGovernor(h.doc, h.options);

  // Activate #gl directly (Three.js sets data-engine on the WebGL canvas).
  h.gl.setAttribute('data-engine', 'three.js r170');
  h.stage.classList.remove('paused');
  h.play.textContent = 'Pause';

  h.observers[0].emit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(h.stage.dataset.autoPaused, 'offscreen');
  assert.equal(h.playClicks, 1);

  gov.destroy();

  // Standalone film.html has #stage + #gl without a #film wrapper.
  const standalone = createFilmHarness({ started: true, withFilmWrapper: false });
  const gov2 = initFilmPerfGovernor(standalone.doc, standalone.options);
  standalone.observers[0].emit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(standalone.playing, false);
  assert.equal(standalone.stage.dataset.autoPaused, 'offscreen');
  gov2.destroy();
});

test('never overrides manual user pause or restarts an ended ("Replay") film', () => {
  const h = createFilmHarness({ started: true });
  const gov = initFilmPerfGovernor(h.doc, h.options);

  // 1) User manually pauses while onscreen.
  h.play.click();
  assert.equal(h.playing, false);
  assert.equal(h.stage.dataset.autoPaused, undefined);

  h.observers[0].emit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(h.stage.dataset.autoPaused, undefined);
  assert.equal(h.playClicks, 1, 'governor does not touch #play when already manually paused');

  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 0.8 });
  assert.equal(h.playing, false, 'manual pause stays paused when scrolling back into view');
  assert.equal(h.playClicks, 1);

  // 2) User resumes manually, governor auto-pauses offscreen, then user takes manual control and pauses.
  h.play.click();
  assert.equal(h.playing, true);
  h.observers[0].emit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(h.stage.dataset.autoPaused, 'offscreen');

  // User clicks Play then Pause manually on the transport controls below #stage.
  h.play.click();
  assert.equal(h.stage.dataset.autoPaused, undefined);
  h.play.click();
  assert.equal(h.playing, false);

  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 0.75 });
  assert.equal(h.playing, false, 'user pause after auto-pause is preserved');

  // 3) Ended film ("Replay") is never restarted by scroll intersection changes.
  h.replay.click();
  assert.equal(h.playing, true);
  h.setEnded();
  assert.equal(h.play.textContent, 'Replay');
  const clicksBeforeScroll = h.playClicks;
  h.observers[0].emit({ isIntersecting: false, intersectionRatio: 0 });
  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 1 });
  assert.equal(h.playClicks, clicksBeforeScroll);
  assert.equal(h.playing, false);

  gov.destroy();
});

test('auto-pauses on visibilitychange (document.hidden) with data-auto-paused="hidden" and coordinates with offscreen state', () => {
  const h = createFilmHarness({ started: true });
  // Simulate startFilm()'s own bubble-phase visibilitychange listener registered BEFORE or AFTER governor.
  h.doc.addEventListener('visibilitychange', () => {
    if (h.doc.hidden && h.playing) h.play.onclick();
  });

  const gov = initFilmPerfGovernor(h.doc, h.options);

  // Tab becomes hidden while playing onscreen -> sets data-auto-paused="hidden".
  h.doc.hidden = true;
  h.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.playing, false);
  assert.equal(h.stage.dataset.autoPaused, 'hidden');

  // Tab becomes visible again while onscreen -> cleanly resumes and clears data-auto-paused.
  h.doc.hidden = false;
  h.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.playing, true);
  assert.equal(h.stage.dataset.autoPaused, undefined);

  // Scroll offscreen first, then hide tab, then unhide tab while STILL offscreen -> stays paused until scrolled back.
  h.observers[0].emit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(h.stage.dataset.autoPaused, 'offscreen');

  h.doc.hidden = true;
  h.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.stage.dataset.autoPaused, 'hidden');

  h.doc.hidden = false;
  h.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.playing, false, 'must not resume WebGL offscreen when tab becomes visible');
  assert.equal(h.stage.dataset.autoPaused, 'offscreen');

  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 0.5 });
  assert.equal(h.playing, true);
  assert.equal(h.stage.dataset.autoPaused, undefined);

  gov.destroy();
});

test('trackScrollSmoothness uses passive scroll listener, toggles data-scroll-tier="smooth|eco", and idles cleanly', () => {
  const h = createFilmHarness({ started: true });
  const gov = initFilmPerfGovernor(h.doc, h.options);

  const scrollListener = h.win.listeners.get('scroll')?.[0];
  assert.ok(scrollListener, 'registers scroll listener on scroll target');
  assert.equal(scrollListener.options?.passive, true, 'scroll listener must be passive');
  assert.equal(h.stage.dataset.scrollTier, 'smooth');
  assert.equal(h.pendingFrames, 0, 'no idle rAF loop before scrolling starts');

  // Gentle 60 fps scrolling (scroll event + rAF in the same 16ms vsync) stays in "smooth" tier.
  h.scrollTo(18, 16);
  h.flushFrame(0);
  h.scrollTo(36, 16);
  h.flushFrame(0);
  h.scrollTo(54, 16);
  h.flushFrame(0);
  assert.equal(h.stage.dataset.scrollTier, 'smooth');

  // Dropped compositor/main-thread frame (>= 32ms) during scroll enters "eco" tier.
  h.scrollTo(72, 34);
  h.flushFrame(0);
  assert.equal(h.stage.dataset.scrollTier, 'eco');
  assert.equal(h.stage.getAttribute('data-scroll-tier'), 'eco');

  // Sustained smooth 60 fps frames mid-scroll can recover back to "smooth".
  for (let i = 1; i <= 8; i++) {
    h.scrollTo(72 + i * 12, 16);
    h.flushFrame(0);
  }
  assert.equal(h.stage.dataset.scrollTier, 'smooth');

  // Two mildly slow frames (> 24ms) also enter "eco", and settling after scroll stops restores "smooth".
  h.scrollTo(180, 26);
  h.flushFrame(0);
  h.scrollTo(192, 26);
  h.flushFrame(0);
  assert.equal(h.stage.dataset.scrollTier, 'eco');

  h.advanceTimers(200);
  assert.equal(h.stage.dataset.scrollTier, 'smooth');
  assert.equal(h.pendingFrames, 0, 'rAF loop stops once scrolling settles');

  // Rapid fling scroll immediately enters "eco" without waiting for dropped frames, then recovers.
  h.scrollTo(210, 16);
  h.scrollTo(370, 16);
  assert.equal(h.stage.dataset.scrollTier, 'eco');

  h.advanceTimers(200);
  assert.equal(h.stage.dataset.scrollTier, 'smooth');

  // Re-initializing on the same #stage tears down the prior instance cleanly without duplicate clicks.
  const replacement = initFilmPerfGovernor(h.doc, h.options);
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.observers.length, 2);
  h.observers[1].emit({ isIntersecting: false, intersectionRatio: 0 });
  assert.equal(h.playClicks, 1);

  // Opening #creditsToggle while auto-paused clears data-auto-paused so manual reading isn't interrupted.
  h.creditsToggle.open = true;
  h.creditsToggle.dispatchEvent({ type: 'toggle' });
  assert.equal(h.stage.dataset.autoPaused, undefined);
  h.observers[1].emit({ isIntersecting: true, intersectionRatio: 0.9 });
  assert.equal(h.playing, false);

  // Standalone trackScrollSmoothness export also works directly and cleans up on destroy().
  const standaloneStage = createElement('stage');
  const monitor = trackScrollSmoothness(standaloneStage, {
    ...h.options,
    scrollTarget: h.win,
  });
  assert.equal(standaloneStage.dataset.scrollTier, 'smooth');
  monitor.destroy();

  replacement.destroy();
  assert.equal(h.observers[1].disconnected, true);
});

test('auto-initializes on browser document load and coexists cleanly with untrusted inline scroll pause', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');

  // Verify synchronous CJS require() works alongside ESM import().
  const cjsExports = require('../public/js/film-perf-governor.js');
  assert.equal(typeof cjsExports.initFilmPerfGovernor, 'function');
  assert.equal(typeof cjsExports.trackScrollSmoothness, 'function');

  // Verify browser classic <script defer> auto-initialization on #stage.
  const h = createFilmHarness({ started: true });
  const scriptText = fs.readFileSync(
    path.join(__dirname, '../public/js/film-perf-governor.js'),
    'utf8',
  );
  const browserGlobal = {
    document: h.doc,
    window: h.win,
    IntersectionObserver: h.FakeIntersectionObserver,
    setTimeout: h.options.setTimer,
    clearTimeout: h.options.clearTimer,
    requestAnimationFrame: h.options.requestFrame,
    cancelAnimationFrame: h.options.cancelFrame,
    performance: { now: h.options.now },
    queueMicrotask,
  };
  browserGlobal.globalThis = browserGlobal;
  vm.runInNewContext(scriptText, browserGlobal);

  assert.equal(h.observers.length, 1);
  assert.equal(h.stage.dataset.scrollTier, 'smooth');

  // Coexistence: if an inline 0.25 observer triggers an untrusted #play click during active scroll,
  // governor still records data-auto-paused="offscreen" at < 0.05 and cleanly resumes on return.
  h.scrollTo(40, 16);
  h.play.dispatchEvent({ type: 'click', target: h.play, isTrusted: false });
  h.play.onclick();
  assert.equal(h.playing, false);

  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 0.03 });
  assert.equal(h.stage.dataset.autoPaused, 'offscreen');

  h.observers[0].emit({ isIntersecting: true, intersectionRatio: 0.3 });
  assert.equal(h.playing, true);
  assert.equal(h.stage.dataset.autoPaused, undefined);
});
