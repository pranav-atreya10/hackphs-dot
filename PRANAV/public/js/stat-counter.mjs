// Tabular odometer & stat counter engine for SkySentry HUD readouts and landing-page facts.

const activeAnimations = new WeakMap();
const animatedFacts = new WeakSet();

const STAT_NUMBER_RE = /^([^\d]*?)((?:(?<![A-Za-z0-9_])[+-])?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.(\d+))?)(.*)$/s;

function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

export function cubicEaseOut(t) {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const inv = 1 - clamped;
  return 1 - inv * inv * inv;
}

export function parseStatValue(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    const raw = String(input);
    const dotIndex = raw.indexOf('.');
    const decimals = dotIndex === -1 || raw.includes('e') || raw.includes('E') ? 0 : raw.length - dotIndex - 1;
    return {
      raw,
      prefix: '',
      suffix: '',
      value: input,
      decimals,
      grouped: false,
      plusSign: false,
      minIntDigits: 1,
    };
  }

  if (typeof input !== 'string' || input.trim() === '') return null;
  const match = STAT_NUMBER_RE.exec(input);
  if (!match) return null;

  const [, prefix, numToken, decPart, suffix] = match;
  const plusSign = numToken.startsWith('+');
  const unsigned = numToken.replace(/^[+-]/, '');
  const [rawIntPart] = unsigned.split('.');
  const grouped = rawIntPart.includes(',');
  const cleanDigits = rawIntPart.replace(/,/g, '');
  const minIntDigits = !grouped && cleanDigits.length > 1 && cleanDigits.startsWith('0') ? cleanDigits.length : 1;
  const value = Number(numToken.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;

  return {
    raw: input,
    prefix,
    suffix,
    value,
    decimals: decPart ? decPart.length : 0,
    grouped,
    plusSign,
    minIntDigits,
  };
}

export function formatStatValue(parsed, numericValue) {
  const { prefix = '', suffix = '', decimals = 0, grouped = false, plusSign = false, minIntDigits = 1 } = parsed;
  const factor = 10 ** decimals;
  const rounded = Math.round(numericValue * factor) / factor;
  const normalized = Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
  const sign = normalized < 0 ? '-' : plusSign && normalized > 0 ? '+' : '';
  const fixed = Math.abs(normalized).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const paddedInt = minIntDigits > 1 ? intPart.padStart(minIntDigits, '0') : intPart;
  const formattedInt = grouped ? paddedInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : paddedInt;
  const numberBody = decPart !== undefined ? `${formattedInt}.${decPart}` : formattedInt;
  return `${prefix}${sign}${numberBody}${suffix}`;
}

function applyTabularNums(el) {
  if (!el || !el.style || typeof el.style !== 'object') return;
  if (typeof el.style.setProperty === 'function') {
    el.style.setProperty('font-variant-numeric', 'tabular-nums');
  }
  if (!el.style.fontVariantNumeric) {
    el.style.fontVariantNumeric = 'tabular-nums';
  }
}

export function cancelStatAnimation(el, caf = globalThis.cancelAnimationFrame) {
  if (!el || typeof el !== 'object') return null;
  const prev = activeAnimations.get(el);
  if (!prev) return null;
  prev.cancelled = true;
  prev.active = false;
  if (prev.rafId !== null && prev.rafId !== undefined && typeof caf === 'function') {
    caf.call(globalThis, prev.rafId);
  }
  prev.rafId = null;
  return prev;
}

export function animateStatValue(
  el,
  nextTextOrNumber,
  options = {},
) {
  if (!el || typeof el !== 'object') return { cancel() {} };

  const {
    durationMs = 420,
    reducedMotion = prefersReducedMotion(),
    animateInitial = true,
    fromValue,
    raf = globalThis.requestAnimationFrame,
    caf = globalThis.cancelAnimationFrame,
    now = () => performance.now(),
  } = options;
  const hasCustomNow = typeof options.now === 'function';

  const prevState = cancelStatAnimation(el, caf);
  const targetText = nextTextOrNumber == null ? '' : String(nextTextOrNumber);
  const target = typeof nextTextOrNumber === 'number'
    ? parseStatValue(nextTextOrNumber)
    : parseStatValue(targetText);

  if (!target) {
    activeAnimations.delete(el);
    el.textContent = targetText;
    return { cancel() {} };
  }

  applyTabularNums(el);

  let startValue = 0;
  let hasPriorNumeric = false;
  if (Number.isFinite(fromValue)) {
    startValue = fromValue;
    hasPriorNumeric = true;
  } else if (prevState && el.textContent === prevState.lastRenderedText) {
    startValue = prevState.currentValue;
    hasPriorNumeric = true;
  } else {
    const currentRaw = typeof el.textContent === 'string' ? el.textContent : '';
    const prevParsed = currentRaw.trim() === '' ? null : parseStatValue(currentRaw);
    if (prevParsed) {
      startValue = prevParsed.value;
      hasPriorNumeric = true;
    }
  }

  if (
    reducedMotion ||
    typeof raf !== 'function' ||
    !(durationMs > 0) ||
    (!hasPriorNumeric && !animateInitial) ||
    startValue === target.value
  ) {
    el.textContent = targetText;
    activeAnimations.set(el, {
      currentValue: target.value,
      lastRenderedText: targetText,
      active: false,
      cancelled: false,
      rafId: null,
    });
    return { cancel() {} };
  }

  const initialRendered = formatStatValue(target, startValue);
  el.textContent = initialRendered;

  const startAt = now();
  const state = {
    currentValue: startValue,
    lastRenderedText: initialRendered,
    active: true,
    cancelled: false,
    rafId: null,
  };
  activeAnimations.set(el, state);

  function scheduleNext() {
    if (state.cancelled || !state.active) return;
    const id = raf.call(globalThis, step);
    if (!state.cancelled && state.active && state.rafId === null) {
      state.rafId = id ?? null;
    }
  }

  function step(frameTime) {
    state.rafId = null;
    if (state.cancelled || !state.active) return;

    const currentAt = !hasCustomNow && Number.isFinite(frameTime) ? frameTime : now();
    const elapsed = Math.max(0, currentAt - startAt);
    const progress = Math.min(1, elapsed / durationMs);

    if (progress >= 1) {
      state.currentValue = target.value;
      state.lastRenderedText = targetText;
      state.active = false;
      el.textContent = targetText;
      return;
    }

    const eased = cubicEaseOut(progress);
    const currentValue = startValue + (target.value - startValue) * eased;
    const rendered = formatStatValue(target, currentValue);
    state.currentValue = currentValue;
    state.lastRenderedText = rendered;
    if (el.textContent !== rendered) {
      el.textContent = rendered;
    }
    scheduleNext();
  }

  scheduleNext();

  return {
    cancel() {
      if (activeAnimations.get(el) === state) {
        cancelStatAnimation(el, caf);
      }
    },
  };
}

export function observeLandingFacts(
  root = typeof document !== 'undefined' ? document : null,
  options = {},
) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return { disconnect() {} };
  }

  const {
    selector = '.fact b',
    threshold = 0.2,
    rootMargin = '0px',
    IntersectionObserver: Observer = globalThis.IntersectionObserver,
    reducedMotion = prefersReducedMotion(),
    durationMs = 420,
    raf = globalThis.requestAnimationFrame,
    caf = globalThis.cancelAnimationFrame,
    now,
  } = options;

  const candidates = Array.from(root.querySelectorAll(selector));
  const targets = new Map();

  for (const el of candidates) {
    if (!el || typeof el !== 'object' || animatedFacts.has(el)) continue;
    if (!el.dataset) {
      try { el.dataset = {}; } catch {}
    }
    const rawTarget = el.dataset?.targetText || (typeof el.textContent === 'string' ? el.textContent : '');
    const parsed = parseStatValue(rawTarget);
    if (!parsed) continue;

    if (el.dataset && !el.dataset.targetText) {
      el.dataset.targetText = rawTarget;
    }
    applyTabularNums(el);
    targets.set(el, rawTarget);
  }

  if (targets.size === 0) {
    return { disconnect() {} };
  }

  if (reducedMotion || typeof Observer !== 'function' || typeof raf !== 'function') {
    for (const [el, finalText] of targets) {
      el.textContent = finalText;
      animatedFacts.add(el);
    }
    return { disconnect() {} };
  }

  const animBaseOptions = {
    durationMs,
    reducedMotion: false,
    fromValue: 0,
    raf,
    caf,
  };
  if (typeof now === 'function') {
    animBaseOptions.now = now;
  }

  const io = new Observer(
    entries => {
      for (const entry of entries) {
        if (!entry || !entry.isIntersecting) continue;
        const el = entry.target;
        const finalText = el?.dataset?.targetText ?? targets.get(el);
        if (!el || finalText === undefined || animatedFacts.has(el)) continue;
        animatedFacts.add(el);
        if (typeof io.unobserve === 'function') io.unobserve(el);
        animateStatValue(el, finalText, animBaseOptions);
      }
    },
    { threshold, rootMargin },
  );

  for (const el of targets.keys()) {
    io.observe(el);
  }

  return {
    disconnect() {
      if (typeof io.disconnect === 'function') io.disconnect();
      for (const [el, fallbackText] of targets.entries()) {
        const prev = cancelStatAnimation(el, caf);
        if (prev) {
          el.textContent = el.dataset?.targetText || fallbackText;
        }
      }
    },
  };
}
