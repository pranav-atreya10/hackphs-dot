// Live camera feeds on the tower, with the bot's overlay.
//
// Each streaming phone gets a tile. Frames arrive as JPEG over Socket.IO. The overlay comes from the
// server bot (bot:state). If the server bot hands over (bot:status mode "tower") or goes quiet while frames
// keep arriving, this page runs its own copy of Vivan's engine on the same frames and reports events with
// tower:bot-event. The server accepts them from one tower per camera, so alerts are never duplicated.
import { DetectionEngine, PRESETS } from '/detection/index.js';

const COLORS = { bird: '#4f9cff', drone: '#ff5a4a', unknown: '#f2b705', rejected: 'rgba(200,200,200,.5)', debris: '#a08c78' };
const FALLBACK_AFTER_MS = 3000;

export function startFeeds(socket, { container, hint, onFallbackEvent, onFeed, onRemove }) {
  const tiles = new Map();

  function tile(cameraId) {
    if (tiles.has(cameraId)) return tiles.get(cameraId);
    const el = document.createElement('div'); el.className = 'tile';
    el.innerHTML = `<div class="wrap"><canvas aria-hidden="true"></canvas><canvas aria-hidden="true"></canvas></div><span class="tag"></span><span class="bot">waiting…</span>
      <div class="tools" role="toolbar" aria-label="Feed view">
        <button type="button" data-z="-" aria-label="Zoom out">−</button><span class="zl">1×</span><button type="button" data-z="+" aria-label="Zoom in">+</button>
        <button type="button" data-z="0" aria-label="Reset zoom">Fit</button><button type="button" data-fs aria-label="Full screen">Full screen</button></div>`;
    el.querySelector('.tag').textContent = cameraId;
    el.querySelector('.wrap').setAttribute('role', 'img');
    el.querySelector('.wrap').setAttribute('aria-label', `Live video from camera ${cameraId}, with the detector's boxes drawn over birds and drones`);
    container.appendChild(el); hint.hidden = true;
    const [video, overlay] = el.querySelectorAll('canvas');
    const small = document.createElement('canvas');
    const t = { cameraId, el, video, overlay, vctx: video.getContext('2d'), octx: overlay.getContext('2d'), small, sctx: small.getContext('2d', { willReadFrequently: true }),
      botState: null, lastBotAt: 0, frames: 0, mode: 'server', reason: null, config: null, engine: null, bitmap: null, lastFrameAt: 0, owner: true,
      decoding: false, pending: null, received: 0, fps: 0, fpsAt: performance.now(), offline: false };
    tiles.set(cameraId, t);
    setupZoom(t);
    return t;
  }

  function fallbackActive(t) {
    return t.mode === 'tower' || (t.frames > 30 && Date.now() - t.lastBotAt > FALLBACK_AFTER_MS);
  }

  function ensureEngine(t) {
    if (t.engine) return t.engine;
    t.engine = new DetectionEngine({ camera_id: t.cameraId });
    applyConfig(t);
    t.engine.on('event', ev => {
      if (ev.needs_snapshot && ev.crop_box && t.bitmap) ev.snapshot = crop(t.bitmap, ev.crop_box);
      socket.timeout(4000).emit('tower:bot-event', ev, (err, ack) => { t.owner = !err && ack?.ok; });
      onFallbackEvent?.(ev);
    });
    return t.engine;
  }
  function applyConfig(t) {
    if (!t.engine || !t.config) return;
    for (const name of [].concat(t.config.preset || 'phone_15fps')) if (PRESETS[name]) t.engine.setConfig(PRESETS[name]);
    if (t.config.camera) t.engine.setCamera(t.config.camera);
    if (Array.isArray(t.config.corridor)) t.engine.setCorridor(t.config.corridor);
  }

  function crop(bitmap, b) {
    const W = bitmap.width, H = bitmap.height, c = document.createElement('canvas');
    const sx = Math.max(0, b.x * W), sy = Math.max(0, b.y * H), sw = Math.min(W - sx, b.w * W), sh = Math.min(H - sy, b.h * H);
    if (sw < 2 || sh < 2) return null;
    c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75).split(',')[1];
  }

  function draw(t, state) {
    // clientWidth ignores the zoom transform, so the overlay stays aligned with the video at any zoom.
    const o = t.overlay, dpr = Math.min(2, devicePixelRatio || 1) * Math.max(1, t.zoom?.z || 1);
    const ow = Math.round(o.clientWidth * dpr), oh = Math.round(o.clientHeight * dpr);
    if (o.width !== ow || o.height !== oh) { o.width = ow; o.height = oh; }
    const W = o.width, H = o.height, ar = t.video.width / t.video.height || 4 / 3;
    let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
    const f = { x: (W - w) / 2, y: (H - h) / 2, w, h }, P = ([x, y]) => [f.x + x * f.w, f.y + y * f.h];
    const ctx = t.octx; ctx.clearRect(0, 0, W, H);
    const corridor = t.config?.corridor;
    if (corridor?.length > 2) {
      ctx.beginPath(); corridor.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(p))); ctx.closePath();
      ctx.fillStyle = 'rgba(194,100,63,.14)'; ctx.fill(); ctx.setLineDash([6, 5]); ctx.strokeStyle = 'rgba(242,140,90,.85)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
    }
    if (!state) return;
    ctx.font = `600 ${Math.round(11 * dpr)}px system-ui`; ctx.lineWidth = 2;
    for (const g of state.flocks || []) if (g.bbox) {
      const [x, y] = P([g.bbox.x, g.bbox.y]);
      ctx.setLineDash([5, 4]); ctx.strokeStyle = '#fff'; ctx.strokeRect(x - 5, y - 5, g.bbox.w * f.w + 10, g.bbox.h * f.h + 10); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.fillText(`flock of ${g.size}${g.eta_seconds != null ? ` · ${Math.round(g.eta_seconds)} s` : ''}`, x - 5, y - 10);
    }
    for (const tr of state.tracks || []) {
      const c = COLORS[tr.classification] || COLORS.unknown, [x, y] = P([tr.bbox.x, tr.bbox.y]);
      ctx.strokeStyle = c; ctx.strokeRect(x, y, Math.max(5, tr.bbox.w * f.w), Math.max(5, tr.bbox.h * f.h));
      if (tr.trail?.length > 1) { ctx.beginPath(); tr.trail.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](...P(p))); ctx.globalAlpha = .6; ctx.stroke(); ctx.globalAlpha = 1; }
      if (!tr.is_flock) { ctx.fillStyle = c; ctx.fillText(`${tr.classification}${tr.flap_hz ? ` ${tr.flap_hz} Hz` : ''}`, x, y - 4); }
    }
  }

  function label(t) {
    const fb = fallbackActive(t);
    const state = fb ? t.fallbackState : t.botState;
    const shake = state?.motion?.shake ?? state?.shake;
    const learning = state?.motion ? !state.motion.ready : state?.learning;
    let text = t.offline ? 'Camera offline' : !t.frames ? 'Waiting for video…' : shake ? 'Camera moving · hold still' : learning ? 'Model warming up · hold still' : !state ? 'Starting model…' : fb ? (t.owner ? 'Model active on this Mac' : 'Model active on another tower') : 'Model active on server';
    if (t.frames && !t.offline) text += ` · ${Math.round(t.fps)} fps`;
    const el = t.el.querySelector('.bot');
    if (el.textContent !== text) el.textContent = text;
  }

  // Zoom (buttons, wheel, double-click) and pan (drag) on one wrapper holding video + overlay, plus full screen.
  function setupZoom(t) {
    const wrap = t.el.querySelector('.wrap'), z = t.zoom = { z: 1, x: 0, y: 0 };
    const apply = () => {
      const w = t.el.clientWidth, h = t.el.clientHeight;
      z.x = Math.min(0, Math.max(w - w * z.z, z.x)); z.y = Math.min(0, Math.max(h - h * z.z, z.y));
      wrap.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.z})`;
      t.el.querySelector('.zl').textContent = `${+z.z.toFixed(1)}×`;
      t.el.classList.toggle('zoomed', z.z > 1);
    };
    const zoomAt = (nz, px, py) => {               // keep the point under (px, py) fixed while zooming
      nz = Math.min(6, Math.max(1, nz));
      const r = t.el.getBoundingClientRect(), cx = px - r.left, cy = py - r.top;
      z.x = cx - (cx - z.x) * (nz / z.z); z.y = cy - (cy - z.y) * (nz / z.z); z.z = nz; apply();
    };
    const centre = () => { const r = t.el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    t.el.querySelector('.tools').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.z === '+') zoomAt(z.z * 1.5, ...centre());
      if (b.dataset.z === '-') zoomAt(z.z / 1.5, ...centre());
      if (b.dataset.z === '0') { z.z = 1; z.x = z.y = 0; apply(); }
      if ('fs' in b.dataset) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else t.el.requestFullscreen?.().catch(() => {});
      }
    });
    t.el.addEventListener('wheel', e => { e.preventDefault(); zoomAt(z.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); }, { passive: false });
    t.el.addEventListener('dblclick', e => { if (e.target.closest('.tools')) return; z.z > 1 ? (z.z = 1, z.x = z.y = 0, apply()) : zoomAt(2.5, e.clientX, e.clientY); });
    let drag = null;
    t.el.addEventListener('pointerdown', e => { if (z.z > 1 && !e.target.closest('.tools')) { drag = { x: e.clientX - z.x, y: e.clientY - z.y }; t.el.setPointerCapture(e.pointerId); } });
    t.el.addEventListener('pointermove', e => { if (drag) { z.x = e.clientX - drag.x; z.y = e.clientY - drag.y; apply(); } });
    t.el.addEventListener('pointerup', () => { drag = null; });
    document.addEventListener('fullscreenchange', () => { t.el.querySelector('[data-fs]').textContent = document.fullscreenElement === t.el ? 'Exit full screen' : 'Full screen'; apply(); });
  }

  socket.on('camera:config', cfg => { const t = tile(cfg.cameraId); t.config = cfg; applyConfig(t); });
  socket.on('bot:status', s => { const t = tile(s.cameraId); t.mode = s.mode; t.reason = s.reason; label(t); });
  socket.on('bot:state', ({ cameraId, state }) => { const t = tile(cameraId); t.botState = state; t.lastBotAt = Date.now(); label(t); });
  socket.on('camera:status', ({ cameraId, online }) => {
    const t = tiles.get(cameraId); if (!t) return;
    t.offline = !online; label(t);
    if (online) return;
    setTimeout(() => { if (Date.now() - t.lastFrameAt > 9000) { t.bitmap?.close?.(); t.el.remove(); tiles.delete(cameraId); onRemove?.(cameraId); hint.hidden = tiles.size > 0; } }, 10000);
  });
  socket.on('camera:frame', ({ cameraId, t: ft, jpeg }) => {
    const t = tile(cameraId);
    t.lastFrameAt = Date.now(); t.offline = false; t.received++;
    const now = performance.now(), dt = now - t.fpsAt;
    if (dt >= 1000) { t.fps = t.received * 1000 / dt; t.received = 0; t.fpsAt = now; }
    // Keep one newest frame while a decode is running. Never build a video backlog or draw old frames out of order.
    t.pending = { ft, jpeg };
    if (!t.decoding) renderLatest(t);
  });

  async function renderLatest(t) {
    t.decoding = true;
    try {
      while (t.pending && tiles.get(t.cameraId) === t) {
        const { ft, jpeg } = t.pending; t.pending = null;
        let bitmap;
        try { bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })); } catch { continue; }
        if (tiles.get(t.cameraId) !== t) { bitmap.close(); break; }
        t.bitmap?.close?.(); t.bitmap = bitmap; t.frames++; t.frameT = Number(ft);
        if (t.video.width !== bitmap.width || t.video.height !== bitmap.height) { t.video.width = bitmap.width; t.video.height = bitmap.height; }
        t.vctx.drawImage(bitmap, 0, 0);
        let state = t.botState;
        t.fallbackActive = fallbackActive(t);
        if (t.fallbackActive) {
          const e = ensureEngine(t);
          t.small.width = 320; t.small.height = Math.round(320 * bitmap.height / bitmap.width);
          t.sctx.drawImage(bitmap, 0, 0, t.small.width, t.small.height);
          t.fallbackState = e.process(t.sctx.getImageData(0, 0, t.small.width, t.small.height), Number(ft) || performance.now() / 1000);
          state = t.fallbackState;
        }
        draw(t, state); label(t);
        onFeed?.(t);
      }
    } finally {
      t.decoding = false;
    }
  }
}
