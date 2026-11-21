// Advisory-only acoustic telemetry HUD pill controller for SkySentry Tower.
// Displays live per-camera and sidebar acoustic status without affecting authoritative risk or clearance.

export const ACOUSTIC_INACTIVE_TEXT = 'Video only · mic off';
export const ACOUSTIC_MONITORING_TEXT = 'Acoustic monitor · mic on (advisory)';
export const ACOUSTIC_ADVISORY_TITLE =
  'Advisory acoustic telemetry only — does not set tower risk or clear airspace';
export const ACOUSTIC_TTL_MS = 3000;

const RAW_AUDIO_KEYS = Object.freeze([
  'pcm',
  'samples',
  'audioBuffer',
  'rawAudio',
  'audioData',
  'pcmData',
  'audioSamples',
]);

function isBinaryAudioValue(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof ArrayBuffer !== 'undefined') {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    return true;
  }
  const BufferCtor = globalThis.Buffer;
  if (typeof BufferCtor?.isBuffer === 'function' && BufferCtor.isBuffer(value)) {
    return true;
  }
  return false;
}

function hasRawAudioFields(payload) {
  if (isBinaryAudioValue(payload)) return true;
  for (const key of RAW_AUDIO_KEYS) {
    if (payload[key] !== undefined && payload[key] !== null) return true;
  }
  for (const val of Object.values(payload)) {
    if (isBinaryAudioValue(val)) return true;
  }
  return false;
}

function inactiveResult() {
  return {
    active: false,
    state: 'inactive',
    text: ACOUSTIC_INACTIVE_TEXT,
    advisory: false,
  };
}

export function formatAcousticPill(
  telemetry,
  options = {},
) {
  const { ttlMs = ACOUSTIC_TTL_MS, now = Date.now } =
    options && typeof options === 'object' ? options : {};
  const readNow = typeof now === 'function' ? now : Date.now;
  const maxAgeMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : ACOUSTIC_TTL_MS;

  if (
    !telemetry ||
    typeof telemetry !== 'object' ||
    Array.isArray(telemetry) ||
    hasRawAudioFields(telemetry) ||
    telemetry.active === false ||
    telemetry.demo === true ||
    telemetry.isDemo === true
  ) {
    return inactiveResult();
  }

  if (telemetry.source !== undefined && telemetry.source !== 'live') {
    return inactiveResult();
  }
  if (telemetry.sourceMode !== undefined && telemetry.sourceMode !== 'live') {
    return inactiveResult();
  }

  if (telemetry.updatedAt !== undefined && telemetry.updatedAt !== null) {
    if (typeof telemetry.updatedAt !== 'number' || !Number.isFinite(telemetry.updatedAt)) {
      return inactiveResult();
    }
    const age = readNow() - telemetry.updatedAt;
    if (age < 0 || age >= maxAgeMs) {
      return inactiveResult();
    }
  }

  const hasSignal =
    telemetry.active === true ||
    typeof telemetry.humDetected === 'boolean' ||
    Number.isFinite(telemetry.dominantHz) ||
    Number.isFinite(telemetry.droneProb);
  if (!hasSignal) {
    return inactiveResult();
  }

  const droneProb = Number.isFinite(telemetry.droneProb)
    ? Math.min(1, Math.max(0, telemetry.droneProb))
    : 0;
  const dominantHz = Number.isFinite(telemetry.dominantHz)
    ? Math.round(telemetry.dominantHz)
    : 0;

  if (
    telemetry.humDetected === true ||
    (telemetry.humDetected === undefined && dominantHz > 0)
  ) {
    const hz = Math.max(0, Math.round(dominantHz));
    const pct = Math.round(Math.min(1, Math.max(0, droneProb)) * 100);
    return {
      active: true,
      state: 'advisory',
      text: `Acoustic monitor · ${hz} Hz (${pct}%)`,
      advisory: true,
      dominantHz: hz,
      probabilityPct: pct,
    };
  }

  return {
    active: true,
    state: 'monitoring',
    text: ACOUSTIC_MONITORING_TEXT,
    advisory: true,
  };
}

function normalizeAirport(code) {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function normalizeCameraId(cameraId) {
  if (typeof cameraId !== 'string') return null;
  const trimmed = cameraId.trim();
  return trimmed ? trimmed : null;
}

function createFallbackPillElement() {
  const attrs = new Map();
  const classes = new Set();
  const el = {
    nodeType: 1,
    tagName: 'SPAN',
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    children: [],
    parentNode: null,
    classList: {
      add(...names) {
        for (const name of names) {
          if (name) classes.add(name);
        }
        el.className = [...classes].join(' ');
      },
      remove(...names) {
        for (const name of names) classes.delete(name);
        el.className = [...classes].join(' ');
      },
      contains(name) {
        return classes.has(name);
      },
    },
    setAttribute(name, value) {
      const key = String(name).toLowerCase();
      const str = String(value);
      attrs.set(key, str);
      if (key === 'class') {
        el.className = str;
        classes.clear();
        for (const tok of str.split(/\s+/)) {
          if (tok) classes.add(tok);
        }
      } else if (key === 'title') {
        el.title = str;
      } else if (key.startsWith('data-')) {
        const prop = key.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        el.dataset[prop] = str;
      }
    },
    getAttribute(name) {
      const key = String(name).toLowerCase();
      if (key === 'class') return el.className || null;
      if (key === 'title') return el.title || attrs.get('title') || null;
      return attrs.get(key) ?? null;
    },
    removeAttribute(name) {
      const key = String(name).toLowerCase();
      attrs.delete(key);
      if (key.startsWith('data-')) {
        const prop = key.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        delete el.dataset[prop];
      }
    },
  };
  return el;
}

function hasClassToken(el, token) {
  if (!el || typeof el !== 'object') return false;
  if (typeof el.classList?.contains === 'function' && el.classList.contains(token)) {
    return true;
  }
  if (typeof el.className === 'string') {
    return el.className.split(/\s+/).includes(token);
  }
  return false;
}

function canAppendChild(container) {
  return Boolean(
    container &&
    typeof container === 'object' &&
    (typeof container.appendChild === 'function' || typeof container.append === 'function'),
  );
}

function appendInto(container, child) {
  if (!container || !child || container === child) return;
  if (child.parentNode === container) return;
  if (typeof container.appendChild === 'function') {
    container.appendChild(child);
  } else if (typeof container.append === 'function') {
    container.append(child);
  }
  if ('parentNode' in child && !child.parentNode) {
    try { child.parentNode = container; } catch {}
  }
}

function setPillAttributes(pill, formatted, variant, cameraId = null) {
  if (!pill || typeof pill !== 'object') return;
  const variantClass = `acoustic-pill--${variant}`;
  const expectedClass = `acoustic-pill ${variantClass}`;

  if (typeof pill.className === 'string' && pill.className.trim()) {
    const existing = pill.className
      .split(/\s+/)
      .filter(tok => tok && tok !== 'acoustic-pill--sidebar' && tok !== 'acoustic-pill--camera');
    if (!existing.includes('acoustic-pill')) existing.push('acoustic-pill');
    existing.push(variantClass);
    pill.className = existing.join(' ');
  } else {
    pill.className = expectedClass;
  }

  pill.classList?.remove?.(
    variant === 'sidebar' ? 'acoustic-pill--camera' : 'acoustic-pill--sidebar',
  );
  pill.classList?.add?.('acoustic-pill', variantClass);

  if (!pill.dataset || typeof pill.dataset !== 'object') {
    try {
      pill.dataset = {};
    } catch {
      // Read-only dataset on real HTMLElement already exists.
    }
  }

  if (pill.dataset && typeof pill.dataset === 'object') {
    pill.dataset.acousticState = formatted.state;
    pill.dataset.advisory = 'true';
    if (cameraId) {
      pill.dataset.cameraId = cameraId;
    } else if ('cameraId' in pill.dataset) {
      delete pill.dataset.cameraId;
    }
  }

  if (typeof pill.setAttribute === 'function') {
    pill.setAttribute('data-acoustic-state', formatted.state);
    pill.setAttribute('data-advisory', 'true');
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.setAttribute('aria-atomic', 'true');
    pill.setAttribute('title', ACOUSTIC_ADVISORY_TITLE);
    if (cameraId) {
      pill.setAttribute('data-camera-id', cameraId);
    } else if (typeof pill.removeAttribute === 'function') {
      pill.removeAttribute('data-camera-id');
    }
  }

  if ('title' in pill || typeof pill.setAttribute !== 'function') {
    try {
      pill.title = ACOUSTIC_ADVISORY_TITLE;
    } catch {
      // Ignore read-only mock properties if setAttribute already handled it.
    }
  }

  if (pill.textContent !== formatted.text) {
    pill.textContent = formatted.text;
  }
}

function isElementLike(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (typeof value.nodeType === 'number' || typeof value.setAttribute === 'function') &&
    !('sidebarContainer' in value) &&
    !('getCameraContainer' in value) &&
    !('ttlMs' in value),
  );
}

export function createTowerAcousticHud(rawOptions = {}, maybeSecondOptions = undefined) {
  const resolvedOptions = isElementLike(rawOptions)
    ? {
        ...(maybeSecondOptions && typeof maybeSecondOptions === 'object' ? maybeSecondOptions : {}),
        sidebarContainer: rawOptions,
      }
    : rawOptions && typeof rawOptions === 'object'
      ? rawOptions
      : {};

  const {
    sidebarContainer = null,
    getCameraContainer = null,
    airport = null,
    ttlMs = ACOUSTIC_TTL_MS,
    now = () => Date.now(),
    doc = globalThis.document ?? null,
    socket = null,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
  } = resolvedOptions;

  const effectiveTtlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : ACOUSTIC_TTL_MS;
  const readNow = typeof now === 'function' ? now : () => Date.now();

  const entries = new Map();
  const timers = new Map();
  const cameraPills = new Map();
  let sidebarPill = null;
  let currentAirport = normalizeAirport(airport);
  let detachCurrentSocket = null;
  let destroyed = false;

  function createPill(variant) {
    const el =
      doc && typeof doc.createElement === 'function'
        ? doc.createElement('span')
        : createFallbackPillElement();
    el.className = `acoustic-pill acoustic-pill--${variant}`;
    return el;
  }

  function cancelCameraTimer(id) {
    const handle = timers.get(id);
    if (handle !== undefined) {
      timers.delete(id);
      if (typeof clearTimer === 'function') {
        clearTimer(handle);
      }
    }
  }

  function scheduleCameraExpiry(id, receivedAt, currentNow) {
    cancelCameraTimer(id);
    if (destroyed || typeof setTimer !== 'function') return;
    const delay = Math.max(0, receivedAt + effectiveTtlMs - currentNow);
    const handle = setTimer(() => {
      timers.delete(id);
      if (!destroyed) sweep();
    }, delay);
    if (handle && typeof handle === 'object' && typeof handle.unref === 'function') {
      handle.unref();
    }
    timers.set(id, handle);
  }

  function formatEntry(entry, currentNow) {
    if (!entry) return inactiveResult();
    return formatAcousticPill(
      { ...entry.telemetry, updatedAt: entry.receivedAt },
      { ttlMs: effectiveTtlMs, now: () => currentNow },
    );
  }

  function computeSidebarSnapshot(currentNow) {
    let bestAdvisory = null;
    let firstMonitoring = null;

    for (const [id, entry] of entries.entries()) {
      const formatted = formatEntry(entry, currentNow);
      if (formatted.state === 'advisory') {
        const prob = Number.isFinite(entry.telemetry.droneProb)
          ? Math.min(1, Math.max(0, entry.telemetry.droneProb))
          : 0;
        if (
          !bestAdvisory ||
          prob > bestAdvisory.prob ||
          (prob === bestAdvisory.prob && entry.receivedAt > bestAdvisory.receivedAt)
        ) {
          bestAdvisory = { cameraId: id, prob, receivedAt: entry.receivedAt, formatted };
        }
      } else if (formatted.state === 'monitoring' && !firstMonitoring) {
        firstMonitoring = { cameraId: id, formatted };
      }
    }

    if (bestAdvisory) {
      return {
        ...bestAdvisory.formatted,
        cameraId: bestAdvisory.cameraId,
      };
    }
    if (firstMonitoring) {
      return {
        ...firstMonitoring.formatted,
        cameraId: firstMonitoring.cameraId,
      };
    }
    return {
      ...inactiveResult(),
      cameraId: null,
    };
  }

  function syncSidebar(currentNow = readNow()) {
    const state = computeSidebarSnapshot(currentNow);
    if (sidebarPill) {
      setPillAttributes(sidebarPill, state, 'sidebar', state.cameraId);
    }
    return state;
  }

  function sweep() {
    const currentNow = readNow();
    for (const [id, entry] of [...entries.entries()]) {
      const age = currentNow - entry.receivedAt;
      if (age < 0 || age >= effectiveTtlMs) {
        entries.delete(id);
        cancelCameraTimer(id);
        const pill = cameraPills.get(id);
        if (pill) {
          setPillAttributes(pill, inactiveResult(), 'camera', id);
        }
      }
    }
    return syncSidebar(currentNow);
  }

  function mountSidebar(container) {
    if (!container || typeof container !== 'object') {
      if (!sidebarPill) {
        sidebarPill = createPill('sidebar');
        syncSidebar();
      }
      return sidebarPill;
    }

    if (hasClassToken(container, 'acoustic-pill') || !canAppendChild(container)) {
      sidebarPill = container;
    } else {
      if (!sidebarPill || sidebarPill === container) {
        sidebarPill = createPill('sidebar');
      }
      appendInto(container, sidebarPill);
    }

    sweep();
    return sidebarPill;
  }

  function mountCamera(cameraId, container = null) {
    const id = normalizeCameraId(cameraId);
    if (!id) return null;

    const target =
      container ??
      (typeof getCameraContainer === 'function' ? getCameraContainer(id) : null);

    let pill = cameraPills.get(id) ?? null;

    if (target && typeof target === 'object') {
      if (hasClassToken(target, 'acoustic-pill') || !canAppendChild(target)) {
        pill = target;
      } else {
        if (!pill || pill === target) {
          pill = createPill('camera');
        }
        appendInto(target, pill);
      }
    } else if (!pill) {
      pill = createPill('camera');
    }

    cameraPills.set(id, pill);
    const state = getState(id);
    setPillAttributes(pill, state, 'camera', id);
    return pill;
  }

  function getState(cameraId) {
    const id = normalizeCameraId(cameraId);
    if (!id) return inactiveResult();
    const currentNow = readNow();
    const entry = entries.get(id);
    if (!entry) return inactiveResult();

    const age = currentNow - entry.receivedAt;
    if (age < 0 || age >= effectiveTtlMs) {
      entries.delete(id);
      cancelCameraTimer(id);
      const pill = cameraPills.get(id);
      if (pill) {
        setPillAttributes(pill, inactiveResult(), 'camera', id);
      }
      syncSidebar(currentNow);
      return inactiveResult();
    }

    return formatEntry(entry, currentNow);
  }

  function clearCamera(cameraId) {
    const id = normalizeCameraId(cameraId);
    if (!id) return inactiveResult();
    entries.delete(id);
    cancelCameraTimer(id);
    const pill = cameraPills.get(id);
    const inactive = inactiveResult();
    if (pill) {
      setPillAttributes(pill, inactive, 'camera', id);
    }
    syncSidebar();
    return inactive;
  }

  function update(payload) {
    if (destroyed || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    if (hasRawAudioFields(payload)) {
      return null;
    }
    const id = normalizeCameraId(payload.cameraId);
    if (!id) {
      return null;
    }
    if (
      payload.demo === true ||
      payload.isDemo === true ||
      (payload.source !== undefined && payload.source !== 'live') ||
      (payload.sourceMode !== undefined && payload.sourceMode !== 'live')
    ) {
      return null;
    }

    const packetAirport = normalizeAirport(payload.airport);
    if (currentAirport && packetAirport && packetAirport !== currentAirport) {
      return null;
    }

    if (payload.active === false) {
      clearCamera(id);
      return getState(id);
    }

    if (
      payload.updatedAt !== undefined &&
      payload.updatedAt !== null &&
      (typeof payload.updatedAt !== 'number' || !Number.isFinite(payload.updatedAt))
    ) {
      return null;
    }

    const currentNow = readNow();
    const receivedAt = Number.isFinite(payload.updatedAt) ? payload.updatedAt : currentNow;

    const existing = entries.get(id);
    if (existing && Number.isFinite(payload.updatedAt) && payload.updatedAt < existing.receivedAt) {
      return getState(id);
    }

    const candidateTelemetry = {
      active: payload.active ?? true,
      source: 'live',
      droneProb: payload.droneProb,
      dominantHz: payload.dominantHz,
      humDetected: payload.humDetected,
      updatedAt: receivedAt,
    };

    const formatted = formatAcousticPill(candidateTelemetry, {
      ttlMs: effectiveTtlMs,
      now: () => currentNow,
    });

    if (typeof getCameraContainer === 'function') {
      const existingPill = cameraPills.get(id);
      if (!existingPill || !existingPill.parentNode) {
        const autoContainer = getCameraContainer(id);
        if (autoContainer) {
          mountCamera(id, autoContainer);
        }
      }
    }

    if (!formatted.active) {
      clearCamera(id);
      return formatted;
    }

    entries.set(id, {
      cameraId: id,
      cameraLabel: typeof payload.cameraLabel === 'string' ? payload.cameraLabel : null,
      receivedAt,
      telemetry: candidateTelemetry,
    });

    const pill = cameraPills.get(id);
    if (pill) {
      setPillAttributes(pill, formatted, 'camera', id);
    }

    scheduleCameraExpiry(id, receivedAt, currentNow);
    sweep();
    return formatted;
  }

  function reset() {
    for (const id of [...timers.keys()]) {
      cancelCameraTimer(id);
    }
    entries.clear();
    const inactive = inactiveResult();
    for (const [id, pill] of cameraPills.entries()) {
      setPillAttributes(pill, inactive, 'camera', id);
    }
    syncSidebar();
  }

  function setAirport(nextAirport) {
    const normalized = normalizeAirport(nextAirport);
    if (normalized !== currentAirport) {
      currentAirport = normalized;
      reset();
    }
    return currentAirport;
  }

  function detachSocket() {
    if (typeof detachCurrentSocket === 'function') {
      const fn = detachCurrentSocket;
      detachCurrentSocket = null;
      fn();
    }
  }

  function attachSocket(sock) {
    detachSocket();
    if (!sock || typeof sock.on !== 'function') {
      return () => {};
    }

    const onAudio = packet => {
      update(packet);
    };
    const onCameraStatus = statusPacket => {
      if (statusPacket && statusPacket.online === false && statusPacket.cameraId) {
        clearCamera(statusPacket.cameraId);
      }
    };
    const onDisconnect = () => {
      reset();
    };

    sock.on('bot:audio', onAudio);
    sock.on('camera:status', onCameraStatus);
    sock.on('disconnect', onDisconnect);

    let active = true;
    const detach = () => {
      if (!active) return;
      active = false;
      const remove =
        typeof sock.off === 'function'
          ? (ev, fn) => sock.off(ev, fn)
          : typeof sock.removeListener === 'function'
            ? (ev, fn) => sock.removeListener(ev, fn)
            : null;
      if (remove) {
        remove('bot:audio', onAudio);
        remove('camera:status', onCameraStatus);
        remove('disconnect', onDisconnect);
      }
      if (detachCurrentSocket === detach) {
        detachCurrentSocket = null;
      }
    };

    detachCurrentSocket = detach;
    return detach;
  }

  function destroy() {
    if (destroyed) return;
    detachSocket();
    reset();
    destroyed = true;
  }

  if (sidebarContainer) {
    mountSidebar(sidebarContainer);
  }
  if (socket) {
    attachSocket(socket);
  }

  return {
    mountSidebar,
    mountCamera,
    ensureCameraPill: mountCamera,
    update,
    receive: update,
    onBotAudio: update,
    clearCamera,
    removeCamera: clearCamera,
    setAirport,
    sweep,
    getState,
    getSidebarState: () => sweep(),
    getCameraPill: cameraId => {
      const id = normalizeCameraId(cameraId);
      return id ? (cameraPills.get(id) ?? null) : null;
    },
    getSidebarPill: () => sidebarPill,
    attachSocket,
    detachSocket,
    reset,
    destroy,
    dispose: destroy,
    stop: destroy,
  };
}
