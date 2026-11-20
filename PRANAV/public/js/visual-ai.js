import { chooseBirdCandidate, MAX_FRAME_AGE, snapshotClassifierFrame, validBox } from './bird-evidence.js';
import { createV41Scheduler } from './skysentry-v41-schedule.mjs';
import { createV41Votes } from './skysentry-v41-vote.mjs';

const TICK_MS = 350;
const REVIEW_INTERVAL_MS = 3000;
const TUPLE_FIELDS = ['cameraId', 'streamId', 'generation', 'trackId', 'frameId', 'frameT'];
const CLASSES = ['bird', 'drone', 'other'];
const WAITING = 'V4.1 ready · waiting for a fresh tracked object.';
const createDefaultClient = async () => {
  const { createV41WorkerClient } = await import('./skysentry-v41-client.mjs');
  return createV41WorkerClient();
};

const sameTuple = (a, b) => TUPLE_FIELDS.every(key => a?.[key] === b[key]);
const fresh = (at, now) => Number.isFinite(at) && now >= at && now - at <= MAX_FRAME_AGE;
const tracksIn = state => !Array.isArray(state?.tracks) || state.shake || state.learning || state.overflow ||
  (state.motion && (!state.motion.ready || state.motion.shake || state.motion.overflow)) ? [] : state.tracks;
const usableTrack = tr => Number.isSafeInteger(tr?.id) && tr.id > 0 && validBox(tr.bbox) &&
  !tr.missed && !tr.dense && tr.classification !== 'rejected' && tr.classification !== 'debris';
const trackItem = (item, trackId) => ({ ...item, tuple: { ...item.tuple, trackId } });

// Visual results are status text only. Neither observer writes labels, risk, or alerts.
export class VisualBirdVerifier {
  constructor({ button, status, reviewStatus, onProgress = null, createWorkerClient = createDefaultClient,
    now = Date.now, isHidden = () => typeof document !== 'undefined' && document.hidden }) {
    Object.assign(this, { button, status, reviewStatus, onProgress, createWorkerClient, now, isHidden });
    this.scheduler = createV41Scheduler();
    this.votes = createV41Votes();
    this.feeds = new Map();
    this.scopes = new Map();
    this.run = null;
    this.timer = null;
    this.local = null;
    this.judge = null;
    this.review = null;
    this.reviewAt = -Infinity;
    this.reviewAttempts = new Map();
    this.reviewCameraAttempts = new Map();
    button.addEventListener('click', () => this.enabled ? this.disable() : void this.enable());
    this.updateButton();
  }

  get enabled() { return this.run !== null; }

  notifyProgress(cameraId) {
    if (typeof this.onProgress !== 'function') return;
    try {
      this.onProgress({ cameraId });
    } catch (error) {
      console.warn('V4.1 progress listener failed:', error);
    }
  }

  getTrackVote(cameraId, trackId, scopeOptions = {}) {
    if (!this.enabled || typeof cameraId !== 'string' || !cameraId ||
        !Number.isSafeInteger(trackId) || trackId <= 0) {
      return null;
    }
    const feed = this.feeds.get(cameraId);
    const current = this.context(feed);
    if (!current || !current.tracks.has(trackId)) return null;
    const { streamId, generation, epoch } = scopeOptions ?? {};
    if ((streamId !== undefined && streamId !== current.streamId) ||
        (generation !== undefined && generation !== current.generation) ||
        (epoch !== undefined && epoch !== current.epoch)) {
      return null;
    }
    const scope = this.scopes.get(cameraId);
    const samePhase = Boolean(scope && scope.streamId === current.streamId &&
      scope.generation === current.generation && scope.epoch === current.epoch);
    const startedAt = current.tracks.get(trackId);
    const vote = samePhase && scope.voteFrame && startedAt <= scope.voteFrame.captureTime
      ? this.votes.inspect({ cameraId, streamId: current.streamId, generation: current.generation, trackId })
      : null;
    const job = this.run?.job;
    const pending = Boolean(job && job.feed === feed && job.tuple.cameraId === cameraId &&
      this.sameScope(job, current) && job.active.has(trackId) && startedAt <= job.tuple.frameT);
    return Object.freeze({
      count: vote?.count ?? 0,
      total: vote?.total ?? 5,
      ready: vote?.ready ?? false,
      label: vote?.label ?? null,
      confidence: vote?.confidence ?? null,
      pending,
    });
  }

  onFeed(feed) {
    const replaced = Boolean(this.feeds.get(feed.cameraId) && this.feeds.get(feed.cameraId) !== feed);
    if (replaced) this.invalidateCamera(feed.cameraId);
    this.feeds.set(feed.cameraId, feed);
    if (this.enabled || this.judge) this.reconcile(feed, replaced);
    else if (replaced) this.notifyProgress(feed.cameraId);
  }

  onRemove(cameraId) {
    const known = this.feeds.has(cameraId) || this.scopes.has(cameraId) ||
      this.run?.job?.tuple.cameraId === cameraId;
    this.feeds.delete(cameraId);
    this.invalidateCamera(cameraId);
    if (known) this.notifyProgress(cameraId);
  }

  invalidateCamera(cameraId) {
    this.scopes.delete(cameraId);
    this.scheduler.clear(cameraId);
    this.votes.clear(cameraId);
    if (this.run?.job?.tuple.cameraId === cameraId) this.run.job.active.clear();
    if (this.local?.tuple.cameraId === cameraId) this.clearLocal();
    if (this.review?.tuple.cameraId === cameraId) this.clearReview();
    this.reviewCameraAttempts.delete(cameraId);
  }

  reset() {
    const cameraIds = [...this.feeds.keys()];
    for (const id of cameraIds) this.onRemove(id);
    this.reviewAttempts.clear();
    if (!cameraIds.length) this.notifyProgress(null);
  }

  updateButton() {
    this.button.textContent = this.enabled ? 'Turn off browser check' : 'Enable v4.1 browser check';
    this.button.setAttribute('aria-pressed', String(this.enabled));
  }

  setStatus(text, state) {
    if (this.status.textContent !== text) this.status.textContent = text;
    if (this.status.dataset.state !== state) this.status.dataset.state = state;
  }

  async enable() {
    if (this.enabled) return;
    const run = this.run = { client: null, ready: false, job: null };
    this.updateButton();
    this.setStatus('Loading v4.1 in the browser… motion detection stays active.', 'loading');
    try {
      const client = await this.createWorkerClient();
      if (this.run !== run) { client.close(); return; }
      run.client = client;
      await client.load();
      if (this.run !== run) return;
      run.ready = true;
      this.setStatus(WAITING, 'ready');
      this.schedule();
    } catch (error) {
      if (this.run === run) this.fail('load the browser model', error);
    }
  }

  stopWorker() {
    const run = this.run;
    const cameraIds = [...this.feeds.keys()];
    this.run = null;
    if (!this.judge) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    run?.client?.close();
    this.scheduler.clear();
    this.votes.clear();
    for (const scope of this.scopes.values()) delete scope.voteFrame;
    this.local = null;
    this.updateButton();
    if (run) {
      if (cameraIds.length) for (const cameraId of cameraIds) this.notifyProgress(cameraId);
      else this.notifyProgress(null);
    }
  }

  disable() {
    this.stopWorker();
    this.setStatus('Browser check off · motion detection stays active.', 'off');
  }

  fail(action, error) {
    this.stopWorker();
    this.setStatus('Browser check unavailable. Motion detection stays active; enable the check to retry.', 'unavailable');
    console.warn(`V4.1 could not ${action}:`, error.message);
  }

  schedule() {
    if ((!this.run?.ready && !this.judge) || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
      this.schedule();
    }, TICK_MS);
  }

  context(feed) {
    if (!feed || feed.offline || feed.demo || feed.fallbackActive || feed.mode === 'tower') return null;
    const state = feed.detector ? feed.detector.current() : feed.botState;
    const streamId = feed.birdStreamId ?? feed.streamId;
    const generation = feed.detector ? feed.detector.generation : state?.generation;
    if (!streamId || !generation) return null;
    const sameStream = feed.birdStateStreamId === undefined || feed.birdStateStreamId === streamId;
    const tracks = sameStream && Number.isFinite(state?.t) && fresh(feed.lastFrameAt, this.now()) ? tracksIn(state) : [];
    const epoch = feed.birdEpoch, previous = this.scopes.get(feed.cameraId);
    const samePhase = previous?.streamId === streamId && previous.generation === generation && previous.epoch === epoch;
    // The detector stream can advance before a matching bitmap arrives. Do not warm a resumed ID with a pre-gap pair.
    const started = samePhase ? previous.tracks : new Map();
    return { streamId, generation, epoch, tracks: new Map(tracks.filter(usableTrack).map(tr => [tr.id, started.get(tr.id) ?? state.t])) };
  }

  retains(item, feed, context = this.context(feed)) {
    return Boolean(feed === item.feed && this.sameScope(item, context) &&
      context.tracks.get(item.tuple.trackId) <= item.tuple.frameT);
  }

  sameScope(item, context) {
    return Boolean(context && context.epoch === item.epoch &&
      context.streamId === item.tuple.streamId && context.generation === item.tuple.generation);
  }

  reconcile(feed, invalidated = false) {
    const context = this.context(feed), { cameraId } = feed;
    let previous = this.scopes.get(cameraId);
    let changed = invalidated;
    if (previous && (!context || ['streamId', 'generation', 'epoch'].some(key => previous[key] !== context[key]))) {
      this.invalidateCamera(cameraId);
      previous = null;
      changed = true;
    }
    if (context) {
      context.voteFrame = previous?.voteFrame;
      if (context.voteFrame && [...previous.tracks.keys()].some(id => !context.tracks.has(id))) {
        // Narrow the active frame's roster without replacing its handle or accepting a lost track again.
        this.votes.prune({ ...context.voteFrame, liveTrackIds: [...context.tracks.keys()] });
        changed = true;
      }
      this.scopes.set(cameraId, context);
    }
    const job = this.run?.job;
    if (job?.tuple.cameraId === cameraId) {
      const before = job.active.size;
      if (job.feed !== feed || !this.sameScope(job, context)) job.active.clear();
      else for (const id of job.active) if (!context.tracks.has(id)) job.active.delete(id);
      if (job.active.size !== before) changed = true;
    }
    if (this.local?.tuple.cameraId === cameraId && !this.isCurrent(this.local, context)) this.clearLocal();
    if (this.review?.tuple.cameraId === cameraId) {
      if (!this.retains(this.review, feed, context)) this.review.valid = false;
      this.renderReview();
    }
    if (changed) this.notifyProgress(cameraId);
  }

  isCurrent(item, context) {
    return fresh(item.frameReceivedAt, this.now()) && this.retains(item, this.feeds.get(item.tuple.cameraId), context);
  }

  frameItem(feed, pair) {
    if (!pair || feed.birdEvidence !== pair || this.feeds.get(feed.cameraId) !== feed) return null;
    const { source, generation, frame, state } = pair;
    if (source !== 'server' || !frame || state?.generation !== generation) return null;
    const { streamId, frameId, frameT, frameReceivedAt } = frame;
    const item = { feed, epoch: feed.birdEpoch, frameReceivedAt,
      tuple: { cameraId: feed.cameraId, streamId, generation, frameId, frameT } };
    return Number.isSafeInteger(frameId) && frameId > 0 && Number.isFinite(frameT) && frameT === state?.t &&
      fresh(frameReceivedAt, this.now()) && this.sameScope(item, this.scopes.get(feed.cameraId)) ? item : null;
  }

  clearLocal() {
    this.local = null;
    if (this.run?.ready) this.setStatus(WAITING, 'ready');
  }

  async tick() {
    if (this.isHidden()) return;
    const now = this.now();
    for (const feed of this.feeds.values()) {
      if (now - feed.lastFrameAt > 10000) this.onRemove(feed.cameraId);
      else this.reconcile(feed);
    }
    if (this.judge && !this.review?.pending && now - this.reviewAt >= REVIEW_INTERVAL_MS) void this.reviewLatest(now);
    const run = this.run;
    if (!run?.ready || run.job) return;
    this.votes.prune();
    const candidate = this.scheduler.pick(this.feeds, now);
    if (!candidate) return;
    const { feed, pair } = candidate;
    const item = this.frameItem(feed, pair);
    if (!item) return;
    const scope = this.scopes.get(feed.cameraId);
    const tracks = candidate.tracks.filter(tr => scope.tracks.get(tr.id) <= item.tuple.frameT);
    if (!tracks.length) return;
    const job = run.job = { ...item, active: new Set(tracks.map(tr => tr.id)) };
    const { cameraId, streamId, generation, frameId, frameT } = item.tuple;
    let started = false, failed = false;
    try {
      const voteFrame = { cameraId, streamId, generation, frameId, captureTime: frameT };
      const handle = this.votes.prune({ ...voteFrame, liveTrackIds: [...scope.tracks.keys()] });
      if (handle.status !== 'active') return;
      scope.voteFrame = voteFrame;
      const input = snapshotClassifierFrame(pair);
      if (!input) return;
      started = true;
      this.notifyProgress(cameraId);
      // The client returns results in submitted order, not identity. This job owns the tuple and copied boxes.
      const results = await run.client.classify(input, tracks.map(tr => tr.bbox));
      if (this.run !== run || !job.active.size || this.feeds.get(cameraId) !== feed || !fresh(item.frameReceivedAt, this.now())) return;
      const current = this.context(feed);
      if (!this.sameScope(item, current)) return;
      if (!Array.isArray(results) || results.length !== tracks.length) throw new Error('inference returned the wrong number of results');
      let chosen = null;
      for (const [i, track] of tracks.entries()) {
        if (!job.active.has(track.id) || !(current.tracks.get(track.id) <= frameT) || !results[i]?.probs) continue;
        const vote = this.votes.record({ frame: handle, trackId: track.id, probs: results[i].probs });
        if (chosen?.vote.status !== 'ready' && (vote.status === 'ready' || (vote.status === 'collecting' && !chosen))) {
          chosen = { checked: trackItem(item, track.id), vote };
        }
      }
      if (chosen) this.showVote(chosen);
    } catch (error) {
      if (this.run === run) {
        failed = true;
        this.fail('check the tracked objects', error);
      }
    } finally {
      run.job = null;
      if (started && !failed && this.run === run) this.notifyProgress(cameraId);
    }
  }

  showVote({ checked, vote }) {
    const { cameraId, trackId } = checked.tuple;
    const subject = `Browser advisory · ${cameraId}, object ${trackId}`;
    if (vote.status === 'ready' && CLASSES.includes(vote.label)) {
      this.local = checked;
      this.setStatus(`${subject}: ${vote.label} (${Math.round(vote.score * 100)}% mean probability over 5 frames). Not a clearance.`, 'active');
    } else if (vote.status === 'collecting' && this.status.dataset.state !== 'active') {
      this.local = checked;
      this.setStatus(`${subject} · collecting distinct frames (${vote.count}/5).`, 'checking');
    }
  }

  setJudge(judge) {
    if (this.judge === judge) return;
    this.judge = judge;
    this.clearReview();
    if (judge) this.schedule();
    else if (!this.run?.ready) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  clearReview() {
    this.review?.abort.abort();
    this.review = null;
    this.renderReview();
  }

  async reviewLatest(now) {
    const live = new Map([...this.feeds].filter(([id]) => this.scopes.has(id)));
    const candidate = chooseBirdCandidate(live, this.reviewAttempts, now, this.reviewCameraAttempts);
    const frame = candidate && this.frameItem(candidate.t, candidate.evidence);
    const item = frame && trackItem(frame, candidate.tr.id);
    if (!item || !this.isCurrent(item)) return;
    const { cameraId, streamId, frameId, trackId } = item.tuple;
    const reference = { cameraId, streamId, frameId, trackId };
    this.reviewAt = now;
    // Review cadence is lower than inference and must stay below the server's request limit.
    for (const [key, at] of this.reviewAttempts) if (now - at > 10000) this.reviewAttempts.delete(key);
    this.reviewAttempts.set(candidate.key, now);
    this.reviewCameraAttempts.set(cameraId, now);
    const review = this.review = { ...item, valid: true, pending: true, abort: new AbortController() };
    this.renderReview();
    try {
      const result = await this.judge(reference, review.abort.signal);
      if (this.review !== review) return;
      const ref = result?.evidenceRef;
      if (!ref || !sameTuple({ ...ref, frameT: ref.t }, item.tuple) || result.status !== 'verified' ||
          !['gemini', 'local'].includes(result.source) || !['advisory', 'historical'].includes(result.application) ||
          !['bird', 'not_bird', 'uncertain'].includes(result.verdict)) {
        review.unavailable = true;
      } else review.result = result;
    } catch (error) {
      if (this.review === review) {
        review.unavailable = true;
        console.warn('Evidence review unavailable:', error.message);
      }
    } finally {
      if (this.review === review) {
        review.pending = false;
        this.renderReview();
      }
    }
  }

  renderReview() {
    if (!this.reviewStatus) return;
    const review = this.review;
    let text = '';
    if (review?.pending) text = 'Evidence review pending. Browser checks are independent.';
    else if (review?.unavailable) text = 'Evidence review unavailable.';
    else if (review?.result) {
      const { result, tuple } = review;
      const verdict = { bird: 'bird', not_bird: 'not a bird', uncertain: 'uncertain' }[result.verdict];
      const where = result.source === 'local' ? 'local-model' : 'cloud';
      const current = result.application === 'advisory' && review.valid && this.isCurrent(review);
      const label = current ? `${where === 'cloud' ? 'Cloud' : 'Local-model'} advisory` : `Earlier ${where} review`;
      text = `${label} · ${tuple.cameraId}, object ${tuple.trackId}: ${verdict}. Not a clearance.`;
    }
    if (this.reviewStatus.textContent !== text) this.reviewStatus.textContent = text;
  }
}
