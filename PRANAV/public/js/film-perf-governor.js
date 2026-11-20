// Offscreen auto-pause and passive scroll frame-budget governor for the 3D airfield film (#film / #stage).
// Pauses the Three.js EffectComposer loop and HUD CSS animations at 0% GPU/CPU cost when #stage scrolls
// out of view or the tab hides, and exposes data-scroll-tier="smooth|eco" during active scrolling.
(function (globalScope) {
  'use strict';

const DEFAULT_THRESHOLDS = Object.freeze([0, 0.05]);
const DEFAULT_OFFSCREEN_RATIO = 0.05;
const DEFAULT_SLOW_FRAME_MS = 24;
const DEFAULT_SMOOTH_FRAME_MS = 18.5;
const DEFAULT_RAPID_SCROLL_PX = 80;
const DEFAULT_RAPID_VELOCITY_PX_S = 1800;
const DEFAULT_RECOVERY_FRAMES = 8;
const DEFAULT_IDLE_MS = 180;
const WARM_FETCH_URLS = Object.freeze([
  './vendor/three.module.js',
  './film-enhancements.js',
  './details.js',
  './cinema.js',
  './assets/narrow-body-airliner.glb',
  './assets/derelict_airfield_01_1k.hdr',
]);

const activeGovernors = new WeakMap();

function setDataAttr(el, prop, attr, value) {
  if (!el) return;
  if (el.dataset) el.dataset[prop] = value;
  if (typeof el.setAttribute === 'function' && el.getAttribute?.(attr) !== value) {
    el.setAttribute(attr, value);
  }
}

function clearDataAttr(el, prop, attr) {
  if (!el) return;
  if (el.dataset && prop in el.dataset) delete el.dataset[prop];
  if (typeof el.removeAttribute === 'function') el.removeAttribute(attr);
}

function getDataAttr(el, prop, attr) {
  if (!el) return undefined;
  const fromDataset = el.dataset ? el.dataset[prop] : undefined;
  if (fromDataset !== undefined) return fromDataset;
  if (typeof el.getAttribute === 'function') {
    const fromAttr = el.getAttribute(attr);
    return fromAttr === null ? undefined : fromAttr;
  }
  return undefined;
}

function findById(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  if (typeof root.getElementById === 'function') return root.getElementById(id);
  if (typeof root.querySelector === 'function') return root.querySelector(`#${id}`);
  return null;
}

function isGlActive(gl, stage) {
  if (!gl) return false;
  if (gl.active === true) return true;
  const engine = getDataAttr(gl, 'engine', 'data-engine');
  const active = getDataAttr(gl, 'active', 'data-active');
  if (engine || active === 'true') return true;
  if (gl.classList?.contains?.('active')) return true;
  const assets = getDataAttr(stage, 'assets', 'data-assets');
  return assets === 'background' || assets === 'ready' || assets === 'partial';
}

function isFilmStarted(stage, film, gl, root) {
  if (!stage) return false;
  if (getDataAttr(stage, 'assets', 'data-assets') === 'failed') return false;
  if (film?.classList?.contains?.('film-started') || stage.closest?.('.film-started')) {
    return true;
  }
  if (isGlActive(gl, stage)) return true;
  const poster = findById(root, 'filmPoster') ?? findById(stage, 'filmPoster');
  if (!film && !poster) return true;
  return false;
}

function getPlayLabel(playBtn) {
  return typeof playBtn?.textContent === 'string' ? playBtn.textContent.trim().toLowerCase() : '';
}

function isEnded(playBtn) {
  return getPlayLabel(playBtn) === 'replay';
}

function isPlaying(stage, playBtn) {
  if (!stage) return false;
  if (stage.classList?.contains?.('paused')) return false;
  const label = getPlayLabel(playBtn);
  if (label === 'play' || label === 'replay') return false;
  if (label === 'pause') return true;
  if (playBtn?.getAttribute?.('aria-pressed') === 'false') return false;
  return true;
}

function trackScrollSmoothness(stage, options = {}) {
  if (!stage) {
    return {
      get tier() { return 'smooth'; },
      get isScrolling() { return false; },
      destroy() {},
    };
  }

  const doc = options.document ?? stage.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  const win = options.window ?? doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const scrollTarget = options.scrollTarget ?? win;
  const now = options.now ?? (() => (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()));
  const requestFrame = options.requestFrame
    ?? (typeof win?.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null)
    ?? (typeof globalScope.requestAnimationFrame === 'function' ? globalScope.requestAnimationFrame.bind(globalScope) : null);
  const cancelFrame = options.cancelFrame
    ?? (typeof win?.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null)
    ?? (typeof globalScope.cancelAnimationFrame === 'function' ? globalScope.cancelAnimationFrame.bind(globalScope) : null);
  const setTimer = options.setTimer ?? globalScope.setTimeout.bind(globalScope);
  const clearTimer = options.clearTimer ?? globalScope.clearTimeout.bind(globalScope);

  const slowFrameMs = options.slowFrameMs ?? DEFAULT_SLOW_FRAME_MS;
  const smoothFrameMs = options.smoothFrameMs ?? DEFAULT_SMOOTH_FRAME_MS;
  const slowFramesRequired = Math.max(1, options.slowFramesRequired ?? 2);
  const droppedFrameMs = options.droppedFrameMs ?? slowFrameMs * 1.3;
  const rapidScrollPx = options.rapidScrollPx ?? DEFAULT_RAPID_SCROLL_PX;
  const rapidVelocityPxPerSec = options.rapidVelocityPxPerSec ?? DEFAULT_RAPID_VELOCITY_PX_S;
  const recoveryFrames = Math.max(1, options.recoveryFrames ?? DEFAULT_RECOVERY_FRAMES);
  const idleMs = Math.max(16, options.idleMs ?? DEFAULT_IDLE_MS);

  const readScrollY = options.getScrollY ?? (() => {
    if (scrollTarget && typeof scrollTarget.scrollY === 'number') return scrollTarget.scrollY;
    if (scrollTarget && typeof scrollTarget.pageYOffset === 'number') return scrollTarget.pageYOffset;
    if (scrollTarget && typeof scrollTarget.scrollTop === 'number') return scrollTarget.scrollTop;
    return doc?.documentElement?.scrollTop ?? doc?.body?.scrollTop ?? 0;
  });

  let currentTier = 'smooth';
  let initialized = false;
  let destroyed = false;
  let scrolling = false;
  let rafId = null;
  let idleTimer = null;
  let lastFrameTs = null;
  let lastScrollY = 0;
  let lastScrollAt = 0;
  let lastRapidAt = -Infinity;
  let slowStreak = 0;
  let smoothStreak = 0;

  function setTier(nextTier) {
    if (destroyed) return;
    if (initialized && currentTier === nextTier) return;
    initialized = true;
    currentTier = nextTier;
    setDataAttr(stage, 'scrollTier', 'data-scroll-tier', nextTier);
    if (typeof options.onTierChange === 'function') options.onTierChange(nextTier);
  }

  function stopFrameLoop() {
    if (rafId !== null) {
      if (typeof cancelFrame === 'function') cancelFrame(rafId);
      rafId = null;
    }
    lastFrameTs = null;
  }

  function onFrame(frameTs) {
    rafId = null;
    if (destroyed || !scrolling) return;
    const ts = typeof frameTs === 'number' && Number.isFinite(frameTs) ? frameTs : now();
    if (lastFrameTs !== null) {
      const dt = ts - lastFrameTs;
      if (dt > slowFrameMs) {
        slowStreak += 1;
        smoothStreak = 0;
        if (dt >= droppedFrameMs || slowStreak >= slowFramesRequired) setTier('eco');
      } else if (dt <= smoothFrameMs) {
        slowStreak = 0;
        smoothStreak += 1;
        if (currentTier === 'eco' && smoothStreak >= recoveryFrames && (ts - lastRapidAt) >= idleMs) {
          setTier('smooth');
        }
      }
    }
    lastFrameTs = ts;
    scheduleFrame();
  }

  function scheduleFrame() {
    if (destroyed || !scrolling || rafId !== null || typeof requestFrame !== 'function') return;
    rafId = requestFrame(onFrame);
  }

  function onScrollIdle() {
    idleTimer = null;
    scrolling = false;
    slowStreak = 0;
    smoothStreak = 0;
    stopFrameLoop();
    setTier('smooth');
  }

  function onScroll() {
    if (destroyed) return;
    const ts = now();
    const y = Number(readScrollY()) || 0;
    if (!scrolling) {
      scrolling = true;
      lastScrollY = y;
      lastScrollAt = ts;
    } else {
      const dy = Math.abs(y - lastScrollY);
      const dt = Math.max(1, ts - lastScrollAt);
      const velocity = (dy * 1000) / dt;
      lastScrollY = y;
      lastScrollAt = ts;
      if (dy >= rapidScrollPx || velocity >= rapidVelocityPxPerSec) {
        lastRapidAt = ts;
        smoothStreak = 0;
        setTier('eco');
      }
    }
    scheduleFrame();
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = setTimer(onScrollIdle, idleMs);
  }

  setTier('smooth');
  if (scrollTarget && typeof scrollTarget.addEventListener === 'function') {
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  }

  return {
    get tier() { return currentTier; },
    get isScrolling() { return scrolling; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      scrolling = false;
      if (idleTimer !== null) {
        clearTimer(idleTimer);
        idleTimer = null;
      }
      stopFrameLoop();
      if (scrollTarget && typeof scrollTarget.removeEventListener === 'function') {
        scrollTarget.removeEventListener('scroll', onScroll, { passive: true });
      }
    },
  };
}

function initFilmPerfGovernor(
  root = typeof document !== 'undefined' ? document : null,
  options = {},
) {
  const stage = options.stage ?? findById(root, 'stage');
  if (!stage) return null;

  const previous = activeGovernors.get(stage);
  if (previous) previous.destroy();

  const film = options.film ?? findById(root, 'film') ?? stage.closest?.('#film') ?? null;
  const gl = options.gl ?? findById(stage, 'gl') ?? findById(root, 'gl');
  const playButton = options.playButton ?? findById(root, 'play');
  const replayButton = options.replayButton ?? findById(root, 'replay');
  const creditsToggle = options.creditsToggle ?? findById(root, 'creditsToggle');
  const poster = options.poster ?? findById(root, 'filmPoster') ?? findById(stage, 'filmPoster');

  const doc = options.document
    ?? stage.ownerDocument
    ?? (root && ('hidden' in root || typeof root.getElementById === 'function') ? root : null)
    ?? (typeof document !== 'undefined' ? document : null);
  const win = options.window ?? doc?.defaultView ?? (typeof window !== 'undefined' ? window : null);

  const thresholds = Array.isArray(options.thresholds) && options.thresholds.length > 0
    ? [...options.thresholds]
    : [...DEFAULT_THRESHOLDS];
  const offscreenRatio = options.offscreenRatio ?? DEFAULT_OFFSCREEN_RATIO;

  const ObserverCtor = options.IntersectionObserver
    ?? win?.IntersectionObserver
    ?? globalScope.IntersectionObserver;
  const MutationObserverCtor = options.MutationObserver
    ?? win?.MutationObserver
    ?? globalScope.MutationObserver;

  let destroyed = false;
  let internalClick = false;
  let offscreen = false;
  let spaceKeyTurn = false;
  let programmaticScrollPause = false;

  const scrollMonitor = trackScrollSmoothness(stage, {
    ...options,
    document: doc,
    window: win,
  });

  const isDocHidden = () => Boolean(
    typeof options.isHidden === 'function' ? options.isHidden() : doc?.hidden,
  );

  function clickPlayButton() {
    if (!playButton || typeof playButton.click !== 'function') return false;
    internalClick = true;
    try {
      playButton.click();
      return true;
    } finally {
      internalClick = false;
    }
  }

  function pausePlayback(reason) {
    if (destroyed || !isFilmStarted(stage, film, gl, root)) return false;
    const existingReason = getDataAttr(stage, 'autoPaused', 'data-auto-paused');
    if (existingReason) {
      if (reason === 'hidden' && existingReason !== 'hidden') {
        setDataAttr(stage, 'autoPaused', 'data-auto-paused', 'hidden');
      }
      return false;
    }
    if (!isPlaying(stage, playButton)) {
      if (reason === 'offscreen' && programmaticScrollPause && !isEnded(playButton)) {
        programmaticScrollPause = false;
        setDataAttr(stage, 'autoPaused', 'data-auto-paused', 'offscreen');
        stage.classList?.add?.('paused');
        return true;
      }
      return false;
    }
    programmaticScrollPause = false;
    setDataAttr(stage, 'autoPaused', 'data-auto-paused', reason);
    clickPlayButton();
    stage.classList?.add?.('paused');
    return true;
  }

  function resumePlayback(expectedReason) {
    if (destroyed) return false;
    programmaticScrollPause = false;
    const currentReason = getDataAttr(stage, 'autoPaused', 'data-auto-paused');
    if (!currentReason) return false;
    if (expectedReason && currentReason !== expectedReason) return false;
    if (isDocHidden()) return false;
    if (offscreen) {
      if (currentReason === 'hidden') {
        setDataAttr(stage, 'autoPaused', 'data-auto-paused', 'offscreen');
      }
      return false;
    }
    clearDataAttr(stage, 'autoPaused', 'data-auto-paused');
    if (isEnded(playButton)) return false;
    if (!isPlaying(stage, playButton)) {
      const clicked = clickPlayButton();
      if (!clicked || getPlayLabel(playButton) !== 'play') {
        stage.classList?.remove?.('paused');
      }
      return true;
    }
    return false;
  }

  function onKeyDown(event) {
    if (destroyed) return;
    if (event?.key === ' ') {
      spaceKeyTurn = true;
      queueMicrotask(() => { spaceKeyTurn = false; });
    }
  }

  function onPlayClick(event) {
    if (internalClick || destroyed) return;
    if (event && event.isTrusted === false && !spaceKeyTurn && scrollMonitor.isScrolling) {
      programmaticScrollPause = true;
      return;
    }
    programmaticScrollPause = false;
    clearDataAttr(stage, 'autoPaused', 'data-auto-paused');
  }

  function onReplayClick() {
    if (internalClick || destroyed) return;
    programmaticScrollPause = false;
    clearDataAttr(stage, 'autoPaused', 'data-auto-paused');
  }

  function onCreditsToggle() {
    if (destroyed) return;
    if (creditsToggle?.open) {
      programmaticScrollPause = false;
      clearDataAttr(stage, 'autoPaused', 'data-auto-paused');
    }
  }

  function onVisibilityChange() {
    if (destroyed) return;
    if (isDocHidden()) {
      pausePlayback('hidden');
    } else {
      resumePlayback('hidden');
    }
  }

  function handleEntries(entries) {
    if (destroyed || !Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || (entry.target && entry.target !== stage)) continue;
      const ratio = typeof entry.intersectionRatio === 'number'
        ? entry.intersectionRatio
        : (entry.isIntersecting ? 1 : 0);
      const intersecting = typeof entry.isIntersecting === 'boolean'
        ? entry.isIntersecting
        : ratio > 0;
      offscreen = !intersecting || ratio < offscreenRatio;
      if (offscreen) {
        pausePlayback('offscreen');
      } else {
        resumePlayback('offscreen');
      }
    }
  }

  let observer = null;
  if (typeof ObserverCtor === 'function') {
    observer = new ObserverCtor(handleEntries, { threshold: thresholds });
    observer.observe(stage);
  }

  // Warm-fetch core Three.js modules + hero aircraft/HDR once when #filmPoster enters within 300px or is hovered/focused.
  const fetchFn = options.fetch ?? win?.fetch?.bind?.(win) ?? (typeof globalScope.fetch === 'function' ? globalScope.fetch.bind(globalScope) : null);
  const nav = options.navigator ?? win?.navigator ?? (typeof navigator !== 'undefined' ? navigator : null);
  let warmObserver = null;
  let warmDone = false;
  function warmFetchFilmAssets() {
    if (destroyed || warmDone) return;
    if (getDataAttr(poster, 'warmFetched', 'data-warm-fetched') === '1') {
      warmDone = true;
      warmObserver?.disconnect?.();
      return;
    }
    if (nav?.connection?.saveData) return;
    warmDone = true;
    if (poster) setDataAttr(poster, 'warmFetched', 'data-warm-fetched', '1');
    warmObserver?.disconnect?.();
    if (typeof fetchFn === 'function') {
      for (const url of WARM_FETCH_URLS) {
        try {
          Promise.resolve(fetchFn(url, { priority: 'low' })).catch(() => {});
        } catch {}
      }
    }
  }
  if (poster && !isFilmStarted(stage, film, gl, root)) {
    if (typeof ObserverCtor === 'function') {
      warmObserver = new ObserverCtor(entries => {
        if (destroyed || !Array.isArray(entries)) return;
        if (entries.some(e => e && (e.isIntersecting || (typeof e.intersectionRatio === 'number' && e.intersectionRatio > 0)))) {
          warmFetchFilmAssets();
        }
      }, { rootMargin: '300px' });
      warmObserver.observe(poster);
    }
    if (typeof poster.addEventListener === 'function') {
      poster.addEventListener('pointerenter', warmFetchFilmAssets, { once: true, passive: true });
      poster.addEventListener('focusin', warmFetchFilmAssets, { once: true });
    }
  }

  let filmMutationObserver = null;
  if (film && typeof MutationObserverCtor === 'function' && typeof film.addEventListener === 'function') {
    filmMutationObserver = new MutationObserverCtor(() => {
      if (destroyed || !isFilmStarted(stage, film, gl, root)) return;
      if (isDocHidden()) pausePlayback('hidden');
      else if (offscreen) pausePlayback('offscreen');
    });
    try {
      filmMutationObserver.observe(film, { attributes: true, attributeFilter: ['class'] });
    } catch {
      filmMutationObserver = null;
    }
  }

  if (playButton && typeof playButton.addEventListener === 'function') {
    playButton.addEventListener('click', onPlayClick);
  }
  if (replayButton && typeof replayButton.addEventListener === 'function') {
    replayButton.addEventListener('click', onReplayClick);
  }
  if (creditsToggle && typeof creditsToggle.addEventListener === 'function') {
    creditsToggle.addEventListener('toggle', onCreditsToggle);
  }
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('keydown', onKeyDown, true);
    // Capture phase runs before startFilm()'s bubble-phase visibilitychange listener.
    doc.addEventListener('visibilitychange', onVisibilityChange, true);
  }

  const controller = {
    stage,
    film,
    playButton,
    observer,
    scrollMonitor,
    getState() {
      return {
        started: isFilmStarted(stage, film, gl, root),
        playing: isPlaying(stage, playButton),
        offscreen,
        hidden: isDocHidden(),
        autoPaused: getDataAttr(stage, 'autoPaused', 'data-auto-paused') ?? null,
        scrollTier: scrollMonitor.tier,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (activeGovernors.get(stage) === controller) activeGovernors.delete(stage);
      observer?.disconnect?.();
      warmObserver?.disconnect?.();
      if (poster && typeof poster.removeEventListener === 'function') {
        poster.removeEventListener('pointerenter', warmFetchFilmAssets);
        poster.removeEventListener('focusin', warmFetchFilmAssets);
      }
      filmMutationObserver?.disconnect?.();
      if (playButton && typeof playButton.removeEventListener === 'function') {
        playButton.removeEventListener('click', onPlayClick);
      }
      if (replayButton && typeof replayButton.removeEventListener === 'function') {
        replayButton.removeEventListener('click', onReplayClick);
      }
      if (creditsToggle && typeof creditsToggle.removeEventListener === 'function') {
        creditsToggle.removeEventListener('toggle', onCreditsToggle);
      }
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('keydown', onKeyDown, true);
        doc.removeEventListener('visibilitychange', onVisibilityChange, true);
      }
      scrollMonitor.destroy();
    },
  };

  activeGovernors.set(stage, controller);
  return controller;
}

if (typeof document !== 'undefined') {
  const boot = () => initFilmPerfGovernor(document);
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}

globalScope.SkySentryFilmPerfGovernor = {
  initFilmPerfGovernor,
  trackScrollSmoothness,
};

if (typeof module === 'object' && module !== null && module.exports) {
  module.exports = {
    initFilmPerfGovernor,
    trackScrollSmoothness,
  };
}
})(typeof globalThis !== 'undefined' ? globalThis : window);
