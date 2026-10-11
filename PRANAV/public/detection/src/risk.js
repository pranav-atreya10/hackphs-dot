// Risk engine: green / yellow / red with hysteresis.
//
//  red    : any drone, any bird flock of 5+, or any bird/flock under 30 s from the corridor
//  yellow : any confirmed bird (or, by default, any unverified object so Gemini can check it)
//  green  : nothing confirmed in the sky
//  (debris, meaning thrown rocks and falling objects, never raises the level; it is only listed)
//
// The level rises immediately but only steps down after it has been lower for
// `holdSec`, so the tower display and voice alerts don't flicker.

const RANK = { green: 0, yellow: 1, red: 2 };
const LEVELS = ['green', 'yellow', 'red'];

export class RiskEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.level = 'green';
    this.lowerSince = null;
    this.changedAt = 0;
  }

  reset() {
    this.level = 'green';
    this.lowerSince = null;
  }

  // groups: [{ kind: 'flock'|'track', size, classification, eta_seconds, label }]
  // audio: { active, confidence }
  evaluate(groups, audio, t) {
    const c = this.cfg;
    const reasons = [];
    let raw = 0;

    if (audio && audio.active) {
      raw = 2;
      reasons.push(`Drone sound (${audio.confidence} confidence)`);
    }
    let debris = 0;
    for (const g of groups) {
      const cls = g.classification;
      if (cls === 'rejected') continue;
      if (cls === 'debris') { debris += g.size; continue; }
      if (cls === 'drone') {
        raw = 2;
        reasons.push(`Drone ${g.label}`);
      } else if (cls === 'bird') {
        if (g.size >= c.flockRed) {
          raw = 2;
          reasons.push(`Flock of ${g.size} ${g.label}`);
        }
        if (g.eta_seconds !== null && g.eta_seconds <= c.etaRedSec) {
          raw = 2;
          reasons.push(`${g.size > 1 ? `Flock of ${g.size}` : 'Bird'} ${g.label} ${Math.round(g.eta_seconds)} s from corridor`);
        }
        if (raw < 1) raw = 1;
      } else if (c.unknownCountsYellow && raw < 1) {
        raw = 1;
      }
    }
    if (raw === 1 && !reasons.length) {
      const birds = groups.filter((g) => g.classification === 'bird').reduce((s, g) => s + g.size, 0);
      const unknown = groups.filter((g) => g.classification === 'unknown').reduce((s, g) => s + g.size, 0);
      if (birds) reasons.push(`${birds} bird${birds > 1 ? 's' : ''} in view`);
      if (unknown) reasons.push(`${unknown} unverified object${unknown > 1 ? 's' : ''}`);
    }
    if (debris) reasons.push(`${debris} falling object${debris > 1 ? 's' : ''} ignored (debris, not birds)`);

    const cur = RANK[this.level];
    if (raw >= cur) {
      if (raw > cur) this.changedAt = t;
      this.level = LEVELS[raw];
      this.lowerSince = null;
    } else {
      if (this.lowerSince === null) this.lowerSince = t;
      if (t - this.lowerSince >= c.holdSec) {
        this.level = LEVELS[raw];
        this.lowerSince = null;
        this.changedAt = t;
      }
    }
    return { level: this.level, raw: LEVELS[raw], reasons, since: this.changedAt };
  }
}
