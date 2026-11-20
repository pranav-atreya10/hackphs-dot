// Smooth <details> accordions & drawers fallback for SkySentry.
// Browsers supporting CSS ::details-content + interpolate-size: allow-keywords animate via
// /css/smooth-details.css; everywhere else this uses the Web Animations API (el.animate) while
// preserving native [open] state, Enter/Space keyboard activation, and synchronous/reliable
// toggle events (critical for #more chart/beacon lazy-loading and #towerDemo preview in tower.js).
(() => {
  'use strict';

  const DEFAULT_SELECTOR = 'details.fold, .faq details, details.card';
  const DEFAULT_DURATION = 280;
  const DEFAULT_EASING = 'cubic-bezier(.2, .7, .2, 1)';
  const INTERACTIVE_CHILD = 'a[href], button, input, select, textarea, [contenteditable="true"]';
  const boundElements = new WeakMap();

  function parsePx(value) {
    const n = typeof value === 'string' ? parseFloat(value) : Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function prefersReducedMotion(win) {
    if (!win || typeof win.matchMedia !== 'function') return false;
    try {
      const mql = win.matchMedia('(prefers-reduced-motion: reduce)');
      return Boolean(mql && mql.matches);
    } catch {
      return false;
    }
  }

  function supportsNativeDetailsTransition(win) {
    if (!win || !win.CSS || typeof win.CSS.supports !== 'function') return false;
    try {
      return (
        Boolean(win.CSS.supports('selector(::details-content)')) &&
        Boolean(win.CSS.supports('interpolate-size', 'allow-keywords'))
      );
    } catch {
      return false;
    }
  }

  function isNativeBrowserDetails(details, win) {
    if (!details || !win || typeof win.HTMLDetailsElement !== 'function') return false;
    try {
      return (
        /\[native code\]/.test(Function.prototype.toString.call(win.HTMLDetailsElement)) &&
        details instanceof win.HTMLDetailsElement
      );
    } catch {
      return false;
    }
  }

  function findDirectSummary(details) {
    if (!details) return null;
    const children = details.children;
    if (children && typeof children.length === 'number') {
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child && String(child.tagName || '').toUpperCase() === 'SUMMARY') return child;
      }
    }
    if (typeof details.querySelector === 'function') {
      try {
        return details.querySelector(':scope > summary') || details.querySelector('summary');
      } catch {
        return details.querySelector('summary');
      }
    }
    return null;
  }

  function isInteractiveNestedTarget(target, summary) {
    if (!target || target === summary || typeof target.closest !== 'function') return false;
    const hit = target.closest(INTERACTIVE_CHILD);
    return Boolean(hit && hit !== summary && (!summary.contains || summary.contains(hit)));
  }

  function measureHeight(el) {
    if (!el) return 0;
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && Number.isFinite(rect.height) && rect.height > 0) return rect.height;
    }
    if (Number.isFinite(el.offsetHeight)) return el.offsetHeight;
    return 0;
  }

  function measureCollapsedHeight(details, summary, win) {
    const summaryHeight = measureHeight(summary);
    const readStyle = win && typeof win.getComputedStyle === 'function'
      ? el => {
          try { return el ? win.getComputedStyle(el) : null; } catch { return null; }
        }
      : () => null;
    const dStyle = readStyle(details);
    const sStyle = readStyle(summary);
    const padY = dStyle ? parsePx(dStyle.paddingTop) + parsePx(dStyle.paddingBottom) : 0;
    const borderY = dStyle ? parsePx(dStyle.borderTopWidth) + parsePx(dStyle.borderBottomWidth) : 0;
    const marginY = sStyle ? parsePx(sStyle.marginTop) + parsePx(sStyle.marginBottom) : 0;
    return Math.max(0, summaryHeight + marginY + padY + borderY);
  }

  function setFlag(el, name, active) {
    if (!el) return;
    if (el.dataset) {
      if (active) el.dataset[name] = 'true';
      else delete el.dataset[name];
    } else if (active) {
      el.setAttribute?.(`data-${name}`, 'true');
    } else {
      el.removeAttribute?.(`data-${name}`);
    }
  }

  // Updates details.open + [open] attribute and guarantees a reliable toggle event without
  // double-firing in real browsers or synchronous test harnesses.
  function setDetailsOpen(details, nextOpen, win) {
    const target = Boolean(nextOpen);
    if (Boolean(details.open) === target) return;

    const nativeDetails = isNativeBrowserDetails(details, win);
    let toggleObserved = false;
    const onToggleProbe = () => { toggleObserved = true; };
    details.addEventListener?.('toggle', onToggleProbe, { once: true });

    details.open = target;
    if (!nativeDetails) {
      if (typeof details.toggleAttribute === 'function') {
        details.toggleAttribute('open', target);
      } else if (target) {
        details.setAttribute?.('open', '');
      } else {
        details.removeAttribute?.('open');
      }
    }

    details.removeEventListener?.('toggle', onToggleProbe);

    if (!toggleObserved && !nativeDetails && typeof details.dispatchEvent === 'function') {
      const EventCtor = (win && win.Event) || (typeof Event === 'function' ? Event : null);
      let evt;
      if (EventCtor) {
        try { evt = new EventCtor('toggle'); } catch { evt = { type: 'toggle', target: details }; }
      } else {
        evt = { type: 'toggle', target: details };
      }
      details.dispatchEvent(evt);
    }
  }

  function shouldSkipAnimation(details, win) {
    if (!details || typeof details.animate !== 'function') return true;
    if (prefersReducedMotion(win)) return true;
    if (supportsNativeDetailsTransition(win)) return true;
    return false;
  }

  function bindDetails(details, { win, duration, easing }) {
    if (!details || boundElements.has(details)) return boundElements.get(details) || null;
    const summary = findDirectSummary(details);
    if (!summary || typeof summary.addEventListener !== 'function') return null;

    const state = {
      phase: 'idle',
      animation: null,
      cancelToken: null,
      savedStyles: null,
      suppressSyntheticClick: false,
      clearSuppressTimer: null,
    };

    function saveInlineStyles() {
      if (state.savedStyles || !details.style) return;
      state.savedStyles = {
        height: details.style.height || '',
        overflow: details.style.overflow || '',
        boxSizing: details.style.boxSizing || '',
      };
    }

    function restoreInlineStyles() {
      if (state.savedStyles && details.style) {
        details.style.height = state.savedStyles.height;
        details.style.overflow = state.savedStyles.overflow;
        details.style.boxSizing = state.savedStyles.boxSizing;
      }
      state.savedStyles = null;
      setFlag(details, 'animating', false);
      setFlag(details, 'closing', false);
      state.phase = 'idle';
      state.animation = null;
      state.cancelToken = null;
    }

    function cancelActiveAnimation() {
      if (state.cancelToken) state.cancelToken.aborted = true;
      const anim = state.animation;
      state.animation = null;
      state.cancelToken = null;
      if (anim && typeof anim.cancel === 'function') {
        try { anim.cancel(); } catch {}
      }
    }

    function runHeightAnimation(fromHeight, toHeight, onComplete) {
      const token = { aborted: false, settled: false };
      state.cancelToken = token;

      if (details.style) {
        details.style.overflow = 'hidden';
        details.style.boxSizing = 'border-box';
      }

      let anim;
      try {
        anim = details.animate(
          [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
          { duration, easing }
        );
      } catch {
        restoreInlineStyles();
        onComplete();
        return;
      }

      state.animation = anim;

      const finish = () => {
        if (token.aborted || token.settled) return;
        token.settled = true;
        restoreInlineStyles();
        onComplete();
      };

      const cancel = () => {
        if (token.aborted || token.settled) return;
        token.settled = true;
        restoreInlineStyles();
      };

      if (!anim) {
        finish();
        return;
      }

      anim.onfinish = finish;
      anim.oncancel = cancel;
      if (typeof anim.addEventListener === 'function') {
        anim.addEventListener('finish', finish, { once: true });
        anim.addEventListener('cancel', cancel, { once: true });
      }
      if (anim.finished && typeof anim.finished.then === 'function') {
        anim.finished.then(finish, cancel);
      }
    }

    function activateAnimatedToggle() {
      const logicallyOpen = Boolean(details.open) && state.phase !== 'collapsing';

      if (!logicallyOpen) {
        // Expand (from closed, or reversing a mid-flight collapse).
        const startHeight = measureHeight(details);
        cancelActiveAnimation();
        saveInlineStyles();
        if (details.style) details.style.height = '';
        setFlag(details, 'closing', false);
        setFlag(details, 'animating', true);

        // Open synchronously so #more lazy-loaders and native [open] consumers observe it immediately.
        setDetailsOpen(details, true, win);
        const endHeight = measureHeight(details);
        state.phase = 'expanding';
        runHeightAnimation(startHeight, endHeight, () => {});
      } else {
        // Collapse (from open, or reversing a mid-flight expand).
        const startHeight = measureHeight(details);
        cancelActiveAnimation();
        saveInlineStyles();
        const endHeight = measureCollapsedHeight(details, summary, win);
        setFlag(details, 'animating', true);
        setFlag(details, 'closing', true);
        state.phase = 'collapsing';
        runHeightAnimation(startHeight, endHeight, () => {
          setDetailsOpen(details, false, win);
        });
      }
    }

    function clearSyntheticSuppressionSoon() {
      const scheduleMicro = typeof queueMicrotask === 'function'
        ? queueMicrotask
        : fn => Promise.resolve().then(fn);
      scheduleMicro(() => { state.suppressSyntheticClick = false; });
      if (state.clearSuppressTimer) {
        (win?.clearTimeout || clearTimeout)(state.clearSuppressTimer);
        state.clearSuppressTimer = null;
      }
    }

    function onClick(event) {
      if (event?.defaultPrevented) return;
      if (typeof event?.button === 'number' && event.button !== 0) return;
      if (isInteractiveNestedTarget(event?.target, summary)) return;

      if (state.suppressSyntheticClick && (!event || !event.detail)) {
        event?.preventDefault?.();
        state.suppressSyntheticClick = false;
        return;
      }
      state.suppressSyntheticClick = false;

      if (shouldSkipAnimation(details, win)) {
        if (state.phase !== 'idle') {
          cancelActiveAnimation();
          restoreInlineStyles();
        }
        return;
      }

      event?.preventDefault?.();
      activateAnimatedToggle();
    }

    function onKeyDown(event) {
      if (event?.defaultPrevented) return;
      if (event?.altKey || event?.ctrlKey || event?.metaKey) return;
      const key = event?.key;
      if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
      if (isInteractiveNestedTarget(event?.target, summary)) return;
      if (shouldSkipAnimation(details, win)) return;

      event?.preventDefault?.();
      if (event?.repeat) return;

      state.suppressSyntheticClick = true;
      const setTimer = win?.setTimeout || setTimeout;
      if (state.clearSuppressTimer) (win?.clearTimeout || clearTimeout)(state.clearSuppressTimer);
      state.clearSuppressTimer = setTimer(() => {
        state.suppressSyntheticClick = false;
        state.clearSuppressTimer = null;
      }, 400);
      if (key === 'Enter') clearSyntheticSuppressionSoon();

      activateAnimatedToggle();
    }

    function onKeyUp(event) {
      const key = event?.key;
      if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
        if (state.suppressSyntheticClick) clearSyntheticSuppressionSoon();
      }
    }

    summary.addEventListener('click', onClick);
    summary.addEventListener('keydown', onKeyDown);
    summary.addEventListener('keyup', onKeyUp);

    const destroy = () => {
      cancelActiveAnimation();
      restoreInlineStyles();
      if (state.clearSuppressTimer) {
        (win?.clearTimeout || clearTimeout)(state.clearSuppressTimer);
        state.clearSuppressTimer = null;
      }
      summary.removeEventListener?.('click', onClick);
      summary.removeEventListener?.('keydown', onKeyDown);
      summary.removeEventListener?.('keyup', onKeyUp);
      boundElements.delete(details);
    };

    const handle = { details, summary, destroy };
    boundElements.set(details, handle);
    return handle;
  }

  function collectTargets(root, selector) {
    const found = [];
    if (!root) return found;
    if (typeof root.matches === 'function') {
      try {
        if (root.matches(selector)) found.push(root);
      } catch {}
    }
    if (typeof root.querySelectorAll === 'function') {
      const list = root.querySelectorAll(selector);
      if (list) {
        for (let i = 0; i < list.length; i++) found.push(list[i]);
      }
    }
    return found;
  }

  function initSmoothDetails(
    root = typeof document !== 'undefined' ? document : null,
    {
      win = (root && root.defaultView) || (typeof window !== 'undefined' ? window : undefined),
      selector = DEFAULT_SELECTOR,
      duration = DEFAULT_DURATION,
      easing = DEFAULT_EASING,
    } = {}
  ) {
    const handles = new Set();
    const scan = scope => {
      for (const el of collectTargets(scope, selector)) {
        const handle = bindDetails(el, { win, duration, easing });
        if (handle) handles.add(handle);
      }
      return handles.size;
    };

    scan(root);

    let observer = null;
    const ObserverCtor = win && typeof win.MutationObserver === 'function' ? win.MutationObserver : null;
    const observeTarget = root && (root.body || root.documentElement || (root.nodeType === 1 ? root : null));
    if (ObserverCtor && observeTarget) {
      try {
        observer = new ObserverCtor(mutations => {
          for (let i = 0; i < mutations.length; i++) {
            const added = mutations[i].addedNodes;
            if (!added) continue;
            for (let j = 0; j < added.length; j++) {
              const node = added[j];
              if (node && (typeof node.matches === 'function' || typeof node.querySelectorAll === 'function')) {
                scan(node);
              }
            }
          }
        });
        observer.observe(observeTarget, { childList: true, subtree: true });
      } catch {
        observer = null;
      }
    }

    return {
      get count() { return handles.size; },
      refresh: () => scan(root),
      destroy() {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        for (const handle of handles) handle.destroy();
        handles.clear();
      },
    };
  }

  if (typeof module === 'object' && module && module.exports) {
    module.exports = { initSmoothDetails, DEFAULT_SELECTOR };
  } else if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.initSmoothDetails = initSmoothDetails;
    const start = () => initSmoothDetails(document, { win: window });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
})();
