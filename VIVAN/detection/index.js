// Public entry point for the SkySentry detection engine.
// Frontend: import { DetectionEngine } from '../detection/index.js'

export { DetectionEngine } from './src/engine.js';
export { DEFAULTS, mergeConfig } from './src/config.js';
export { SyntheticSky, SCENARIOS } from './src/synthetic.js';
export { ClipEvaluator } from './src/eval.js';
export { HumDetector } from './src/audio.js';
export { analyzeWingbeat } from './src/wingbeat.js';
export { bearingFromX, compassName, destination } from './src/geo.js';
export { etaToPolygon, pointInPolygon } from './src/geometry.js';
export { PARAMS, PRESETS, describeParams, getParam, patchFor } from './src/params.js';
export { runScenario, scoreRun, evaluateConfig, sweep, WEIGHTS } from './src/tune.js';
