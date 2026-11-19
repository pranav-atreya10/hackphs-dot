export const VIDEO_ONLY = 'Video only · drone audio unavailable';
const MAX_RESULT_AGE_MS = 3000;
const validGeneration = value => typeof value === 'string' && value.trim().length > 0;

export class DetectorStatus {
  constructor(now = () => performance.now(), wallNow = () => Date.now()) {
    this.now = now;
    this.wallNow = wallNow;
    this.lastSourceAt = 0;
    this.reset();
  }

  reset(mode = 'starting', reason = 'waiting for fresh server results') {
    this.mode = mode;
    this.reason = reason;
    this.generation = null;
    this.state = null;
    this.expiresAt = 0;
  }

  update({ mode, reason, generation }) {
    if (mode !== 'server') this.reset(mode === 'starting' ? 'starting' : 'unavailable', reason || 'server detection unavailable');
    else if (!validGeneration(generation)) this.reset('unavailable', 'missing detector generation');
    else {
      if (generation !== this.generation) this.reset();
      this.mode = mode;
      this.reason = null;
      this.generation = generation;
    }
  }

  accept({ mode, state, at, remaining_ms }) {
    if (this.mode !== 'server' || mode !== 'server' || !validGeneration(state?.generation) || state.generation !== this.generation || !Array.isArray(state.tracks) ||
        !['green', 'yellow', 'red'].includes(state.risk) || state.learning || state.shake || state.overflow ||
        !Number.isSafeInteger(at) || at <= this.lastSourceAt ||
        !Number.isFinite(remaining_ms) || remaining_ms <= 0) return false;
    // remaining_ms is the server's budget at `at`, not a fresh lease at receipt.
    const age = this.wallNow() - at;
    const usableMs = Math.min(MAX_RESULT_AGE_MS, remaining_ms) - age;
    if (age < 0 || !Number.isFinite(usableMs) || usableMs <= 0) return false;

    this.lastSourceAt = at;
    this.state = state;
    this.expiresAt = this.now() + usableMs;
    return true;
  }

  current() {
    if (this.now() >= this.expiresAt) this.state = null;
    return this.state;
  }

  message() {
    if (this.current()) return `Server detector active · ${VIDEO_ONLY}`;
    if (this.mode === 'starting') return `Server detector not ready (${this.reason}) · ${VIDEO_ONLY}`;
    const reason = this.reason || 'no fresh server results';
    return `Server detection unavailable (${reason}) · ${VIDEO_ONLY}`;
  }
}
