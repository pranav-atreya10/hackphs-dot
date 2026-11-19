// Write the engine's settings as plain JSON, so any language or runtime can read them without running JavaScript.
//   node VIVAN/detection/tools/export-config.mjs        -> VIVAN/detection/models/engine_config.json
// Contains: every default (config.js), the presets (params.js), and the tuning registry (range, step, what it does).
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULTS } from '../src/config.js';
import { PARAMS, PRESETS } from '../src/params.js';

const body = { defaults: DEFAULTS, presets: PRESETS, registry: PARAMS.map(({ path, min, max, step, stage, impact, what, raiseIf, lowerIf }) => ({ path, min, max, step, stage, impact, what, raiseIf, lowerIf })) };
const json = JSON.stringify(body);
const out = {
  name: 'skysentry-engine-config',
  about: 'All settings of the motion/flock/forecast detection engine (VIVAN/detection). Generated from src/config.js and src/params.js; regenerate after changing them. A preset is a partial override, deep-merged onto defaults.',
  sha256: createHash('sha256').update(json).digest('hex'),
  ...body,
};
const dest = new URL('../models/engine_config.json', import.meta.url);
writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote models/engine_config.json (${Object.keys(DEFAULTS).length} sections, ${PARAMS.length} tunable settings, ${Object.keys(PRESETS).length} presets)`);
