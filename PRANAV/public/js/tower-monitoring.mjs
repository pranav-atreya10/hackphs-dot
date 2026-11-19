export const RISK_RANK = Object.freeze({ green: 0, yellow: 1, red: 2 });
const LIVE_MS = 10_000;
const STATE_MS = 3_000;
const MAX_CLOCK_LEAD_MS = 2_000;

const fresh = (at, now, maxAge) => Number.isFinite(at) && now - at < maxAge && at - now <= MAX_CLOCK_LEAD_MS;
export const operational = packet => packet && packet.demo !== true && packet.isDemo !== true &&
  !['demo', 'recorded', 'upload', 'file'].includes(packet.source) &&
  !['demo', 'recorded', 'upload', 'file'].includes(packet.sourceMode);
const cameraId = packet => operational(packet) && typeof packet.cameraId === 'string' && packet.cameraId.trim()
  ? packet.cameraId : null;
const isRisk = level => typeof level === 'string' && Object.hasOwn(RISK_RANK, level);

export function imageEta(event) {
  return event?.eta_basis === 'image_space_corridor' && Number.isFinite(event.eta_seconds) && event.eta_seconds >= 0
    ? event.eta_seconds : null;
}

function detectorStatus(state) {
  if (state.motion?.shake === true || state.shake === true) return 'unstable';
  if (state.motion?.ready === false || state.learning === true || state.ready === false) return 'warming';
  if (state.motion?.overflow === true || state.overflow === true) return 'unstable';
  if (state.motion?.ready !== true && state.learning !== false && state.ready !== true) return 'no detector data';
  return 'ready';
}

function stronger(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.risk !== b.risk) return RISK_RANK[a.risk] > RISK_RANK[b.risk] ? a : b;
  // Prefer a contract event on ties for its richer target description and bearing.
  return a.cameraId === b.cameraId && a.fromState !== b.fromState ? (a.fromState ? b : a)
    : b.receivedAt > a.receivedAt || (b.receivedAt === a.receivedAt && b.cameraId < a.cameraId) ? b : a;
}

export function createTowerMonitoring(clock = Date.now) {
  const cameras = new Map();
  let connected = false;
  function get(packet) {
    const id = cameraId(packet);
    if (!connected || !id) return null;
    if (!cameras.has(id)) cameras.set(id, { id });
    const cam = cameras.get(id);
    if (typeof packet.cameraLabel === 'string' && packet.cameraLabel.trim()) cam.label = packet.cameraLabel;
    return cam;
  }
  function presence(packet, source, online = true) {
    const now = clock();
    const at = packet?.at ?? now;
    if (!cameraId(packet) || !fresh(at, now, LIVE_MS)) return false;
    const cam = get(packet);
    if (!cam || (source === 'status' && (cam.statusAt ?? -Infinity) > at)) return false;
    if (source === 'status') cam.statusAt = at;
    if (!online) {
      cam.offlineAt = at;
      cam.lastLiveAt = cam.event = cam.state = undefined;
      return true;
    }
    if (cam.offlineAt !== undefined) {
      if (source !== 'status' || at <= cam.offlineAt) return false;
      cam.restartedAt = at;
      cam.offlineAt = undefined;
    }
    cam.lastLiveAt = Math.max(cam.lastLiveAt ?? -Infinity, at);
    return true;
  }
  return {
    setConnected(value) {
      if (connected === value) return;
      connected = value;
      for (const cam of cameras.values()) {
        // Keep the known coverage inventory, but never carry detector data across socket lifetimes.
        cam.lastLiveAt = cam.offlineAt = cam.statusAt = cam.restartedAt = cam.event = cam.state = cam.mode = cam.generation = undefined;
      }
    },
    status(packet) {
      return typeof packet?.online === 'boolean' && presence(packet, 'status', packet.online);
    },
    heartbeat(packet) {
      return packet?.online !== false && presence(packet, 'heartbeat');
    },
    mode(packet) {
      if (!['server', 'tower', 'starting', 'unavailable'].includes(packet?.mode)) return false;
      const cam = get(packet);
      if (packet.at != null && !fresh(packet.at, clock(), LIVE_MS)) return false;
      const generation = packet.generation ?? undefined;
      if (!cam || (cam.mode === packet.mode && cam.generation === generation)) return false;
      cam.state = undefined;
      cam.mode = packet.mode;
      cam.generation = generation;
      return true;
    },
    detector(packet) {
      const now = clock();
      const at = packet?.at;
      const state = packet?.state;
      const risk = state?.risk?.level ?? state?.risk;
      if (!operational(state) || !isRisk(risk) || !fresh(at, now, STATE_MS)) return false;
      // The producer's remaining TTL starts at its packet timestamp, not at delivery.
      const remaining = packet.remaining_ms === undefined ? STATE_MS : packet.remaining_ms;
      if (!Number.isFinite(remaining) || remaining <= 0) return false;
      const expiresAt = at + Math.min(remaining, STATE_MS);
      if (now >= expiresAt) return false;
      const cam = get(packet);
      const mode = packet.mode ?? 'server';
      if (!cam || cam.offlineAt !== undefined || at < (cam.restartedAt ?? -Infinity) ||
          at < (cam.state?.at ?? -Infinity) || mode !== 'server' ||
          (cam.mode && cam.mode !== mode) || (cam.generation !== undefined && state.generation !== cam.generation)) return false;
      if (!presence({ ...packet, at }, 'heartbeat')) return false;
      const status = detectorStatus(state), p = state.primary;
      const target = ['bird', 'drone', 'unknown'].includes(p?.classification) ? p.classification : 'unknown';
      cam.state = { at, expiresAt, status, reading: {
        cameraId: cam.id, receivedAt: at, risk, fromState: true,
        type: risk === 'green' ? 'none' : target, classification: target,
        flock_size: p?.size, direction: p?.heading?.name ?? p?.heading, bearing_deg: p?.bearing_deg,
        eta_seconds: p?.eta_seconds, eta_basis: p?.eta_basis ?? state.eta_basis,
      } };
      return true;
    },
    event(packet) {
      const now = clock(), at = packet?.receivedAt ?? now;
      if (!isRisk(packet?.risk) || !fresh(at, now, LIVE_MS)) return null;
      const cam = get(packet);
      if (!cam || cam.offlineAt !== undefined || at < (cam.restartedAt ?? -Infinity) ||
          at < (cam.event?.receivedAt ?? -Infinity)) return null;
      // Older relays may have event-only cameras. A warning is useful, but a legacy clear
      // event is not evidence that a detector is running and out of warmup.
      if (!presence({ ...packet, at }, 'event')) return null;
      return cam.event = { ...packet, receivedAt: at };
    },
    snapshot() {
      if (!connected) return { level: 'unavailable', coverage: 'unavailable', reason: 'Tower socket disconnected', top: null, online: [], cameraIds: new Set(), warnings: [] };
      const now = clock();
      let top = null, ready = 0;
      const online = [], warnings = [], cameraIds = new Set(), issues = new Map();
      for (const cam of cameras.values()) {
        const label = cam.label ?? cam.id;
        const live = cam.offlineAt === undefined && fresh(cam.lastLiveAt, now, LIVE_MS);
        const state = cam.state?.expiresAt > now ? cam.state : null;
        const issue = !live ? (cam.offlineAt !== undefined ? 'offline' : cam.lastLiveAt !== undefined ? 'timed out' : 'waiting for live data')
          : state ? (state.status === 'ready' ? null : state.status)
          : cam.mode === 'starting' ? 'warming'
          : ['tower', 'unavailable'].includes(cam.mode) ? 'detector unavailable'
          : cam.state ? 'detector timed out' : 'waiting for detector';
        if (live) { online.push(label); cameraIds.add(cam.id); }
        if (issue) issues.set(issue, (issues.get(issue) ?? 0) + 1);
        else ready++;
        if (!live) continue;
        const reading = !issue ? state.reading : null;
        const event = fresh(cam.event?.receivedAt, now, LIVE_MS) ? cam.event : null;
        const ev = event && event.risk !== 'green' &&
          (!reading || event.receivedAt >= reading.receivedAt || event.risk === reading.risk) ? event : null;
        const stateWarns = reading && reading.risk !== 'green';
        const threat = stronger(ev, stateWarns ? reading : null);
        if (threat) {
          const warning = { ...threat, cameraLabel: label };
          warnings.push(warning);
          top = stronger(top, warning);
        }
      }
      const total = cameras.size;
      const coverage = ready && ready === total ? 'healthy' : online.length ? 'degraded' : 'unavailable';
      const reason = !total ? 'No live cameras known'
        : coverage === 'healthy' ? `${ready}/${total} cameras monitoring`
        : `${ready}/${total} cameras monitoring (${[...issues].map(([issue, count]) => `${count} ${issue}`).join(', ')})`;
      return { level: top?.risk ?? (coverage === 'healthy' ? 'green' : coverage), coverage, reason, top, online, cameraIds, warnings };
    },
  };
}
