export const LAYER_COLORS = Object.freeze({
  blue: '#1f6fd1',
  green: '#16a34a',
  yellow: '#d99a00',
  red: '#dc2626',
  offline: '#6b7280',
});
const MAX_CLOCK_LEAD_MS = 2_000;
const VALID_RISKS = new Set(['blue', 'green', 'yellow', 'red']);

const validGeo = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 && Math.abs(p[1]) < 90;
const latLng = ([lon, lat]) => [lat, lon];
function destination(lat, lon, bearing) {
  const radians = bearing * Math.PI / 180;
  return [lat + 400 * Math.cos(radians) / 111320, lon + 400 * Math.sin(radians) / (111320 * Math.cos(lat * Math.PI / 180))];
}
function makeSpan() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
    ? document.createElement('span') : { textContent: '' };
}
function syncRiskAttr(layer, risk) {
  const el = layer?.getElement?.() ?? layer?._path;
  if (!el) return;
  if (el.dataset) el.dataset.risk = risk;
  else if (typeof el.setAttribute === 'function') el.setAttribute('data-risk', risk);
}
function attachInitialRiskAttr(layer, getRisk) {
  syncRiskAttr(layer, getRisk());
  if (!(layer?.getElement?.() ?? layer?._path) && typeof layer?.once === 'function') {
    layer.once('add', () => syncRiskAttr(layer, getRisk()));
  }
}
function coneStyleFor(visualRisk) {
  const color = LAYER_COLORS[visualRisk] ?? LAYER_COLORS.blue;
  if (visualRisk === 'offline') {
    return { color, fillColor: color, weight: 1, opacity: 0.55, fillOpacity: 0.04, dashArray: '4 4' };
  }
  const warning = visualRisk === 'red' || visualRisk === 'yellow';
  const fillOpacity = visualRisk === 'red' ? 0.16 : visualRisk === 'yellow' ? 0.13 : 0.08;
  return { color, fillColor: color, weight: warning ? 1.5 : 1, opacity: 0.85, fillOpacity, dashArray: null };
}
function camPinStyleFor(visualRisk) {
  const color = LAYER_COLORS[visualRisk] ?? LAYER_COLORS.blue;
  const offline = visualRisk === 'offline';
  return { color, fillColor: color, opacity: offline ? 0.65 : 1, fillOpacity: offline ? 0.45 : 1 };
}

export function createTowerLayers(L, map, { describe = ev => ev.risk, clock, now = clock ?? Date.now, staleMs = 10_000 } = {}) {
  const cameras = new Map(), threats = new Map(), pulses = new Map(), pendingStatus = new Map();
  let centered = false;

  const eventTime = ev => {
    const ts = ev?.receivedAt ?? ev?.at ?? ev?.timestamp;
    return Number.isFinite(ts) ? ts : null;
  };
  const isFreshAt = ts => {
    if (ts === null) return false;
    const current = now();
    return current - ts < staleMs && ts - current <= MAX_CLOCK_LEAD_MS;
  };
  const isStaleEvent = ev => {
    if (!ev) return false;
    if (ev.online === false || ev.stale === true) return true;
    if (ev.fresh === true) return false;
    const ts = eventTime(ev);
    return ts !== null && !isFreshAt(ts);
  };
  const isFreshEvent = ev => {
    if (!ev || ev.online === false || ev.stale === true) return false;
    if (ev.fresh === true) return true;
    return isFreshAt(eventTime(ev));
  };
  const visualRiskOf = cam => (!cam.online ? 'offline' : VALID_RISKS.has(cam.risk) ? cam.risk : 'blue');

  const removePulse = id => {
    const pulse = pulses.get(id);
    if (!pulse) return;
    pulse.marker.remove();
    pulses.delete(id);
  };
  const syncPulse = (id, explicitCoords = null, explicitRisk = null) => {
    const cam = cameras.get(id), threat = threats.get(id);
    const active = Boolean(threat?.pulse || (cam?.online && cam.pulse));
    if (!active || typeof L?.circleMarker !== 'function') {
      removePulse(id);
      return;
    }
    const coords = explicitCoords ?? threat?.coords ?? cam?.pos;
    if (!coords) {
      removePulse(id);
      return;
    }
    const risk = explicitRisk ?? threat?.risk ?? visualRiskOf(cam);
    const color = LAYER_COLORS[risk] ?? LAYER_COLORS.yellow;
    const posKey = `${coords[0]}:${coords[1]}`;
    let pulse = pulses.get(id);
    if (!pulse) {
      const marker = L.circleMarker(coords, {
        radius: 14, color, fillColor: color, weight: 2, opacity: 0.85, fillOpacity: 0.18,
        interactive: false, className: 'sky-map-pulse',
      }).addTo(map);
      pulse = { marker, posKey, color, risk };
      pulses.set(id, pulse);
      attachInitialRiskAttr(marker, () => pulse.risk);
      return;
    }
    if (pulse.posKey !== posKey) {
      pulse.marker.setLatLng(coords);
      pulse.posKey = posKey;
    }
    pulse.risk = risk;
    if (pulse.color !== color) {
      pulse.marker.setStyle?.({ color, fillColor: color });
      pulse.color = color;
    }
    syncRiskAttr(pulse.marker, risk);
  };
  const applyCameraStyle = cam => {
    const visualRisk = visualRiskOf(cam);
    cam.visualRisk = visualRisk;
    if (cam.appliedVisualRisk !== visualRisk) {
      cam.cone.setStyle?.(coneStyleFor(visualRisk));
      cam.marker?.setStyle?.(camPinStyleFor(visualRisk));
      cam.appliedVisualRisk = visualRisk;
    }
    syncRiskAttr(cam.cone, visualRisk);
    syncRiskAttr(cam.marker, visualRisk);
  };
  const removeThreatOnly = id => {
    const threat = threats.get(id);
    if (!threat) return;
    threat.marker?.remove();
    threat.path?.remove();
    threats.delete(id);
  };
  const removeThreat = id => {
    removeThreatOnly(id);
    syncPulse(id);
  };

  return {
    placeCamera(ev) {
      const c = ev?.camera;
      if (!c || !validGeo([c.lon, c.lat]) || !Number.isFinite(c.heading_deg) || !Number.isFinite(c.hfov_deg) ||
          c.hfov_deg <= 0 || c.hfov_deg > 180) return;
      const id = ev.cameraId;
      if (id == null || id === '') return;
      const label = ev.cameraLabel || id;
      const prior = cameras.get(id);
      const pending = pendingStatus.get(id);
      const stale = isStaleEvent(ev);
      const fresh = isFreshEvent(ev);
      const hasStatusSignal = stale || fresh || ev.risk !== undefined || ev.online !== undefined || ev.pulse !== undefined;

      let online = prior ? prior.online : (pending ? pending.online : true);
      let clearRisk = prior ? prior.clearRisk : (pending?.clearRisk ?? 'blue');
      let risk = prior ? prior.risk : (pending ? pending.risk : (threats.get(id)?.risk ?? 'blue'));
      let pulse = prior ? prior.pulse : Boolean(pending?.pulse);

      if (hasStatusSignal) {
        if (stale) {
          online = false;
          pulse = false;
        } else {
          if (ev.online !== undefined) online = Boolean(ev.online);
          else if (!prior || ev.risk !== undefined || fresh) online = true;
          if (VALID_RISKS.has(ev.risk)) {
            risk = ev.risk;
            if (ev.risk === 'blue' || ev.risk === 'green') clearRisk = ev.risk;
          }
          if (ev.pulse !== undefined) pulse = online && Boolean(ev.pulse);
          else if (ev.risk === 'yellow' || ev.risk === 'red') pulse = online && fresh;
          else if (ev.risk === 'blue' || ev.risk === 'green') pulse = false;
        }
        pendingStatus.delete(id);
      }

      const signature = [c.lat, c.lon, c.heading_deg, c.hfov_deg].join(':');
      if (prior && prior.signature === signature) {
        if (prior.label !== label) {
          prior.text.textContent = `Camera ${label}`;
          prior.label = label;
        }
        Object.assign(prior, { online, clearRisk, risk, pulse });
        if (!online) removeThreatOnly(id);
        applyCameraStyle(prior);
        syncPulse(id);
        return;
      }

      const pos = [c.lat, c.lon], cone = [pos];
      for (let i = 0; i <= 10; i++) cone.push(destination(c.lat, c.lon, c.heading_deg + (i / 10 - .5) * c.hfov_deg));
      if (!cone.every(([lat, lon]) => validGeo([lon, lat]))) return;

      if (prior) {
        prior.cone.setLatLngs(cone);
        prior.marker?.setLatLng(pos);
        if (prior.label !== label) prior.text.textContent = `Camera ${label}`;
        Object.assign(prior, { signature, label, pos, online, clearRisk, risk, pulse });
        if (!online) removeThreatOnly(id);
        applyCameraStyle(prior);
      } else {
        const text = makeSpan();
        text.textContent = `Camera ${label}`;
        const visualRisk = !online ? 'offline' : (VALID_RISKS.has(risk) ? risk : 'blue');
        const cam = {
          signature, label, pos, text, online, clearRisk, risk, pulse,
          visualRisk, appliedVisualRisk: visualRisk,
          cone: null, marker: null,
        };
        cam.cone = L.polygon(cone, { ...coneStyleFor(visualRisk), className: 'sky-fov-cone' }).addTo(map);
        cam.marker = typeof L?.circleMarker === 'function'
          ? L.circleMarker(pos, { radius: 7, ...camPinStyleFor(visualRisk), className: 'sky-cam-pin' })
              .bindTooltip(text).addTo(map)
          : null;
        attachInitialRiskAttr(cam.cone, () => cam.visualRisk);
        attachInitialRiskAttr(cam.marker, () => cam.visualRisk);
        cameras.set(id, cam);
        pendingStatus.delete(id);
        if (!online) removeThreatOnly(id);
      }
      syncPulse(id);
      if (!centered) { map.setView(pos, 16); centered = true; }
    },
    setCameraStatus(cameraId, { risk = 'blue', online = true, pulse = false } = {}) {
      if (cameraId == null || cameraId === '') return;
      const normalizedRisk = VALID_RISKS.has(risk) ? risk : 'blue';
      const isOnline = Boolean(online) && risk !== 'offline';
      const clearRisk = normalizedRisk === 'green' || normalizedRisk === 'blue' ? normalizedRisk : 'blue';
      const nextPulse = isOnline && Boolean(pulse);
      if (!isOnline || (normalizedRisk !== 'yellow' && normalizedRisk !== 'red')) {
        removeThreatOnly(cameraId);
      } else {
        const threat = threats.get(cameraId);
        if (threat) threat.pulse = nextPulse;
      }
      const cam = cameras.get(cameraId);
      if (!cam) {
        pendingStatus.set(cameraId, {
          risk: normalizedRisk,
          clearRisk,
          online: isOnline,
          pulse: nextPulse,
        });
        syncPulse(cameraId);
        return;
      }
      cam.online = isOnline;
      if (normalizedRisk === 'green' || normalizedRisk === 'blue') cam.clearRisk = normalizedRisk;
      cam.risk = normalizedRisk;
      cam.pulse = nextPulse;
      applyCameraStyle(cam);
      syncPulse(cameraId);
    },
    setCameraState(cameraId, status) {
      return this.setCameraStatus(cameraId, status);
    },
    pin(ev) {
      if (!ev) return;
      const id = ev.cameraId;
      if (id == null || id === '') return;
      const cam = cameras.get(id);
      const stale = isStaleEvent(ev);
      if (stale) {
        if (cam) {
          cam.online = false;
          cam.pulse = false;
          applyCameraStyle(cam);
        }
        removeThreat(id);
        return;
      }

      const isWarning = ev.risk === 'red' || ev.risk === 'yellow';
      const freshWarning = isWarning && ev.pulse !== false && (ev.pulse === true || isFreshEvent(ev));
      if (cam) {
        cam.online = true;
        if (isWarning) {
          cam.risk = ev.risk;
          cam.pulse = freshWarning;
        } else {
          if (ev.risk === 'green' || ev.risk === 'blue') cam.clearRisk = ev.risk;
          cam.risk = ev.risk === 'green' || ev.risk === 'blue' ? ev.risk : cam.clearRisk;
          cam.pulse = Boolean(ev.pulse);
        }
        applyCameraStyle(cam);
      }

      // The old detector estimates positions from a generic projection, not a measured location.
      if (!isWarning || ev.geo_basis !== 'measured' || !validGeo(ev.target_geo?.coordinates)) {
        removeThreat(id);
        return;
      }
      const coords = latLng(ev.target_geo.coordinates), color = LAYER_COLORS[ev.risk];
      const path = Array.isArray(ev.path_geo?.coordinates) && ev.path_geo.coordinates.every(validGeo)
        ? ev.path_geo.coordinates.map(latLng) : [];
      let threat = threats.get(id);
      const markerKey = [...coords, color].join(':');
      const pathKey = path.length > 1 ? JSON.stringify([color, path]) : '';
      const description = describe(ev);
      if (!threat) {
        const text = makeSpan();
        const marker = typeof L?.circleMarker === 'function'
          ? L.circleMarker(coords, {
              radius: 8, color, fillColor: color, fillOpacity: .85, className: 'sky-threat-pin',
            }).bindPopup(text).addTo(map)
          : null;
        threat = { marker, text, markerKey, coords, risk: ev.risk, pulse: freshWarning };
        threats.set(id, threat);
        attachInitialRiskAttr(marker, () => threat.risk);
      } else {
        threat.coords = coords;
        threat.risk = ev.risk;
        threat.pulse = freshWarning;
        if (threat.markerKey !== markerKey) {
          threat.marker?.setLatLng(coords).setStyle?.({ color, fillColor: color });
          threat.markerKey = markerKey;
        }
        syncRiskAttr(threat.marker, ev.risk);
      }
      if (threat.text.textContent !== description) threat.text.textContent = description;
      syncPulse(id, coords, ev.risk);
      if (pathKey === threat.pathKey) return;
      if (!pathKey) { threat.path?.remove(); threat.path = null; }
      else if (threat.path) threat.path.setLatLngs(path).setStyle?.({ color });
      else if (typeof L?.polyline === 'function') {
        threat.path = L.polyline(path, { color, weight: 2, opacity: .6, dashArray: '4 4' }).addTo(map);
      }
      threat.pathKey = pathKey;
    },
    prune(activeCameraIds, warningCameraIds = activeCameraIds) {
      for (const [id, cam] of cameras) {
        if (!activeCameraIds.has(id)) {
          cam.cone.remove();
          cam.marker?.remove();
          cameras.delete(id);
          pendingStatus.delete(id);
          removePulse(id);
        } else if (!warningCameraIds.has(id) && (cam.risk === 'yellow' || cam.risk === 'red')) {
          cam.risk = cam.clearRisk;
          cam.pulse = false;
          applyCameraStyle(cam);
        }
      }
      for (const id of threats.keys()) if (!warningCameraIds.has(id)) removeThreat(id);
      for (const id of pulses.keys()) {
        if (!cameras.has(id) && !threats.has(id)) removePulse(id);
        else if (!warningCameraIds.has(id) && !cameras.get(id)?.pulse) removePulse(id);
      }
    },
    clear() {
      pendingStatus.clear();
      this.prune(new Set());
    },
  };
}
