// Live camera feeds on the tower, with the bot's overlay.
//
// Each streaming phone gets a tile. Frames arrive as JPEG over Socket.IO. The overlay comes from the
// server bot (bot:state). If the server bot hands over (bot:status mode "tower") or goes quiet while frames
// keep arriving, this page runs its own copy of Vivan's engine on the same frames and reports events with
// tower:bot-event. The server accepts them from one tower per camera, so alerts are never duplicated.
import { DetectionEngine } from '/detection/index.js';

const COLORS = { bird: '#4f9cff', drone: '#ff5a4a', unknown: '#f2b705', rejected: 'rgba(200,200,200,.5)' };
const FALLBACK_AFTER_MS = 3000;

export function startFeeds(socket, { container, hint, onFallbackEvent }) {
  const tiles = new Map();

  function tile(cameraId) {
    if (tiles.has(cameraId)) return tiles.get(cameraId);
    const el = document.createElement('div'); el.className = 'tile';
    el.innerHTML = '<canvas></canvas><canvas></canvas><span class="tag"></span><span class="bot">waiting…</span>';
    el.querySelector('.tag').textContent = cameraId;
    container.appendChild(el); hint.hidden = true;
    const [video, overlay] = el.querySelectorAll('canvas');
    const small = document.createElement('canvas');
    const t = { cameraId, el, video, overlay, vctx: video.getContext('2d'), octx: overlay.getContext('2d'), small, sctx: small.getContext('2d', { willReadFrequently: true }),
      botState: null, lastBotAt: 0, frames: 0, mode: 'server', reason: null, config: null, engine: null, bitmap: null, lastFrameAt: 0, owner: true };
    tiles.set(cameraId, t);
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
    const o = t.overlay, r = o.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (o.width !== Math.round(r.width * dpr)) { o.width = Math.round(r.width * dpr); o.height = Math.round(r.height * dpr); }
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
    t.el.querySelector('.bot').textContent = fb ? (t.owner ? 'bot: this tower (server bot unavailable)' : 'bot: another tower') : 'bot: server';
  }

  socket.on('camera:config', cfg => { const t = tile(cfg.cameraId); t.config = cfg; applyConfig(t); });
  socket.on('bot:status', s => { const t = tile(s.cameraId); t.mode = s.mode; t.reason = s.reason; label(t); });
  socket.on('bot:state', ({ cameraId, state }) => { const t = tile(cameraId); t.botState = state; t.lastBotAt = Date.now(); });
  socket.on('camera:status', ({ cameraId, online }) => {
    const t = tiles.get(cameraId); if (!t || online) return;
    t.el.querySelector('.bot').textContent = 'camera offline';
    setTimeout(() => { if (Date.now() - t.lastFrameAt > 9000) { t.el.remove(); tiles.delete(cameraId); hint.hidden = tiles.size > 0; } }, 10000);
  });
  socket.on('camera:frame', async ({ cameraId, t: ft, jpeg }) => {
    const t = tile(cameraId);
    let bitmap;
    try { bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })); } catch { return; }
    t.bitmap?.close?.(); t.bitmap = bitmap; t.frames++; t.lastFrameAt = Date.now();
    if (t.video.width !== bitmap.width) { t.video.width = bitmap.width; t.video.height = bitmap.height; }
    t.vctx.drawImage(bitmap, 0, 0);
    let state = t.botState;
    if (fallbackActive(t)) {
      const e = ensureEngine(t);
      t.small.width = 320; t.small.height = Math.round(320 * bitmap.height / bitmap.width);
      t.sctx.drawImage(bitmap, 0, 0, t.small.width, t.small.height);
      const st = e.process(t.sctx.getImageData(0, 0, t.small.width, t.small.height), Number(ft) || performance.now() / 1000);
      state = { tracks: st.tracks, flocks: st.flocks };
    }
    draw(t, state); label(t);
  });
}
