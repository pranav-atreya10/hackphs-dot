#!/usr/bin/env node
// DigitalOcean App Platform preflight validator, credential bundle generator, and live readiness prober.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { accessConfig, hasCode } = require('../access.js');
const { parseEnv } = require('../airports.js');
const { readSurveys } = require('../corridor-calibration.js');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_APP_YAML_PATH = path.resolve(SCRIPT_DIR, '..', '.do', 'app.yaml');

const SECRET_ENV_KEYS = new Set([
  'CAMERA_API_KEY',
  'TOWER_API_KEY',
  'MONGODB_URI',
  'CLERK_SECRET_KEY',
  'AIRPORT_CODES',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'SOLANA_SECRET_KEY',
  'LOCAL_JUDGE_KEY',
]);

const SENSITIVE_REDACT_KEYS = [
  'CAMERA_API_KEY',
  'TOWER_API_KEY',
  'MONGODB_URI',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
  'AIRPORT_CODES',
  'ADMIN_EMAILS',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'SOLANA_SECRET_KEY',
  'LOCAL_JUDGE_KEY',
];

/* ---------- Lightweight YAML subset parser for .do/app.yaml ---------- */

function stripInlineYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && i + 1 < line.length) i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function findTopLevelColon(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return i;
    }
  }
  return -1;
}

function parseYamlScalar(raw) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '~' || trimmed === 'null') return null;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"') ? inner.replace(/\\(["\\nrt])/g, (_m, c) => (
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c
    )) : inner;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^[+-]?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === '[]') return [];
  if (trimmed === '{}') return {};
  return trimmed;
}

export function parseSimpleYaml(yamlText) {
  const rawLines = String(yamlText || '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const cleaned = stripInlineYamlComment(rawLines[i]);
    if (!cleaned.trim()) continue;
    const indent = cleaned.length - cleaned.trimStart().length;
    lines.push({ indent, text: cleaned.trimStart(), line: i + 1 });
  }

  function parseMapEntries(target, startIdx, mapIndent) {
    let idx = startIdx;
    while (idx < lines.length) {
      const cur = lines[idx];
      if (cur.indent < mapIndent) break;
      if (cur.indent > mapIndent) {
        throw new Error(`Unexpected YAML indentation at line ${cur.line}`);
      }
      if (cur.text === '-' || cur.text.startsWith('- ')) break;
      const colon = findTopLevelColon(cur.text);
      if (colon === -1) {
        throw new Error(`Expected key: value mapping at line ${cur.line}`);
      }
      const key = cur.text.slice(0, colon).trim();
      const rest = cur.text.slice(colon + 1).trim();
      idx++;
      if (rest !== '') {
        target[key] = parseYamlScalar(rest);
      } else if (
        idx < lines.length &&
        (lines[idx].indent > mapIndent ||
          (lines[idx].indent === mapIndent && (lines[idx].text === '-' || lines[idx].text.startsWith('- '))))
      ) {
        const child = parseBlock(idx, lines[idx].indent);
        target[key] = child.value;
        idx = child.nextIndex;
      } else {
        target[key] = null;
      }
    }
    return idx;
  }

  function parseBlock(startIdx, minIndent) {
    if (startIdx >= lines.length || lines[startIdx].indent < minIndent) {
      return { value: null, nextIndex: startIdx };
    }
    const baseIndent = lines[startIdx].indent;
    if (lines[startIdx].text === '-' || lines[startIdx].text.startsWith('- ')) {
      const arr = [];
      let idx = startIdx;
      while (
        idx < lines.length &&
        lines[idx].indent === baseIndent &&
        (lines[idx].text === '-' || lines[idx].text.startsWith('- '))
      ) {
        const rawAfterDash = lines[idx].text.slice(1);
        const rest = rawAfterDash.trim();
        const contentOffset = rawAfterDash.length - rawAfterDash.trimStart().length;
        const itemIndent = baseIndent + 1 + Math.max(1, contentOffset);
        idx++;
        if (!rest) {
          if (idx < lines.length && lines[idx].indent > baseIndent) {
            const child = parseBlock(idx, lines[idx].indent);
            arr.push(child.value);
            idx = child.nextIndex;
          } else {
            arr.push(null);
          }
          continue;
        }
        const colon = findTopLevelColon(rest);
        if (colon !== -1) {
          const itemObj = {};
          const key = rest.slice(0, colon).trim();
          const valPart = rest.slice(colon + 1).trim();
          if (valPart !== '') {
            itemObj[key] = parseYamlScalar(valPart);
          } else if (idx < lines.length && lines[idx].indent >= itemIndent) {
            const child = parseBlock(idx, lines[idx].indent);
            itemObj[key] = child.value;
            idx = child.nextIndex;
          } else {
            itemObj[key] = null;
          }
          if (idx < lines.length && lines[idx].indent > baseIndent) {
            idx = parseMapEntries(itemObj, idx, lines[idx].indent);
          }
          arr.push(itemObj);
        } else {
          arr.push(parseYamlScalar(rest));
        }
      }
      return { value: arr, nextIndex: idx };
    }

    const obj = {};
    const nextIndex = parseMapEntries(obj, startIdx, baseIndent);
    return { value: obj, nextIndex };
  }

  return parseBlock(0, 0).value || {};
}

/* ---------- Value & redaction helpers ---------- */

export function isPlaceholderCredential(rawValue) {
  if (typeof rawValue !== 'string') return false;
  const v = rawValue.trim();
  if (!v) return false;
  if (/^(?:paste|your|change|replace|todo|placeholder|insert|example)[_-]/i.test(v)) return true;
  if (/^change-me\b/i.test(v)) return true;
  if (/\.\.\.$/.test(v)) return true;
  if (/^\[\s*\]$/.test(v)) return true;
  if (/^<[^>]+>$/.test(v)) return true;
  if (/cluster0\.x+\.mongodb\.net/i.test(v)) return true;
  return false;
}

function redactEnvSecrets(text, env) {
  let out = String(text ?? '');
  if (!env || typeof env !== 'object') return out;
  for (const key of SENSITIVE_REDACT_KEYS) {
    const val = typeof env[key] === 'string' ? env[key].trim() : '';
    if (val && val.length >= 3) {
      out = out.split(val).join('[REDACTED]');
    }
  }
  out = out.replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, 'mongodb+srv://[REDACTED]');
  return out;
}

/* ---------- 1. App Platform YAML spec validation (--app-yaml) ---------- */

export function validateAppYaml(input = DEFAULT_APP_YAML_PATH) {
  const blockers = [];
  const warnings = [];
  let yamlText = '';
  let sourceLabel = 'inline';

  try {
    if (input && typeof input === 'object') {
      if (typeof input.yamlText === 'string' || typeof input.yaml === 'string') {
        yamlText = input.yamlText ?? input.yaml;
        sourceLabel = input.filePath || input.path || 'inline';
      } else {
        const targetPath = path.resolve(input.filePath || input.path || DEFAULT_APP_YAML_PATH);
        sourceLabel = targetPath;
        yamlText = fs.readFileSync(targetPath, 'utf8');
      }
    } else if (typeof input === 'string') {
      const looksInline =
        input.includes('\n') ||
        /^\s*(?:#|name\s*:|services\s*:)/i.test(input);
      if (looksInline) {
        yamlText = input;
      } else {
        const targetPath = path.resolve(input);
        sourceLabel = targetPath;
        yamlText = fs.readFileSync(targetPath, 'utf8');
      }
    } else {
      sourceLabel = DEFAULT_APP_YAML_PATH;
      yamlText = fs.readFileSync(DEFAULT_APP_YAML_PATH, 'utf8');
    }
  } catch (err) {
    blockers.push(`Could not read DigitalOcean app spec (${sourceLabel}): ${err.message}`);
    return {
      ok: false,
      blockers,
      warnings,
      service: null,
      declaredEnvKeys: [],
      summary: `App spec validation failed: ${blockers[0]}`,
    };
  }

  let spec;
  try {
    spec = parseSimpleYaml(yamlText);
  } catch (err) {
    blockers.push(`Invalid YAML syntax in app spec: ${err.message}`);
    return {
      ok: false,
      blockers,
      warnings,
      service: null,
      declaredEnvKeys: [],
      summary: `App spec validation failed: ${blockers[0]}`,
    };
  }

  const services = Array.isArray(spec?.services) ? spec.services : [];
  if (services.length === 0) {
    blockers.push('App spec must declare at least one web service under services.');
    return {
      ok: false,
      blockers,
      warnings,
      service: null,
      declaredEnvKeys: [],
      summary: `App spec validation failed (${blockers.length} blocker).`,
    };
  }

  const service = services.find(s => s?.name === 'web') || services[0];

  if (service.source_dir !== 'PRANAV') {
    blockers.push(`services.web.source_dir must be "PRANAV" (found ${JSON.stringify(service.source_dir ?? null)}).`);
  }
  if (service.instance_count !== 1) {
    blockers.push(
      `services.web.instance_count must be 1 for single-instance socket revocation and camera state (found ${JSON.stringify(service.instance_count ?? null)}).`
    );
  }
  if (service.http_port !== 8080) {
    blockers.push(`services.web.http_port must be 8080 (found ${JSON.stringify(service.http_port ?? null)}).`);
  }
  const healthPath = service.health_check?.http_path;
  if (healthPath !== '/health') {
    blockers.push(
      `services.web.health_check.http_path must be "/health" for liveness probing (found ${JSON.stringify(healthPath ?? null)}).`
    );
  }

  const envs = Array.isArray(service.envs) ? service.envs : [];
  const byKey = new Map();
  for (const entry of envs) {
    if (entry && typeof entry.key === 'string' && entry.key.trim()) {
      byKey.set(entry.key.trim(), entry);
    }
  }

  for (const requiredKey of ['AIRPORT_CODES', 'CAMERA_API_KEY', 'CAMERA_API_AIRPORT']) {
    if (!byKey.has(requiredKey)) {
      blockers.push(`services.web.envs must declare required key "${requiredKey}".`);
    }
  }

  const declaresTowerKey = byKey.has('TOWER_API_KEY') && byKey.has('TOWER_API_AIRPORT');
  const declaresClerkMongo =
    byKey.has('CLERK_PUBLISHABLE_KEY') &&
    byKey.has('CLERK_SECRET_KEY') &&
    byKey.has('MONGODB_URI');
  if (!declaresTowerKey && !declaresClerkMongo) {
    blockers.push(
      'services.web.envs must declare either TOWER_API_KEY + TOWER_API_AIRPORT or CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY + MONGODB_URI.'
    );
  }

  const nodeEnvEntry = byKey.get('NODE_ENV');
  if (!nodeEnvEntry || nodeEnvEntry.value !== 'production') {
    warnings.push('services.web.envs should set NODE_ENV=production explicitly.');
  }

  for (const [key, entry] of byKey.entries()) {
    if (SECRET_ENV_KEYS.has(key)) {
      if (entry.type !== 'SECRET') {
        blockers.push(`Secret environment variable "${key}" must declare "type: SECRET" in app.yaml.`);
      }
      if (entry.value !== undefined && entry.value !== null && String(entry.value).trim() !== '') {
        const valStr = String(entry.value).trim();
        if (!/^EV\[1:/i.test(valStr)) {
          blockers.push(`Secret environment variable "${key}" must not hardcode a plaintext value in app.yaml.`);
        } else {
          warnings.push(`"${key}" contains an inline EV[...] cipher; prefer setting encrypted values in the DigitalOcean dashboard.`);
        }
      }
    }
  }

  const spoolEntry = byKey.get('RECEIPT_SPOOL_FILE');
  if (spoolEntry && spoolEntry.value !== undefined && spoolEntry.value !== null && String(spoolEntry.value).trim() !== '') {
    blockers.push('Do not set RECEIPT_SPOOL_FILE in .do/app.yaml; App Platform containers use an ephemeral filesystem.');
  }

  const ok = blockers.length === 0;
  return {
    ok,
    blockers,
    warnings,
    service: service.name || 'web',
    declaredEnvKeys: [...byKey.keys()],
    summary: ok
      ? `App spec OK (${byKey.size} env declarations verified, instance_count=1, health=/health).`
      : `App spec validation failed with ${blockers.length} blocker(s).`,
  };
}

/* ---------- 2. Environment validation against PRANAV/access.js (--check-env) ---------- */

export function validateDeployEnv(rawInput = process.env, options = {}) {
  const env =
    rawInput && typeof rawInput === 'object' && rawInput.env && typeof rawInput.env === 'object' && !rawInput.CAMERA_API_KEY
      ? rawInput.env
      : (rawInput || {});

  const blockers = [];
  const warnings = [];
  const addBlocker = msg => {
    const clean = redactEnvSecrets(msg, env);
    if (!blockers.includes(clean)) blockers.push(clean);
  };
  const addWarning = msg => {
    const clean = redactEnvSecrets(msg, env);
    if (!warnings.includes(clean)) warnings.push(clean);
  };

  const str = key => (typeof env[key] === 'string' ? env[key].trim() : '');

  const rawAirportCodes = str('AIRPORT_CODES');
  const fixedAirports = parseEnv(rawAirportCodes);

  if (!rawAirportCodes || fixedAirports.size === 0) {
    addBlocker('AIRPORT_CODES must be set with at least one valid AIRPORT=join-code entry (e.g. KPCT=kpct-4821-9310).');
  } else {
    const segments = rawAirportCodes.split(',').map(s => s.trim()).filter(Boolean);
    for (const seg of segments) {
      const eq = seg.indexOf('=');
      const code = eq === -1 ? seg : seg.slice(0, eq).trim();
      const joinCode = eq === -1 ? '' : seg.slice(eq + 1).trim();
      if (!hasCode(code) || !joinCode) {
        addBlocker('AIRPORT_CODES contains a malformed entry; every item must be CODE=join-code with a 3-5 uppercase alphanumeric airport code.');
        break;
      }
      if (isPlaceholderCredential(joinCode)) {
        addBlocker(`AIRPORT_CODES entry for ${code} uses a placeholder join code; generate a real join code before deploying.`);
      }
    }
  }

  const cameraKey = str('CAMERA_API_KEY');
  const cameraAirport = str('CAMERA_API_AIRPORT');
  const towerKey = str('TOWER_API_KEY');
  const towerAirport = str('TOWER_API_AIRPORT');
  const clerkPub = str('CLERK_PUBLISHABLE_KEY');
  const clerkSec = str('CLERK_SECRET_KEY');
  const mongoUri = str('MONGODB_URI');

  for (const [keyName, keyVal] of [
    ['CAMERA_API_KEY', cameraKey],
    ['TOWER_API_KEY', towerKey],
    ['CLERK_PUBLISHABLE_KEY', clerkPub],
    ['CLERK_SECRET_KEY', clerkSec],
    ['MONGODB_URI', mongoUri],
  ]) {
    if (keyVal && isPlaceholderCredential(keyVal)) {
      addBlocker(`${keyName} contains a placeholder value from .env.example; replace it with a real credential.`);
    }
  }

  const hasClerk = Boolean(clerkSec && clerkPub);
  if (Boolean(clerkSec) !== Boolean(clerkPub)) {
    addBlocker('configure both Clerk keys or neither');
  }

  if (cameraKey && (!hasCode(cameraAirport) || !fixedAirports.has(cameraAirport))) {
    addBlocker('CAMERA_API_AIRPORT must name a registered AIRPORT_CODES entry when CAMERA_API_KEY is set');
  }
  if (towerKey && (!hasCode(towerAirport) || !fixedAirports.has(towerAirport))) {
    addBlocker('TOWER_API_AIRPORT must name a registered AIRPORT_CODES entry when TOWER_API_KEY is set');
  }
  if (cameraKey && cameraKey === towerKey) {
    addBlocker('camera and tower keys must be distinct');
  }

  const checkProduction = options.production !== false;
  if (checkProduction) {
    if (!cameraKey) {
      addBlocker('CAMERA_API_KEY is required: production requires a bound camera key and either a bound tower key or Clerk with MongoDB');
    }
    if (!hasClerk && !towerKey) {
      addBlocker('Tower authentication missing: production requires a bound camera key and either a bound tower key or Clerk with MongoDB');
    }
    if (hasClerk && !mongoUri) {
      addBlocker('MONGODB_URI is required when Clerk keys are configured: production requires a bound camera key and either a bound tower key or Clerk with MongoDB');
    }
  }

  // Run the exact PRANAV/access.js gate under production mode to guarantee 1:1 boot parity.
  try {
    accessConfig(
      {
        ...env,
        NODE_ENV: checkProduction ? 'production' : (env.NODE_ENV || 'development'),
        CAMERA_API_KEY: cameraKey,
        CAMERA_API_AIRPORT: cameraAirport,
        TOWER_API_KEY: towerKey,
        TOWER_API_AIRPORT: towerAirport,
        CLERK_PUBLISHABLE_KEY: clerkPub,
        CLERK_SECRET_KEY: clerkSec,
        MONGODB_URI: mongoUri,
      },
      fixedAirports
    );
  } catch (err) {
    addBlocker(err.message);
  }

  const corridorsRaw = str('SURVEYED_CORRIDORS_JSON');
  if (corridorsRaw) {
    try {
      readSurveys(corridorsRaw);
    } catch (err) {
      addBlocker(`SURVEYED_CORRIDORS_JSON invalid: ${err.message}`);
    }
  }

  if (str('NODE_ENV') && str('NODE_ENV') !== 'production') {
    addWarning(`NODE_ENV is "${str('NODE_ENV')}"; DigitalOcean App Platform should run with NODE_ENV=production.`);
  }
  if (str('ALLOW_UNAUTHENTICATED_TOWER') === 'true') {
    addWarning('ALLOW_UNAUTHENTICATED_TOWER=true is ignored in production and never passes /ready.');
  }
  if (hasClerk && !str('ADMIN_EMAILS')) {
    addWarning('ADMIN_EMAILS is unset; no account will be able to open /admin.html to manage airports.');
  }
  if (!mongoUri) {
    addWarning('MONGODB_URI is unset; /ready receipt_storage will report not_configured and detections will remain in-memory only.');
  }
  if (str('RECEIPT_SPOOL_FILE')) {
    addWarning('RECEIPT_SPOOL_FILE is set; ensure this runs on a persistent local volume (never on DigitalOcean App Platform ephemeral disk).');
  }

  const ok = blockers.length === 0;
  return {
    ok,
    blockers,
    warnings,
    airports: [...fixedAirports.keys()],
    summary: ok
      ? `Environment passed production preflight (${fixedAirports.size} registered airport(s), ${warnings.length} warning(s)).`
      : `Environment blocked from production startup (${blockers.length} blocker(s)).`,
  };
}

/* ---------- 3. In-memory DigitalOcean key & join-code generator (--generate) ---------- */

export function generateAirportEnvBundle(airportCode) {
  const code = String(airportCode ?? '').trim().toUpperCase();
  if (!hasCode(code)) {
    throw new Error('Airport code must be 3 to 5 uppercase letters or digits (for example KPCT or KTTN).');
  }

  const cameraApiKey = crypto.randomBytes(32).toString('hex');
  let towerApiKey = crypto.randomBytes(32).toString('hex');
  while (towerApiKey === cameraApiKey) {
    towerApiKey = crypto.randomBytes(32).toString('hex');
  }

  const joinCode = `${code.toLowerCase()}-${crypto.randomInt(1000, 10000)}-${crypto.randomInt(1000, 10000)}`;
  const airportCodes = `${code}=${joinCode}`;

  const env = {
    NODE_ENV: 'production',
    AIRPORT_CODES: airportCodes,
    CAMERA_API_KEY: cameraApiKey,
    CAMERA_API_AIRPORT: code,
    TOWER_API_KEY: towerApiKey,
    TOWER_API_AIRPORT: code,
  };

  const pasteBlock = [
    `AIRPORT_CODES=${airportCodes}`,
    `CAMERA_API_KEY=${cameraApiKey}`,
    `CAMERA_API_AIRPORT=${code}`,
    `TOWER_API_KEY=${towerApiKey}`,
    `TOWER_API_AIRPORT=${code}`,
  ].join('\n');

  return {
    airport: code,
    joinCode,
    cameraApiKey,
    towerApiKey,
    ...env,
    env,
    pasteBlock,
  };
}

/* ---------- 4. Live /health & /ready deployment probe (--probe) ---------- */

async function fetchJsonBounded(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  try {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const status = Number(res.status) || 0;
    let body = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { reachable: true, status, body, error: null };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return {
      reachable: false,
      status: 0,
      body: null,
      error: timedOut ? `Request timed out after ${timeoutMs}ms` : String(err?.message || err),
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function probeLiveDeployment(baseUrl, options = {}) {
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 6000;
  const blockers = [];
  const warnings = [];

  let parsedBase;
  try {
    parsedBase = new URL(String(baseUrl || '').trim());
    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      throw new Error('URL protocol must be http: or https:');
    }
  } catch (err) {
    blockers.push(`Invalid deployment base URL: ${err.message}`);
    return {
      ok: false,
      status: 'invalid_url',
      stalePrePr56: false,
      livenessOk: false,
      readinessOk: false,
      health: null,
      ready: null,
      degradedChecks: [],
      blockers,
      warnings,
      summary: blockers[0],
    };
  }

  if (typeof fetchImpl !== 'function') {
    blockers.push('No fetch implementation available to probe deployment.');
    return {
      ok: false,
      status: 'unreachable',
      stalePrePr56: false,
      livenessOk: false,
      readinessOk: false,
      health: null,
      ready: null,
      degradedChecks: [],
      blockers,
      warnings,
      summary: blockers[0],
    };
  }

  const originBase = parsedBase.href.endsWith('/') ? parsedBase.href : `${parsedBase.href}/`;
  const healthUrl = new URL('health', originBase).href;
  const readyUrl = new URL('ready', originBase).href;

  const [health, ready] = await Promise.all([
    fetchJsonBounded(healthUrl, fetchImpl, timeoutMs),
    fetchJsonBounded(readyUrl, fetchImpl, timeoutMs),
  ]);

  const livenessOk = health.reachable && health.status === 200;
  if (!livenessOk) {
    blockers.push(
      health.reachable
        ? `/health returned HTTP ${health.status} (expected 200).`
        : `/health probe failed: ${health.error}`
    );
  }

  if (ready.reachable && ready.status === 404) {
    blockers.push(
      'GET /ready returned HTTP 404: DigitalOcean is still serving a stale pre-PR-#56 deployment because newer builds failed startup (set AIRPORT_CODES, CAMERA_API_KEY, CAMERA_API_AIRPORT, and tower/Clerk variables in App Platform).'
    );
    return {
      ok: false,
      status: 'stale_pre_pr56',
      stalePrePr56: true,
      livenessOk,
      readinessOk: false,
      health,
      ready,
      degradedChecks: [],
      blockers,
      warnings,
      summary: 'STALE DEPLOYMENT (HTTP 404 on /ready): live site is stuck on a pre-PR-#56 build.',
    };
  }

  if (!ready.reachable) {
    blockers.push(`/ready probe failed: ${ready.error}`);
    return {
      ok: false,
      status: 'unreachable',
      stalePrePr56: false,
      livenessOk,
      readinessOk: false,
      health,
      ready,
      degradedChecks: [],
      blockers,
      warnings,
      summary: `Deployment unreachable: ${blockers.join(' ')}`,
    };
  }

  const checks = ready.body && typeof ready.body.checks === 'object' && ready.body.checks !== null
    ? ready.body.checks
    : {};
  const degradedChecks = Object.entries(checks)
    .filter(([, state]) => state !== 'ready')
    .map(([name, state]) => ({ name, state: String(state) }));

  if (ready.status === 200 && livenessOk) {
    return {
      ok: true,
      status: 'ready',
      stalePrePr56: false,
      livenessOk: true,
      readinessOk: true,
      health,
      ready,
      degradedChecks,
      blockers,
      warnings,
      summary: 'Deployment is live on current code (/health 200, /ready 200).',
    };
  }

  if (ready.status === 503) {
    const names = degradedChecks.map(c => `${c.name}=${c.state}`).join(', ') || 'checks pending';
    if (degradedChecks.length === 1 && degradedChecks[0].name === 'receipt_recovery') {
      warnings.push(
        'Only receipt_recovery is unavailable, which is expected on DigitalOcean App Platform ephemeral containers without RECEIPT_SPOOL_FILE.'
      );
    }
    blockers.push(`/ready returned HTTP 503 (${names}).`);
    return {
      ok: false,
      status: 'not_ready',
      stalePrePr56: false,
      livenessOk,
      readinessOk: false,
      health,
      ready,
      degradedChecks,
      blockers,
      warnings,
      summary: `Post-PR-#56 build is running (/health ${health.status}), but /ready returned 503 (${names}).`,
    };
  }

  blockers.push(`/ready returned unexpected HTTP ${ready.status}.`);
  return {
    ok: false,
    status: 'unexpected_status',
    stalePrePr56: false,
    livenessOk,
    readinessOk: false,
    health,
    ready,
    degradedChecks,
    blockers,
    warnings,
    summary: `Unexpected response from deployment (/health ${health.status}, /ready ${ready.status}).`,
  };
}

/* ---------- 5. CLI runner ---------- */

const USAGE = [
  'SkySentry DigitalOcean Deployment Preflight',
  '',
  'Usage:',
  '  node scripts/do-deploy-preflight.mjs --app-yaml [path]',
  '  node scripts/do-deploy-preflight.mjs --check-env',
  '  node scripts/do-deploy-preflight.mjs --generate <AIRPORT_CODE>',
  '  node scripts/do-deploy-preflight.mjs --probe <baseUrl>',
].join('\n');

export async function runPreflightCli(argv = process.argv.slice(2), io = {}) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const env = io.env ?? process.env;
  const lines = [];
  const errLines = [];
  const writeOut = msg => {
    lines.push(msg);
    if (typeof io.stdout === 'function') io.stdout(`${msg}\n`);
    else if (io.stdout && typeof io.stdout.write === 'function') io.stdout.write(`${msg}\n`);
  };
  const writeErr = msg => {
    errLines.push(msg);
    if (typeof io.stderr === 'function') io.stderr(`${msg}\n`);
    else if (io.stderr && typeof io.stderr.write === 'function') io.stderr.write(`${msg}\n`);
  };

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    writeOut(USAGE);
    return { exitCode: args.length === 0 ? 1 : 0, result: null, output: lines.join('\n') };
  }

  const jsonOutput = args.includes('--json');
  const filtered = args.filter(a => a !== '--json');

  for (let i = 0; i < filtered.length; i++) {
    const arg = filtered[i];

    if (arg === '--app-yaml' || arg.startsWith('--app-yaml=')) {
      const explicit = arg.includes('=')
        ? arg.slice('--app-yaml='.length)
        : (filtered[i + 1] && !filtered[i + 1].startsWith('--') ? filtered[++i] : DEFAULT_APP_YAML_PATH);
      const result = validateAppYaml(explicit || DEFAULT_APP_YAML_PATH);
      if (jsonOutput) writeOut(JSON.stringify(result, null, 2));
      else {
        writeOut(result.summary);
        for (const b of result.blockers) writeErr(`  BLOCKER: ${b}`);
        for (const w of result.warnings) writeOut(`  WARNING: ${w}`);
      }
      return { exitCode: result.ok ? 0 : 1, result, output: [...lines, ...errLines].join('\n') };
    }

    if (arg === '--check-env') {
      const result = validateDeployEnv(env);
      if (jsonOutput) writeOut(JSON.stringify(result, null, 2));
      else {
        writeOut(result.summary);
        for (const b of result.blockers) writeErr(`  BLOCKER: ${b}`);
        for (const w of result.warnings) writeOut(`  WARNING: ${w}`);
      }
      return { exitCode: result.ok ? 0 : 1, result, output: [...lines, ...errLines].join('\n') };
    }

    if (arg === '--generate' || arg.startsWith('--generate=')) {
      const code = arg.includes('=') ? arg.slice('--generate='.length) : filtered[++i];
      try {
        const bundle = generateAirportEnvBundle(code);
        if (jsonOutput) {
          writeOut(JSON.stringify(bundle, null, 2));
        } else {
          writeOut(`# In-memory DigitalOcean App Platform credentials for ${bundle.airport} (not written to disk):`);
          writeOut(bundle.pasteBlock);
        }
        return { exitCode: 0, result: bundle, output: lines.join('\n') };
      } catch (err) {
        writeErr(`ERROR: ${err.message}`);
        return { exitCode: 1, result: null, output: errLines.join('\n') };
      }
    }

    if (arg === '--probe' || arg.startsWith('--probe=')) {
      const url = arg.includes('=') ? arg.slice('--probe='.length) : filtered[++i];
      const result = await probeLiveDeployment(url, { fetch: io.fetch ?? io.fetchImpl, timeoutMs: io.timeoutMs });
      if (jsonOutput) writeOut(JSON.stringify(result, null, 2));
      else {
        writeOut(result.summary);
        for (const b of result.blockers) writeErr(`  BLOCKER: ${b}`);
        for (const w of result.warnings) writeOut(`  NOTE: ${w}`);
      }
      return { exitCode: result.ok ? 0 : 1, result, output: [...lines, ...errLines].join('\n') };
    }
  }

  writeErr(`Unknown option: ${filtered[0]}`);
  writeOut(USAGE);
  return { exitCode: 1, result: null, output: [...lines, ...errLines].join('\n') };
}

const directEntryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (directEntryHref && import.meta.url === directEntryHref) {
  runPreflightCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  }).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
