// Inline SHA-256 and Solana devnet proof drawer for SkySentry incident details.
// Pure ES module compatible with browsers, jsdom, and lightweight mock DOM nodes.

export const VALID_SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export const PROOF_ADVISORY_NOTE =
  'Advisory note: A SHA-256 hash and Solana devnet memo prove report text integrity (that the text was not altered after stamping), not detection or classification accuracy.';

const mountedDrawers = new WeakMap();

const STATUS_HEADINGS = {
  verified_on_chain: 'Verified on Solana devnet',
  hash_mismatch: 'Hash mismatch — report text differs from recorded fingerprint',
  hash_only: 'Local SHA-256 verified — no Solana devnet transaction stamped',
  rpc_unavailable: 'Solana devnet RPC unavailable — showing local SHA-256',
};

function createUnmountedController() {
  return {
    element: null,
    button: null,
    card: null,
    verify: async () => null,
    getState: () => ({ status: 'unmounted' }),
    destroy() {},
  };
}

function setClasses(el, ...names) {
  if (!el) return;
  const clean = names.filter(Boolean);
  const joined = clean.join(' ');
  if (typeof el.setAttribute === 'function') {
    el.setAttribute('class', joined);
  }
  if ('className' in el && el.className !== joined) {
    el.className = joined;
  }
  if (el.classList && typeof el.classList.add === 'function') {
    for (const cls of clean) {
      if (typeof el.classList.contains !== 'function' || !el.classList.contains(cls)) {
        el.classList.add(cls);
      }
    }
  }
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

function appendNodes(parent, ...nodes) {
  if (!parent) return;
  const valid = nodes.filter(Boolean);
  if (!valid.length) return;
  if (typeof parent.append === 'function') {
    parent.append(...valid);
    return;
  }
  if (typeof parent.appendChild === 'function') {
    for (const node of valid) parent.appendChild(node);
    return;
  }
  if (Array.isArray(parent.children)) {
    parent.children.push(...valid);
  }
}

function replaceNodeChildren(parent, nodes) {
  if (!parent) return;
  const valid = nodes.filter(Boolean);
  if (typeof parent.replaceChildren === 'function') {
    parent.replaceChildren(...valid);
    return;
  }
  if (typeof parent.removeChild === 'function' && typeof parent.appendChild === 'function') {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    for (const node of valid) parent.appendChild(node);
    return;
  }
  if (Array.isArray(parent.children)) {
    parent.children = [...valid];
  }
}

function detachFromContainer(containerEl, childEl) {
  if (!childEl) return;
  if (typeof childEl.remove === 'function') {
    childEl.remove();
  } else if (childEl.parentNode && typeof childEl.parentNode.removeChild === 'function') {
    childEl.parentNode.removeChild(childEl);
  }
  if (containerEl && Array.isArray(containerEl.children)) {
    const idx = containerEl.children.indexOf(childEl);
    if (idx !== -1) containerEl.children.splice(idx, 1);
  }
}

function normalizeHash(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function hashesEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function buildDevnetExplorerUrl(tx) {
  if (typeof tx !== 'string') return null;
  const trimmed = tx.trim();
  if (!VALID_SOLANA_SIG_RE.test(trimmed)) return null;
  return 'https://explorer.solana.com/tx/' + encodeURIComponent(trimmed) + '?cluster=devnet';
}

function resolveExplorerHref(serverData, recordedTx) {
  const fromTx = buildDevnetExplorerUrl(serverData?.tx) || buildDevnetExplorerUrl(recordedTx);
  if (fromTx) return fromTx;
  if (typeof serverData?.explorer === 'string') {
    const trimmed = serverData.explorer.trim();
    if (trimmed.startsWith('https://explorer.solana.com/tx/')) {
      const match = /^https:\/\/explorer\.solana\.com\/tx\/([1-9A-HJ-NP-Za-km-z]{64,88})(?:\?cluster=devnet)?$/.exec(
        trimmed,
      );
      if (match) return buildDevnetExplorerUrl(match[1]);
    }
  }
  return null;
}

function describeComparison({ status, matches, localHash, serverHash, recordedHash }) {
  if (status === 'verified_on_chain') {
    return localHash
      ? 'Match — browser, server, and Solana devnet memo SHA-256 fingerprints are identical.'
      : 'Match — server SHA-256 matches confirmed Solana devnet memo (browser WebCrypto unavailable).';
  }
  if (status === 'hash_mismatch') {
    return 'Mismatch — computed SHA-256 does not match the recorded or on-chain fingerprint.';
  }
  if (status === 'hash_only') {
    if (matches === true) {
      return 'Match — browser and server SHA-256 fingerprints match; no Solana devnet transaction is stamped.';
    }
    return 'Hash recorded without a Solana devnet transaction (browser comparison unavailable).';
  }
  const referenceHash = serverHash || recordedHash;
  if (localHash && referenceHash && hashesEqual(localHash, referenceHash)) {
    return 'On-chain check unavailable; browser SHA-256 matches recorded server fingerprint.';
  }
  return 'Unable to verify against Solana devnet right now; local SHA-256 shown above.';
}

export async function computeReportSha256Hex(reportText, options = {}) {
  const { subtle = globalThis.crypto?.subtle } = options ?? {};
  if (typeof reportText !== 'string' || !subtle || typeof subtle.digest !== 'function') {
    return null;
  }
  if (typeof TextEncoder !== 'function') return null;
  try {
    const bytes = new TextEncoder().encode(reportText);
    const digest = await subtle.digest('SHA-256', bytes);
    if (!digest) return null;
    const view = ArrayBuffer.isView(digest)
      ? new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength)
      : new Uint8Array(digest);
    if (view.byteLength === 0) return null;
    let hex = '';
    for (let i = 0; i < view.length; i += 1) {
      hex += view[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null;
  }
}

export function mountSolanaProofDrawer(containerEl, incident, options = {}) {
  if (
    !containerEl ||
    typeof containerEl !== 'object' ||
    typeof containerEl.append !== 'function' ||
    !incident ||
    typeof incident !== 'object' ||
    Array.isArray(incident)
  ) {
    return createUnmountedController();
  }

  const doc = containerEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc || typeof doc.createElement !== 'function') {
    return createUnmountedController();
  }

  const {
    fetchImpl = globalThis.fetch,
    subtle = globalThis.crypto?.subtle,
    headers = {},
    getHeaders,
  } = options ?? {};

  const previous = mountedDrawers.get(containerEl);
  if (previous) {
    previous.destroy();
    detachFromContainer(containerEl, previous.element);
    mountedDrawers.delete(containerEl);
  }

  const drawer = doc.createElement('div');
  setClasses(drawer, 'sky-proof-drawer');
  setData(drawer, 'incidentId', String(incident._id ?? incident.id ?? ''));

  const button = doc.createElement('button');
  setClasses(button, 'ghost', 'sky-proof-btn');
  button.type = 'button';
  if (typeof button.setAttribute === 'function') {
    button.setAttribute('type', 'button');
    button.setAttribute('aria-expanded', 'false');
  }
  button.textContent = 'Verify SHA-256 / Solana Proof';

  const card = doc.createElement('div');
  setClasses(card, 'sky-proof-card');
  card.hidden = true;
  if (typeof card.setAttribute === 'function') {
    card.setAttribute('role', 'region');
    card.setAttribute('aria-live', 'polite');
    card.setAttribute('aria-label', 'SHA-256 and Solana devnet proof');
  }
  setData(card, 'proofStatus', 'idle');

  appendNodes(drawer, button, card);

  let activeAbort = null;
  let destroyed = false;
  let lastState = {
    status: 'idle',
    matches: null,
    localHash: null,
    serverHash: null,
    onChainHash: null,
    tx: null,
    explorerUrl: null,
  };

  function createNoteNode() {
    const noteEl = doc.createElement('p');
    setClasses(noteEl, 'sky-proof-note');
    noteEl.textContent = PROOF_ADVISORY_NOTE;
    return noteEl;
  }

  function createStatusNode(text) {
    const statusEl = doc.createElement('p');
    setClasses(statusEl, 'sky-proof-status');
    statusEl.textContent = text;
    return statusEl;
  }

  function createGridRow(gridEl, label, value, fieldKey) {
    const dt = doc.createElement('dt');
    dt.textContent = label;
    const dd = doc.createElement('dd');
    setData(dd, 'proofField', fieldKey);
    dd.textContent = value;
    appendNodes(gridEl, dt, dd);
  }

  async function fetchServerProof(incidentId, airport, signal) {
    if (!incidentId || typeof fetchImpl !== 'function') return null;
    try {
      const extraHeaders = typeof getHeaders === 'function' ? (await getHeaders()) || {} : {};
      if (signal.aborted) return null;
      const mergedHeaders = {
        Accept: 'application/json',
        ...(airport ? { 'x-airport': airport } : {}),
        ...(headers && typeof headers === 'object' ? headers : {}),
        ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
      };
      const query = airport ? `?airport=${encodeURIComponent(airport)}` : '';
      const url = `/api/incidents/${encodeURIComponent(incidentId)}/verify-solana${query}`;
      const response = await fetchImpl.call(globalThis, url, {
        headers: mergedHeaders,
        cache: 'no-store',
        signal,
      });
      if (!response || !response.ok || typeof response.json !== 'function') {
        return null;
      }
      const data = await response.json();
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  async function verify() {
    if (destroyed) return null;

    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    const controller = new AbortController();
    activeAbort = controller;

    card.hidden = false;
    if (typeof button.setAttribute === 'function') {
      button.setAttribute('aria-expanded', 'true');
    }
    button.disabled = true;
    setData(card, 'proofStatus', 'verifying');
    replaceNodeChildren(card, [
      createStatusNode('Computing SHA-256 fingerprint and checking Solana devnet…'),
      createNoteNode(),
    ]);

    const incidentId = String(incident._id ?? incident.id ?? '').trim();
    const airport = typeof incident.airport === 'string' ? incident.airport.trim() : '';
    const reportText = typeof incident.report === 'string' ? incident.report : '';
    const recordedHash = normalizeHash(incident.report_hash);
    const rawRecordedTx = typeof incident.solana_tx === 'string' ? incident.solana_tx.trim() : '';
    const recordedTx = rawRecordedTx || null;

    if (!reportText.trim()) {
      if (destroyed || activeAbort !== controller) return lastState;
      activeAbort = null;
      setData(card, 'proofStatus', 'report_unavailable');
      replaceNodeChildren(card, [
        createStatusNode('Report text is not available yet to compute a SHA-256 fingerprint.'),
        createNoteNode(),
      ]);
      button.disabled = false;
      lastState = {
        status: 'report_unavailable',
        matches: null,
        localHash: null,
        serverHash: null,
        onChainHash: null,
        tx: null,
        explorerUrl: null,
      };
      return lastState;
    }

    const [localHash, serverData] = await Promise.all([
      computeReportSha256Hex(reportText, { subtle }),
      fetchServerProof(incidentId, airport, controller.signal),
    ]);

    if (destroyed || activeAbort !== controller || controller.signal.aborted) {
      return lastState;
    }
    activeAbort = null;

    const serverHash = normalizeHash(serverData?.reportHash);
    const onChainHash = normalizeHash(serverData?.onChainHash);

    let status;
    let matches;
    if (serverData?.status === 'verified_on_chain') {
      if (
        !onChainHash ||
        (localHash && !hashesEqual(localHash, onChainHash)) ||
        (localHash && serverHash && !hashesEqual(localHash, serverHash)) ||
        (serverHash && !hashesEqual(serverHash, onChainHash)) ||
        (recordedHash && !hashesEqual(recordedHash, onChainHash))
      ) {
        status = 'hash_mismatch';
        matches = false;
      } else {
        status = 'verified_on_chain';
        matches = true;
      }
    } else if (
      serverData?.status === 'hash_mismatch' ||
      (localHash && recordedHash && !hashesEqual(localHash, recordedHash)) ||
      (localHash && serverHash && !hashesEqual(localHash, serverHash))
    ) {
      status = 'hash_mismatch';
      matches = false;
    } else if (serverData?.status === 'hash_only') {
      status = 'hash_only';
      matches = localHash && serverHash ? hashesEqual(localHash, serverHash) : null;
    } else {
      status = 'rpc_unavailable';
      matches = false;
    }

    const explorerHref = resolveExplorerHref(serverData, recordedTx);
    const safeServerTx =
      typeof serverData?.tx === 'string' && VALID_SOLANA_SIG_RE.test(serverData.tx.trim())
        ? serverData.tx.trim()
        : null;
    const safeRecordedTx =
      typeof recordedTx === 'string' && VALID_SOLANA_SIG_RE.test(recordedTx) ? recordedTx : null;
    const resolvedTx = safeServerTx ?? safeRecordedTx;

    const statusNode = createStatusNode(STATUS_HEADINGS[status] || STATUS_HEADINGS.rpc_unavailable);
    const gridEl = doc.createElement('dl');
    setClasses(gridEl, 'sky-proof-grid');
    createGridRow(
      gridEl,
      'Browser SHA-256 (WebCrypto)',
      localHash || 'WebCrypto unavailable in this context',
      'local-hash',
    );
    createGridRow(
      gridEl,
      'Server SHA-256',
      serverHash || recordedHash || 'Unavailable',
      'server-hash',
    );
    createGridRow(
      gridEl,
      'Devnet Memo SHA-256',
      onChainHash || (status === 'hash_only' ? 'Not stamped on-chain' : 'Unavailable'),
      'onchain-hash',
    );
    createGridRow(
      gridEl,
      'Comparison',
      describeComparison({ status, matches, localHash, serverHash, recordedHash }),
      'comparison',
    );

    let linkEl = null;
    if (explorerHref) {
      linkEl = doc.createElement('a');
      setClasses(linkEl, 'sky-proof-link');
      linkEl.href = explorerHref;
      linkEl.target = '_blank';
      linkEl.rel = 'noopener noreferrer';
      if (typeof linkEl.setAttribute === 'function') {
        linkEl.setAttribute('href', explorerHref);
        linkEl.setAttribute('target', '_blank');
        linkEl.setAttribute('rel', 'noopener noreferrer');
      }
      linkEl.textContent = 'Inspect transaction on Solana Devnet Explorer';
    }

    setData(card, 'proofStatus', status);
    replaceNodeChildren(card, [statusNode, gridEl, linkEl, createNoteNode()]);
    button.disabled = false;

    lastState = {
      status,
      matches,
      localHash,
      serverHash: serverHash ?? null,
      onChainHash: onChainHash ?? null,
      tx: resolvedTx,
      explorerUrl: explorerHref,
    };
    return lastState;
  }

  const onButtonClick = () => {
    void verify();
  };
  if (typeof button.addEventListener === 'function') {
    button.addEventListener('click', onButtonClick);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (activeAbort) {
      activeAbort.abort();
      activeAbort = null;
    }
    if (typeof button.removeEventListener === 'function') {
      button.removeEventListener('click', onButtonClick);
    }
    detachFromContainer(containerEl, drawer);
    if (mountedDrawers.get(containerEl) === handle) {
      mountedDrawers.delete(containerEl);
    }
  }

  const handle = {
    element: drawer,
    button,
    card,
    verify,
    getState: () => lastState,
    destroy,
  };

  containerEl.append(drawer);
  mountedDrawers.set(containerEl, handle);
  return handle;
}
