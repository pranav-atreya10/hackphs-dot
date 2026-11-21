// Light / dark / system theme. Loaded (not deferred) in <head> so the page never flashes the wrong theme.
// Saved from the settings page; on the dashboards, buttons marked [data-theme-toggle] also cycle System → Light → Dark; [data-side-toggle] opens the mobile sidebar.
// Fires a "themechange" event on <html> so canvas-drawn things (charts) can recolour.
(() => {
  const KEY = 'skysentryTheme', root = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)');
  const read = () => { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } };
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : dark.matches;
  const darkFor = mode => mode === 'system' ? dark.matches : mode === 'dark';
  const label = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
  const icon = {
    system: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>'
  };
  function apply(mode) {
    if (mode === 'system') delete root.dataset.theme; else root.dataset.theme = mode;
    document.querySelectorAll('[data-theme-toggle]').forEach(b => { b.innerHTML = icon[mode]; b.setAttribute('aria-label', label[mode]); b.title = label[mode]; });
    root.dispatchEvent(new CustomEvent('themechange', { detail: { dark: isDark() } }));
  }
  let current = read(), transitionSeq = 0, pendingMode = null;   // kept in memory too, so the toggle still works when storage is blocked
  const commit = mode => { if (!label[mode]) return; current = mode; try { localStorage.setItem(KEY, mode); } catch {} apply(mode); };
  function originPoint(originEvent, fallbackEl, vw, vh) {
    const btn = originEvent?.currentTarget || fallbackEl;
    if (btn && typeof btn.getBoundingClientRect === 'function') {
      const r = btn.getBoundingClientRect();
      if (r && Number.isFinite(r.left) && Number.isFinite(r.top) && (r.width > 0 || r.height > 0)) {
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    const hasCoords = originEvent && Number.isFinite(originEvent.clientX) && Number.isFinite(originEvent.clientY);
    if (hasCoords && (originEvent.clientX !== 0 || originEvent.clientY !== 0)) {
      return { x: originEvent.clientX, y: originEvent.clientY };
    }
    const target = originEvent?.target;
    if (target && typeof target.getBoundingClientRect === 'function') {
      const r = target.getBoundingClientRect();
      if (r && Number.isFinite(r.left) && Number.isFinite(r.top) && (r.width > 0 || r.height > 0)) {
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    if (hasCoords) return { x: originEvent.clientX, y: originEvent.clientY };
    return { x: vw / 2, y: vh / 2 };
  }
  function flushPending() {
    if (!pendingMode) return;
    const mode = pendingMode;
    pendingMode = null;
    commit(mode);
  }
  function transitionTo(nextMode, originEvent, fallbackEl) {
    if (!label[nextMode]) return;
    flushPending();
    const reduced = Boolean(matchMedia('(prefers-reduced-motion: reduce)')?.matches);
    if (typeof document.startViewTransition !== 'function' || reduced || isDark() === darkFor(nextMode)) {
      ++transitionSeq;
      delete root.dataset.themeTransition;
      commit(nextMode);
      return;
    }
    const vw = (typeof innerWidth === 'number' ? innerWidth : window.innerWidth) || root.clientWidth || 0;
    const vh = (typeof innerHeight === 'number' ? innerHeight : window.innerHeight) || root.clientHeight || 0;
    const { x, y } = originPoint(originEvent, fallbackEl, vw, vh);
    const maxRadius = Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y));
    const seq = ++transitionSeq;
    let applied = false, transition;
    pendingMode = nextMode;
    root.dataset.themeTransition = '1';
    try {
      transition = document.startViewTransition(() => {
        if (transitionSeq !== seq) return;
        pendingMode = null;
        applied = true;
        commit(nextMode);
      });
    } catch {
      pendingMode = null;
      if (transitionSeq === seq) delete root.dataset.themeTransition;
      if (!applied) commit(nextMode);
      return;
    }
    const reveal = () => {
      if (transitionSeq !== seq || typeof root.animate !== 'function') return;
      try {
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxRadius}px at ${x}px ${y}px)`] },
          { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' }
        );
      } catch {}
    };
    if (transition && transition.ready && typeof transition.ready.then === 'function') {
      transition.ready.then(reveal, () => {});
    } else {
      reveal();
    }
    const cleanup = () => {
      if (transitionSeq !== seq) return;
      pendingMode = null;
      delete root.dataset.themeTransition;
      if (!applied) commit(nextMode);
    };
    if (transition && transition.finished && typeof transition.finished.finally === 'function') {
      transition.finished.finally(cleanup).catch(() => {});
    } else {
      cleanup();
    }
  }
  // The settings page (settings.html) reads and sets the mode directly; callers may pass { originEvent } for a circular reveal.
  const set = (mode, options) => {
    if (options && typeof options === 'object' && ('originEvent' in options || 'clientX' in options || 'currentTarget' in options || 'target' in options)) {
      transitionTo(mode, 'originEvent' in options ? options.originEvent : options);
      return;
    }
    if (!label[mode]) return;
    ++transitionSeq;
    pendingMode = null;
    delete root.dataset.themeTransition;
    commit(mode);
  };
  window.skysentryTheme = { isDark, mode: () => current, set };
  apply(current);
  dark.addEventListener('change', () => { if (current === 'system') apply('system'); });
  document.addEventListener('DOMContentLoaded', () => {
    apply(current);
    document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', originEvent => {
      flushPending();
      transitionTo({ system: 'light', light: 'dark', dark: 'system' }[current], originEvent, b);
    }));
    document.querySelectorAll('[data-side-toggle]').forEach(b => b.addEventListener('click', () => {
      const side = document.getElementById(b.getAttribute('aria-controls'));
      const open = !side.hasAttribute('data-open');
      side.toggleAttribute('data-open', open); b.setAttribute('aria-expanded', String(open));
    }));
  });
})();
