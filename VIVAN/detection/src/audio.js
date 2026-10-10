// Drone sound: turns a stream of "drone probability" readings into a stable
// heard / not-heard decision, from either the Teachable Machine model or the
// built-in hum detector below.

export class DroneAudioState {
  constructor(cfg) {
    this.cfg = cfg;
    this.prob = 0;
    this.source = null;
    this.aboveSince = null;
    this.lastAbove = -Infinity;
    this.active = false;
  }

  // prob in 0..1, t in seconds (same clock as the video frames)
  update(prob, t, source = 'model') {
    const c = this.cfg;
    this.prob = prob;
    this.source = source;
    if (prob >= c.highProb) {
      if (this.aboveSince === null) this.aboveSince = t;
      this.lastAbove = t;
      if (t - this.aboveSince >= c.sustainSec) this.active = true;
    } else {
      this.aboveSince = null;
      if (t - this.lastAbove > c.decaySec) this.active = false;
    }
  }

  // Readings stop arriving if the mic dies; expire the state on the frame clock too.
  tick(t) {
    if (this.active && t - this.lastAbove > this.cfg.decaySec) this.active = false;
  }

  snapshot() {
    return { active: this.active, prob: +this.prob.toFixed(3), source: this.source };
  }
}

// Fallback drone detector that needs no trained model. Drone motors and props make
// a steady buzz: a strong fundamental (roughly 80-600 Hz) with harmonics that
// stays at the same pitch. Feed it AnalyserNode.getFloatFrequencyData() output
// (dB per bin) a few times per second; it returns a 0..1 drone probability.
export class HumDetector {
  constructor() {
    this.history = []; // recent fundamental estimates (Hz)
  }

  update(spectrumDb, sampleRate) {
    const n = spectrumDb.length;
    const binHz = sampleRate / 2 / n;
    const lo = Math.ceil(80 / binHz);
    const hi = Math.min(n - 2, Math.floor(600 / binHz));

    // Noise floor: median of the 80-4000 Hz band.
    const band = Array.from(spectrumDb.slice(lo, Math.min(n, Math.floor(4000 / binHz))));
    band.sort((a, b) => a - b);
    const floor = band[band.length >> 1];

    let bestScore = 0;
    let bestF = 0;
    for (let k = lo; k <= hi; k++) {
      const v = spectrumDb[k];
      if (v < spectrumDb[k - 1] || v < spectrumDb[k + 1] || v - floor < 12) continue;
      // Harmonic support: energy near 2f and 3f above the floor.
      let support = 0;
      for (const m of [2, 3]) {
        const c = Math.round(k * m);
        if (c + 1 >= n) break;
        const h = Math.max(spectrumDb[c - 1], spectrumDb[c], spectrumDb[c + 1]);
        if (h - floor > 8) support++;
      }
      const score = (v - floor) * (1 + 0.5 * support);
      if (score > bestScore) { bestScore = score; bestF = k * binHz; }
    }

    this.history.push(bestF);
    if (this.history.length > 8) this.history.shift();
    if (!bestF || this.history.length < 4) return 0;

    // Pitch stability across the last readings.
    const recent = this.history.filter((f) => f > 0);
    const stable = recent.filter((f) => Math.abs(f - bestF) / bestF < 0.06).length / this.history.length;
    const loud = Math.min(1, bestScore / 40);
    return +(stable * loud).toFixed(3);
  }
}
