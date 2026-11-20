// Alert & incident enrichment motion choreography for SkySentry Tower.
// Pure ES module compatible with real browsers, jsdom, and lightweight mock DOM nodes.

export const ROW_ENTER_MS = 240;
export const ROW_REPLAY_MS = 160;
export const ROW_DISMISS_MS = 180;
export const ROW_DISMISS_FALLBACK_MS = 220;

const TRANSIENT_ROW_CLASSES = ['sky-row-enter', 'sky-row-replay', 'sky-row-exit'];
const activeEnterCleanups = new WeakMap();
const activeDismissals = new WeakMap();
const previousSnapshots = new WeakMap();

function detectReducedMotion() {
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    return false;
  }
}

function splitClasses(value) {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function addClass(el, ...names) {
  if (!el) return;
  const clean = names.filter(Boolean);
  if (!clean.length) return;
  if (el.classList && typeof el.classList.add === 'function') {
    el.classList.add(...clean);
    return;
  }
  const set = new Set(splitClasses(el.className));
  for (const name of clean) set.add(name);
  el.className = [...set].join(' ');
}

function removeClass(el, ...names) {
  if (!el) return;
  const clean = names.filter(Boolean);
  if (!clean.length) return;
  if (el.classList && typeof el.classList.remove === 'function') {
    el.classList.remove(...clean);
    return;
  }
  const set = new Set(splitClasses(el.className));
  for (const name of clean) set.delete(name);
  el.className = [...set].join(' ');
}

function setData(el, key, value) {
  if (!el) return;
  const attr = `data-${key.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}`;
  if (value === null || value === undefined) {
    if (el.dataset) delete el.dataset[key];
    if (typeof el.removeAttribute === 'function') el.removeAttribute(attr);
    return;
  }
  const str = String(value);
  if (el.dataset) el.dataset[key] = str;
  if (typeof el.setAttribute === 'function') el.setAttribute(attr, str);
}

function createBadgeElement(containerEl, tag = 'span') {
  const doc = containerEl?.ownerDocument || globalThis.document;
  if (doc && typeof doc.createElement === 'function') return doc.createElement(tag);
  const classes = new Set();
  const listeners = new Map();
  const attributes = {};
  const node = {
    tagName: tag.toUpperCase(),
    textContent: '',
    className: '',
    dataset: {},
    style: {},
    children: [],
    classList: {
      add(...names) {
        for (const n of names) if (n) classes.add(n);
        node.className = [...classes].join(' ');
      },
      remove(...names) {
        for (const n of names) classes.delete(n);
        node.className = [...classes].join(' ');
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        node.className = [...classes].join(' ');
        return next;
      },
    },
    setAttribute(name, value) {
      const str = String(value);
      attributes[name] = str;
      if (name === 'class') {
        classes.clear();
        for (const token of splitClasses(str)) classes.add(token);
        node.className = [...classes].join(' ');
      } else if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        node.dataset[camel] = str;
      } else if (name === 'title') {
        node.title = str;
      }
    },
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
    removeAttribute(name) {
      delete attributes[name];
      if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        delete node.dataset[camel];
      }
    },
    addEventListener(type, fn) {
      if (typeof fn !== 'function') return;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      const event = ev && typeof ev === 'object' ? { target: node, ...ev } : { type: String(ev), target: node };
      for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
      return true;
    },
  };
  return node;
}

function readChildren(containerEl) {
  if (!containerEl) return [];
  if (containerEl.children && typeof containerEl.children[Symbol.iterator] === 'function') {
    return [...containerEl.children];
  }
  if (Array.isArray(containerEl.childNodes)) return [...containerEl.childNodes];
  return [];
}

function reconcileChildren(containerEl, nextNodes) {
  if (!containerEl) return;
  if (typeof containerEl.insertBefore === 'function' && containerEl.children) {
    const keep = new Set(nextNodes);
    for (const child of [...containerEl.children]) {
      if (!keep.has(child)) {
        if (typeof child.remove === 'function') child.remove();
        else if (typeof containerEl.removeChild === 'function') containerEl.removeChild(child);
      }
    }
    let cursor = containerEl.firstElementChild ?? containerEl.firstChild ?? null;
    for (const node of nextNodes) {
      if (node !== cursor) containerEl.insertBefore(node, cursor);
      else cursor = cursor.nextElementSibling ?? cursor.nextSibling ?? null;
    }
    return;
  }
  if (typeof containerEl.replaceChildren === 'function') {
    containerEl.replaceChildren(...nextNodes);
    return;
  }
  if (typeof containerEl.removeChild === 'function' && typeof containerEl.appendChild === 'function') {
    while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
    for (const node of nextNodes) containerEl.appendChild(node);
    return;
  }
  if (Array.isArray(containerEl.children)) {
    containerEl.children = [...nextNodes];
  }
}

function cancelEnterCleanup(el) {
  const stop = activeEnterCleanups.get(el);
  if (stop) {
    activeEnterCleanups.delete(el);
    stop();
  }
}

/**
 * Tags a newly inserted alert, incident, or feed row with `.sky-row-enter`
 * (or `.sky-row-replay` for quiet historical bursts) and removes transient
 * animation classes once the entrance completes.
 */
export function animateRowEnter(el, options = {}) {
  if (!el || typeof el !== 'object') return el;
  const { replay = false, reducedMotion = detectReducedMotion() } = options ?? {};

  cancelEnterCleanup(el);
  removeClass(el, ...TRANSIENT_ROW_CLASSES);

  if (reducedMotion) return el;

  const cls = replay ? 'sky-row-replay' : 'sky-row-enter';
  const fallbackMs = (replay ? ROW_REPLAY_MS : ROW_ENTER_MS) + 60;
  addClass(el, cls);

  let finished = false;
  let timer = null;
  const onAnimationEnd = ev => {
    if (ev && ev.target && ev.target !== el) return;
    cleanup();
  };
  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimeout(timer);
    if (typeof el.removeEventListener === 'function') {
      el.removeEventListener('animationend', onAnimationEnd);
    }
    removeClass(el, cls);
    if (activeEnterCleanups.get(el) === cleanup) activeEnterCleanups.delete(el);
  };

  if (typeof el.addEventListener === 'function') {
    el.addEventListener('animationend', onAnimationEnd);
  }
  timer = setTimeout(cleanup, fallbackMs);
  timer?.unref?.();
  activeEnterCleanups.set(el, cleanup);
  return el;
}

/**
 * Plays a crisp 180 ms collapse + fade-out on `el` and invokes `onDone()`
 * once complete. Guarantees `onDone()` via a bounded fallback timeout even in
 * jsdom or mock DOMs where `transitionend` / `animationend` never fire.
 */
export function animateRowDismiss(el, onDone, options = {}) {
  const callback = typeof onDone === 'function' ? onDone : () => {};
  const { reducedMotion = detectReducedMotion() } = options ?? {};

  if (!el || typeof el !== 'object') {
    callback();
    return;
  }

  cancelEnterCleanup(el);
  removeClass(el, 'sky-row-enter', 'sky-row-replay');

  if (reducedMotion) {
    const inflight = activeDismissals.get(el);
    if (inflight) {
      inflight.callbacks.push(callback);
      inflight.finish();
      return;
    }
    removeClass(el, 'sky-row-exit');
    callback();
    return;
  }

  const existing = activeDismissals.get(el);
  if (existing) {
    existing.callbacks.push(callback);
    return;
  }

  if (typeof el.offsetHeight === 'number' && el.offsetHeight > 0 && el.style) {
    if (typeof el.style.setProperty === 'function') {
      el.style.setProperty('--sky-row-h', `${el.offsetHeight}px`);
    } else {
      el.style['--sky-row-h'] = `${el.offsetHeight}px`;
    }
  }

  addClass(el, 'sky-row-exit');
  setData(el, 'dismissing', 'true');

  const callbacks = [callback];
  let settled = false;
  let timer = null;

  const onEnd = ev => {
    if (ev && ev.target && ev.target !== el) return;
    finish();
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    if (typeof el.removeEventListener === 'function') {
      el.removeEventListener('transitionend', onEnd);
      el.removeEventListener('animationend', onEnd);
    }
    activeDismissals.delete(el);
    for (const cb of callbacks) {
      try { cb(); } catch (err) { queueMicrotask(() => { throw err; }); }
    }
  };

  if (typeof el.addEventListener === 'function') {
    el.addEventListener('transitionend', onEnd);
    el.addEventListener('animationend', onEnd);
  }
  timer = setTimeout(finish, ROW_DISMISS_FALLBACK_MS);
  activeDismissals.set(el, { callbacks, finish });
}

/**
 * Returns true only when durable storage is not unavailable AND a non-empty
 * `solana_tx` signature has been confirmed without errors or pending reconciliation.
 */
export function isSolanaConfirmed(incident) {
  if (!incident || typeof incident !== 'object') return false;
  if (incident.persistence === 'unavailable' || incident.receipt_state === 'unavailable') return false;
  if (typeof incident.solana_tx !== 'string' || incident.solana_tx.trim().length === 0) return false;
  if (incident.solana_error) return false;
  if (incident.stamp_state === 'reconciliation_required' || incident.stamp_state === 'incomplete') return false;
  if (incident.solana_status && incident.solana_status !== 'confirmed') return false;
  return true;
}

function resolveStorageSpec(incident) {
  const unavailable = incident.persistence === 'unavailable' || incident.receipt_state === 'unavailable';
  if (unavailable) {
    return {
      key: 'storage',
      state: 'unavailable',
      text: 'Storage unavailable',
      classes: ['sky-enrichment-pill', 'sky-pill-unavailable'],
      verified: false,
    };
  }
  const syncing = incident.persistence === 'pending' ||
    ['pending', 'retrying', 'retrying_volatile'].includes(incident.receipt_state);
  const hasStoredSignal = incident.persistence === 'stored' ||
    (Number.isSafeInteger(incident.revision) && incident.revision > 0) ||
    incident.report_state === 'stored' ||
    incident.stamp_state === 'stored' ||
    (typeof incident.report === 'string' && incident.report.trim().length > 0);

  if (!syncing && hasStoredSignal) {
    return {
      key: 'storage',
      state: 'confirmed',
      text: 'Storage confirmed',
      classes: ['sky-enrichment-pill', 'sky-pill-confirmed'],
      verified: true,
    };
  }
  return {
    key: 'storage',
    state: 'pending',
    text: 'Syncing receipt…',
    classes: ['sky-enrichment-pill', 'sky-shimmer-pill'],
    verified: false,
  };
}

function resolveReportSpec(incident) {
  const storageUnavailable = incident.persistence === 'unavailable' || incident.receipt_state === 'unavailable';
  const hasReport = typeof incident.report === 'string' && incident.report.trim().length > 0;
  if (!storageUnavailable && (hasReport || incident.report_state === 'stored')) {
    return {
      key: 'report',
      state: 'ready',
      text: 'Report ready',
      classes: ['sky-enrichment-pill', 'sky-pill-ready'],
    };
  }
  if (storageUnavailable || incident.report_state === 'unavailable' || incident.report_state === 'incomplete') {
    const incomplete = !storageUnavailable && incident.report_state === 'incomplete';
    return {
      key: 'report',
      state: incomplete ? 'incomplete' : 'unavailable',
      text: incomplete ? 'Report incomplete' : 'Report unavailable',
      classes: ['sky-enrichment-pill', 'sky-pill-unavailable'],
    };
  }
  return {
    key: 'report',
    state: 'pending',
    text: 'Drafting report…',
    classes: ['sky-enrichment-pill', 'sky-shimmer-pill'],
  };
}

function resolveSolanaSpec(incident, prevSnapshot, reducedMotion) {
  const storageUnavailable = incident.persistence === 'unavailable' || incident.receipt_state === 'unavailable';
  if (storageUnavailable) return null;

  if (isSolanaConfirmed(incident)) {
    const transitioned = prevSnapshot !== null && !prevSnapshot.solanaConfirmed;
    const classes = ['sky-enrichment-pill', 'sky-pill-solana-confirmed'];
    if (transitioned && !reducedMotion) classes.push('sky-badge-pop');
    return {
      key: 'solana',
      state: 'confirmed',
      text: '✓ Solana devnet',
      classes,
      verified: true,
      tx: incident.solana_tx.trim(),
      pop: transitioned && !reducedMotion,
    };
  }

  if (incident.solana_status === 'pending' || incident.stamp_state === 'reconciliation_required') {
    return {
      key: 'solana',
      state: 'pending',
      text: 'Stamping devnet…',
      classes: ['sky-enrichment-pill', 'sky-shimmer-pill'],
      verified: false,
    };
  }

  if (incident.solana_error || incident.stamp_state === 'incomplete') {
    return {
      key: 'solana',
      state: 'incomplete',
      text: 'Devnet stamp incomplete',
      classes: ['sky-enrichment-pill', 'sky-pill-warn'],
      verified: false,
    };
  }

  if (incident.solana_status === 'hash only') {
    return {
      key: 'solana',
      state: 'hash-only',
      text: 'Hash only · unverified',
      classes: ['sky-enrichment-pill', 'sky-pill-unavailable'],
      verified: false,
    };
  }

  return null;
}

function resolveBirdSpec(incident) {
  const bv = incident?.bird_verdict;
  if (!bv || typeof bv !== 'object') return null;

  if (bv.status === 'unavailable') {
    return {
      key: 'bird-review',
      state: 'unavailable',
      text: 'Bird review unavailable (advisory)',
      classes: ['sky-enrichment-pill', 'sky-advisory-chip', 'sky-pill-unavailable'],
      advisory: true,
      source: 'unavailable',
    };
  }

  const hasValidStatus = bv.status === 'verified' || bv.status === undefined;
  const rawVerdict = typeof bv.verdict === 'string' ? bv.verdict.trim() : '';
  if (!hasValidStatus || (!rawVerdict && bv.status !== 'verified')) return null;

  const isV41 = bv.source === 'local' || bv.source === 'v4.1' ||
    /v4\.?1/i.test(`${bv.source ?? ''} ${bv.model ?? ''}`);
  const verdictText = rawVerdict ? rawVerdict.replace(/_/g, ' ') : '';
  const pct = typeof bv.confidence === 'number' && Number.isFinite(bv.confidence) &&
    bv.confidence >= 0 && bv.confidence <= 1
    ? ` (${Math.round(bv.confidence * 100)}%)`
    : '';

  const text = isV41
    ? (verdictText ? `v4.1 advisory · ${verdictText}${pct}` : 'v4.1 advisory')
    : (verdictText ? `Bird review · ${verdictText}${pct} (advisory)` : 'Bird review (advisory)');

  return {
    key: 'bird-review',
    state: 'advisory',
    text,
    classes: ['sky-enrichment-pill', 'sky-advisory-chip'],
    advisory: true,
    source: isV41 ? 'v4.1' : 'bird-review',
  };
}

function snapshotIncident(incident) {
  if (!incident || typeof incident !== 'object') return null;
  return {
    id: typeof incident._id === 'string' ? incident._id : null,
    solanaConfirmed: isSolanaConfirmed(incident),
  };
}

const ALL_PILL_CLASSES = [
  'sky-enrichment-pill',
  'sky-shimmer-pill',
  'sky-pill-confirmed',
  'sky-pill-ready',
  'sky-pill-solana-confirmed',
  'sky-pill-unavailable',
  'sky-pill-warn',
  'sky-advisory-chip',
  'sky-badge-pop',
];

/**
 * Renders or reconciles incident enrichment status badges inside `containerEl`.
 * Never fabricates storage or Solana verification if `persistence === 'unavailable'`
 * or `solana_tx` is absent.
 */
export function applyEnrichmentBadges(containerEl, incident, options = {}) {
  if (!containerEl || typeof containerEl !== 'object') return [];
  addClass(containerEl, 'sky-enrichment-badges');

  if (!incident || typeof incident !== 'object') {
    previousSnapshots.delete(containerEl);
    reconcileChildren(containerEl, []);
    return [];
  }

  const opts = options ?? {};
  const reducedMotion = typeof opts.reducedMotion === 'boolean' ? opts.reducedMotion : detectReducedMotion();
  const hasExplicitPrevious = options !== null && typeof options === 'object' && Object.hasOwn(options, 'previous');

  let prevSnapshot = null;
  if (hasExplicitPrevious) {
    prevSnapshot = snapshotIncident(opts.previous);
  } else {
    const cached = previousSnapshots.get(containerEl) ?? null;
    if (cached && (!cached.id || !incident._id || cached.id === incident._id)) {
      prevSnapshot = cached;
    }
  }
  if (prevSnapshot && prevSnapshot.id && incident._id && prevSnapshot.id !== incident._id) {
    prevSnapshot = null;
  }

  const specs = [
    resolveStorageSpec(incident),
    resolveReportSpec(incident),
    resolveSolanaSpec(incident, prevSnapshot, reducedMotion),
    resolveBirdSpec(incident),
  ].filter(Boolean);

  const existingByKey = new Map();
  for (const child of readChildren(containerEl)) {
    const key = child?.dataset?.badge ?? child?.getAttribute?.('data-badge');
    if (key) existingByKey.set(key, child);
  }

  const nextNodes = specs.map(spec => {
    const el = existingByKey.get(spec.key) ?? createBadgeElement(containerEl, 'span');
    if (el.textContent !== spec.text) el.textContent = spec.text;
    removeClass(el, ...ALL_PILL_CLASSES);
    addClass(el, ...spec.classes);
    setData(el, 'badge', spec.key);
    setData(el, 'state', spec.state);
    setData(el, 'verified', spec.verified ? 'true' : null);
    setData(el, 'advisory', spec.advisory ? 'true' : null);
    setData(el, 'source', spec.source ?? null);
    setData(el, 'tx', spec.tx ?? null);
    if (spec.advisory) {
      const title = 'Advisory only — does not change detector risk or clearance';
      if (typeof el.setAttribute === 'function') el.setAttribute('title', title);
      else el.title = title;
    }
    if (spec.pop && typeof el.addEventListener === 'function') {
      const clearPop = ev => {
        if (ev && ev.target && ev.target !== el) return;
        removeClass(el, 'sky-badge-pop');
        el.removeEventListener?.('animationend', clearPop);
      };
      el.addEventListener('animationend', clearPop);
    }
    return el;
  });

  reconcileChildren(containerEl, nextNodes);
  previousSnapshots.set(containerEl, snapshotIncident(incident));
  return nextNodes;
}
