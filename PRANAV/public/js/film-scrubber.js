// Progressive enhancement for SkySentry's 100-second 3D film (#film on index.html and standalone film.html).
// Non-invasive: keeps .seg > i > b child order untouched so the film engine's frame() loop continues cleanly.

const DEFAULT_CHAPTERS = Object.freeze([
  Object.freeze({ index: 1, title: 'The airfield', duration: 8 }),
  Object.freeze({ index: 2, title: 'Why it matters', duration: 14 }),
  Object.freeze({ index: 3, title: 'The gap', duration: 10 }),
  Object.freeze({ index: 4, title: 'Detection', duration: 16 }),
  Object.freeze({ index: 5, title: 'Risk engine', duration: 10 }),
  Object.freeze({ index: 6, title: 'Alert journey', duration: 22 }),
  Object.freeze({ index: 7, title: 'The tower', duration: 12 }),
  Object.freeze({ index: 8, title: 'Close', duration: 8 }),
]);

const FILM_SCRUBBER_CSS = `
#bar,.film-scrubber-bar{position:relative;touch-action:manipulation}
:is(#film,.wrap) .seg{position:relative;padding-block:4px 2px;margin-block:-4px -2px;transition:opacity .18s ease}
:is(#film,.wrap) .seg i{position:relative;transition:transform .2s cubic-bezier(.22,1,.36,1),background-color .2s ease,box-shadow .2s ease;transform-origin:50% 50%}
:is(#film,.wrap) .seg:is(:hover,:focus-visible) i{transform:scaleY(1.34)}
:is(#film,.wrap) .seg[data-hovered="true"] i::after{content:"";position:absolute;inset:0;background:color-mix(in srgb,var(--on-surround,#0a0a0a) 24%,transparent);transform-origin:0 50%;transform:scaleX(var(--seg-hover-p,0));pointer-events:none}
:is(#film,.wrap) .seg.cur i{box-shadow:0 0 0 1px color-mix(in srgb,var(--on-surround,#0a0a0a) 22%,transparent)}
:is(#film,.wrap) .seg.cur span{font-weight:600;color:var(--on-surround)}
@keyframes film-seg-pulse{0%{transform:scaleY(1);box-shadow:0 0 0 0 rgba(242,183,5,.48)}42%{transform:scaleY(1.55);box-shadow:0 0 0 4px rgba(242,183,5,0)}100%{transform:scaleY(1);box-shadow:0 0 0 0 rgba(242,183,5,0)}}
:is(#film,.wrap) .seg.is-pulsing i{animation:film-seg-pulse .42s cubic-bezier(.22,1,.36,1)}
@media (prefers-reduced-motion:no-preference){
  .film-scrubber-ready:not([data-reduced-motion="true"]) .seg i b{width:100%!important;transform-origin:0 50%;transform:scaleX(var(--seg-progress,0));will-change:transform}
}
.film-chapter-tooltip{position:absolute;left:0;bottom:calc(100% + 28px);z-index:30;pointer-events:none;display:inline-flex;align-items:center;gap:0;white-space:nowrap;padding:6px 11px;border-radius:999px;background:var(--surround-2,#111);background:color-mix(in srgb,var(--surround-2,#111) 92%,transparent);border:1px solid var(--frame-line,var(--line-s,rgba(128,128,128,.26)));box-shadow:0 12px 28px -10px rgba(0,0,0,.38),0 2px 6px rgba(0,0,0,.12);backdrop-filter:blur(12px) saturate(1.2);-webkit-backdrop-filter:blur(12px) saturate(1.2);color:var(--on-surround,#fafafa);font:500 .74rem/1.2 var(--body,system-ui,sans-serif);letter-spacing:-.005em;opacity:0;transform:translate3d(var(--tooltip-x,0px),6px,0) translateX(var(--tooltip-shift,0%)) scale(.96);transition:opacity .16s ease,transform .26s cubic-bezier(.22,1.24,.36,1);will-change:transform,opacity}
.film-chapter-tooltip[data-mode="focus"]{bottom:calc(100% + 10px)}
.film-chapter-tooltip[data-visible="true"]{opacity:1;transform:translate3d(var(--tooltip-x,0px),0,0) translateX(var(--tooltip-shift,0%)) scale(1)}
.film-chapter-tooltip[data-spring="js"]{transition:opacity .16s ease}
.film-chapter-idx{font:600 .7rem/1 var(--mono,monospace);font-variant-numeric:tabular-nums;color:var(--on-surround);opacity:.86}
.film-chapter-sep{color:var(--on-surround-mute);white-space:pre}
.film-chapter-title{font-weight:600;color:var(--on-surround)}
.film-chapter-range{font:500 .7rem/1 var(--mono,monospace);font-variant-numeric:tabular-nums;color:var(--on-surround-mute)}
.film-scrub-ghost{position:absolute;left:0;top:0;z-index:28;pointer-events:none;opacity:0;transform:translate3d(var(--scrub-x,0px),0,0);transition:opacity .12s ease;will-change:transform,opacity}
.film-scrub-ghost[data-visible="true"]{opacity:1}
.film-scrub-ghost-line{display:block;position:absolute;left:-1px;top:-3px;width:2px;height:12px;border-radius:999px;background:var(--sign,#f2b705);box-shadow:0 0 0 1px rgba(10,10,10,.28),0 0 8px rgba(242,183,5,.55)}
.film-scrub-ghost-time{position:absolute;left:0;top:-24px;transform:translateX(var(--scrub-badge-shift,-50%));padding:2px 6px;border-radius:5px;white-space:nowrap;background:var(--on-surround,#0a0a0a);color:var(--surround,#fafafa);font:500 .66rem/1.25 var(--mono,monospace);font-variant-numeric:tabular-nums;letter-spacing:.02em;box-shadow:0 4px 12px rgba(0,0,0,.22)}
#filmPoster.film-poster-interactive{overflow:hidden;transform-style:preserve-3d;transform:perspective(1100px) rotateX(var(--poster-rx,0deg)) rotateY(var(--poster-ry,0deg)) scale(var(--poster-scale,1));transition:transform .28s cubic-bezier(.22,1,.36,1),box-shadow .28s ease;will-change:transform}
#filmPoster.film-poster-interactive::before{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;opacity:var(--poster-glow-opacity,0);background:radial-gradient(420px circle at var(--poster-glow-x,50%) var(--poster-glow-y,50%),rgba(242,183,5,.22),rgba(255,255,255,.08) 42%,transparent 72%);transition:opacity .24s ease}
#filmPoster.film-poster-interactive img{transform:scale(1.035) translate3d(var(--poster-img-x,0px),var(--poster-img-y,0px),0);transition:transform .32s cubic-bezier(.22,1,.36,1);will-change:transform}
#filmPoster.film-poster-interactive :is(a,button,span){z-index:2}
#filmPoster.film-poster-interactive #filmLaunch{transform:translate3d(var(--launch-mx,0px),var(--launch-my,0px),0);transition:transform .22s cubic-bezier(.22,1.2,.36,1),box-shadow .22s ease,background-color .18s ease,border-color .18s ease,opacity .18s ease;box-shadow:0 10px 28px -8px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.14);will-change:transform}
@media (prefers-reduced-motion:reduce){
  :is(#film,.wrap) :is(.seg,.seg i,.seg i b),.film-chapter-tooltip,.film-scrub-ghost,#filmPoster,#filmPoster img,#filmPoster #filmLaunch{transition:none!important;animation:none!important}
  :is(#film,.wrap) .seg:is(:hover,:focus-visible) i{transform:none!important}
  :is(#film,.wrap) .seg i b,.film-chapter-tooltip,.film-scrub-ghost,#filmPoster.film-poster-interactive,#filmPoster.film-poster-interactive img,#filmPoster.film-poster-interactive #filmLaunch{will-change:auto!important}
  :is(#film,.wrap) .seg i b,#filmPoster.film-poster-interactive,#filmPoster.film-poster-interactive img,#filmPoster.film-poster-interactive #filmLaunch{transform:none!important}
}
`.trim();

const activeControllers = new WeakMap();
let tooltipUid = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatFilmTime(seconds) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function parseFilmTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  const mmss = trimmed.match(/^(\d+):([0-5]\d(?:\.\d+)?)$/);
  if (mmss) return parseInt(mmss[1], 10) * 60 + parseFloat(mmss[2]);
  return null;
}

function parseTotalDurationFromTimeEl(scope, fallback = 100) {
  const timeEl = scope?.querySelector?.('#time, .time');
  const text = timeEl?.textContent || '';
  const parts = text.split('/');
  if (parts.length >= 2) {
    const parsed = parseFilmTime(parts[parts.length - 1]);
    if (parsed && parsed > 0) return parsed;
  }
  return fallback;
}

function readFlexDuration(seg) {
  if (!seg) return null;
  const grow = seg.style?.flexGrow;
  if (grow !== undefined && grow !== '' && Number.isFinite(parseFloat(grow)) && parseFloat(grow) > 0) {
    return parseFloat(grow);
  }
  const flex = seg.style?.flex;
  if (flex !== undefined && flex !== '' && Number.isFinite(parseFloat(flex)) && parseFloat(flex) > 0) {
    return parseFloat(flex);
  }
  const rawStyle = seg.getAttribute?.('style') || '';
  const match = rawStyle.match(/\bflex(?:-grow)?\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (match) {
    const num = parseFloat(match[1]);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function readSegmentTitle(seg, index, override) {
  const fromOverride = override?.title ?? override?.name ?? override?.label;
  if (typeof fromOverride === 'string' && fromOverride.trim()) return fromOverride.trim();
  const ds = seg?.dataset || {};
  const fromData = ds.chapterTitle || ds.title || ds.label || seg?.getAttribute?.('data-chapter-title') ||
    seg?.getAttribute?.('data-title') || seg?.getAttribute?.('data-label');
  if (typeof fromData === 'string' && fromData.trim()) return fromData.trim();
  const spanText = seg?.querySelector?.('span')?.textContent?.trim();
  if (spanText) return spanText;
  const aria = seg?.getAttribute?.('aria-label') || '';
  if (aria.trim()) {
    const cleaned = aria.replace(/^(?:scene|chapter|shot)\s*\d+\s*[:·\-–—]\s*/i, '').trim();
    if (cleaned) return cleaned;
  }
  return DEFAULT_CHAPTERS[index]?.title || `Chapter ${index + 1}`;
}

function readSegmentShotNumber(seg, index, override) {
  if (Number.isFinite(override?.index) && override.index >= 1) return Math.floor(override.index);
  const ds = seg?.dataset || {};
  const raw = ds.shot ?? ds.index ?? ds.chapterIndex ??
    seg?.getAttribute?.('data-shot') ?? seg?.getAttribute?.('data-index');
  if (raw !== undefined && raw !== null && /^\d+$/.test(String(raw).trim())) {
    const n = parseInt(String(raw).trim(), 10);
    if (n >= 1) return n;
  }
  const aria = seg?.getAttribute?.('aria-label') || '';
  const m = aria.match(/\b(?:scene|chapter|shot)\s+(\d+)\b/i);
  if (m) return parseInt(m[1], 10);
  return index + 1;
}

function parseWindowAttribute(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.trim().split(/\s*[–—-]\s*/);
  if (parts.length !== 2) return null;
  const start = parseFilmTime(parts[0]);
  const end = parseFilmTime(parts[1]);
  if (start !== null && end !== null && end >= start) return { start, end };
  return null;
}

function parseChapterMetadata(segs, options = {}) {
  const list = Array.from(segs || []);
  if (!list.length) return [];
  const totalHint = Number.isFinite(options.totalDuration) && options.totalDuration > 0
    ? options.totalDuration
    : 100;
  const overrides = Array.isArray(options.chapters) ? options.chapters : [];

  const rawDurations = list.map((seg, i) => {
    const ov = overrides[i];
    const explicitDur = parseFilmTime(ov?.duration ?? ov?.dur ?? seg?.dataset?.duration ?? seg?.dataset?.dur ??
      seg?.getAttribute?.('data-duration') ?? seg?.getAttribute?.('data-dur'));
    if (explicitDur !== null && explicitDur > 0) return { dur: explicitDur, source: 'explicit' };
    const flexDur = readFlexDuration(seg);
    if (flexDur !== null && flexDur > 0) return { dur: flexDur, source: 'flex' };
    return { dur: null, source: 'none' };
  });

  const allUnitFlex = list.length > 1 && rawDurations.every(d => d.source === 'flex' && d.dur === 1) && totalHint > list.length;
  let cursor = 0;

  return list.map((seg, i) => {
    const ov = overrides[i];
    const shotNum = readSegmentShotNumber(seg, i, ov);
    const code = String(shotNum).padStart(2, '0');
    const title = readSegmentTitle(seg, i, ov);

    const ds = seg?.dataset || {};
    const windowAttr = parseWindowAttribute(ov?.window ?? ds.window ?? seg?.getAttribute?.('data-window'));
    const explicitStart = parseFilmTime(ov?.start ?? ds.start ?? seg?.getAttribute?.('data-start'));
    const explicitEnd = parseFilmTime(ov?.end ?? ds.end ?? seg?.getAttribute?.('data-end'));

    let start;
    let end;
    if (windowAttr) {
      start = windowAttr.start;
      end = windowAttr.end;
    } else if (explicitStart !== null && explicitEnd !== null && explicitEnd >= explicitStart) {
      start = explicitStart;
      end = explicitEnd;
    } else {
      start = explicitStart !== null ? explicitStart : cursor;
      let dur = rawDurations[i].dur;
      if (allUnitFlex) {
        dur = totalHint / list.length;
      } else if (dur === null) {
        const canonical = DEFAULT_CHAPTERS.find(c => c.title.toLowerCase() === title.toLowerCase());
        dur = canonical && list.length === DEFAULT_CHAPTERS.length ? canonical.duration : totalHint / list.length;
      }
      end = explicitEnd !== null && explicitEnd >= start ? explicitEnd : start + dur;
    }

    cursor = end;
    const duration = Math.max(0.001, end - start);
    const rangeLabel = `${formatFilmTime(start)}\u2013${formatFilmTime(end)}`;
    const pillLabel = `${code} \u00b7 ${title} \u00b7 ${rangeLabel}`;
    return { index: shotNum, code, title, start, end, duration, rangeLabel, pillLabel };
  });
}

function ensureFilmScrubberStyles(doc) {
  if (!doc || !doc.head || typeof doc.createElement !== 'function') return null;
  const existing = doc.querySelector?.('style[data-film-scrubber-styles]');
  if (existing) return existing;
  const links = doc.querySelectorAll ? Array.from(doc.querySelectorAll('link[rel="stylesheet"]')) : [];
  const hasFilmCss = links.some(link => {
    const href = link.getAttribute?.('href') || link.href || '';
    return /(?:^|\/)css\/film\.css(?:$|[?#])/.test(href);
  });
  if (hasFilmCss) return null;
  const style = doc.createElement('style');
  style.id = 'film-scrubber-styles';
  if (style.dataset) style.dataset.filmScrubberStyles = 'true';
  style.setAttribute?.('data-film-scrubber-styles', 'true');
  style.textContent = FILM_SCRUBBER_CSS;
  doc.head.appendChild(style);
  return style;
}

function readFillElement(seg) {
  return seg?.querySelector?.('i > b') || seg?.querySelector?.('b') || seg?.firstElementChild?.firstElementChild || null;
}

function readSegmentRawProgress(seg) {
  const fill = readFillElement(seg);
  const inlineWidth = fill?.style?.width;
  if (typeof inlineWidth === 'string' && inlineWidth.trim() !== '') {
    const num = parseFloat(inlineWidth);
    if (Number.isFinite(num)) return clamp(num / 100, 0, 1);
  }
  const attrStyle = fill?.getAttribute?.('style') || '';
  const match = attrStyle.match(/\bwidth\s*:\s*([0-9]+(?:\.[0-9]+)?)%/i);
  if (match) return clamp(parseFloat(match[1]) / 100, 0, 1);
  const dataProg = seg?.dataset?.progress ?? seg?.getAttribute?.('data-progress');
  if (dataProg !== undefined && dataProg !== null && Number.isFinite(parseFloat(dataProg))) {
    const val = parseFloat(dataProg);
    return clamp(val > 1 ? val / 100 : val, 0, 1);
  }
  return 0;
}

function getRect(el) {
  if (el && typeof el.getBoundingClientRect === 'function') {
    const r = el.getBoundingClientRect();
    if (r && Number.isFinite(r.left) && Number.isFinite(r.width)) {
      return {
        left: r.left,
        top: Number.isFinite(r.top) ? r.top : 0,
        width: r.width,
        height: Number.isFinite(r.height) ? r.height : 0,
        right: Number.isFinite(r.right) ? r.right : r.left + r.width,
        bottom: Number.isFinite(r.bottom) ? r.bottom : (Number.isFinite(r.top) ? r.top : 0) + (Number.isFinite(r.height) ? r.height : 0),
      };
    }
  }
  return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
}

function setCssVar(el, name, value) {
  if (!el?.style) return;
  if (typeof el.style.setProperty === 'function') el.style.setProperty(name, value);
  else el.style[name] = value;
}

function removeCssVar(el, name) {
  if (!el?.style) return;
  if (typeof el.style.removeProperty === 'function') el.style.removeProperty(name);
  else delete el.style[name];
}

function findBarElement(scope) {
  if (!scope) return null;
  const isBar = el => Boolean(el && (el.id === 'bar' || (el.classList?.contains?.('bar') && String(el.tagName || '').toLowerCase() !== 'header')));
  if (isBar(scope)) return scope;
  const byId = scope.querySelector?.('#bar');
  if (byId) return byId;
  const bars = scope.querySelectorAll ? Array.from(scope.querySelectorAll('.bar')) : [];
  return bars.find(isBar) || null;
}

function findFilmScope(root) {
  if (!root) return null;
  if (root.nodeType === 1) {
    if (root.id === 'film' || root.classList?.contains?.('wrap') || root.id === 'bar' || root.id === 'filmPoster') {
      return root;
    }
  }
  return root.querySelector?.('#film') || root.querySelector?.('.wrap') || root;
}

function findPosterElement(root, scope) {
  if (root?.nodeType === 1 && (root.id === 'filmPoster' || root.classList?.contains?.('film-poster'))) return root;
  return scope?.querySelector?.('#filmPoster, .film-poster') || root?.querySelector?.('#filmPoster, .film-poster') || null;
}

function initFilmScrubber(root = globalThis.document, options = {}) {
  if (!root) return null;
  if (activeControllers.has(root)) {
    const existing = activeControllers.get(root);
    existing.refresh();
    return existing;
  }

  const doc = root.nodeType === 9 ? root : root.ownerDocument || globalThis.document;
  const win = doc?.defaultView || globalThis;
  const scope = findFilmScope(root);
  if (options.injectStyles !== false && doc) ensureFilmScrubberStyles(doc);

  const mediaQuery = typeof options.reducedMotion === 'boolean'
    ? null
    : win?.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
  let reducedMotion = typeof options.reducedMotion === 'boolean'
    ? options.reducedMotion
    : Boolean(mediaQuery?.matches);

  const requestFrame = options.requestFrame ||
    (typeof win?.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null);
  const cancelFrame = options.cancelFrame ||
    (typeof win?.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null);
  const nowFn = options.now || (() => (win?.performance?.now ? win.performance.now() : Date.now()));
  const Observer = options.MutationObserver || win?.MutationObserver || globalThis.MutationObserver || null;

  const cleanups = [];
  const on = (target, type, handler, opts) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, opts);
    cleanups.push(() => target.removeEventListener?.(type, handler, opts));
  };

  let bar = findBarElement(scope) || findBarElement(root);
  let poster = findPosterElement(root, scope);
  let tooltip = null;
  let ghost = null;
  let ghostTimeEl = null;
  let chapters = [];
  let boundSegs = [];
  const segStates = new Map();
  const segCleanups = new Map();
  let activeCurIndex = -1;
  let hoveredSeg = null;
  let focusedSeg = null;
  let pointerInsideBar = false;
  let pulseTimer = null;

  // Spring state for tooltip & playhead
  let rafId = null;
  let lastFrameTime = null;
  const tipSpring = { current: 0, target: 0, velocity: 0, initialized: false };

  function applyReducedMotionState() {
    if (bar) {
      if (bar.dataset) bar.dataset.reducedMotion = String(reducedMotion);
      bar.setAttribute?.('data-reduced-motion', String(reducedMotion));
    }
    if (reducedMotion) {
      stopAnimationLoop();
      if (tooltip) {
        if (tooltip.dataset) delete tooltip.dataset.spring;
        tooltip.removeAttribute?.('data-spring');
        tipSpring.current = tipSpring.target;
        tipSpring.velocity = 0;
        setCssVar(tooltip, '--tooltip-x', `${tipSpring.target.toFixed(1)}px`);
      }
      boundSegs.forEach(seg => {
        seg.classList?.remove?.('is-pulsing');
        if (seg.dataset) delete seg.dataset.pulse;
        seg.removeAttribute?.('data-pulse');
        const st = segStates.get(seg);
        if (st) {
          st.current = st.target;
          st.velocity = 0;
          setCssVar(seg, '--seg-progress', st.target.toFixed(4));
        }
      });
      resetPosterTransforms();
    }
  }

  function stopAnimationLoop() {
    if (rafId !== null && cancelFrame) cancelFrame(rafId);
    rafId = null;
    lastFrameTime = null;
  }

  const isTipSettled = () =>
    Math.abs(tipSpring.target - tipSpring.current) <= 0.35 && Math.abs(tipSpring.velocity) <= 8;
  const isSegSettled = st =>
    Math.abs(st.target - st.current) <= 0.001 && Math.abs(st.velocity) <= 0.01;

  function needsAnimationTick() {
    if (reducedMotion) return false;
    if (tooltip && tooltip.getAttribute?.('data-visible') === 'true' && tipSpring.initialized && !isTipSettled()) {
      return true;
    }
    for (const st of segStates.values()) {
      if (!isSegSettled(st)) return true;
    }
    return false;
  }

  function scheduleAnimationTick() {
    if (reducedMotion || rafId !== null || !requestFrame) return;
    if (!needsAnimationTick()) return;
    lastFrameTime = nowFn();
    rafId = requestFrame(frameTime => {
      rafId = null;
      const now = Number.isFinite(frameTime) ? frameTime : nowFn();
      const dtMs = lastFrameTime !== null ? Math.max(1, now - lastFrameTime) : 16.67;
      lastFrameTime = now;
      step(dtMs);
      if (needsAnimationTick()) scheduleAnimationTick();
    });
  }

  function step(dtMs = 16.67) {
    if (reducedMotion) {
      syncPlayhead(true);
      if (tooltip) {
        tipSpring.current = tipSpring.target;
        tipSpring.velocity = 0;
        setCssVar(tooltip, '--tooltip-x', `${tipSpring.current.toFixed(1)}px`);
      }
      return false;
    }

    const totalSec = clamp(dtMs / 1000, 0.001, 0.1);
    const substeps = Math.max(1, Math.ceil(totalSec / 0.016));
    const dt = totalSec / substeps;

    // 1. Tooltip horizontal spring (critically damped: k=320, c=35.8)
    if (tooltip && tipSpring.initialized) {
      for (let k = 0; k < substeps; k++) {
        const force = (tipSpring.target - tipSpring.current) * 320 - tipSpring.velocity * 35.8;
        tipSpring.velocity += force * dt;
        tipSpring.current += tipSpring.velocity * dt;
      }
      if (isTipSettled()) {
        tipSpring.current = tipSpring.target;
        tipSpring.velocity = 0;
      }
      if (tooltip.dataset) tooltip.dataset.spring = 'js';
      tooltip.setAttribute?.('data-spring', 'js');
      setCssVar(tooltip, '--tooltip-x', `${tipSpring.current.toFixed(1)}px`);
    }

    // 2. Playhead bar spring interpolation (critically damped: k=300, c=34.6)
    for (const [seg, st] of segStates.entries()) {
      if (isSegSettled(st)) {
        if (st.current !== st.target || st.velocity !== 0) {
          st.current = st.target;
          st.velocity = 0;
          setCssVar(seg, '--seg-progress', st.current.toFixed(4));
        }
        continue;
      }
      for (let k = 0; k < substeps; k++) {
        const force = (st.target - st.current) * 300 - st.velocity * 34.6;
        st.velocity += force * dt;
        st.current = clamp(st.current + st.velocity * dt, 0, 1);
      }
      if (isSegSettled(st)) {
        st.current = st.target;
        st.velocity = 0;
      }
      setCssVar(seg, '--seg-progress', st.current.toFixed(4));
    }

    return needsAnimationTick();
  }

  function ensureOverlays() {
    if (!bar || !doc?.createElement) return;
    bar.classList?.add?.('film-scrubber-bar', 'film-scrubber-ready');
    if (bar.dataset) {
      bar.dataset.scrubberReady = 'true';
      bar.dataset.reducedMotion = String(reducedMotion);
    }
    bar.setAttribute?.('data-scrubber-ready', 'true');
    bar.setAttribute?.('data-reduced-motion', String(reducedMotion));

    if (!tooltip) {
      tooltip = bar.querySelector?.('.film-chapter-tooltip');
      if (!tooltip) {
        tooltip = doc.createElement('div');
        tooltip.className = 'film-chapter-tooltip';
        tooltipUid += 1;
        tooltip.id = `film-chapter-tooltip-${tooltipUid}`;
        tooltip.setAttribute?.('role', 'tooltip');
        tooltip.setAttribute?.('aria-hidden', 'true');
        tooltip.setAttribute?.('data-visible', 'false');
        if (tooltip.dataset) tooltip.dataset.visible = 'false';

        const idxSpan = doc.createElement('span');
        idxSpan.className = 'film-chapter-idx';
        const sep1 = doc.createElement('span');
        sep1.className = 'film-chapter-sep';
        sep1.setAttribute?.('aria-hidden', 'true');
        sep1.textContent = ' \u00b7 ';
        const titleSpan = doc.createElement('span');
        titleSpan.className = 'film-chapter-title';
        const sep2 = doc.createElement('span');
        sep2.className = 'film-chapter-sep';
        sep2.setAttribute?.('aria-hidden', 'true');
        sep2.textContent = ' \u00b7 ';
        const rangeSpan = doc.createElement('span');
        rangeSpan.className = 'film-chapter-range';

        tooltip.appendChild(idxSpan);
        tooltip.appendChild(sep1);
        tooltip.appendChild(titleSpan);
        tooltip.appendChild(sep2);
        tooltip.appendChild(rangeSpan);
        bar.appendChild(tooltip);
      }
    }

    if (!ghost) {
      ghost = bar.querySelector?.('.film-scrub-ghost');
      if (!ghost) {
        ghost = doc.createElement('div');
        ghost.className = 'film-scrub-ghost';
        ghost.setAttribute?.('aria-hidden', 'true');
        ghost.setAttribute?.('data-visible', 'false');
        if (ghost.dataset) ghost.dataset.visible = 'false';

        ghostTimeEl = doc.createElement('span');
        ghostTimeEl.className = 'film-scrub-ghost-time';
        ghostTimeEl.textContent = '0:00';
        const lineEl = doc.createElement('i');
        lineEl.className = 'film-scrub-ghost-line';

        ghost.appendChild(ghostTimeEl);
        ghost.appendChild(lineEl);
        bar.appendChild(ghost);
      } else {
        ghostTimeEl = ghost.querySelector?.('.film-scrub-ghost-time') || null;
      }
    }
  }

  function renderTooltipContent(chapter, seg) {
    if (!tooltip || !chapter) return;
    const idxEl = tooltip.querySelector?.('.film-chapter-idx');
    const titleEl = tooltip.querySelector?.('.film-chapter-title');
    const rangeEl = tooltip.querySelector?.('.film-chapter-range');
    if (idxEl && titleEl && rangeEl) {
      idxEl.textContent = chapter.code;
      titleEl.textContent = chapter.title;
      rangeEl.textContent = chapter.rangeLabel;
    } else {
      tooltip.textContent = chapter.pillLabel;
    }
    if (tooltip.dataset) {
      tooltip.dataset.chapter = chapter.code;
      tooltip.dataset.range = chapter.rangeLabel;
    }
    tooltip.setAttribute?.('data-chapter', chapter.code);
    tooltip.setAttribute?.('data-range', chapter.rangeLabel);
    boundSegs.forEach(s => {
      if (s === seg) s.setAttribute?.('aria-describedby', tooltip.id);
      else if (s.getAttribute?.('aria-describedby') === tooltip.id) s.removeAttribute?.('aria-describedby');
    });
  }

  function positionTooltipAt(anchorX, barWidth, immediate = false) {
    if (!tooltip) return;
    const tipRect = getRect(tooltip);
    const tipWidth = Number.isFinite(tooltip.offsetWidth) && tooltip.offsetWidth > 0
      ? tooltip.offsetWidth
      : tipRect.width;

    let targetX = anchorX;
    if (barWidth > 0 && tipWidth > 0) {
      targetX = clamp(anchorX - tipWidth / 2, 0, Math.max(0, barWidth - tipWidth));
      setCssVar(tooltip, '--tooltip-shift', '0%');
    } else {
      targetX = barWidth > 0 ? clamp(anchorX, 0, barWidth) : Math.max(0, anchorX);
      setCssVar(tooltip, '--tooltip-shift', '-50%');
    }

    const wasVisible = tooltip.getAttribute?.('data-visible') === 'true';
    tipSpring.target = targetX;
    if (immediate || reducedMotion || !wasVisible || !tipSpring.initialized || !requestFrame) {
      tipSpring.current = targetX;
      tipSpring.velocity = 0;
      tipSpring.initialized = true;
      setCssVar(tooltip, '--tooltip-x', `${targetX.toFixed(1)}px`);
    } else {
      scheduleAnimationTick();
    }
  }

  function setTooltipVisible(visible, mode = 'hover') {
    if (!tooltip) return;
    const v = visible ? 'true' : 'false';
    if (tooltip.dataset) {
      tooltip.dataset.visible = v;
      tooltip.dataset.mode = mode;
    }
    tooltip.setAttribute?.('data-visible', v);
    tooltip.setAttribute?.('data-mode', mode);
    tooltip.setAttribute?.('aria-hidden', visible ? 'false' : 'true');
    if (!visible) {
      tipSpring.initialized = false;
      boundSegs.forEach(s => {
        if (s.getAttribute?.('aria-describedby') === tooltip.id) s.removeAttribute?.('aria-describedby');
      });
    }
  }

  function setGhostState(visible, scrubX = 0, barWidth = 0, timestamp = '0:00') {
    if (!ghost) return;
    const v = visible ? 'true' : 'false';
    if (ghost.dataset) {
      ghost.dataset.visible = v;
      if (visible) ghost.dataset.timestamp = timestamp;
    }
    ghost.setAttribute?.('data-visible', v);
    if (visible) {
      ghost.setAttribute?.('data-timestamp', timestamp);
      if (ghostTimeEl) ghostTimeEl.textContent = timestamp;
      setCssVar(ghost, '--scrub-x', `${scrubX.toFixed(1)}px`);
      let shift = '-50%';
      if (barWidth > 0) {
        if (scrubX < 22) shift = '0%';
        else if (scrubX > barWidth - 22) shift = '-100%';
      }
      setCssVar(ghost, '--scrub-badge-shift', shift);
    }
  }

  function clearHoveredSegment() {
    boundSegs.forEach(seg => {
      if (seg.dataset) delete seg.dataset.hovered;
      seg.removeAttribute?.('data-hovered');
      removeCssVar(seg, '--seg-hover-p');
    });
    hoveredSeg = null;
  }

  function markHoveredSegment(seg, ratio) {
    boundSegs.forEach(s => {
      if (s === seg) {
        if (s.dataset) s.dataset.hovered = 'true';
        s.setAttribute?.('data-hovered', 'true');
        setCssVar(s, '--seg-hover-p', clamp(ratio, 0, 1).toFixed(4));
      } else {
        if (s.dataset) delete s.dataset.hovered;
        s.removeAttribute?.('data-hovered');
        removeCssVar(s, '--seg-hover-p');
      }
    });
    hoveredSeg = seg;
  }

  function resolveHoverTarget(clientX, explicitSeg) {
    if (!boundSegs.length || !chapters.length) return null;
    const barRect = getRect(bar);
    const totalDur = chapters[chapters.length - 1].end;

    // 1. Check if individual segments have layout rects
    const segRects = boundSegs.map(s => getRect(s));
    const hasSegLayout = segRects.some(r => r.width > 0);

    if (Number.isFinite(clientX) && hasSegLayout) {
      let chosenIdx = explicitSeg ? boundSegs.indexOf(explicitSeg) : -1;
      if (chosenIdx < 0) {
        chosenIdx = segRects.findIndex(r => clientX >= r.left && clientX <= r.right);
      }
      if (chosenIdx < 0) {
        let bestDist = Infinity;
        segRects.forEach((r, idx) => {
          const dist = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
          if (dist < bestDist) { bestDist = dist; chosenIdx = idx; }
        });
      }
      chosenIdx = clamp(chosenIdx, 0, boundSegs.length - 1);
      const r = segRects[chosenIdx];
      const ch = chapters[chosenIdx];
      const localRatio = r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
      const hoverSeconds = ch.start + localRatio * ch.duration;
      const barWidth = barRect.width > 0 ? barRect.width : Math.max(0, segRects[segRects.length - 1].right - segRects[0].left);
      const originLeft = barRect.width > 0 ? barRect.left : segRects[0].left;
      const scrubX = clamp(clientX - originLeft, 0, barWidth || Infinity);
      return { seg: boundSegs[chosenIdx], index: chosenIdx, chapter: ch, localRatio, hoverSeconds, scrubX, barWidth };
    }

    // 2. Bar has width, individual segments have 0-width rects (e.g. unit test mock on bar)
    if (Number.isFinite(clientX) && barRect.width > 0) {
      const barRatio = clamp((clientX - barRect.left) / barRect.width, 0, 1);
      const hoverSeconds = barRatio * totalDur;
      let chosenIdx = chapters.findIndex((ch, i) => hoverSeconds <= ch.end || i === chapters.length - 1);
      if (explicitSeg && boundSegs.includes(explicitSeg)) {
        const expIdx = boundSegs.indexOf(explicitSeg);
        if (hoverSeconds >= chapters[expIdx].start && hoverSeconds <= chapters[expIdx].end) chosenIdx = expIdx;
      }
      chosenIdx = clamp(chosenIdx, 0, boundSegs.length - 1);
      const ch = chapters[chosenIdx];
      const localRatio = clamp((hoverSeconds - ch.start) / ch.duration, 0, 1);
      const scrubX = barRatio * barRect.width;
      return { seg: boundSegs[chosenIdx], index: chosenIdx, chapter: ch, localRatio, hoverSeconds, scrubX, barWidth: barRect.width };
    }

    // 3. Synthetic hover event without geometry
    const fallbackIdx = clamp(explicitSeg ? boundSegs.indexOf(explicitSeg) : 0, 0, boundSegs.length - 1);
    const ch = chapters[fallbackIdx];
    return { seg: boundSegs[fallbackIdx], index: fallbackIdx, chapter: ch, localRatio: 0, hoverSeconds: ch.start, scrubX: 0, barWidth: barRect.width };
  }

  function findContainingSeg(target) {
    let node = target;
    while (node) {
      if (boundSegs.includes(node)) return node;
      node = node.parentNode || node.parentElement || null;
    }
    return target?.closest?.('.seg') || null;
  }

  function handlePointerScrub(event, explicitSeg = null) {
    if (!bar || !boundSegs.length) return;
    if (event && typeof event === 'object') {
      if (event.__filmScrubHandled) return;
      event.__filmScrubHandled = true;
    }
    pointerInsideBar = true;
    const targetFromEvent = findContainingSeg(event?.target) || explicitSeg;
    const clientX = Number.isFinite(event?.clientX) ? event.clientX : NaN;
    const resolved = resolveHoverTarget(clientX, targetFromEvent);
    if (!resolved) return;

    markHoveredSegment(resolved.seg, resolved.localRatio);
    renderTooltipContent(resolved.chapter, resolved.seg);
    positionTooltipAt(resolved.scrubX, resolved.barWidth, false);
    setTooltipVisible(true, 'hover');
    setGhostState(true, resolved.scrubX, resolved.barWidth, formatFilmTime(resolved.hoverSeconds));
  }

  function showKeyboardFocusPreview(seg) {
    const idx = boundSegs.indexOf(seg);
    if (idx < 0 || !chapters[idx]) return;
    focusedSeg = seg;
    const ch = chapters[idx];
    const barRect = getRect(bar);
    const segRect = getRect(seg);
    let anchorX = 0;
    if (segRect.width > 0) {
      anchorX = (segRect.left - barRect.left) + segRect.width / 2;
    } else if (barRect.width > 0 && chapters[chapters.length - 1].end > 0) {
      const midTime = (ch.start + ch.end) / 2;
      anchorX = (midTime / chapters[chapters.length - 1].end) * barRect.width;
    }
    renderTooltipContent(ch, seg);
    positionTooltipAt(anchorX, barRect.width, false);
    if (!pointerInsideBar) {
      setGhostState(false);
      setTooltipVisible(true, 'focus');
    } else {
      setTooltipVisible(true, 'hover');
    }
  }

  function handleBarPointerLeave() {
    pointerInsideBar = false;
    clearHoveredSegment();
    setGhostState(false);
    const activeEl = doc?.activeElement;
    if (activeEl && boundSegs.includes(activeEl)) {
      showKeyboardFocusPreview(activeEl);
    } else {
      setTooltipVisible(false);
    }
  }

  function triggerSegmentPulse(seg) {
    if (!seg) return;
    boundSegs.forEach(s => {
      const isCur = s === seg;
      if (isCur) s.setAttribute?.('aria-current', 'step');
      else s.removeAttribute?.('aria-current');
      if (!isCur) {
        s.classList?.remove?.('is-pulsing');
        if (s.dataset) delete s.dataset.pulse;
        s.removeAttribute?.('data-pulse');
      }
    });
    if (reducedMotion) return;
    seg.classList?.remove?.('is-pulsing');
    seg.classList?.add?.('is-pulsing');
    if (seg.dataset) seg.dataset.pulse = 'true';
    seg.setAttribute?.('data-pulse', 'true');
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      seg.classList?.remove?.('is-pulsing');
      if (seg.dataset) delete seg.dataset.pulse;
      seg.removeAttribute?.('data-pulse');
    }, 460);
    if (typeof pulseTimer?.unref === 'function') pulseTimer.unref();
  }

  function syncActiveCurSegment(allowPulse = true) {
    const newCurIndex = boundSegs.findIndex(s => s.classList?.contains?.('cur'));
    if (newCurIndex < 0) return;
    const changed = newCurIndex !== activeCurIndex && (activeCurIndex !== -1 || newCurIndex > 0);
    activeCurIndex = newCurIndex;
    boundSegs.forEach((s, idx) => {
      if (idx === newCurIndex) s.setAttribute?.('aria-current', 'step');
      else s.removeAttribute?.('aria-current');
    });
    if (changed && allowPulse) {
      triggerSegmentPulse(boundSegs[newCurIndex]);
    }
  }

  function syncPlayhead(immediate = false) {
    boundSegs.forEach(seg => {
      const target = readSegmentRawProgress(seg);
      let st = segStates.get(seg);
      if (!st) {
        st = { current: target, target, velocity: 0 };
        segStates.set(seg, st);
        setCssVar(seg, '--seg-progress', target.toFixed(4));
        return;
      }
      st.target = target;
      if (immediate || reducedMotion || !requestFrame) {
        st.current = target;
        st.velocity = 0;
        setCssVar(seg, '--seg-progress', target.toFixed(4));
      }
    });
    if (!immediate && !reducedMotion) scheduleAnimationTick();
  }

  let fillStyleObserver = null;
  let segClassObserver = null;
  let barChildObserver = null;

  function disconnectSegmentObservers() {
    fillStyleObserver?.disconnect?.();
    segClassObserver?.disconnect?.();
    fillStyleObserver = null;
    segClassObserver = null;
  }

  function bindSegments() {
    if (!bar) bar = findBarElement(scope) || findBarElement(root);
    if (!bar) return;
    ensureOverlays();

    const currentSegs = bar.querySelectorAll ? Array.from(bar.querySelectorAll('.seg')) : [];
    const totalDuration = Number.isFinite(options.totalDuration) && options.totalDuration > 0
      ? options.totalDuration
      : parseTotalDurationFromTimeEl(scope || root, 100);
    chapters = parseChapterMetadata(currentSegs, { ...options, totalDuration });

    // Remove listeners for segments no longer in bar
    for (const [oldSeg, dispose] of segCleanups.entries()) {
      if (!currentSegs.includes(oldSeg)) {
        dispose();
        segCleanups.delete(oldSeg);
        segStates.delete(oldSeg);
      }
    }

    boundSegs = currentSegs;
    currentSegs.forEach((seg, idx) => {
      const ch = chapters[idx];
      if (ch) {
        if (seg.dataset) {
          seg.dataset.chapterCode = ch.code;
          seg.dataset.chapterRange = ch.rangeLabel;
        }
        seg.setAttribute?.('data-chapter-code', ch.code);
        seg.setAttribute?.('data-chapter-range', ch.rangeLabel);
      }

      if (!segStates.has(seg)) {
        const initial = readSegmentRawProgress(seg);
        segStates.set(seg, { current: initial, target: initial, velocity: 0 });
        setCssVar(seg, '--seg-progress', initial.toFixed(4));
      }

      if (!segCleanups.has(seg)) {
        const localCleanups = [];
        const bind = (type, fn) => {
          if (!seg.addEventListener) return;
          seg.addEventListener(type, fn);
          localCleanups.push(() => seg.removeEventListener?.(type, fn));
        };
        bind('pointerenter', e => handlePointerScrub(e, seg));
        bind('pointermove', e => handlePointerScrub(e, seg));
        bind('mousemove', e => handlePointerScrub(e, seg));
        bind('mouseenter', e => handlePointerScrub(e, seg));
        bind('focus', () => showKeyboardFocusPreview(seg));
        bind('blur', e => {
          const nextFocus = e?.relatedTarget;
          if (focusedSeg === seg) focusedSeg = null;
          if (!pointerInsideBar && (!nextFocus || !boundSegs.includes(nextFocus))) {
            setTooltipVisible(false);
          }
        });
        bind('click', () => triggerSegmentPulse(seg));
        bind('animationend', () => {
          seg.classList?.remove?.('is-pulsing');
          if (seg.dataset) delete seg.dataset.pulse;
          seg.removeAttribute?.('data-pulse');
        });
        segCleanups.set(seg, () => localCleanups.forEach(fn => fn()));
      }
    });

    syncActiveCurSegment(false);
    syncPlayhead(true);

    disconnectSegmentObservers();
    if (Observer && boundSegs.length) {
      fillStyleObserver = new Observer(() => syncPlayhead(false));
      segClassObserver = new Observer(() => {
        syncActiveCurSegment(true);
        syncPlayhead(false);
      });
      boundSegs.forEach(seg => {
        const fill = readFillElement(seg);
        if (fill) fillStyleObserver.observe(fill, { attributes: true, attributeFilter: ['style'] });
        segClassObserver.observe(seg, { attributes: true, attributeFilter: ['class'] });
      });
    }
  }

  // Bind bar-level listeners once
  let barBound = false;
  function bindBarContainer() {
    if (!bar || barBound) return;
    barBound = true;
    on(bar, 'pointermove', e => handlePointerScrub(e));
    on(bar, 'mousemove', e => handlePointerScrub(e));
    on(bar, 'pointerleave', handleBarPointerLeave);
    on(bar, 'mouseleave', handleBarPointerLeave);
    on(bar, 'keydown', e => {
      if (e?.key === 'Escape') {
        setTooltipVisible(false);
        setGhostState(false);
      }
    });
    if (Observer) {
      barChildObserver = new Observer(mutations => {
        const hasSegMutation = mutations.some(m => {
          const added = Array.from(m.addedNodes || []);
          const removed = Array.from(m.removedNodes || []);
          return [...added, ...removed].some(n => n?.classList?.contains?.('seg'));
        });
        if (hasSegMutation || boundSegs.length === 0) bindSegments();
      });
      barChildObserver.observe(bar, { childList: true });
    }
  }

  // #filmPoster subtle magnetic / parallax tilt & cursor spotlight glow before launch
  let posterBound = false;
  function resetPosterTransforms() {
    if (!poster) return;
    setCssVar(poster, '--poster-rx', '0deg');
    setCssVar(poster, '--poster-ry', '0deg');
    setCssVar(poster, '--poster-scale', '1');
    setCssVar(poster, '--poster-img-x', '0px');
    setCssVar(poster, '--poster-img-y', '0px');
    setCssVar(poster, '--launch-mx', '0px');
    setCssVar(poster, '--launch-my', '0px');
    setCssVar(poster, '--poster-glow-opacity', '0');
  }

  function handlePosterMove(event) {
    if (!poster) return;
    const rect = getRect(poster);
    const width = rect.width > 0 ? rect.width : 1280;
    const height = rect.height > 0 ? rect.height : 720;
    const clientX = Number.isFinite(event?.clientX) ? event.clientX : rect.left + width / 2;
    const clientY = Number.isFinite(event?.clientY) ? event.clientY : rect.top + height / 2;

    const px = clamp((clientX - rect.left) / width, 0, 1);
    const py = clamp((clientY - rect.top) / height, 0, 1);
    setCssVar(poster, '--poster-glow-x', `${(px * 100).toFixed(1)}%`);
    setCssVar(poster, '--poster-glow-y', `${(py * 100).toFixed(1)}%`);
    setCssVar(poster, '--poster-glow-opacity', '1');

    if (reducedMotion) {
      setCssVar(poster, '--poster-rx', '0deg');
      setCssVar(poster, '--poster-ry', '0deg');
      setCssVar(poster, '--poster-scale', '1');
      setCssVar(poster, '--poster-img-x', '0px');
      setCssVar(poster, '--poster-img-y', '0px');
      setCssVar(poster, '--launch-mx', '0px');
      setCssVar(poster, '--launch-my', '0px');
      return;
    }

    const nx = px - 0.5;
    const ny = py - 0.5;
    setCssVar(poster, '--poster-rx', `${(-ny * 4.5).toFixed(2)}deg`);
    setCssVar(poster, '--poster-ry', `${(nx * 4.5).toFixed(2)}deg`);
    setCssVar(poster, '--poster-scale', '1.012');
    setCssVar(poster, '--poster-img-x', `${(-nx * 12).toFixed(2)}px`);
    setCssVar(poster, '--poster-img-y', `${(-ny * 8).toFixed(2)}px`);

    const launchEl = poster.querySelector?.('#filmLaunch, a, button');
    const launchRect = launchEl ? getRect(launchEl) : { left: 0, top: 0, width: 0, height: 0 };
    if (launchRect.width > 0 && launchRect.height > 0) {
      const cx = launchRect.left + launchRect.width / 2;
      const cy = launchRect.top + launchRect.height / 2;
      const dx = (clientX - cx) / Math.max(width * 0.45, 1);
      const dy = (clientY - cy) / Math.max(height * 0.45, 1);
      setCssVar(poster, '--launch-mx', `${clamp(dx * 8, -7, 7).toFixed(2)}px`);
      setCssVar(poster, '--launch-my', `${clamp(dy * 6, -5, 5).toFixed(2)}px`);
    } else {
      setCssVar(poster, '--launch-mx', `${(nx * 12).toFixed(2)}px`);
      setCssVar(poster, '--launch-my', `${(ny * 8).toFixed(2)}px`);
    }
  }

  function bindPoster() {
    if (!poster) poster = findPosterElement(root, scope);
    if (!poster || posterBound) return;
    posterBound = true;
    poster.classList?.add?.('film-poster-interactive');
    if (poster.dataset) poster.dataset.posterInteractive = 'true';
    poster.setAttribute?.('data-poster-interactive', 'true');
    resetPosterTransforms();

    on(poster, 'pointerenter', handlePosterMove);
    on(poster, 'pointermove', handlePosterMove);
    on(poster, 'mousemove', handlePosterMove);
    on(poster, 'pointerleave', resetPosterTransforms);
    on(poster, 'mouseleave', resetPosterTransforms);
    on(poster, 'focusin', () => {
      setCssVar(poster, '--poster-glow-x', '50.0%');
      setCssVar(poster, '--poster-glow-y', '50.0%');
      setCssVar(poster, '--poster-glow-opacity', '1');
    });
    on(poster, 'focusout', resetPosterTransforms);
    const launchEl = poster.querySelector?.('#filmLaunch, a, button');
    if (launchEl) on(launchEl, 'click', resetPosterTransforms);
  }

  if (mediaQuery?.addEventListener) {
    const onMotionChange = e => {
      reducedMotion = Boolean(e?.matches);
      applyReducedMotionState();
    };
    mediaQuery.addEventListener('change', onMotionChange);
    cleanups.push(() => mediaQuery.removeEventListener?.('change', onMotionChange));
  }

  bindBarContainer();
  bindSegments();
  bindPoster();

  const controller = {
    get bar() { return bar; },
    get poster() { return poster; },
    get tooltip() { return tooltip; },
    get ghost() { return ghost; },
    getChapters: () => chapters.map(ch => ({ ...ch })),
    isReducedMotion: () => reducedMotion,
    refresh() {
      bindBarContainer();
      bindSegments();
      bindPoster();
      return controller;
    },
    syncPlayhead(immediate = false) {
      syncPlayhead(immediate);
      return controller;
    },
    step,
    destroy() {
      stopAnimationLoop();
      if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null; }
      disconnectSegmentObservers();
      barChildObserver?.disconnect?.();
      barChildObserver = null;
      for (const dispose of segCleanups.values()) dispose();
      segCleanups.clear();
      segStates.clear();
      cleanups.splice(0).forEach(fn => fn());
      boundSegs.forEach(seg => {
        seg.classList?.remove?.('is-pulsing');
        if (seg.dataset) {
          delete seg.dataset.hovered;
          delete seg.dataset.pulse;
          delete seg.dataset.chapterCode;
          delete seg.dataset.chapterRange;
        }
        seg.removeAttribute?.('data-hovered');
        seg.removeAttribute?.('data-pulse');
        seg.removeAttribute?.('data-chapter-code');
        seg.removeAttribute?.('data-chapter-range');
        seg.removeAttribute?.('aria-current');
        if (tooltip && seg.getAttribute?.('aria-describedby') === tooltip.id) {
          seg.removeAttribute?.('aria-describedby');
        }
        removeCssVar(seg, '--seg-progress');
        removeCssVar(seg, '--seg-hover-p');
      });
      tooltip?.remove?.();
      ghost?.remove?.();
      tooltip = null;
      ghost = null;
      ghostTimeEl = null;
      if (bar) {
        bar.classList?.remove?.('film-scrubber-bar', 'film-scrubber-ready');
        if (bar.dataset) {
          delete bar.dataset.scrubberReady;
          delete bar.dataset.reducedMotion;
        }
        bar.removeAttribute?.('data-scrubber-ready');
        bar.removeAttribute?.('data-reduced-motion');
      }
      if (poster) {
        resetPosterTransforms();
        poster.classList?.remove?.('film-poster-interactive');
        if (poster.dataset) delete poster.dataset.posterInteractive;
        poster.removeAttribute?.('data-poster-interactive');
      }
      activeControllers.delete(root);
    },
  };

  activeControllers.set(root, controller);
  return controller;
}

if (typeof module === 'object' && module && module.exports) {
  module.exports = {
    initFilmScrubber,
    FILM_SCRUBBER_CSS,
    DEFAULT_CHAPTERS,
    ensureFilmScrubberStyles,
    formatFilmTime,
    parseFilmTime,
    parseChapterMetadata,
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.initFilmScrubber = initFilmScrubber;
  globalThis.SkySentryFilmScrubber = {
    initFilmScrubber,
    FILM_SCRUBBER_CSS,
    DEFAULT_CHAPTERS,
    ensureFilmScrubberStyles,
    formatFilmTime,
    parseFilmTime,
    parseChapterMetadata,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__FILM_SCRUBBER_NO_AUTO_INIT__) {
  const autoStart = () => {
    if (document.querySelector('#film, #bar, .wrap .bar, #filmPoster')) {
      initFilmScrubber(document);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  } else {
    autoStart();
  }
}
