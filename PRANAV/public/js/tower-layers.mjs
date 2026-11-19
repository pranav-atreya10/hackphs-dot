const validGeo = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
  Math.abs(p[0]) <= 180 && Math.abs(p[1]) < 90;
const latLng = ([lon, lat]) => [lat, lon];
function destination(lat, lon, bearing) {
  const radians = bearing * Math.PI / 180;
  return [lat + 400 * Math.cos(radians) / 111320, lon + 400 * Math.sin(radians) / (111320 * Math.cos(lat * Math.PI / 180))];
}

export function createTowerLayers(L, map, { describe = ev => ev.risk } = {}) {
  const cameras = new Map(), threats = new Map();
  let centered = false;
  const removeThreat = id => {
    const threat = threats.get(id);
    threat?.marker.remove();
    threat?.path?.remove();
    threats.delete(id);
  };
  return {
    placeCamera(ev) {
      const c = ev.camera;
      if (!c || !validGeo([c.lon, c.lat]) || !Number.isFinite(c.heading_deg) || !Number.isFinite(c.hfov_deg) ||
          c.hfov_deg <= 0 || c.hfov_deg > 180) return;
      const id = ev.cameraId, label = ev.cameraLabel || id;
      const prior = cameras.get(id);
      const signature = [c.lat, c.lon, c.heading_deg, c.hfov_deg].join(':');
      if (prior?.signature === signature && prior.label === label) return;
      const pos = [c.lat, c.lon], cone = [pos];
      for (let i = 0; i <= 10; i++) cone.push(destination(c.lat, c.lon, c.heading_deg + (i / 10 - .5) * c.hfov_deg));
      if (!cone.every(([lat, lon]) => validGeo([lon, lat]))) return;
      if (prior) {
        prior.cone.setLatLngs(cone);
        prior.marker.setLatLng(pos);
        prior.text.textContent = `Camera ${label}`;
        Object.assign(prior, { signature, label });
      } else {
        const text = document.createElement('span');
        text.textContent = `Camera ${label}`;
        cameras.set(id, { signature, label, text,
          cone: L.polygon(cone, { color: '#1f6fd1', weight: 1, fillOpacity: .08 }).addTo(map),
          marker: L.circleMarker(pos, { radius: 7, color: '#1f6fd1', fillOpacity: 1 }).bindTooltip(text).addTo(map),
        });
      }
      if (!centered) { map.setView(pos, 16); centered = true; }
    },
    pin(ev) {
      const id = ev.cameraId;
      // The old detector estimates positions from a generic projection, not a measured location.
      if (ev.geo_basis !== 'measured' || !validGeo(ev.target_geo?.coordinates) || !['red', 'yellow'].includes(ev.risk)) {
        removeThreat(id);
        return;
      }
      const coords = latLng(ev.target_geo.coordinates), color = ev.risk === 'red' ? '#c0392b' : '#d99a00';
      const path = Array.isArray(ev.path_geo?.coordinates) && ev.path_geo.coordinates.every(validGeo)
        ? ev.path_geo.coordinates.map(latLng) : [];
      let threat = threats.get(id);
      const markerKey = [...coords, color].join(':');
      const pathKey = path.length > 1 ? JSON.stringify([color, path]) : '';
      const description = describe(ev);
      if (!threat) {
        const text = document.createElement('span');
        const marker = L.circleMarker(coords, { radius: 8, color, fillOpacity: .85 }).bindPopup(text).addTo(map);
        threat = { marker, text, markerKey };
        threats.set(id, threat);
      } else if (threat.markerKey !== markerKey) {
        threat.marker.setLatLng(coords).setStyle({ color });
        threat.markerKey = markerKey;
      }
      if (threat.text.textContent !== description) threat.text.textContent = description;
      if (pathKey === threat.pathKey) return;
      if (!pathKey) { threat.path?.remove(); threat.path = null; }
      else if (threat.path) threat.path.setLatLngs(path).setStyle({ color });
      else threat.path = L.polyline(path, { color, weight: 2, opacity: .6, dashArray: '4 4' }).addTo(map);
      threat.pathKey = pathKey;
    },
    prune(activeCameraIds, warningCameraIds = activeCameraIds) {
      for (const [id, { cone, marker }] of cameras) if (!activeCameraIds.has(id)) {
        cone.remove();
        marker.remove();
        cameras.delete(id);
      }
      for (const id of threats.keys()) if (!warningCameraIds.has(id)) removeThreat(id);
    },
    clear() { this.prune(new Set()); },
  };
}
