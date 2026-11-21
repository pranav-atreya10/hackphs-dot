// Admin Deployment & Subsystem Readiness panel controller for #diagPanel on admin.html.

const SUBSYSTEM_META = [
  ['video_detector', 'Video Detector'],
  ['airport_registry', 'Airport Registry'],
  ['camera_access', 'Camera Access'],
  ['tower_access', 'Tower Access'],
  ['receipt_storage', 'Receipt Storage'],
  ['receipt_recovery', 'Receipt Recovery'],
];

const CHECK_LABELS = {
  ready: 'READY',
  not_configured: 'NOT CONFIGURED',
  unavailable: 'UNAVAILABLE',
  timed_out: 'TIMED OUT',
  degraded: 'DEGRADED',
};

const MODE_LABELS = {
  local_ai_model: 'Local AI Model',
  local_ai_model_onnx: 'Local AI Model (ONNX)',
  local_fallback: 'Local Fallback',
  cloud_advisory_model: 'Cloud Advisory Model',
  off: 'Disabled',
  clerk_mongodb: 'Clerk + MongoDB',
  tower_key: 'Bound Tower Key',
  tower_key_and_clerk: 'Tower Key + Clerk',
  local_demo: 'Local Loopback Demo',
  unconfigured: 'Unconfigured',
  misconfigured: 'Misconfigured',
  invalid: 'Invalid',
};

function createNoopHandle() {
  return {
    element: null,
    refresh: async () => null,
    destroy() {},
  };
}

function isMountableContainer(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (!tag || tag === 'CANVAS') return false;
  return typeof el.appendChild === 'function' || typeof el.replaceChildren === 'function';
}

function resolveDocument(containerEl, options) {
  if (options?.document && typeof options.document.createElement === 'function') {
    return options.document;
  }
  if (containerEl?.ownerDocument && typeof containerEl.ownerDocument.createElement === 'function') {
    return containerEl.ownerDocument;
  }
  if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
    return document;
  }
  return null;
}

function sanitizeDisplayCopy(value) {
  return String(value ?? '').replace(/gemini/gi, 'Cloud Advisory Model');
}

function makeEl(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = sanitizeDisplayCopy(text);
  return node;
}

function replaceContainerContent(containerEl, childNode) {
  if (typeof containerEl.replaceChildren === 'function') {
    containerEl.replaceChildren(childNode);
    return;
  }
  while (containerEl.firstChild && typeof containerEl.removeChild === 'function') {
    containerEl.removeChild(containerEl.firstChild);
  }
  if (Array.isArray(containerEl.children)) {
    containerEl.children.length = 0;
  }
  containerEl.appendChild(childNode);
}

function normalizeEnvEntries(envChecklist) {
  if (!envChecklist) return [];
  if (Array.isArray(envChecklist)) {
    return envChecklist
      .filter(item => item && typeof item === 'object')
      .map((item, idx) => ({
        id: String(item.id || item.key || `item_${idx}`),
        label: item.label || item.key || `Setting ${idx + 1}`,
        required: Boolean(item.required),
        configured: Boolean(item.configured),
        valid: item.valid !== false,
        bound: typeof item.bound === 'boolean' ? item.bound : undefined,
        enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
        mode: typeof item.mode === 'string' ? item.mode : undefined,
        detail: typeof item.detail === 'string' ? item.detail : '',
      }));
  }
  if (typeof envChecklist === 'object') {
    return Object.entries(envChecklist)
      .filter(([, item]) => item && typeof item === 'object')
      .map(([key, item]) => ({
        id: key,
        label: item.label || key,
        required: Boolean(item.required),
        configured: Boolean(item.configured),
        valid: item.valid !== false,
        bound: typeof item.bound === 'boolean' ? item.bound : undefined,
        enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
        mode: typeof item.mode === 'string' ? item.mode : undefined,
        detail: typeof item.detail === 'string' ? item.detail : '',
      }));
  }
  return [];
}

function deriveOverallBadge(snapshot, envEntries) {
  if (!snapshot || snapshot.errorOnly) {
    return { state: 'action-required', text: 'ACTION REQUIRED' };
  }
  const explicit = typeof snapshot.status === 'string' ? snapshot.status.toLowerCase() : '';
  if (explicit === 'action_required' || explicit === 'action-required') {
    return { state: 'action-required', text: 'ACTION REQUIRED' };
  }
  if (envEntries.some(entry => !entry.valid)) {
    return { state: 'action-required', text: 'ACTION REQUIRED' };
  }
  if (explicit === 'ready') {
    return { state: 'ready', text: 'READY' };
  }
  if (explicit === 'degraded' || explicit === 'not_ready') {
    return { state: 'degraded', text: 'DEGRADED' };
  }
  if (snapshot.readiness?.ready === true) {
    return { state: 'ready', text: 'READY' };
  }
  return { state: 'degraded', text: 'DEGRADED' };
}

function formatUptime(uptimeSec) {
  const sec = Math.max(0, Math.floor(Number(uptimeSec) || 0));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

export function renderDiagnosticsSnapshot(containerEl, snapshot = {}, options = {}) {
  if (!isMountableContainer(containerEl)) {
    return createNoopHandle();
  }
  const doc = resolveDocument(containerEl, options);
  if (!doc) {
    return createNoopHandle();
  }

  const safeSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const envEntries = normalizeEnvEntries(safeSnapshot.envChecklist);
  const badgeInfo = deriveOverallBadge(safeSnapshot, envEntries);

  containerEl.classList?.add?.('diag-panel');
  const root = makeEl(doc, 'div', 'diag-root');

  // 1. Header with title, runtime summary, overall status badge, and Refresh button
  const head = makeEl(doc, 'div', 'diag-head');
  const titleWrap = makeEl(doc, 'div', 'diag-title-wrap');
  const heading = makeEl(doc, 'h2', 'diag-title', 'Deployment & Subsystem Readiness');
  titleWrap.appendChild(heading);

  const metaParts = [];
  if (safeSnapshot.environment) metaParts.push(`env: ${safeSnapshot.environment}`);
  if (safeSnapshot.nodeVersion) metaParts.push(`Node ${safeSnapshot.nodeVersion}`);
  if (Number.isFinite(Number(safeSnapshot.uptimeSec))) metaParts.push(`uptime ${formatUptime(safeSnapshot.uptimeSec)}`);
  if (metaParts.length > 0) {
    const meta = makeEl(doc, 'p', 'diag-meta', metaParts.join(' · '));
    titleWrap.appendChild(meta);
  }
  head.appendChild(titleWrap);

  const actions = makeEl(doc, 'div', 'diag-actions');
  const badge = makeEl(doc, 'span', 'diag-badge', badgeInfo.text);
  badge.setAttribute('data-state', badgeInfo.state);
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');
  actions.appendChild(badge);

  const refreshBtn = makeEl(
    doc,
    'button',
    'ghost diag-refresh-btn',
    options.loading ? 'Refreshing…' : 'Refresh'
  );
  refreshBtn.type = 'button';
  refreshBtn.disabled = Boolean(options.loading);
  if (typeof options.onRefreshClick === 'function') {
    refreshBtn.addEventListener('click', options.onRefreshClick);
  }
  actions.appendChild(refreshBtn);
  head.appendChild(actions);
  root.appendChild(head);

  if (safeSnapshot.errorMessage) {
    const errBox = makeEl(doc, 'p', 'diag-error', safeSnapshot.errorMessage);
    errBox.setAttribute('role', 'alert');
    root.appendChild(errBox);
  }

  // 2. Subsystem readiness check grid
  const checksObj =
    safeSnapshot.readiness && typeof safeSnapshot.readiness.checks === 'object' && safeSnapshot.readiness.checks !== null
      ? safeSnapshot.readiness.checks
      : {};

  const gridTitle = makeEl(doc, 'h3', 'diag-section-title', 'Subsystem probes (/ready)');
  root.appendChild(gridTitle);

  const grid = makeEl(doc, 'div', 'diag-grid');
  grid.setAttribute('role', 'list');

  const seenKeys = new Set();
  const orderedPairs = [...SUBSYSTEM_META];
  for (const extraKey of Object.keys(checksObj)) {
    if (!SUBSYSTEM_META.some(([k]) => k === extraKey)) {
      orderedPairs.push([extraKey, extraKey.replace(/_/g, ' ')]);
    }
  }

  for (const [checkKey, humanName] of orderedPairs) {
    if (seenKeys.has(checkKey)) continue;
    seenKeys.add(checkKey);
    const rawState = typeof checksObj[checkKey] === 'string'
      ? checksObj[checkKey].trim().toLowerCase()
      : 'unavailable';
    const stateText = CHECK_LABELS[rawState] || rawState.toUpperCase();
    const tone = rawState === 'ready' ? 'ok' : (rawState === 'not_configured' ? 'warn' : 'bad');

    const item = makeEl(doc, 'div', 'diag-item');
    item.setAttribute('role', 'listitem');
    item.setAttribute('data-check', sanitizeDisplayCopy(checkKey));
    item.setAttribute('data-status', sanitizeDisplayCopy(rawState));

    const itemTop = makeEl(doc, 'div', 'diag-item-top');
    const nameEl = makeEl(doc, 'span', 'diag-item-name', humanName);
    const pillEl = makeEl(doc, 'span', 'diag-pill', stateText);
    pillEl.setAttribute('data-tone', tone);
    itemTop.appendChild(nameEl);
    itemTop.appendChild(pillEl);

    const codeEl = makeEl(doc, 'code', 'diag-item-key', checkKey);
    item.appendChild(itemTop);
    item.appendChild(codeEl);
    grid.appendChild(item);
  }
  root.appendChild(grid);

  // 3. Environment binding checklist (strictly boolean status pills, zero secrets)
  if (envEntries.length > 0) {
    const envTitle = makeEl(doc, 'h3', 'diag-section-title', 'Environment bindings (redacted)');
    root.appendChild(envTitle);

    const envList = makeEl(doc, 'ul', 'diag-env-list');
    for (const entry of envEntries) {
      const li = makeEl(doc, 'li', 'diag-env-item');
      li.setAttribute('data-env-key', sanitizeDisplayCopy(entry.id));
      li.setAttribute('data-valid', entry.valid ? 'true' : 'false');

      const info = makeEl(doc, 'div', 'diag-env-info');
      const labelEl = makeEl(doc, 'strong', 'diag-env-label', entry.label);
      info.appendChild(labelEl);
      if (entry.detail) {
        const detailEl = makeEl(doc, 'span', 'diag-env-detail', entry.detail);
        info.appendChild(detailEl);
      }

      const pills = makeEl(doc, 'div', 'diag-env-pills');
      const cfgPill = makeEl(
        doc,
        'span',
        'diag-pill',
        entry.configured ? 'Configured' : (entry.required ? 'Missing' : 'Optional / Unset')
      );
      cfgPill.setAttribute(
        'data-tone',
        entry.configured ? 'ok' : (entry.required ? 'bad' : 'neutral')
      );
      pills.appendChild(cfgPill);

      if (typeof entry.bound === 'boolean') {
        const boundPill = makeEl(doc, 'span', 'diag-pill', entry.bound ? 'Bound' : 'Unbound');
        boundPill.setAttribute('data-tone', entry.bound ? 'ok' : 'bad');
        pills.appendChild(boundPill);
      } else {
        const validPill = makeEl(doc, 'span', 'diag-pill', entry.valid ? 'Valid' : 'Invalid');
        validPill.setAttribute('data-tone', entry.valid ? 'ok' : 'bad');
        pills.appendChild(validPill);
      }

      if (entry.mode) {
        const mappedMode = MODE_LABELS[entry.mode.toLowerCase()] || entry.mode;
        const modePill = makeEl(doc, 'span', 'diag-pill', mappedMode);
        modePill.setAttribute('data-tone', entry.valid ? 'neutral' : 'bad');
        pills.appendChild(modePill);
      }

      li.appendChild(info);
      li.appendChild(pills);
      envList.appendChild(li);
    }
    root.appendChild(envList);
  }

  // 4. Remediation guidance
  const steps = Array.isArray(safeSnapshot.remediation)
    ? safeSnapshot.remediation.filter(s => typeof s === 'string' && s.trim())
    : [];

  const remSection = makeEl(doc, 'div', 'diag-remediation');
  const remTitle = makeEl(doc, 'h3', 'diag-section-title', 'Operator remediation');
  remSection.appendChild(remTitle);

  if (steps.length > 0) {
    const ul = makeEl(doc, 'ul', 'diag-remediation-list');
    for (const step of steps) {
      const li = makeEl(doc, 'li', 'diag-remediation-item', step);
      ul.appendChild(li);
    }
    remSection.appendChild(ul);
  } else {
    const okNote = makeEl(
      doc,
      'p',
      'diag-remediation-empty',
      'All required environment bindings and readiness probes are healthy.'
    );
    remSection.appendChild(okNote);
  }
  root.appendChild(remSection);

  replaceContainerContent(containerEl, root);

  return {
    element: root,
    refreshButton: refreshBtn,
    refresh: async () => safeSnapshot,
    destroy() {
      if (typeof options.onRefreshClick === 'function') {
        refreshBtn.removeEventListener('click', options.onRefreshClick);
      }
    },
  };
}

export function mountAdminDiagnostics(containerEl, options = {}) {
  if (!isMountableContainer(containerEl)) {
    return createNoopHandle();
  }
  const doc = resolveDocument(containerEl, options);
  if (!doc) {
    return createNoopHandle();
  }

  const endpoint = typeof options.endpoint === 'string' && options.endpoint.trim()
    ? options.endpoint.trim()
    : (typeof options.url === 'string' && options.url.trim() ? options.url.trim() : '/api/deploy-diagnostics');

  let destroyed = false;
  let activeAbort = null;
  let currentRendered = null;
  let latestSnapshot = null;

  if (options.showPanel !== false && 'hidden' in containerEl) {
    containerEl.hidden = false;
  }

  const detachCurrentButton = () => {
    if (currentRendered && typeof currentRendered.destroy === 'function') {
      currentRendered.destroy();
      currentRendered = null;
    }
  };

  const renderState = (snap, loading = false) => {
    if (destroyed) return;
    detachCurrentButton();
    containerEl.setAttribute?.('aria-busy', loading ? 'true' : 'false');
    currentRendered = renderDiagnosticsSnapshot(containerEl, snap, {
      document: doc,
      loading,
      onRefreshClick: handleRefreshClick,
    });
  };

  async function refresh() {
    if (destroyed) return null;
    const fetchFn = options.fetch ?? options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    if (typeof fetchFn !== 'function') {
      renderState({
        status: 'action_required',
        errorOnly: true,
        errorMessage: 'Browser fetch API is unavailable in this environment.',
        readiness: { ready: false, checks: {} },
        remediation: ['Open /admin.html in a modern browser with fetch support.'],
      }, false);
      return null;
    }

    if (activeAbort) {
      activeAbort.abort();
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeAbort = controller;

    renderState(latestSnapshot || {
      status: 'degraded',
      readiness: { ready: false, checks: {} },
      remediation: [],
    }, true);

    try {
      const headers = {
        accept: 'application/json',
        ...(options.headers || {}),
      };
      if (typeof options.getToken === 'function') {
        const token = await options.getToken();
        if (token) headers.authorization = `Bearer ${token}`;
      }

      const res = await fetchFn(endpoint, {
        method: 'GET',
        headers,
        signal: controller ? controller.signal : undefined,
      });

      if (destroyed || activeAbort !== controller) return null;

      const status = Number(res?.status) || 0;
      if (status === 200 || status === 503) {
        const payload = await res.json();
        if (destroyed || activeAbort !== controller) return null;
        latestSnapshot = payload;
        renderState(payload, false);
        if (typeof options.onRefresh === 'function') {
          options.onRefresh(payload);
        }
        return payload;
      }

      let serverErr = '';
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') serverErr = body.error;
      } catch {
        serverErr = '';
      }

      const fallbackMessage = status === 404
        ? 'Diagnostics endpoint returned HTTP 404 (server may still be running an older deployment).'
        : (serverErr || `Diagnostics request failed with HTTP ${status || 'error'}.`);

      renderState({
        status: 'action_required',
        errorOnly: true,
        errorMessage: fallbackMessage,
        readiness: { ready: false, checks: {} },
        remediation: status === 404
          ? ['Verify DigitalOcean App Platform environment variables so the latest deployment can boot cleanly.']
          : ['Confirm your admin session is active and retry Refresh.'],
      }, false);
      return null;
    } catch (err) {
      if (destroyed || err?.name === 'AbortError') return null;
      renderState({
        status: 'action_required',
        errorOnly: true,
        errorMessage: `Could not load deployment diagnostics: ${err?.message || 'network error'}`,
        readiness: { ready: false, checks: {} },
        remediation: ['Check server connectivity and select Refresh to retry.'],
      }, false);
      return null;
    } finally {
      if (activeAbort === controller) {
        activeAbort = null;
      }
    }
  }

  function handleRefreshClick(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    void refresh();
  }

  if (options.immediate !== false && options.autoLoad !== false) {
    void refresh();
  } else {
    renderState(options.initialSnapshot || {
      status: 'degraded',
      readiness: { ready: false, checks: {} },
      remediation: [],
    }, false);
  }

  return {
    element: containerEl,
    refresh,
    destroy() {
      destroyed = true;
      if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
      }
      detachCurrentButton();
      containerEl.setAttribute?.('aria-busy', 'false');
    },
  };
}
