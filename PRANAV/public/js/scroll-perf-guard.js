// Scroll compositor & offscreen media guard for SkySentry.
// 1. Passive scroll listener toggles html[data-scrolling="1"] with a 140 ms idle debounce
//    and zero layout/geometry reads inside the scroll handler.
// 2. Shared IntersectionObserver pauses offscreen preview/demo <video> elements and
//    [data-pause-offscreen] containers when completely out of view (intersectionRatio === 0)
//    and resumes guard-paused videos cleanly when visible again.
(function (globalScope) {
  'use strict';

  const SCROLL_IDLE_MS = 140;
  const WATCH_SELECTOR = 'video, [data-pause-offscreen]';
  const activeGuards = new WeakMap();

  function isVideoLike(node) {
    if (!node || typeof node !== 'object') return false;
    const tag = String(node.tagName || node.nodeName || '').toUpperCase();
    if (tag === 'VIDEO') return true;
    return typeof node.pause === 'function' && typeof node.play === 'function' && 'paused' in node;
  }

  function isPauseContainer(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.dataset && 'pauseOffscreen' in node.dataset) {
      return node.dataset.pauseOffscreen !== 'false';
    }
    if (typeof node.hasAttribute === 'function' && node.hasAttribute('data-pause-offscreen')) {
      const val = typeof node.getAttribute === 'function' ? node.getAttribute('data-pause-offscreen') : '';
      return val !== 'false';
    }
    return false;
  }

  function shouldSkipVideoPause(video) {
    // Never pause active live webcam/phone MediaStream capture (e.g. camera.html).
    if (video.srcObject) return true;
    if (video.dataset && video.dataset.pauseOffscreen === 'false') return true;
    if (typeof video.hasAttribute === 'function' && video.hasAttribute('data-no-pause-offscreen')) return true;
    return false;
  }

  function isAutoplayPreview(video, win) {
    const autoplay = Boolean(
      video.autoplay || (typeof video.hasAttribute === 'function' && video.hasAttribute('autoplay'))
    );
    if (!autoplay) return false;
    if (win && typeof win.matchMedia === 'function') {
      try {
        if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
      } catch {}
    }
    return true;
  }

  function isInsideClosedDetails(node) {
    return Boolean(node && typeof node.closest === 'function' && node.closest('details:not([open])'));
  }

  function isCompletelyOutOfView(entry) {
    if (typeof entry.intersectionRatio === 'number') {
      if (entry.intersectionRatio > 0) return false;
      return entry.isIntersecting !== true;
    }
    return entry.isIntersecting === false;
  }

  function setScrollingAttribute(docEl, active) {
    if (!docEl) return;
    if (docEl.dataset) {
      if (active) docEl.dataset.scrolling = '1';
      else delete docEl.dataset.scrolling;
    } else if (active && typeof docEl.setAttribute === 'function') {
      docEl.setAttribute('data-scrolling', '1');
    } else if (!active && typeof docEl.removeAttribute === 'function') {
      docEl.removeAttribute('data-scrolling');
    }
  }

  function setOffscreenAttribute(el, offscreen) {
    if (!el || isVideoLike(el)) return;
    if (el.dataset) {
      if (offscreen) el.dataset.offscreen = '1';
      else delete el.dataset.offscreen;
    } else if (offscreen && typeof el.setAttribute === 'function') {
      el.setAttribute('data-offscreen', '1');
    } else if (!offscreen && typeof el.removeAttribute === 'function') {
      el.removeAttribute('data-offscreen');
    }
  }

  function getControlledVideos(target) {
    const list = [];
    if (isVideoLike(target)) list.push(target);
    if (target && typeof target.querySelectorAll === 'function') {
      const nested = target.querySelectorAll('video');
      if (nested) {
        for (const v of nested) {
          if (isVideoLike(v) && !list.includes(v)) list.push(v);
        }
      }
    }
    return list;
  }

  function initScrollPerfGuard(
    root = typeof document !== 'undefined' ? document : null,
    { win = (root && root.defaultView) || (typeof window !== 'undefined' ? window : null), idleMs = SCROLL_IDLE_MS } = {}
  ) {
    if (root && typeof root === 'object' && activeGuards.has(root)) {
      activeGuards.get(root).destroy();
    }

    const docEl = root && root.documentElement ? root.documentElement : root;
    const scrollTarget = win && typeof win.addEventListener === 'function'
      ? win
      : (root && typeof root.addEventListener === 'function' ? root : null);
    const setTimer = win && typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;
    const clearTimer = win && typeof win.clearTimeout === 'function' ? win.clearTimeout.bind(win) : clearTimeout;
    const delayMs = typeof idleMs === 'number' && idleMs >= 0 ? idleMs : SCROLL_IDLE_MS;

    let scrolling = false;
    let scrollTimer = null;
    let destroyed = false;

    function clearScrollState() {
      if (scrollTimer !== null) {
        clearTimer(scrollTimer);
        scrollTimer = null;
      }
      if (scrolling) {
        scrolling = false;
        setScrollingAttribute(docEl, false);
      }
    }

    function onScrollIdle() {
      scrollTimer = null;
      scrolling = false;
      setScrollingAttribute(docEl, false);
    }

    // Zero getBoundingClientRect or layout/geometry reads inside the passive scroll handler.
    function onScroll() {
      if (destroyed) return;
      if (!scrolling) {
        scrolling = true;
        setScrollingAttribute(docEl, true);
      }
      if (scrollTimer !== null) {
        clearTimer(scrollTimer);
      }
      scrollTimer = setTimer(onScrollIdle, delayMs);
    }

    const scrollOptions = { passive: true };
    if (scrollTarget) {
      scrollTarget.addEventListener('scroll', onScroll, scrollOptions);
    }

    const ObserverCtor = (win && win.IntersectionObserver)
      || (typeof IntersectionObserver !== 'undefined' ? IntersectionObserver : null);
    const MutationCtor = (win && win.MutationObserver)
      || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

    const observedTargets = new Set();
    const pausedByGuard = new WeakSet();
    const seenOnscreen = new WeakSet();
    const targetOutOfView = new WeakMap();

    function pauseVideoForOffscreen(video) {
      if (!isVideoLike(video) || shouldSkipVideoPause(video) || video.ended) return;
      const pendingOffscreenAutoplay = !seenOnscreen.has(video) && isAutoplayPreview(video, win);
      if (!video.paused || pendingOffscreenAutoplay) {
        pausedByGuard.add(video);
        video.pause();
      }
    }

    function resumeVideoForOnscreen(video) {
      if (!isVideoLike(video)) return;
      seenOnscreen.add(video);
      if (!pausedByGuard.has(video)) return;
      pausedByGuard.delete(video);
      if (isInsideClosedDetails(video)) return;
      if (video.paused && !video.ended) {
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      }
    }

    const io = typeof ObserverCtor === 'function'
      ? new ObserverCtor(entries => {
        if (destroyed || !entries) return;
        for (const entry of entries) {
          if (!entry || !entry.target) continue;
          const target = entry.target;
          const out = isCompletelyOutOfView(entry);
          targetOutOfView.set(target, out);

          if (isPauseContainer(target)) {
            setOffscreenAttribute(target, out);
          }

          const videos = getControlledVideos(target);
          for (const video of videos) {
            if (out) {
              pauseVideoForOffscreen(video);
            } else if (video === target || targetOutOfView.get(video) !== true) {
              resumeVideoForOnscreen(video);
            }
          }
        }
      }, { threshold: [0, 0.01] })
      : null;

    function observeTarget(node) {
      if (!io || !node || typeof node !== 'object' || observedTargets.has(node)) return;
      if (isVideoLike(node) || isPauseContainer(node)) {
        observedTargets.add(node);
        io.observe(node);
      }
    }

    function unobserveSubtree(node) {
      if (!io || !node || typeof node !== 'object') return;
      if (observedTargets.has(node)) {
        observedTargets.delete(node);
        if (typeof io.unobserve === 'function') io.unobserve(node);
      }
      if (typeof node.querySelectorAll === 'function') {
        const descendants = node.querySelectorAll(WATCH_SELECTOR);
        if (descendants) {
          for (const child of descendants) {
            if (observedTargets.has(child)) {
              observedTargets.delete(child);
              if (typeof io.unobserve === 'function') io.unobserve(child);
            }
          }
        }
      }
    }

    function scanSubtree(scope) {
      if (!io || !scope || typeof scope !== 'object') return;
      observeTarget(scope);
      if (typeof scope.querySelectorAll === 'function') {
        const matches = scope.querySelectorAll(WATCH_SELECTOR);
        if (matches) {
          for (const el of matches) observeTarget(el);
        }
      }
    }

    let mo = null;
    function attachMutationObserver() {
      if (mo || !io || typeof MutationCtor !== 'function' || !root) return;
      const mutationRoot = root.body || root.documentElement || (typeof root.nodeType === 'number' ? root : null);
      if (!mutationRoot) return;
      mo = new MutationCtor(records => {
        if (destroyed || !records) return;
        for (const record of records) {
          if (record.addedNodes) {
            for (const added of record.addedNodes) {
              if (added && (added.nodeType === 1 || added.nodeType === undefined)) {
                scanSubtree(added);
              }
            }
          }
          if (record.removedNodes) {
            for (const removed of record.removedNodes) {
              if (removed && (removed.nodeType === 1 || removed.nodeType === undefined)) {
                unobserveSubtree(removed);
              }
            }
          }
        }
      });
      mo.observe(mutationRoot, { childList: true, subtree: true });
    }

    function onDomReady() {
      if (destroyed) return;
      scanSubtree(root);
      attachMutationObserver();
    }

    let domReadyAttached = false;
    if (root && root.readyState === 'loading' && typeof root.addEventListener === 'function') {
      domReadyAttached = true;
      root.addEventListener('DOMContentLoaded', onDomReady, { once: true });
      scanSubtree(root);
    } else {
      onDomReady();
    }

    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', clearScrollState, scrollOptions);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearScrollState();
      if (scrollTarget && typeof scrollTarget.removeEventListener === 'function') {
        scrollTarget.removeEventListener('scroll', onScroll, scrollOptions);
      }
      if (win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('pagehide', clearScrollState, scrollOptions);
      }
      if (domReadyAttached && root && typeof root.removeEventListener === 'function') {
        root.removeEventListener('DOMContentLoaded', onDomReady);
      }
      if (mo && typeof mo.disconnect === 'function') {
        mo.disconnect();
        mo = null;
      }
      if (io && typeof io.disconnect === 'function') {
        io.disconnect();
      }
      observedTargets.clear();
      if (root && typeof root === 'object' && activeGuards.get(root) === api) {
        activeGuards.delete(root);
      }
    }

    const api = {
      idleMs: delayMs,
      isScrolling: () => scrolling,
      get observedCount() {
        return observedTargets.size;
      },
      observe: observeTarget,
      refresh: () => scanSubtree(root),
      disconnect: destroy,
      destroy,
    };

    if (root && typeof root === 'object') {
      activeGuards.set(root, api);
    }
    return api;
  }

  if (typeof exports === 'object' && typeof module !== 'undefined' && module.exports) {
    exports.SCROLL_IDLE_MS = SCROLL_IDLE_MS;
    exports.initScrollPerfGuard = initScrollPerfGuard;
  } else {
    const browserWin = typeof window !== 'undefined' ? window : globalScope;
    const browserDoc = typeof document !== 'undefined'
      ? document
      : (browserWin && browserWin.document) || (globalScope && globalScope.document) || null;
    const exported = { initScrollPerfGuard, SCROLL_IDLE_MS };
    if (browserWin && typeof browserWin === 'object') {
      browserWin.SkySentryScrollPerf = exported;
      browserWin.initScrollPerfGuard = initScrollPerfGuard;
    }
    if (globalScope && typeof globalScope === 'object' && globalScope !== browserWin) {
      globalScope.SkySentryScrollPerf = exported;
      globalScope.initScrollPerfGuard = initScrollPerfGuard;
    }
    if (browserDoc) {
      initScrollPerfGuard(browserDoc, { win: browserWin });
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
