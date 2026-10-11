// Default tuning values for the detection engine.
// Pixel sizes are measured at the processing resolution (default 320 px wide).
// Positions sent to the frontend/server are normalized: x and y run 0..1 across the frame.

export const DEFAULTS = {
  camera_id: 'runway-east',

  camera: {
    lat: 40.3987,          // Princeton Airport (39N), runway area. Replace with your demo spot.
    lon: -74.6586,
    heading_deg: 90,       // compass direction the camera faces (90 = east)
    hfov_deg: 65,          // horizontal field of view of the lens
    pitch_deg: 20,         // how far the camera is tilted up from the horizon
    assumed_range_m: 400,  // guessed distance to targets, used only to draw map lines
  },

  motion: {
    threshold: 16,        // minimum gray-level difference from background to count as "changed"
    noiseK: 4,            // threshold also rises to noiseK x (average sensor noise)
    bgAlpha: 0.05,        // how fast the background learns (per frame)
    bgAlphaFg: 0.002,     // much slower learning under moving objects, so slow drones don't leave trails
                          // (ghosts this would otherwise create are removed by the ghost check)
    dilate: 1,            // grow changed pixels by this radius so wing pieces join their body
    shakeFraction: 0.12,  // if more than 12% of the sky changes at once, treat it as camera shake
    shakeCooldown: 6,     // frames to wait after a shake before detecting again
    warmupFrames: 15,     // learn the background quickly at start, so objects in frame 1 don't leave ghosts
    warmupAlpha: 0.25,
  },

  blobs: {
    minArea: 3,           // smallest blob in raw changed pixels
    maxAreaFrac: 0.04,    // biggest blob as a fraction of the frame (bigger = cloud edge, etc.)
    maxBlobs: 200,        // more blobs than this in one frame means noise; skip the frame
    mergeGap: 2,          // blobs whose boxes are within this many px are merged (wing tip + body)
    mergeMaxArea: 400,    // ...but only small ones, so two separate birds don't fuse
  },

  ghost: {
    enabled: true,
    ringPx: 3,            // width of the sky ring around a blob used for comparison
    minRingPixels: 8,
    ratio: 0.35,          // contrast-now / contrast-vs-background below this = ghost
  },

  tracker: {
    maxJump: 24,          // furthest a blob can move between frames and stay the same track (px)
    predictedGate: 0.5,   // once moving, blobs must land within maxJump x this of the predicted spot
    confirmFrames: 4,     // consecutive hits before a track is confirmed
    maxMisses: 5,         // frames a confirmed track can go unseen before it's dropped
    maxMissesTentative: 1,
    minTravel: 2.5,       // px a track must move before confirming (kills flickering specks)
    posGain: 0.85,        // alpha-beta filter gains
    velGain: 0.4,
    velWindowSec: 0.6,    // smoothed velocity = straight-line fit over this much trail
    velMinPoints: 5,
    trailSec: 3,          // trail length kept for drawing and evidence
    sampleSec: 2.5,       // size history kept for wingbeat analysis
  },

  wingbeat: {
    windowSec: 1.5,       // analyse the last 1.5 s of blob size
    minDurationSec: 1.0,
    minSamples: 14,
    minHz: 2,
    maxHz: 12,
    peakThreshold: 0.45,  // autocorrelation peak needed to call it a rhythm
    steadyCV: 0.07,       // size varies less than 7% => steady (drone / plane / glider)
    massSupport: 0.8,     // a rhythm seen in area/major needs mass rhythm >= 80% of peakThreshold...
    massHzTolerance: 0.25, // ...at a beat rate within 25% (guards against pixel-grid ripples)
    minArea: 6,           // blobs smaller than this are too small to judge
    evalEvery: 2,         // analyse every N frames per track
    hzTolerance: 0.25,    // consecutive beat-rate readings must agree within 25%
    minConsistent: 2,     // ...this many times in a row (2 = three matching readings) before "flapping"
    smoothing: 0.35,      // how quickly the per-track verdict follows new analyses
  },

  // Debris check (see debris.js): thrown rocks and tumbling debris are not birds.
  debris: {
    enabled: true,
    windowSec: 1.2,       // fit the path over this much recent trail
    minPoints: 8,         // ...with at least this many positions
    minSpanSec: 0.4,      // ...covering at least this long
    minPull: 25,          // pull (downward accel ÷ own length, per s²) no bird can make; gravity on debris does
    maxFitRatio: 0.35,    // the parabola must leave at most 35% of a straight line's error...
    minBendPx: 0.6,       // ...and the path must visibly bend (px) before we judge it
    downRatio: 2,         // the pull must point down: vertical at least 2x sideways
    spinWindowSec: 1.5,   // look at this much recent shape history for spinning
    minElongation: 1.4,   // only read the angle when the blob is clearly longer than wide
    minSpinSteps: 8,      // ...in at least this many frame-to-frame steps
    minTurnDeg: 180,      // spinning = turned at least half a revolution...
    spinConsistency: 0.7, // ...with at least 70% of steps turning the same way
    smoothing: 0.35,      // how quickly the per-track verdict follows new checks
  },

  flocks: {
    radiusFrac: 0.14,      // tracks closer than 14% of the frame width can be flockmates
    maxHeadingDiff: 30,    // and must be flying within 30 degrees of each other
    minSpeed: 4,           // px/s below which heading is ignored (hovering/soaring)
    minSize: 2,
    inferBirdAtSize: 3,    // a coherent group of 3+ unknowns is treated as birds
  },

  corridor: {
    polygon: [],           // normalized [[x,y], ...] approach corridor drawn by the user
    horizonSec: 60,        // ETAs beyond this are reported as "not heading in"
    etaSigma: 2,           // ETA range = ETA with velocity nudged ±2 standard errors (~95%)
  },

  skyMask: {
    polygon: [],           // normalized polygon; empty = whole frame is sky
  },

  coco: {
    birdScore: 0.4,        // COCO "bird" at or above this upgrades an unknown to bird
    disagreeScore: 0.6,    // COCO non-bird label this confident lowers a flapping bird's confidence
    agreeBoost: 0.1,       // confidence added when wingbeat and COCO both say bird
    disagreePenalty: 0.15,
    maxAgeSec: 6,          // ignore COCO labels older than this (the object may have changed)
    minPx: 24,             // only check objects at least this many px (long side, full camera res)
    cooldownSec: 3,        // re-check the same track at most this often
    // COCO labels that just mean "small thing in the air" (it calls dark blobs frisbees):
    // shown in the UI, but they neither upgrade nor penalise and don't count toward agreement.
    uninformative: ['kite', 'frisbee', 'sports ball'],
  },

  risk: {
    flockRed: 5,
    etaRedSec: 30,
    holdSec: 3,                // stay at a level this long before stepping down
    unknownCountsYellow: true, // unverified objects raise yellow so Gemini can check them
  },

  audio: {
    highProb: 0.8,     // drone class probability for a "drone heard" decision
    sustainSec: 1.0,   // ...held for this long
    decaySec: 2.0,     // drone sound state clears after this long below threshold
  },

  report: {
    batchIntervalSec: 1,     // track_batch cadence
    pointsPerSecond: 5,      // max points per track per second in track_batch
    heartbeatSec: 2,         // repeat yellow/red events this often
    greenHeartbeatSec: 5,    // quiet status updates
    cropMinIntervalSec: 5,   // max one crop per flock/track per 5 s
    cropPad: 0.6,            // padding around the crop box, as a fraction of its size
    evidencePoints: 30,
  },
};

export function mergeConfig(base, patch) {
  if (!patch) return structuredCloneSafe(base);
  const out = structuredCloneSafe(base);
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeConfig(out[k], v);
    } else {
      out[k] = Array.isArray(v) ? v.map((p) => (Array.isArray(p) ? [...p] : p)) : v;
    }
  }
  return out;
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}
