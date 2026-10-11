// A trained second opinion runs separately from the fast motion model and video renderer.
// Only TensorFlow.js and model weights are downloaded; camera pixels stay in this browser.
const MAX_FRAME_AGE = 2500;
const CHECK_COOLDOWN = 3000;
const LOAD_TIMEOUT = 35000;

export function validBox(box) {
  return !!box && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(box[k])) &&
    box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 &&
    box.x + box.w <= 1.001 && box.y + box.h <= 1.001;
}

// Pure selection makes missing, stale or unstable feeds harmless to verification.
export function chooseBirdCandidate(feeds, checked, now = Date.now()) {
  const candidates = [];
  for (const t of feeds.values()) {
    const state = t.mode === 'tower' || t.fallbackActive ? t.fallbackState : t.botState;
    if (t.offline || !t.video?.width || !t.video?.height || !Number.isFinite(t.frameT) || !state ||
      now - t.lastFrameAt > MAX_FRAME_AGE || state.shake || state.learning ||
      state.motion?.shake || (state.motion && !state.motion.ready)) continue;
    for (const tr of state.tracks || []) {
      if (!Number.isSafeInteger(tr.id) || !validBox(tr.bbox) || tr.classification === 'rejected') continue;
      const key = `${t.cameraId}:${tr.id}`;
      if (now - (checked.get(key) ?? -Infinity) < CHECK_COOLDOWN) continue;
      const px = Math.max(tr.bbox.w * t.video.width, tr.bbox.h * t.video.height);
      if (px < 24) continue; // A few pixels cannot support a meaningful shape judgement.
      candidates.push({ t, tr, key, priority: (tr.classification === 'unknown' ? 1000 : 0) + Math.min(px, 400) });
    }
  }
  return candidates.sort((a, b) => b.priority - a.priority)[0] || null;
}

export class VisualBirdVerifier {
  constructor({ socket, button, status, loadAdapter = () => import('../detection/adapters/coco.js') }) {
    Object.assign(this, { socket, button, status, loadAdapter });
    this.feeds = new Map(); this.checked = new Map(); this.enabled = false;
    this.generation = 0; this.timer = null; this.verifier = null; this.loading = null;
    this.busy = false;
    this.checks = 0; this.birds = 0; this.lastResult = '';
    button.addEventListener('click', () => this.enabled ? this.disable() : this.enable());
    this.updateButton();
  }

  onFeed(t) { this.feeds.set(t.cameraId, t); }
  updateButton() {
    this.button.textContent = this.enabled ? 'Turn off bird check' : 'Enable trained bird check';
    this.button.setAttribute('aria-pressed', String(this.enabled));
  }
  setStatus(text, state) { this.status.textContent = text; this.status.dataset.state = state; }

  async enable() {
    this.enabled = true; const generation = ++this.generation;
    this.updateButton();
    this.setStatus('Loading trained bird model… video and motion detection stay active.', 'loading');
    let timer;
    try {
      if (!this.loading) {
        const pending = (async () => {
          const { CocoVerifier } = await this.loadAdapter();
          const verifier = new CocoVerifier(null, {
            intervalMs: 900, budgetMs: 120, maxIntervalMs: 4000,
            tfjsUrl: '/ai-models/tf.min.js', cocoScriptUrl: '/ai-models/coco-ssd.min.js',
            modelUrl: '/ai-models/coco/model.json',
          });
          try {
            await verifier.load(stage => {
              if (this.enabled && generation === this.generation)
                this.setStatus(`${stage} Video and motion detection stay active.`, 'loading');
            });
            return verifier;
          }
          catch (err) { verifier.model?.dispose?.(); throw err; }
        })();
        this.loading = pending;
        pending.then(verifier => { if (this.loading !== pending) verifier.model?.dispose?.(); }, () => {});
      }
      const verifier = await Promise.race([this.loading, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The model download took too long')), LOAD_TIMEOUT);
      })]);
      if (!this.enabled || generation !== this.generation) return;
      this.verifier = verifier;
      this.setStatus('Bird check ready · waiting for a stable tracked object.', 'ready');
      this.schedule();
    } catch (err) {
      if (!this.enabled || generation !== this.generation) return;
      this.enabled = false; this.loading = null; this.updateButton();
      this.setStatus('Bird check unavailable. Motion detection stays active; press Enable to retry.', 'unavailable');
      console.warn('Bird verification could not load:', err.message);
    } finally { clearTimeout(timer); }
  }

  disable() {
    this.enabled = false; this.generation++;
    clearTimeout(this.timer); this.timer = null; this.updateButton();
    this.setStatus('Bird check off · motion detection stays active.', 'off');
  }

  schedule() {
    if (!this.enabled || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick();
      this.schedule();
    }, this.verifier?.stats.intervalMs || 900);
  }

  async tick() {
    if (!this.enabled || !this.verifier || this.busy || (typeof document !== 'undefined' && document.hidden)) return;
    const generation = this.generation, now = Date.now();
    for (const [id, t] of this.feeds) if (now - t.lastFrameAt > 10000) this.feeds.delete(id);
    for (const [key, at] of this.checked) if (now - at > 15000) this.checked.delete(key);
    const c = chooseBirdCandidate(this.feeds, this.checked, now);
    if (!c) {
      this.setStatus(this.checks ? `Bird check ready · ${this.checks} checks, ${this.birds} bird labels. ${this.lastResult}` : 'Bird check ready · waiting for a stable tracked object at least 24 pixels across.', 'ready');
      return;
    }
    this.checked.set(c.key, now);
    const bbox = { ...c.tr.bbox }, frameT = c.t.frameT;
    const fallback = c.t.mode === 'tower' || !!c.t.fallbackActive;
    this.busy = true;
    this.setStatus(`Checking ${c.t.cameraId} · object ${c.tr.id}…`, 'checking');
    try {
      const r = await this.verifier.classifyBox(c.t.video, bbox);
      this.verifier.adapt(r.ms);
      if (!this.enabled || generation !== this.generation || c.t.offline || Date.now() - now > MAX_FRAME_AGE) return;
      if (fallback !== (c.t.mode === 'tower' || !!c.t.fallbackActive)) return;
      const state = fallback ? c.t.fallbackState : c.t.botState;
      if (!state?.tracks?.some(tr => tr.id === c.tr.id)) return;
      this.checks++;
      this.birds += r.label === 'bird' && r.score >= .4 ? 1 : 0;
      const answer = r.label ? `${r.label} ${Math.round(r.score * 100)}%` : 'no clear label';
      this.lastResult = `Latest: ${answer} · ${r.ms} ms.`;
      this.setStatus(`Bird check active · ${this.checks} checks. ${this.lastResult}`, 'active');
      if (fallback) {
        c.t.engine?.applyLabel(c.tr.id, r.label, r.score, 'coco');
      } else if (this.socket.connected) {
        this.socket.timeout(2500).emit('tower:label', {
          cameraId: c.t.cameraId, trackId: c.tr.id, label: r.label, score: r.score,
          bbox, frameT, source: 'coco',
        }, (err, ack) => {
          if (this.enabled && generation === this.generation && (err || !ack?.ok))
            this.setStatus(`Bird check active · latest ${answer}; this label could not be applied to the live track.`, 'active');
        });
      }
    } catch (err) {
      if (!this.enabled || generation !== this.generation) return;
      this.setStatus('Bird check paused after an inference error. Motion detection stays active; another check will retry.', 'unavailable');
      console.warn('Bird verification could not check a crop:', err.message);
    } finally { this.busy = false; }
  }
}
