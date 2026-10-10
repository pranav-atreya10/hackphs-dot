// Risk rules from the build plan, section 1:
//   green  - no birds, no drone sound
//   yellow - 1 to 4 birds, none heading toward the runway
//   red    - 5 or more birds, any bird heading toward the runway, or any drone sound

export const RISK_RULES = {
  redBirdCount: 5,          // this many birds or more is red
  droneConfidence: 0.8,     // drone class must stay above this...
  droneHoldMs: 1000         // ...for this long before it counts
};

/**
 * @param {Object} s
 * @param {number} s.birdCount            birds currently tracked
 * @param {boolean} s.anyTowardRunway     at least one bird is heading toward the runway side
 * @param {boolean} s.droneHeard          the sound model has held "Drone" above threshold long enough
 * @returns {{risk:'green'|'yellow'|'red', reason:string}}
 */
export function classifyRisk({ birdCount = 0, anyTowardRunway = false, droneHeard = false }, rules = RISK_RULES) {
  if (droneHeard) return { risk: 'red', reason: 'drone sound detected' };
  if (birdCount >= rules.redBirdCount) return { risk: 'red', reason: `${birdCount} birds in view` };
  if (birdCount > 0 && anyTowardRunway) return { risk: 'red', reason: 'bird heading toward the runway' };
  if (birdCount > 0) return { risk: 'yellow', reason: `${birdCount} bird${birdCount === 1 ? '' : 's'}, not heading toward the runway` };
  return { risk: 'green', reason: 'clear' };
}

/**
 * Debounces the drone class: "Drone" must stay above the threshold for droneHoldMs.
 * Feed it every sound-model result; read `.heard`.
 */
export class DroneGate {
  constructor(rules = RISK_RULES) { this.rules = rules; this.since = null; this.heard = false; }
  update(droneScore, nowMs) {
    if (droneScore >= this.rules.droneConfidence) {
      this.since ??= nowMs;
      this.heard = nowMs - this.since >= this.rules.droneHoldMs;
    } else {
      this.since = null; this.heard = false;
    }
    return this.heard;
  }
}

/** The sentence the tower hears for a red alert, e.g. "Caution, flock of eight birds crossing the runway, heading east." */
export function alertSentence({ type, object_count, direction }) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  if (type === 'drone') return 'Caution, drone detected near the runway.';
  const n = words[object_count] ?? String(object_count);
  const what = object_count >= 5 ? `flock of ${n} birds` : `${n} bird${object_count === 1 ? '' : 's'}`;
  return `Caution, ${what} ${direction === 'toward runway' ? 'heading toward the runway' : 'near the runway'}.`;
}
