import { captureBirdEvidence, chooseBirdCandidate, pruneBirdAttempts } from './bird-evidence.js';
export { chooseBirdCandidate, validBox } from './bird-evidence.js';

// Local inference and optional server-side evidence review are advisory only.
const MAX_FRAME_AGE = 2500;
const LOAD_TIMEOUT = 35000;

export class VisualBirdVerifier {
  constructor({ button, status, reviewStatus, loadAdapter = () => import('../detection/adapters/coco.js'), judge = null }) {
    Object.assign(this, { button, status, reviewStatus, loadAdapter, judge });
    this.feeds = new Map(); this.checked = new Map(); this.cameraAttempts = new Map(); this.enabled = false;
    this.generation = 0; this.timer = null; this.verifier = null; this.loading = null;
    this.busy = false; this.reviewPending = false; this.review = null;
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
    this.renderReview();
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
              if (this.enabled && this.loading === pending)
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
    this.review = null;
    clearTimeout(this.timer); this.timer = null; this.updateButton();
    this.setStatus('Bird check off · motion detection stays active.', 'off');
    this.renderReview();
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
    this.renderReview();
    for (const [id, t] of this.feeds) if (now - t.lastFrameAt > 10000) { this.feeds.delete(id); this.cameraAttempts.delete(id); }
    pruneBirdAttempts(this.feeds, this.checked, this.cameraAttempts, now);
    const c = chooseBirdCandidate(this.feeds, this.checked, now, this.cameraAttempts);
    if (!c) {
      this.setStatus(this.checks ? `Bird check ready · ${this.checks} checks, ${this.birds} bird labels. ${this.lastResult}` : 'Bird check ready · waiting for a stable tracked object at least 24 pixels across.', 'ready');
      return;
    }
    this.checked.set(c.key, now);
    this.cameraAttempts.set(c.t.cameraId, now);
    this.busy = true;
    this.setStatus(`Checking ${c.t.cameraId} · object ${c.tr.id}…`, 'checking');
    try {
      const evidence = captureBirdEvidence(c, this.verifier.opts);
      if (!evidence) {
        this.setStatus('Bird check ready · no matching crop for this frame.', 'ready');
        return;
      }
      const r = await this.verifier.classifyCaptured(evidence.canvas, evidence.bbox);
      this.verifier.adapt(r.ms);
      if (!this.enabled || generation !== this.generation) return;
      const multiple = (r.relevant?.length || 0) > 1;
      const answer = multiple ? 'uncertain (multiple detections in crop)' :
        r.label ? `${r.label} ${Math.round(r.score * 100)}%` : 'no clear label';
      this.checks++;
      this.birds += !multiple && r.label === 'bird' && r.score >= .4 ? 1 : 0;
      this.lastResult = `Latest local check: ${answer} · ${r.ms} ms. Advisory only.`;
      this.setStatus(`Bird check active · ${this.checks} checks. ${this.lastResult}`, 'active');
      if (!multiple && !(r.label === 'bird' && r.score >= .6)) void this.requestReview(c, generation);
    } catch (err) {
      if (!this.enabled || generation !== this.generation) return;
      this.setStatus('Bird check paused after an inference error. Motion detection stays active; another check will retry.', 'unavailable');
      console.warn('Bird verification could not check a crop:', err.message);
    } finally { this.busy = false; }
  }

  isLive(c) {
    const t = this.feeds.get(c.t.cameraId), state = t?.botState;
    return t === c.t && !t.offline && !t.fallbackActive && t.mode !== 'tower' &&
      Number.isFinite(c.frameReceivedAt) && Math.abs(Date.now() - c.frameReceivedAt) <= MAX_FRAME_AGE &&
      !state?.shake && !state?.learning &&
      state?.tracks?.some(tr => tr.id === c.tr.id && !tr.missed && !tr.dense &&
        tr.classification !== 'rejected' && tr.classification !== 'debris') &&
      (t.birdStreamId ?? t.streamId) === c.streamId && !!c.generation && state.generation === c.generation;
  }

  async requestReview(c, generation) {
    if (!this.judge || this.reviewPending || c.source !== 'server' || !c.streamId ||
        !Number.isSafeInteger(c.frameId) || !this.isLive(c)) return;
    const ref = { cameraId: c.t.cameraId, streamId: c.streamId, frameId: c.frameId, trackId: c.tr.id };
    this.reviewPending = true;
    this.review = { pending: true };
    this.renderReview();
    try {
      const result = await this.judge(ref);
      if (!this.enabled || generation !== this.generation) return;
      const match = Object.keys(ref).every(key => result?.evidenceRef?.[key] === ref[key]) &&
        result.evidenceRef.generation === c.generation && result.evidenceRef.t === c.frameT;
      if (match && result.status === 'verified' && result.source === 'gemini' &&
          ['bird', 'not_bird', 'uncertain'].includes(result.verdict)) {
        this.review = { result, c };
      } else this.review = { unavailable: true };
    } catch (error) {
      if (this.enabled && generation === this.generation) this.review = { unavailable: true };
    } finally {
      this.reviewPending = false;
      this.renderReview();
    }
  }

  renderReview() {
    if (!this.reviewStatus) return;
    const review = this.review;
    if (!this.enabled || !this.judge || !review) this.reviewStatus.textContent = '';
    else if (review.pending) this.reviewStatus.textContent = 'Cloud evidence review pending. Local checks continue.';
    else if (review.unavailable) this.reviewStatus.textContent = 'Cloud evidence review unavailable. Local checks continue.';
    else {
      const { result, c } = review;
      const verdict = { bird: 'bird', not_bird: 'not a bird', uncertain: 'uncertain' }[result.verdict];
      const label = result.application === 'advisory' && this.isLive(c) ? 'Cloud advisory' : 'Earlier cloud review';
      this.reviewStatus.textContent = `${label} · ${c.t.cameraId}, object ${c.tr.id}: ${verdict}. Not a clearance.`;
    }
  }
}
