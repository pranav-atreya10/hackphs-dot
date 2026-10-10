// Tuning registry: every parameter worth adjusting, with a safe range and the symptom
// that tells you which way to move it. A settings panel can be generated from PARAMS,
// and the sweep tool (tune.js) uses the ranges.

import { DEFAULTS } from './config.js';

export const PARAMS = [
  // ---- Motion: what counts as "changed" ----
  { path: 'motion.threshold', min: 6, max: 40, step: 1, stage: 'motion', impact: 'high',
    what: 'Minimum brightness difference from the learned sky to count as changed.',
    raiseIf: 'Random specks or sensor noise become blobs; too many tentative tracks.',
    lowerIf: 'Faint or distant birds are missed; blobs flicker on and off.' },
  { path: 'motion.noiseK', min: 2, max: 8, step: 0.5, stage: 'motion', impact: 'medium',
    what: 'Threshold also rises to noiseK x measured sensor noise (auto-adjust for grainy cameras).',
    raiseIf: 'Noisy/low-light phone produces speckle blobs.',
    lowerIf: 'Threshold (state.motion.threshold) climbs far above 16 on a clean camera.' },
  { path: 'motion.bgAlpha', min: 0.01, max: 0.2, step: 0.01, stage: 'motion', impact: 'medium',
    what: 'How fast the background learns normal sky (per frame).',
    raiseIf: 'Moving clouds or changing light create blobs.',
    lowerIf: 'Slow-moving birds fade out before they are confirmed.' },
  { path: 'motion.bgAlphaFg', min: 0.0005, max: 0.02, step: 0.0005, stage: 'motion', impact: 'medium',
    what: 'How fast the background learns under a moving object.',
    raiseIf: 'Something that really stopped (parked object) stays detected forever.',
    lowerIf: 'Slow drones/birds leave a trail or split into two tracks.' },
  { path: 'motion.dilate', min: 0, max: 3, step: 1, stage: 'motion', impact: 'medium',
    what: 'Grow changed pixels by this radius to join wing pieces to the body.',
    raiseIf: 'One bird shows up as two blobs/tracks.',
    lowerIf: 'Two nearby birds merge into one blob (flock undercounted).' },
  { path: 'motion.shakeFraction', min: 0.04, max: 0.4, step: 0.01, stage: 'motion', impact: 'low',
    what: 'If more than this share of the sky changes at once, treat it as camera shake.',
    raiseIf: 'A large, close flock triggers "shake" and is ignored.',
    lowerIf: 'Bumping the phone causes a burst of false blobs.' },
  { path: 'motion.warmupFrames', min: 5, max: 60, step: 1, stage: 'motion', impact: 'low',
    what: 'Frames of fast background learning at startup/after reset.',
    raiseIf: 'Objects present at startup leave ghosts.',
    lowerIf: 'Detection starts too late after starting a clip.' },

  // ---- Blobs ----
  { path: 'blobs.minArea', min: 1, max: 20, step: 1, stage: 'blobs', impact: 'high',
    what: 'Smallest object in pixels.',
    raiseIf: 'Insects/noise specks become tracks.',
    lowerIf: 'Distant birds (2-3 px) are never detected.' },
  { path: 'blobs.maxAreaFrac', min: 0.005, max: 0.2, step: 0.005, stage: 'blobs', impact: 'low',
    what: 'Largest object as a share of the frame.',
    raiseIf: 'A close bird or drone disappears when it gets big.',
    lowerIf: 'Cloud edges or glare become huge blobs.' },
  { path: 'blobs.mergeGap', min: 0, max: 6, step: 1, stage: 'blobs', impact: 'medium',
    what: 'Merge small blobs whose boxes are within this many px (wing tip + body).',
    raiseIf: 'Flock count too high (birds split when wings fold).',
    lowerIf: 'Tight flocks undercounted (neighbours merged).' },
  { path: 'ghost.ratio', min: 0.1, max: 0.6, step: 0.05, stage: 'blobs', impact: 'medium',
    what: 'Blob contrast vs nearby sky (now) / contrast vs background. Below this = ghost.',
    raiseIf: 'Stationary ghosts appear where objects started.',
    lowerIf: 'Real low-contrast birds (against cloud) are dropped as ghosts.' },

  // ---- Tracking ----
  { path: 'tracker.maxJump', min: 8, max: 80, step: 2, stage: 'track', impact: 'high',
    what: 'Furthest (px) a new object may move between frames and keep its ID.',
    raiseIf: 'Fast birds/low FPS: tracks keep breaking and restarting (IDs climb fast).',
    lowerIf: 'IDs jump between nearby birds; noise gets linked into tracks.' },
  { path: 'tracker.predictedGate', min: 0.2, max: 1, step: 0.05, stage: 'track', impact: 'medium',
    what: 'Once moving, a blob must land within maxJump x this of the predicted spot.',
    raiseIf: 'Erratic flyers (swallows, turning birds) lose their tracks.',
    lowerIf: 'Random noise occasionally confirms as a track.' },
  { path: 'tracker.confirmFrames', min: 2, max: 10, step: 1, stage: 'track', impact: 'high',
    what: 'Consecutive sightings before a track counts.',
    raiseIf: 'Brief flickers/insects become confirmed tracks.',
    lowerIf: 'Alerts feel slow; fast birds cross before confirming.' },
  { path: 'tracker.maxMisses', min: 1, max: 20, step: 1, stage: 'track', impact: 'medium',
    what: 'Frames a confirmed track survives without being seen.',
    raiseIf: 'Birds lose their ID when briefly fading (against clouds).',
    lowerIf: 'Tracks linger after birds leave; ghosts coast too long.' },
  { path: 'tracker.minTravel', min: 0, max: 10, step: 0.5, stage: 'track', impact: 'medium',
    what: 'px a track must move before confirming.',
    raiseIf: 'Stationary flicker (twinkling, ghosts) confirms.',
    lowerIf: 'Hovering birds/drones directly toward the camera never confirm.' },
  { path: 'tracker.velWindowSec', min: 0.2, max: 2, step: 0.1, stage: 'track', impact: 'medium',
    what: 'Seconds of trail used to fit the smooth velocity (ETA, heading, flocks).',
    raiseIf: 'ETA and heading jitter.',
    lowerIf: 'ETA reacts too slowly when a flock turns.' },

  // ---- Wingbeat ----
  { path: 'wingbeat.windowSec', min: 0.8, max: 3, step: 0.1, stage: 'wingbeat', impact: 'high',
    what: 'Seconds of size history analysed per reading.',
    raiseIf: 'Slow flappers (geese, ~2 Hz) not detected; Hz readings jumpy.',
    lowerIf: 'Birds take too long to be classified.' },
  { path: 'wingbeat.peakThreshold', min: 0.25, max: 0.8, step: 0.05, stage: 'wingbeat', impact: 'high',
    what: 'Autocorrelation peak needed to call it a rhythm.',
    raiseIf: 'Bags/debris/drones get called birds.',
    lowerIf: 'Real flapping birds stay "unknown".' },
  { path: 'wingbeat.steadyCV', min: 0.02, max: 0.2, step: 0.01, stage: 'wingbeat', impact: 'high',
    what: 'Size swing below this = steady (drone/plane); flapping needs at least this.',
    raiseIf: 'Drones/planes get called flapping; steady objects show as irregular.',
    lowerIf: 'Distant birds with small swings never count as flapping.' },
  { path: 'wingbeat.minArea', min: 2, max: 20, step: 1, stage: 'wingbeat', impact: 'medium',
    what: 'Objects smaller than this (px) are "too small to judge".',
    raiseIf: 'Tiny objects get unreliable flap_hz (e.g. half the true rate).',
    lowerIf: 'Distant birds never get a wingbeat verdict.' },
  { path: 'wingbeat.hzTolerance', min: 0.1, max: 0.5, step: 0.05, stage: 'wingbeat', impact: 'medium',
    what: 'Consecutive beat-rate readings must agree within this fraction.',
    raiseIf: 'Real birds flicker between flapping and irregular.',
    lowerIf: 'Random flutter gets accepted as a rhythm.' },
  { path: 'wingbeat.minConsistent', min: 1, max: 5, step: 1, stage: 'wingbeat', impact: 'medium',
    what: 'Agreeing readings in a row required before "flapping".',
    raiseIf: 'Brief accidental rhythms (bags, flags) flip to bird.',
    lowerIf: 'Bird classification is too slow.' },
  { path: 'wingbeat.massSupport', min: 0, max: 1, step: 0.1, stage: 'wingbeat', impact: 'low',
    what: 'A rhythm seen in pixel counts must also appear in contrast mass (x peakThreshold). 0 = off.',
    raiseIf: 'Objects drifting across pixel rows show a fake rhythm.',
    lowerIf: 'Real birds whose rhythm only shows in shape (area/major) are missed.' },
  { path: 'wingbeat.evalEvery', min: 1, max: 6, step: 1, stage: 'wingbeat', impact: 'low',
    what: 'Analyse each track every N frames (performance).',
    raiseIf: 'Wingbeat stage is slow with many tracks (see stats.stage_ms.wingbeat).',
    lowerIf: 'Classification lags.' },

  // ---- Flocks ----
  { path: 'flocks.radiusFrac', min: 0.03, max: 0.4, step: 0.01, stage: 'flocks', impact: 'high',
    what: 'Neighbour distance for flockmates (share of frame width).',
    raiseIf: 'One loose flock splits into several small ones.',
    lowerIf: 'Separate birds/flocks get lumped together (inflated flock_size).' },
  { path: 'flocks.maxHeadingDiff', min: 10, max: 90, step: 5, stage: 'flocks', impact: 'medium',
    what: 'Max direction difference (degrees) between flockmates.',
    raiseIf: 'Turning/milling flocks split up.',
    lowerIf: 'Birds crossing in different directions get grouped.' },
  { path: 'flocks.inferBirdAtSize', min: 2, max: 10, step: 1, stage: 'flocks', impact: 'medium',
    what: 'A coherent group this big counts as birds even without wingbeat.',
    raiseIf: 'Groups of debris/insects get labelled birds.',
    lowerIf: 'Distant flocks stay "unknown".' },

  // ---- Corridor / risk ----
  { path: 'corridor.horizonSec', min: 10, max: 180, step: 5, stage: 'risk', impact: 'low',
    what: 'ETAs longer than this are reported as "not heading in".',
    raiseIf: 'You want earlier warnings for slow, far flocks.',
    lowerIf: 'Too many long, unreliable ETAs.' },
  { path: 'corridor.etaSigma', min: 1, max: 3, step: 0.5, stage: 'risk', impact: 'low',
    what: 'Width of the ETA range in standard errors (2 = ~95%).',
    raiseIf: 'Range looks overconfident.', lowerIf: 'Range is too wide to be useful.' },
  { path: 'risk.flockRed', min: 2, max: 20, step: 1, stage: 'risk', impact: 'high',
    what: 'Flock size that triggers RED on its own.',
    raiseIf: 'Too many red alerts for small groups.', lowerIf: 'Airport wants stricter alerts.' },
  { path: 'risk.etaRedSec', min: 5, max: 120, step: 5, stage: 'risk', impact: 'high',
    what: 'Any bird under this many seconds from the corridor triggers RED.',
    raiseIf: 'Tower wants more warning time.', lowerIf: 'Red alerts fire for birds that never arrive.' },
  { path: 'risk.holdSec', min: 0, max: 15, step: 0.5, stage: 'risk', impact: 'medium',
    what: 'Seconds of calm before stepping the risk level down.',
    raiseIf: 'Alerts flicker on and off.', lowerIf: 'Status stays red too long after birds leave.' },

  // ---- COCO-SSD second opinion ----
  { path: 'coco.birdScore', min: 0.2, max: 0.9, step: 0.05, stage: 'coco', impact: 'medium',
    what: 'COCO "bird" score needed to upgrade an unknown object to bird.',
    raiseIf: 'Clouds, kites or debris get upgraded to bird by COCO.',
    lowerIf: 'Large, clearly visible gliding birds stay unknown.' },
  { path: 'coco.disagreeScore', min: 0.3, max: 0.95, step: 0.05, stage: 'coco', impact: 'low',
    what: 'COCO non-bird score that lowers a flapping bird\'s confidence.',
    raiseIf: 'Real birds lose confidence because COCO guesses "kite".',
    lowerIf: 'Flapping false positives keep high confidence despite COCO.' },
  { path: 'coco.minPx', min: 12, max: 120, step: 4, stage: 'coco', impact: 'medium',
    what: 'Only send objects at least this big (px, full camera res) to COCO.',
    raiseIf: 'stats.coco_nothing is high: COCO is wasting time on objects too small to see.',
    lowerIf: 'Mid-size birds never get a COCO check.' },
  { path: 'coco.cooldownSec', min: 0.5, max: 15, step: 0.5, stage: 'coco', impact: 'low',
    what: 'Seconds before the same track is checked again.',
    raiseIf: 'One object hogs COCO while others wait.', lowerIf: 'Labels go stale on long tracks.' },

  // ---- Audio ----
  { path: 'audio.highProb', min: 0.5, max: 0.98, step: 0.02, stage: 'audio', impact: 'high',
    what: 'Drone probability needed from the sound model.',
    raiseIf: 'Room noise / voices trigger drone alerts.', lowerIf: 'Real drone audio is missed.' },
  { path: 'audio.sustainSec', min: 0.2, max: 3, step: 0.1, stage: 'audio', impact: 'medium',
    what: 'How long the drone sound must last.',
    raiseIf: 'Short noises trigger drone alerts.', lowerIf: 'Drone alert is too slow.' },
];

export function getParam(cfg, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), cfg);
}

// Build a nested patch object { motion: { threshold: 20 } } from 'motion.threshold', 20.
export function patchFor(path, value) {
  const keys = path.split('.');
  const out = {};
  let o = out;
  keys.forEach((k, i) => { o[k] = i === keys.length - 1 ? value : {}; o = o[k]; });
  return out;
}

// Registry rows with their current default values filled in.
export function describeParams(cfg = DEFAULTS) {
  return PARAMS.map((p) => ({ ...p, default: getParam(DEFAULTS, p.path), current: getParam(cfg, p.path) }));
}

// Ready-made starting points. Apply with engine.setConfig(PRESETS.phone_15fps).
export const PRESETS = {
  // Laptop webcam / replay at ~30 fps: the defaults.
  laptop_30fps: {},
  // Phone that only manages ~15 fps: objects jump further per frame, fewer samples per beat.
  phone_15fps: {
    tracker: { maxJump: 36, confirmFrames: 3, maxMisses: 4, minTravel: 2 },
    wingbeat: { windowSec: 2.0, minSamples: 12, evalEvery: 1 },
  },
  // Distant birds a few pixels wide: lower size limits, lean on flock inference.
  distant_birds: {
    motion: { threshold: 12, dilate: 1 },
    blobs: { minArea: 2, mergeGap: 1 },
    tracker: { confirmFrames: 5, minTravel: 2 },
    wingbeat: { minArea: 4 },
    flocks: { radiusFrac: 0.18, inferBirdAtSize: 3 },
  },
  // Grainy / low-light camera: stricter thresholds, slower confirmation.
  noisy_camera: {
    motion: { threshold: 22, noiseK: 5 },
    blobs: { minArea: 4 },
    tracker: { confirmFrames: 5, predictedGate: 0.4 },
  },
  // Demo room: loud venue noise, keep drone alerts conservative.
  loud_venue: {
    audio: { highProb: 0.9, sustainSec: 1.5 },
  },
};
