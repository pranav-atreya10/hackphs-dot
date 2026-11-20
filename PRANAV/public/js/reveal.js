// Scroll-reveal for every page. Chrome/Edge already animate the landing page with CSS scroll timelines,
// so this only adds an IntersectionObserver reveal where that isn't supported (Safari, Firefox) and on the
// app pages (cards, demo clips). Respects reduced motion; content is never hidden if JS fails.
(() => {
  const STAGGER_MS = [0, 55, 100, 135];
  const computeStagger = index => STAGGER_MS[Math.max(0, index | 0) % STAGGER_MS.length];
  const noopApi = (reducedMotion = true) => ({
    active: false,
    reducedMotion: Boolean(reducedMotion),
    watch() {},
    refresh() {},
    revealAll() {},
    disconnect() {},
    staggerDelay: () => 0,
    createReveal,
  });

  function createReveal(env = typeof window !== 'undefined' ? window : null) {
    const doc = env?.document;
    const mq = env?.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduced = Boolean(mq?.matches);
    if (!env || !doc || reduced || typeof env.IntersectionObserver !== 'function') {
      return noopApi(reduced || !env || typeof env.IntersectionObserver !== 'function');
    }
    const hasViewTimeline = Boolean(env.CSS?.supports?.('animation-timeline: view()'));
    if (doc.body && doc.body.classList.contains('app') === false && hasViewTimeline) return noopApi(false);

    const style = doc.createElement('style');
    if (style.dataset) style.dataset.skysentryReveal = '';
    style.textContent =
      '@media (prefers-reduced-motion:no-preference){' +
      '.rv{opacity:0;transform:translateY(14px);' +
      'transition:opacity .52s cubic-bezier(.16,1,.3,1),transform .56s cubic-bezier(.16,1,.3,1);' +
      'transition-delay:var(--rv-d,0ms);will-change:opacity,transform}' +
      '.rv:not(.rv-in):not(.risk){animation:none}' +
      '.rv.rv-in{opacity:1;transform:none;will-change:auto}}';
    doc.head?.append(style);

    const getSelector = () => (doc.body && doc.body.classList.contains('app') === false)
      ? '.sec-head, .sec > :not(.sec-head), .risk-row, figure, .card'
      : '.card, .clip, .page-head, .intro, .more-grid > *';
    let sel = getSelector();
    const seen = new WeakSet();
    const pendingEls = new Set();
    let active = true;
    let rescanTimer = 0;
    let mo = null;

    const finishElement = el => {
      pendingEls.delete(el);
      el.classList?.remove('rv', 'rv-in');
      el.style?.removeProperty?.('--rv-d');
    };

    const io = new env.IntersectionObserver(entries => {
      if (!active) return;
      const entering = [];
      for (const e of entries) {
        if (e.isIntersecting) entering.push(e.target);
      }
      entering.forEach((el, idx) => {
        io.unobserve(el);
        const delay = computeStagger(idx);
        if (delay > 0) el.style?.setProperty?.('--rv-d', `${delay}ms`);
        else el.style?.removeProperty?.('--rv-d');
        el.classList.add('rv-in');
        let cleaned = false;
        const done = ev => {
          if (ev && ev.target !== el) return;
          if (cleaned) return;
          cleaned = true;
          el.removeEventListener?.('transitionend', done);
          finishElement(el);
        };
        el.addEventListener?.('transitionend', done);
        const setTimer = env.setTimeout || setTimeout;
        const t = setTimer(done, 650 + delay);
        t?.unref?.();
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    const inspect = (el, slotRef) => {
      if (!active || !el || seen.has(el)) return;
      if (el.isConnected === false) return;
      if (el.closest?.('#film, .stage, .side')) { seen.add(el); return; }
      if (el.hidden || el.closest?.('[hidden], details:not([open])')) return;
      if (hasViewTimeline && el.classList?.contains('clip')) { seen.add(el); return; }
      seen.add(el);
      const viewH = env.innerHeight || doc.documentElement?.clientHeight || 800;
      // Anything already on screen at scan time shows immediately (no flash of hidden content).
      if (el.classList?.contains('rv') || el.getBoundingClientRect().top < viewH * 0.92) return;
      const delay = computeStagger(slotRef.count++);
      el.classList.add('rv');
      if (delay > 0) el.style?.setProperty?.('--rv-d', `${delay}ms`);
      pendingEls.add(el);
      io.observe(el);
    };

    const watch = (root = doc) => {
      if (!active || !root) return;
      const slotRef = { count: 0 };
      if (root.nodeType === 1 && root.matches?.(sel)) inspect(root, slotRef);
      root.querySelectorAll?.(sel)?.forEach(el => inspect(el, slotRef));
    };

    const revealAll = () => {
      for (const el of [...pendingEls]) {
        io.unobserve(el);
        finishElement(el);
      }
    };

    const disconnect = () => {
      if (!active) return;
      active = false;
      if (rescanTimer) { (env.clearTimeout || clearTimeout)(rescanTimer); rescanTimer = 0; }
      mo?.disconnect();
      revealAll();
      io.disconnect();
      style.remove?.();
    };

    mq?.addEventListener?.('change', e => {
      if (e.matches) {
        disconnect();
        api.reducedMotion = true;
      }
    });

    const onMutations = mutations => {
      if (!active) return;
      if (!Array.isArray(mutations)) { watch(doc); return; }
      const roots = [];
      let fallbackScan = false;
      for (const m of mutations) {
        if (m.type === 'attributes') {
          const target = m.target;
          if (target?.nodeType === 1 && !target.hidden && (target.tagName !== 'DETAILS' || target.open)) {
            roots.push(target);
          }
          continue;
        }
        if (!m.addedNodes) { fallbackScan = true; continue; }
        for (const n of m.addedNodes) {
          if (n?.nodeType !== 1) continue;
          if (n.matches?.(sel) || n.querySelector?.(sel)) roots.push(n);
        }
      }
      if (fallbackScan) {
        if (!rescanTimer) {
          const setTimer = env.setTimeout || setTimeout;
          rescanTimer = setTimer(() => { rescanTimer = 0; watch(doc); }, 120);
          rescanTimer?.unref?.();
        }
        return;
      }
      if (!roots.length) return;
      // Inspect newly added/unhidden subtrees immediately before first paint so dynamic cards never flicker.
      const slotRef = { count: 0 };
      for (const root of roots) {
        if (root.matches?.(sel)) inspect(root, slotRef);
        root.querySelectorAll?.(sel)?.forEach(el => inspect(el, slotRef));
      }
    };

    const start = () => {
      if (!active) return;
      sel = getSelector();
      if (doc.body && doc.body.classList.contains('app') === false && hasViewTimeline) {
        disconnect();
        return;
      }
      watch(doc);
      if (doc.body && typeof env.MutationObserver === 'function') {
        mo = new env.MutationObserver(onMutations);
        mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
      }
    };

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
    else start();

    const api = {
      get active() { return active; },
      reducedMotion: false,
      watch,
      refresh: () => watch(doc),
      revealAll,
      disconnect,
      staggerDelay: index => (active ? computeStagger(index) : 0),
      createReveal,
    };
    return api;
  }

  const instance = typeof window !== 'undefined' && typeof document !== 'undefined'
    ? createReveal(window)
    : noopApi(true);
  if (typeof window !== 'undefined') window.SkySentryReveal = instance;
  if (typeof globalThis !== 'undefined') globalThis.SkySentryReveal = instance;
  if (typeof module === 'object' && module && module.exports) module.exports = instance;
})();
