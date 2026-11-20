// Zero-reflow canvas sizing via one shared ResizeObserver, plus a shared RAF frame-budget loop.
// Keeps clientWidth/clientHeight/getBoundingClientRect out of requestAnimationFrame ticks and
// coordinates all animated HUD tiles on one cadence-adaptive animation loop.

export function createCanvasSizer({
  ResizeObserverImpl = globalThis.ResizeObserver,
  dpr = () => Math.min(2, globalThis.devicePixelRatio || 1),
  onResize = null,
} = {}) {
  const sizes = new WeakMap();
  let epoch = 0;

  const observer = typeof ResizeObserverImpl === 'function'
    ? new ResizeObserverImpl(entries => {
        for (const entry of entries) {
          const target = entry?.target;
          if (!target || typeof target !== 'object') continue;
          const rect = entry.contentRect;
          if (!rect) continue;
          const cssWidth = Number(rect.width);
          const cssHeight = Number(rect.height);
          if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth < 0 || cssHeight < 0) continue;
          const record = sizes.get(target);
          if (!record || record.observedEpoch !== epoch) continue;
          const changed = record.cssWidth !== cssWidth || record.cssHeight !== cssHeight;
          record.cssWidth = cssWidth;
          record.cssHeight = cssHeight;
          record.hasSize = cssWidth > 0 && cssHeight > 0;
          if (changed && record.hasSize) {
            const snapshot = { cssWidth, cssHeight };
            record.listener?.(target, snapshot);
            onResize?.(target, snapshot);
          }
        }
      })
    : null;

  function ensureRecord(canvas, listener = null) {
    let record = sizes.get(canvas);
    if (!record) {
      record = {
        cssWidth: 0,
        cssHeight: 0,
        hasSize: false,
        observedEpoch: -1,
        fallbackReadDone: false,
        listener: null,
      };
      sizes.set(canvas, record);
    }
    if (typeof listener === 'function') record.listener = listener;
    if (observer) {
      if (record.observedEpoch !== epoch) {
        record.observedEpoch = epoch;
        observer.observe(canvas);
      }
    } else if (!record.fallbackReadDone) {
      // One-time initial fallback only when ResizeObserver is unavailable (e.g. headless unit tests).
      record.fallbackReadDone = true;
      let w = Number(canvas.clientWidth);
      let h = Number(canvas.clientHeight);
      if (!(w > 0 && h > 0) && typeof canvas.getBoundingClientRect === 'function') {
        const rect = canvas.getBoundingClientRect();
        w = Number(rect?.width);
        h = Number(rect?.height);
      }
      if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
        record.cssWidth = w;
        record.cssHeight = h;
        record.hasSize = true;
      }
    }
    return record;
  }

  function observe(canvas, listener = null) {
    if (!canvas || typeof canvas !== 'object') return false;
    ensureRecord(canvas, listener);
    return true;
  }

  function syncCanvasSize(canvas, zoomScale = 1) {
    const rawDpr = Number(dpr());
    const baseDpr = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
    const rawZoom = Number(zoomScale);
    const zoom = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1;
    const effectiveDpr = baseDpr * zoom;

    if (!canvas || typeof canvas !== 'object') {
      return { width: 0, height: 0, cssWidth: 0, cssHeight: 0, dpr: effectiveDpr, baseDpr, zoomScale: zoom, resized: false };
    }

    const record = ensureRecord(canvas);
    if (!record.hasSize) {
      return {
        width: Number(canvas.width) || 0,
        height: Number(canvas.height) || 0,
        cssWidth: record.cssWidth,
        cssHeight: record.cssHeight,
        dpr: effectiveDpr,
        baseDpr,
        zoomScale: zoom,
        resized: false,
      };
    }

    const nextWidth = Math.max(1, Math.round(record.cssWidth * effectiveDpr));
    const nextHeight = Math.max(1, Math.round(record.cssHeight * effectiveDpr));
    let resized = false;
    if (canvas.width !== nextWidth) {
      canvas.width = nextWidth;
      resized = true;
    }
    if (canvas.height !== nextHeight) {
      canvas.height = nextHeight;
      resized = true;
    }

    return {
      width: nextWidth,
      height: nextHeight,
      cssWidth: record.cssWidth,
      cssHeight: record.cssHeight,
      dpr: effectiveDpr,
      baseDpr,
      zoomScale: zoom,
      resized,
    };
  }

  function getSize(canvas) {
    if (!canvas || typeof canvas !== 'object') return { cssWidth: 0, cssHeight: 0 };
    const record = sizes.get(canvas);
    return record ? { cssWidth: record.cssWidth, cssHeight: record.cssHeight } : { cssWidth: 0, cssHeight: 0 };
  }

  function unobserve(canvas) {
    if (!canvas || typeof canvas !== 'object') return false;
    const record = sizes.get(canvas);
    if (observer && record && record.observedEpoch === epoch) {
      observer.unobserve(canvas);
    }
    return sizes.delete(canvas);
  }

  function disconnect() {
    epoch++;
    observer?.disconnect();
  }

  return { observe, syncCanvasSize, getSize, unobserve, disconnect };
}

const DELTA_WINDOW = 3;
const MAX_PAUSE_DELTA_MS = 1000;
const ECO_RECOVER_RATIO = 0.85;

export function createFrameBudgetLoop({
  maxWorkMs = 6,
  ecoThresholdMs = 26,
  raf = globalThis.requestAnimationFrame,
  caf = globalThis.cancelAnimationFrame,
  now = () => performance.now(),
  isHidden = () => typeof document !== 'undefined' && document.hidden,
  onError = null,
} = {}) {
  const subscribers = new Map();
  const recentDeltas = [];
  const requestFrame = typeof raf === 'function'
    ? cb => raf.call(globalThis, cb)
    : cb => setTimeout(() => cb(now()), 16);
  const cancelFrame = typeof caf === 'function'
    ? id => caf.call(globalThis, id)
    : id => clearTimeout(id);

  const workBudgetMs = Number.isFinite(maxWorkMs) ? Math.max(0, maxWorkMs) : Infinity;
  const slowThresholdMs = Number.isFinite(ecoThresholdMs) && ecoThresholdMs > 0 ? ecoThresholdMs : 26;
  const recoverThresholdMs = slowThresholdMs * ECO_RECOVER_RATIO;

  let scheduled = false;
  let inTick = false;
  let rafId = null;
  let scheduleToken = 0;
  let lastTickAt = null;
  let lastDeltaMs = 0;
  let eco = false;
  let ecoParity = 0;
  let framesRun = 0;
  let framesSkipped = 0;

  function resetCadence() {
    lastTickAt = null;
    lastDeltaMs = 0;
    recentDeltas.length = 0;
    eco = false;
    ecoParity = 0;
  }

  function ensureScheduled() {
    if (scheduled || inTick || subscribers.size === 0) return;
    scheduled = true;
    const token = ++scheduleToken;
    rafId = requestFrame(ts => {
      if (token !== scheduleToken) return;
      tick(ts);
    });
  }

  function cancelScheduled() {
    if (scheduled) {
      const id = rafId;
      scheduled = false;
      rafId = null;
      scheduleToken++;
      cancelFrame(id);
    }
    if (!inTick && subscribers.size === 0) {
      resetCadence();
    }
  }

  function avgRecentDelta() {
    if (!recentDeltas.length) return 0;
    let sum = 0;
    for (let i = 0; i < recentDeltas.length; i++) sum += recentDeltas[i];
    return sum / recentDeltas.length;
  }

  function updateCadence(tickAt) {
    if (lastTickAt === null) {
      lastTickAt = tickAt;
      lastDeltaMs = 0;
      return;
    }
    const rawDelta = tickAt - lastTickAt;
    lastTickAt = tickAt;

    if (!Number.isFinite(rawDelta) || rawDelta < 0 || rawDelta > MAX_PAUSE_DELTA_MS) {
      lastDeltaMs = 0;
      return;
    }

    lastDeltaMs = rawDelta;
    recentDeltas.push(Math.min(rawDelta, slowThresholdMs * 3));
    if (recentDeltas.length > DELTA_WINDOW) recentDeltas.shift();

    const avg = avgRecentDelta();
    if (!eco) {
      if (recentDeltas.length >= 2 && avg > slowThresholdMs && rawDelta > slowThresholdMs) {
        eco = true;
        ecoParity = 1; // Immediately skip this odd slow frame after the previous active frame.
      }
    } else if (
      recentDeltas.length >= DELTA_WINDOW &&
      avg <= recoverThresholdMs &&
      recentDeltas.every(d => d <= slowThresholdMs)
    ) {
      eco = false;
      ecoParity = 0;
    }
  }

  function tick(rafTimestamp) {
    scheduled = false;
    rafId = null;
    if (subscribers.size === 0) {
      resetCadence();
      return;
    }

    inTick = true;
    try {
      if (isHidden()) {
        lastTickAt = null;
        lastDeltaMs = 0;
        framesSkipped++;
        return;
      }

      const tickAt = Number.isFinite(rafTimestamp) ? rafTimestamp : now();
      updateCadence(tickAt);

      if (eco) {
        const skipOdd = ecoParity === 1;
        ecoParity = skipOdd ? 0 : 1;
        if (skipOdd) {
          framesSkipped++;
          return;
        }
      }

      framesRun++;
      const workStart = now();
      const batch = [...subscribers.entries()];
      for (const [key, fn] of batch) {
        if (subscribers.get(key) !== fn) continue;
        // Rotate to the back so maxWorkMs caps remain fair and starvation-free across tiles.
        subscribers.delete(key);
        subscribers.set(key, fn);

        const elapsedBefore = Math.max(0, now() - workStart);
        const info = {
          now: tickAt,
          deltaMs: lastDeltaMs,
          eco,
          mode: eco ? 'eco' : 'full',
          targetFps: eco ? 30 : 60,
          frame: framesRun,
          remainingMs: Math.max(0, workBudgetMs - elapsedBefore),
        };
        try {
          fn(tickAt, info);
        } catch (err) {
          if (typeof onError === 'function') onError(err, key);
        }

        if (now() - workStart >= workBudgetMs) break;
      }
    } finally {
      inTick = false;
      if (subscribers.size > 0) ensureScheduled();
      else resetCadence();
    }
  }

  function subscribe(idOrFn, maybeFn) {
    const hasKey = maybeFn !== undefined;
    const key = idOrFn;
    const fn = hasKey ? maybeFn : idOrFn;
    if (typeof fn !== 'function') throw new TypeError('Expected a subscriber function');
    subscribers.set(key, fn);
    ensureScheduled();
    return () => {
      if (subscribers.get(key) === fn) return unsubscribe(key);
      return false;
    };
  }

  function schedule(idOrFn, maybeFn) {
    const hasKey = maybeFn !== undefined;
    const key = idOrFn;
    const fn = hasKey ? maybeFn : idOrFn;
    if (typeof fn !== 'function') throw new TypeError('Expected a callback function');
    const once = (tickAt, info) => {
      if (subscribers.get(key) === once) subscribers.delete(key);
      fn(tickAt, info);
    };
    subscribers.set(key, once);
    ensureScheduled();
    return () => {
      if (subscribers.get(key) === once) return unsubscribe(key);
      return false;
    };
  }

  function unsubscribe(key) {
    const removed = subscribers.delete(key);
    if (subscribers.size === 0) cancelScheduled();
    return removed;
  }

  function clear() {
    subscribers.clear();
    cancelScheduled();
  }

  return {
    subscribe,
    unsubscribe,
    schedule,
    clear,
    stop: clear,
    isRunning: () => scheduled || inTick,
    isEco: () => eco,
    get running() { return scheduled || inTick; },
    get eco() { return eco; },
    get mode() { return eco ? 'eco' : 'full'; },
    get targetFps() { return eco ? 30 : 60; },
    get size() { return subscribers.size; },
    stats: () => ({
      running: scheduled || inTick,
      eco,
      mode: eco ? 'eco' : 'full',
      targetFps: eco ? 30 : 60,
      subscribers: subscribers.size,
      avgDeltaMs: avgRecentDelta(),
      lastDeltaMs,
      framesRun,
      framesSkipped,
    }),
  };
}
