// Scroll-reveal for every page. Chrome/Edge already animate the landing page with CSS scroll timelines,
// so this only adds an IntersectionObserver reveal where that isn't supported (Safari, Firefox) and on the
// app pages (cards, demo clips). Respects reduced motion; content is never hidden if JS fails.
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const landing = document.body.classList.contains('app') === false;
  if (landing && CSS.supports && CSS.supports('animation-timeline: view()')) return;
  const style = document.createElement('style');
  style.textContent = '.rv{opacity:0;transform:translateY(18px);transition:opacity .6s cubic-bezier(.2,.7,.2,1),transform .6s cubic-bezier(.2,.7,.2,1);transition-delay:var(--rv-d,0ms)}.rv.rv-in{opacity:1;transform:none}';
  document.head.append(style);
  const sel = landing ? '.sec-head, .sec > :not(.sec-head), .risk-row, figure, .card' : '.card, .clip, .page-head, .intro, .more-grid > *';
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('rv-in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  const watch = root => root.querySelectorAll(sel).forEach((el, i) => {
    if (el.classList.contains('rv') || el.closest('#film, .stage, .side')) return;
    // Anything already on screen at load shows immediately (no flash of hidden content).
    if (el.getBoundingClientRect().top < innerHeight * 0.92) return;
    el.classList.add('rv'); el.style.setProperty('--rv-d', `${(i % 4) * 70}ms`); io.observe(el);
  });
  // Live pages (tower, demos) add DOM constantly, so rescans are batched to at most ~3 per second.
  let pending = 0;
  const rescan = () => { if (!pending) pending = setTimeout(() => { pending = 0; watch(document); }, 300); };
  const start = () => { watch(document); new MutationObserver(rescan).observe(document.body, { childList: true, subtree: true }); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();
