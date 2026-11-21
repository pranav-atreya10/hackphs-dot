// Leaflet map overlay controller for advisory 2+ camera stereo bearing intersections.
// Never renders single-camera bearings as 2D points, never accesses browser globals at
// module load time, and degrades to a safe no-op controller under partial mock Leaflet.

export const STEREO_COLORS = Object.freeze({
  drone: '#dc2626',
  bird: '#d99a00',
  unknown: '#d99a00',
});

export const STEREO_ADVISORY_TEXT = 'Advisory 2-camera bearing intersection — not radar or clearance';

const DEFAULT_STALE_MS = 4000;
const MAX_CLOCK_LEAD_MS = 2000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) < 90 && Math.abs(lon) <= 180;
}

function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return Boolean(window.matchMedia('(prefers-reduced-motion: reduce)')?.matches);
}

function makeTextNodeContainer(className) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const el = document.createElement('div');
    if ('className' in el) el.className = className;
    if (typeof el.setAttribute === 'function') {
      el.setAttribute('role', 'group');
    }
    return el;
  }
  return { className, textContent: '' };
}

function syncDataAttrs(layer, kind, risk) {
  const el = layer?.getElement?.() ?? layer?._path;
  if (!el) return;
  if (el.dataset) {
    el.dataset.classification = kind;
    el.dataset.risk = risk;
  } else if (typeof el.setAttribute === 'function') {
    el.setAttribute('data-classification', kind);
    el.setAttribute('data-risk', risk);
  }
}

function attachInitialAttrs(layer, getState) {
  const { kind, risk } = getState();
  syncDataAttrs(layer, kind, risk);
  if (!(layer?.getElement?.() ?? layer?._path) && typeof layer?.once === 'function') {
    layer.once('add', () => {
      const next = getState();
      syncDataAttrs(layer, next.kind, next.risk);
    });
  }
}

function normalizeLabel(raw, fallback) {
  const str = typeof raw === 'string' && raw.trim() ? raw.trim() : String(fallback || 'Camera');
  return str.slice(0, 60);
}

function formatBearing(deg) {
  if (!Number.isFinite(deg)) return null;
  const norm = Math.round(((deg % 360) + 360) % 360) % 360;
  return `${String(norm).padStart(3, '0')}°`;
}

function formatStereoSummary(fix) {
  const clsUpper = fix.kind === 'drone' ? 'DRONE' : fix.kind === 'bird' ? 'BIRD' : 'UNKNOWN OBJECT';
  const uncM = Math.max(1, Math.round(fix.uncertaintyRadiusM));
  const baselineM = Math.max(1, Math.round(fix.baselineM));

  const camParts = fix.cameras.map(cam => {
    const rangeStr = `${Math.max(1, Math.round(cam.rangeM))}m`;
    const brg = formatBearing(cam.bearingDeg);
    return brg ? `${cam.cameraLabel} (${rangeStr}, ${brg})` : `${cam.cameraLabel} (${rangeStr})`;
  });

  const tooltip = `${clsUpper} · ±${uncM}m · ${camParts.join(' + ')} · ${STEREO_ADVISORY_TEXT}`;
  const popup = [
    `STEREO FIX · ${clsUpper} (±${uncM}m)`,
    `Cameras: ${camParts.join(' · ')}`,
    `Baseline: ${baselineM}m · Uncertainty: ±${uncM}m`,
    STEREO_ADVISORY_TEXT,
  ].join('\n');

  return { tooltip, popup };
}

function normalizeFix(raw, nowMs, staleMs, activeAirport) {
  if (!isPlainObject(raw)) return null;
  if (raw.advisory !== true || raw.geo_basis !== 'stereo_bearing_intersection') return null;
  if (activeAirport && raw.airport && raw.airport !== activeAirport) return null;

  const lat = Number(raw.lat ?? raw.target_geo?.coordinates?.[1]);
  const lon = Number(raw.lon ?? raw.target_geo?.coordinates?.[0]);
  if (!validLatLon(lat, lon)) return null;

  const rawCams = Array.isArray(raw.cameras) ? raw.cameras : [];
  const seenCamIds = new Set();
  const cameras = [];
  for (let i = 0; i < rawCams.length; i++) {
    const c = rawCams[i];
    if (!isPlainObject(c)) continue;
    const cameraId = typeof c.cameraId === 'string' && c.cameraId.trim() ? c.cameraId.trim() : null;
    if (!cameraId || seenCamIds.has(cameraId)) continue;
    const cLat = Number(c.lat);
    const cLon = Number(c.lon);
    const rangeM = Number(c.range_m ?? c.rangeM);
    if (!validLatLon(cLat, cLon) || !Number.isFinite(rangeM) || rangeM <= 0) continue;
    seenCamIds.add(cameraId);
    cameras.push({
      cameraId,
      cameraLabel: normalizeLabel(c.cameraLabel, cameraId),
      lat: cLat,
      lon: cLon,
      rangeM,
      bearingDeg: Number.isFinite(c.bearing_deg ?? c.bearingDeg) ? Number(c.bearing_deg ?? c.bearingDeg) : null,
      trackId: c.trackId !== undefined && c.trackId !== null ? String(c.trackId) : String(i),
    });
  }

  // Single-camera input MUST NEVER render a 2D target point on the map.
  if (cameras.length < 2) return null;

  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : nowMs;
  if (nowMs - updatedAt > staleMs || updatedAt - nowMs > MAX_CLOCK_LEAD_MS) return null;

  const rawPoly = Array.isArray(raw.uncertaintyPolygon) ? raw.uncertaintyPolygon : [];
  const polygon = rawPoly
    .filter(pt => Array.isArray(pt) && pt.length >= 2 && validLatLon(pt[0], pt[1]))
    .map(pt => [Number(pt[0]), Number(pt[1])]);
  if (polygon.length < 3) return null;

  const clsRaw = typeof raw.classification === 'string' ? raw.classification.trim().toLowerCase() : 'unknown';
  const kind = clsRaw === 'drone' ? 'drone' : clsRaw === 'bird' ? 'bird' : 'unknown';
  const risk = kind === 'drone' ? 'red' : 'yellow';

  const uncertaintyRadiusM = Number(raw.uncertaintyRadiusM ?? raw.uncertainty_radius_m);
  const baselineM = Number(raw.baseline_m ?? raw.baselineM);
  if (!Number.isFinite(uncertaintyRadiusM) || uncertaintyRadiusM <= 0) return null;
  if (!Number.isFinite(baselineM) || baselineM <= 0) return null;

  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : `${raw.airport || 'local'}:${cameras.map(c => `${c.cameraId}#${c.trackId}`).join('+')}`;

  return {
    id,
    airport: typeof raw.airport === 'string' && raw.airport.trim() ? raw.airport.trim() : null,
    kind,
    risk,
    lat,
    lon,
    baselineM,
    uncertaintyRadiusM,
    polygon,
    cameras,
    updatedAt,
  };
}

function createNoopStereoLayer() {
  return {
    updateStereo() { return 0; },
    prune() {},
    clear() {},
    getFixes() { return []; },
    setAirport() {},
    destroy() {},
  };
}

export function createTowerStereoLayer(L, map, options = {}) {
  if (
    !isPlainObject(L) && typeof L !== 'function' ||
    !isPlainObject(map) ||
    typeof L.polyline !== 'function' ||
    typeof L.polygon !== 'function' ||
    typeof map.setView !== 'function' ||
    (typeof L.circleMarker !== 'function' && typeof L.marker !== 'function')
  ) {
    return createNoopStereoLayer();
  }

  const opts = isPlainObject(options) ? options : {};
  const clock = typeof opts.now === 'function'
    ? opts.now
    : (typeof opts.clock === 'function' ? opts.clock : Date.now);
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : DEFAULT_STALE_MS;
  let activeAirport = typeof opts.airport === 'string' && opts.airport.trim() ? opts.airport.trim() : null;
  let destroyed = false;

  const rootGroup = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  rootGroup?.addTo?.(map);
  const targetContainer = rootGroup ?? map;

  const rendered = new Map(); // fixId -> rendered entry

  function addLayer(layer) {
    if (!layer) return null;
    if (typeof layer.addTo === 'function') {
      layer.addTo(targetContainer);
    } else if (rootGroup && typeof rootGroup.addLayer === 'function') {
      rootGroup.addLayer(layer);
    }
    return layer;
  }

  function removeLayer(layer) {
    if (!layer) return;
    layer.remove?.();
    rootGroup?.removeLayer?.(layer);
  }

  function removeEntry(id) {
    const entry = rendered.get(id);
    if (!entry) return;
    for (const ray of entry.rays) removeLayer(ray);
    removeLayer(entry.poly);
    removeLayer(entry.pulse);
    removeLayer(entry.marker);
    rendered.delete(id);
  }

  function createFixMarker(coords, color, popupNode, tooltipText) {
    if (typeof L.circleMarker === 'function') {
      const marker = L.circleMarker(coords, {
        radius: 8,
        color,
        fillColor: color,
        weight: 2,
        opacity: 0.96,
        fillOpacity: 0.86,
        className: 'stereo-fix-marker',
      });
      marker.bindPopup?.(popupNode, { className: 'stereo-popup-shell' });
      marker.bindTooltip?.(tooltipText, { className: 'stereo-tooltip', direction: 'top' });
      return addLayer(marker);
    }
    const icon = typeof L.divIcon === 'function'
      ? L.divIcon({ className: 'stereo-fix-marker', iconSize: [16, 16] })
      : undefined;
    const marker = L.marker(coords, icon ? { icon } : {});
    marker.bindPopup?.(popupNode, { className: 'stereo-popup-shell' });
    marker.bindTooltip?.(tooltipText, { className: 'stereo-tooltip', direction: 'top' });
    return addLayer(marker);
  }

  function upsertFix(fix) {
    const color = STEREO_COLORS[fix.kind] ?? STEREO_COLORS.unknown;
    const coords = [fix.lat, fix.lon];
    const { tooltip, popup } = formatStereoSummary(fix);
    const reduced = Boolean(opts.reducedMotion) || prefersReducedMotion();

    let entry = rendered.get(fix.id);
    if (!entry) {
      const popupNode = makeTextNodeContainer('stereo-popup');
      popupNode.textContent = popup;
      if (typeof popupNode.setAttribute === 'function') {
        popupNode.setAttribute('aria-label', tooltip);
      }

      const rays = fix.cameras.map(cam => {
        const line = addLayer(
          L.polyline([[cam.lat, cam.lon], coords], {
            color,
            weight: 1.75,
            opacity: 0.82,
            dashArray: '6 5',
            interactive: false,
            className: 'stereo-ray-line',
          })
        );
        return line;
      });

      const poly = addLayer(
        L.polygon(fix.polygon, {
          color,
          fillColor: color,
          weight: 1.25,
          opacity: 0.72,
          fillOpacity: 0.14,
          dashArray: '3 3',
          interactive: false,
          className: 'stereo-uncertainty-poly',
        })
      );

      const pulse = !reduced && typeof L.circleMarker === 'function'
        ? addLayer(
            L.circleMarker(coords, {
              radius: 15,
              color,
              fillColor: color,
              weight: 1.5,
              opacity: 0.78,
              fillOpacity: 0.16,
              interactive: false,
              className: 'stereo-fix-pulse',
            })
          )
        : null;

      const marker = createFixMarker(coords, color, popupNode, tooltip);

      entry = {
        id: fix.id,
        fix,
        color,
        popupText: popup,
        tooltipText: tooltip,
        popupNode,
        rays,
        poly,
        pulse,
        marker,
      };
      rendered.set(fix.id, entry);

      const getState = () => ({ kind: entry.fix.kind, risk: entry.fix.risk });
      for (const ray of rays) attachInitialAttrs(ray, getState);
      attachInitialAttrs(poly, getState);
      attachInitialAttrs(pulse, getState);
      attachInitialAttrs(marker, getState);
      return;
    }

    entry.fix = fix;

    // Reconcile camera sightline count and geometry.
    while (entry.rays.length > fix.cameras.length) {
      removeLayer(entry.rays.pop());
    }
    for (let i = 0; i < fix.cameras.length; i++) {
      const cam = fix.cameras[i];
      const seg = [[cam.lat, cam.lon], coords];
      if (i < entry.rays.length) {
        entry.rays[i].setLatLngs?.(seg);
        if (entry.color !== color) entry.rays[i].setStyle?.({ color });
        syncDataAttrs(entry.rays[i], fix.kind, fix.risk);
      } else {
        const added = addLayer(
          L.polyline(seg, {
            color,
            weight: 1.75,
            opacity: 0.82,
            dashArray: '6 5',
            interactive: false,
            className: 'stereo-ray-line',
          })
        );
        attachInitialAttrs(added, () => ({ kind: entry.fix.kind, risk: entry.fix.risk }));
        entry.rays.push(added);
      }
    }

    entry.poly?.setLatLngs?.(fix.polygon);
    entry.marker?.setLatLng?.(coords);

    if (reduced && entry.pulse) {
      removeLayer(entry.pulse);
      entry.pulse = null;
    } else if (!reduced && !entry.pulse && typeof L.circleMarker === 'function') {
      entry.pulse = addLayer(
        L.circleMarker(coords, {
          radius: 15,
          color,
          fillColor: color,
          weight: 1.5,
          opacity: 0.78,
          fillOpacity: 0.16,
          interactive: false,
          className: 'stereo-fix-pulse',
        })
      );
      attachInitialAttrs(entry.pulse, () => ({ kind: entry.fix.kind, risk: entry.fix.risk }));
    } else if (entry.pulse) {
      entry.pulse.setLatLng?.(coords);
    }

    if (entry.color !== color) {
      entry.poly?.setStyle?.({ color, fillColor: color });
      entry.pulse?.setStyle?.({ color, fillColor: color });
      entry.marker?.setStyle?.({ color, fillColor: color });
      entry.color = color;
    }

    syncDataAttrs(entry.poly, fix.kind, fix.risk);
    syncDataAttrs(entry.pulse, fix.kind, fix.risk);
    syncDataAttrs(entry.marker, fix.kind, fix.risk);

    if (entry.popupText !== popup) {
      entry.popupNode.textContent = popup;
      if (typeof entry.popupNode.setAttribute === 'function') {
        entry.popupNode.setAttribute('aria-label', tooltip);
      }
      entry.popupText = popup;
    }
    if (entry.tooltipText !== tooltip) {
      entry.marker?.setTooltipContent?.(tooltip);
      entry.tooltipText = tooltip;
    }
  }

  function clear() {
    for (const id of [...rendered.keys()]) {
      removeEntry(id);
    }
  }

  function updateStereo(payload) {
    if (destroyed) return 0;
    if (!payload) {
      clear();
      return 0;
    }

    let rawFixes = [];
    if (Array.isArray(payload)) {
      rawFixes = payload;
    } else if (isPlainObject(payload)) {
      if (activeAirport && payload.airport && payload.airport !== activeAirport) {
        return rendered.size;
      }
      if (Number.isFinite(payload.cameraCount) && payload.cameraCount < 2) {
        clear();
        return 0;
      }
      rawFixes = Array.isArray(payload.fixes) ? payload.fixes : [];
    } else {
      clear();
      return 0;
    }

    const nowMs = Number(clock());
    const validFixes = [];
    const nextIds = new Set();

    for (const item of rawFixes) {
      const normalized = normalizeFix(item, nowMs, staleMs, activeAirport);
      if (!normalized || nextIds.has(normalized.id)) continue;
      nextIds.add(normalized.id);
      validFixes.push(normalized);
    }

    for (const id of [...rendered.keys()]) {
      if (!nextIds.has(id)) removeEntry(id);
    }
    for (const fix of validFixes) {
      upsertFix(fix);
    }

    return rendered.size;
  }

  function prune(arg) {
    if (destroyed) return;
    const activeIds = arg instanceof Set ? arg : null;
    const nowMs = typeof arg === 'number' && Number.isFinite(arg) ? arg : Number(clock());

    if (activeIds && activeIds.size < 2) {
      clear();
      return;
    }

    for (const [id, entry] of [...rendered.entries()]) {
      const expired = nowMs - entry.fix.updatedAt > staleMs || entry.fix.updatedAt - nowMs > MAX_CLOCK_LEAD_MS;
      const missingCam = activeIds
        ? entry.fix.cameras.some(cam => !activeIds.has(cam.cameraId))
        : false;
      if (expired || missingCam) {
        removeEntry(id);
      }
    }
  }

  function getFixes() {
    if (destroyed) return [];
    return [...rendered.values()].map(({ fix }) => ({
      id: fix.id,
      airport: fix.airport,
      advisory: true,
      geo_basis: 'stereo_bearing_intersection',
      classification: fix.kind,
      risk: fix.risk,
      lat: fix.lat,
      lon: fix.lon,
      baseline_m: fix.baselineM,
      uncertaintyRadiusM: fix.uncertaintyRadiusM,
      cameraIds: fix.cameras.map(c => c.cameraId),
      cameraLabels: fix.cameras.map(c => c.cameraLabel),
      updatedAt: fix.updatedAt,
      disclaimer: STEREO_ADVISORY_TEXT,
    }));
  }

  function setAirport(airport) {
    const next = typeof airport === 'string' && airport.trim() ? airport.trim() : null;
    if (next !== activeAirport) {
      activeAirport = next;
      clear();
    }
  }

  function destroy() {
    if (destroyed) return;
    clear();
    rootGroup?.clearLayers?.();
    rootGroup?.remove?.();
    destroyed = true;
  }

  return {
    updateStereo,
    prune,
    clear,
    getFixes,
    setAirport,
    destroy,
  };
}
