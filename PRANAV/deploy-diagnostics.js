'use strict';

// Redacted, zero-secret deployment & subsystem readiness diagnostics for GET /api/deploy-diagnostics.
const path = require('node:path');
const { accessConfig, hasCode } = require('./access');
const { parseEnv } = require('./airports');
const { readSurveys } = require('./corridor-calibration');

const CANONICAL_CHECKS = [
  'video_detector',
  'airport_registry',
  'camera_access',
  'tower_access',
  'receipt_storage',
  'receipt_recovery',
];

const ALLOWED_CHECK_STATES = new Set([
  'ready',
  'not_configured',
  'unavailable',
  'timed_out',
  'degraded',
]);

const SENSITIVE_ENV_KEYS = [
  'CAMERA_API_KEY',
  'TOWER_API_KEY',
  'MONGODB_URI',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
  'AIRPORT_CODES',
  'ADMIN_EMAILS',
  'RECEIPT_SPOOL_FILE',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'SOLANA_SECRET_KEY',
  'LOCAL_JUDGE_KEY',
  'LOCAL_JUDGE_URL',
  'SOLANA_RPC_URL',
  'SURVEYED_CORRIDORS_JSON',
];

function isPlaceholder(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  return (
    /^(?:paste|your|change|replace|todo|placeholder|insert|example)[_-]/i.test(v) ||
    /^change-me\b/i.test(v) ||
    /\.\.\.$/.test(v) ||
    /^\[\s*\]$/.test(v) ||
    /^<[^>]+>$/.test(v) ||
    /cluster0\.x+\.mongodb\.net/i.test(v)
  );
}

function collectSecretNeedles(env, processEnv) {
  const needles = new Set();
  for (const source of [env, processEnv]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of SENSITIVE_ENV_KEYS) {
      const raw = typeof source[key] === 'string' ? source[key].trim() : '';
      if (raw && raw.length >= 3) {
        needles.add(raw);
      }
    }
    const airportRaw = typeof source.AIRPORT_CODES === 'string' ? source.AIRPORT_CODES : '';
    for (const pair of airportRaw.split(',')) {
      const eq = pair.indexOf('=');
      if (eq !== -1) {
        const joinCode = pair.slice(eq + 1).trim();
        if (joinCode.length >= 3) needles.add(joinCode);
      }
    }
    const adminRaw = typeof source.ADMIN_EMAILS === 'string' ? source.ADMIN_EMAILS : '';
    for (const email of adminRaw.split(',')) {
      const trimmed = email.trim();
      if (trimmed.length >= 3) needles.add(trimmed);
    }
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

function createRedactor(env, customRedact) {
  const needles = collectSecretNeedles(env, process.env);
  return function redactSafe(input) {
    let text = String(input ?? '');
    if (typeof customRedact === 'function') {
      try {
        text = String(customRedact(text));
      } catch {
        // Ignore custom redactor errors and continue strict scrubbing.
      }
    }
    for (const secret of needles) {
      if (secret && text.includes(secret)) {
        text = text.split(secret).join('[hidden]');
      }
    }
    // Scrub URI credentials, emails, and Gemini brand references from human-facing diagnostics copy.
    text = text
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[redacted-uri]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
      .replace(/\bgemini\b/gi, 'Cloud Advisory Model');
    return text;
  };
}

function deepScrubStrings(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => deepScrubStrings(item, redact));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepScrubStrings(v, redact);
    }
    return out;
  }
  return value;
}

function isAbsoluteAnyPlatform(filePath) {
  return path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
}

function validateSolanaSecret(raw) {
  if (!raw || isPlaceholder(raw)) return false;
  try {
    const parsed = JSON.parse(raw);
    return (
      Array.isArray(parsed) &&
      parsed.length === 64 &&
      parsed.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    );
  } catch {
    return false;
  }
}

function sanitizeChecks(rawChecks, fallbackEnvChecks) {
  const source = rawChecks && typeof rawChecks === 'object' ? rawChecks : fallbackEnvChecks;
  const sanitized = {};
  for (const key of CANONICAL_CHECKS) {
    const rawVal = source?.[key];
    const normalized = typeof rawVal === 'string' ? rawVal.trim().toLowerCase() : '';
    sanitized[key] = ALLOWED_CHECK_STATES.has(normalized) ? normalized : 'unavailable';
  }
  if (source && typeof source === 'object') {
    for (const [key, rawVal] of Object.entries(source)) {
      if (Object.hasOwn(sanitized, key)) continue;
      if (!/^[a-z0-9_]{1,48}$/i.test(key)) continue;
      const normalized = typeof rawVal === 'string' ? rawVal.trim().toLowerCase() : '';
      sanitized[key] = ALLOWED_CHECK_STATES.has(normalized) ? normalized : 'unavailable';
    }
  }
  return sanitized;
}

function normalizeEnvironmentLabel(rawNodeEnv) {
  const trimmed = typeof rawNodeEnv === 'string' ? rawNodeEnv.trim().toLowerCase() : '';
  if (!trimmed) return 'development';
  if (['production', 'development', 'test', 'staging'].includes(trimmed)) return trimmed;
  return 'custom';
}

async function buildDeployDiagnostics(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const redact = createRedactor(env, options.redact);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const str = name => (typeof env[name] === 'string' ? env[name].trim() : '');

  const environment = normalizeEnvironmentLabel(str('NODE_ENV'));
  const nodeVersion = /^v?\d+\.\d+\.\d+/.test(String(options.nodeVersion || process.version))
    ? String(options.nodeVersion || process.version)
    : process.version;
  const rawUptime = typeof options.uptime === 'function'
    ? options.uptime()
    : (Number.isFinite(options.uptimeSec) ? options.uptimeSec : process.uptime());
  const uptimeSec = Math.max(0, Math.floor(Number(rawUptime) || 0));

  // 1. Evaluate environment checklist without recording any secret values.
  const rawAirportCodes = str('AIRPORT_CODES');
  const fixedAirports = parseEnv(rawAirportCodes);
  const airportSegments = rawAirportCodes ? rawAirportCodes.split(',').map(s => s.trim()).filter(Boolean) : [];
  let airportEntriesClean = fixedAirports.size > 0 && airportSegments.length === fixedAirports.size;
  for (const seg of airportSegments) {
    const eq = seg.indexOf('=');
    const joinPart = eq === -1 ? '' : seg.slice(eq + 1).trim();
    if (!joinPart || isPlaceholder(joinPart)) airportEntriesClean = false;
  }

  const rawCameraKey = str('CAMERA_API_KEY');
  const rawCameraAirport = str('CAMERA_API_AIRPORT');
  const rawTowerKey = str('TOWER_API_KEY');
  const rawTowerAirport = str('TOWER_API_AIRPORT');
  const rawClerkPub = str('CLERK_PUBLISHABLE_KEY');
  const rawClerkSec = str('CLERK_SECRET_KEY');
  const rawMongoUri = str('MONGODB_URI');
  const rawSpoolFile = str('RECEIPT_SPOOL_FILE');
  const rawDurableEvidence = str('DURABLE_INCIDENT_EVIDENCE');
  const rawCorridors = str('SURVEYED_CORRIDORS_JSON');
  const rawBirdJudge = str('BIRD_JUDGE').toLowerCase();
  const rawCloudAiKey = str('GEMINI_API_KEY');
  const rawCloudUploads = str('GEMINI_CLOUD_EVIDENCE_ENABLED') === 'true';
  const rawOpenAiKey = str('OPENAI_API_KEY');
  const rawSolanaKey = str('SOLANA_SECRET_KEY');

  const keysDistinct = !(rawCameraKey && rawTowerKey && rawCameraKey === rawTowerKey);
  const cameraAirportBound = Boolean(
    rawCameraKey && hasCode(rawCameraAirport) && fixedAirports.has(rawCameraAirport)
  );
  const cameraValid = Boolean(
    rawCameraKey && !isPlaceholder(rawCameraKey) && cameraAirportBound && keysDistinct
  );

  const towerKeyBound = Boolean(
    rawTowerKey && !isPlaceholder(rawTowerKey) && hasCode(rawTowerAirport) && fixedAirports.has(rawTowerAirport) && keysDistinct
  );
  const clerkPairConsistent = Boolean(rawClerkPub) === Boolean(rawClerkSec);
  const clerkKeysValid = Boolean(
    rawClerkPub && rawClerkSec && !isPlaceholder(rawClerkPub) && !isPlaceholder(rawClerkSec)
  );
  const mongoConfiguredValid = Boolean(rawMongoUri && !isPlaceholder(rawMongoUri));
  const clerkMongoBound = clerkKeysValid && mongoConfiguredValid;

  const towerConfigured = Boolean(rawTowerKey || rawClerkPub || rawClerkSec);
  const towerHasMisconfig =
    !clerkPairConsistent ||
    (Boolean(rawTowerKey) && !towerKeyBound) ||
    (Boolean(rawClerkPub || rawClerkSec) && !clerkMongoBound);
  const towerValid = Boolean(!towerHasMisconfig && (towerKeyBound || clerkMongoBound));

  let towerMode = 'unconfigured';
  if (towerKeyBound && clerkMongoBound) towerMode = 'tower_key_and_clerk';
  else if (clerkMongoBound) towerMode = 'clerk_mongodb';
  else if (towerKeyBound) towerMode = 'tower_key';
  else if (environment !== 'production' && str('ALLOW_UNAUTHENTICATED_TOWER') === 'true' && !towerConfigured) {
    towerMode = 'local_demo';
  } else if (towerHasMisconfig) {
    towerMode = 'misconfigured';
  }

  // Run PRANAV/access.js boot check under production rules to catch any subtle mismatch.
  let accessBootError = null;
  try {
    accessConfig(
      {
        NODE_ENV: 'production',
        CAMERA_API_KEY: rawCameraKey,
        CAMERA_API_AIRPORT: rawCameraAirport,
        TOWER_API_KEY: rawTowerKey,
        TOWER_API_AIRPORT: rawTowerAirport,
        CLERK_PUBLISHABLE_KEY: rawClerkPub,
        CLERK_SECRET_KEY: rawClerkSec,
        MONGODB_URI: rawMongoUri,
      },
      fixedAirports
    );
  } catch (err) {
    accessBootError = redact(err.message);
  }

  const spoolConfigured = Boolean(rawSpoolFile);
  const spoolValid = !spoolConfigured || (!isPlaceholder(rawSpoolFile) && isAbsoluteAnyPlatform(rawSpoolFile));

  const durableConfigured = rawDurableEvidence !== '';
  const durableEnabled = rawDurableEvidence === '1';
  const durableValid = !durableConfigured || ['0', '1', 'false'].includes(rawDurableEvidence.toLowerCase());

  let corridorsValid = true;
  let corridorCount = 0;
  let corridorError = null;
  if (rawCorridors) {
    try {
      const surveys = readSurveys(rawCorridors);
      corridorCount = surveys.length;
    } catch (err) {
      corridorsValid = false;
      corridorError = redact(err.message);
    }
  }

  const allowedJudgeModes = new Set(['', 'gemini', 'local', 'onnx', 'off']);
  const birdJudgeValid = allowedJudgeModes.has(rawBirdJudge);
  let birdJudgeMode = 'local_fallback';
  let birdJudgeDetail = 'Built-in fallback active; set BIRD_JUDGE=local or onnx for Local AI Model verification.';
  if (!birdJudgeValid) {
    birdJudgeMode = 'invalid';
    birdJudgeDetail = 'Invalid BIRD_JUDGE value; use local, onnx, off, or default cloud mode.';
  } else if (rawBirdJudge === 'local') {
    birdJudgeMode = 'local_ai_model';
    birdJudgeDetail = 'Local AI Model active via configured OpenAI-compatible vision endpoint.';
  } else if (rawBirdJudge === 'onnx') {
    birdJudgeMode = 'local_ai_model_onnx';
    birdJudgeDetail = 'Local AI Model active via in-process v5 ONNX classifier.';
  } else if (rawBirdJudge === 'off') {
    birdJudgeMode = 'off';
    birdJudgeDetail = 'Advisory bird judge explicitly disabled (BIRD_JUDGE=off).';
  } else if (rawCloudAiKey && !isPlaceholder(rawCloudAiKey)) {
    birdJudgeMode = 'cloud_advisory_model';
    birdJudgeDetail = rawCloudUploads
      ? 'Cloud Advisory Model configured with operator opt-in crop review.'
      : 'Cloud Advisory Model configured for text reports; crop uploads disabled.';
  }

  const openAiConfigured = Boolean(rawOpenAiKey);
  const openAiValid = !openAiConfigured || !isPlaceholder(rawOpenAiKey);

  const solanaConfigured = Boolean(rawSolanaKey);
  const solanaValid = !solanaConfigured || validateSolanaSecret(rawSolanaKey);

  const envChecklist = {
    AIRPORT_CODES: {
      label: 'Airport Registry (AIRPORT_CODES)',
      required: true,
      configured: Boolean(rawAirportCodes),
      valid: Boolean(rawAirportCodes && airportEntriesClean),
      airportCount: fixedAirports.size,
      detail: rawAirportCodes && airportEntriesClean
        ? `${fixedAirports.size} fixed airport entry/entries registered.`
        : rawAirportCodes
          ? 'AIRPORT_CODES has malformed or placeholder entries.'
          : 'AIRPORT_CODES is not configured.',
    },
    CAMERA_API_KEY: {
      label: 'Camera API Key & Airport Binding',
      required: true,
      configured: Boolean(rawCameraKey),
      bound: cameraAirportBound,
      valid: cameraValid,
      detail: cameraValid
        ? 'Camera credential configured and bound to a registered AIRPORT_CODES entry.'
        : !rawCameraKey
          ? 'CAMERA_API_KEY is not configured.'
          : !cameraAirportBound
            ? 'CAMERA_API_AIRPORT must name a registered AIRPORT_CODES entry when CAMERA_API_KEY is set.'
            : !keysDistinct
              ? 'Camera and tower keys must be distinct.'
              : 'CAMERA_API_KEY contains a placeholder credential.',
    },
    TOWER_AUTH: {
      label: 'Tower Access (Bound Key or Clerk + MongoDB)',
      required: true,
      configured: towerConfigured,
      bound: Boolean(towerKeyBound || clerkMongoBound),
      mode: towerMode,
      valid: towerValid,
      detail: towerValid
        ? (towerMode === 'clerk_mongodb'
          ? 'Clerk keys and MongoDB account/receipt store configured.'
          : towerMode === 'tower_key_and_clerk'
            ? 'Both bound tower key and Clerk + MongoDB are configured.'
            : 'Bound tower API key configured for a registered airport.')
        : !clerkPairConsistent
          ? 'Configure both Clerk keys (CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY) or neither.'
          : (rawClerkPub && !mongoConfiguredValid)
            ? 'MONGODB_URI must be configured alongside Clerk keys.'
            : (rawTowerKey && !towerKeyBound)
              ? (!keysDistinct
                ? 'Camera and tower keys must be distinct.'
                : 'TOWER_API_AIRPORT must name a registered AIRPORT_CODES entry when TOWER_API_KEY is set.')
              : 'Configure either TOWER_API_KEY + TOWER_API_AIRPORT or Clerk keys + MONGODB_URI.',
    },
    RECEIPT_SPOOL_FILE: {
      label: 'Restart Receipt Spool',
      required: false,
      configured: spoolConfigured,
      valid: spoolValid,
      detail: !spoolConfigured
        ? 'Unset (expected on ephemeral DigitalOcean App Platform containers).'
        : spoolValid
          ? 'Absolute spool path configured for single-instance persistent host.'
          : 'RECEIPT_SPOOL_FILE must be an absolute file path without placeholders.',
    },
    DURABLE_INCIDENT_EVIDENCE: {
      label: 'Durable Incident Evidence',
      required: false,
      configured: durableConfigured,
      enabled: durableEnabled,
      valid: durableValid,
      detail: !durableValid
        ? 'Invalid DURABLE_INCIDENT_EVIDENCE flag; use 1 to retain snapshots or 0 to disable.'
        : durableEnabled
          ? 'Opted in (retains eligible server-cropped incident JPEGs in MongoDB).'
          : 'Disabled by default (incident crops are not retained in MongoDB).',
    },
    SURVEYED_CORRIDORS_JSON: {
      label: 'Surveyed Approach Corridors',
      required: false,
      configured: Boolean(rawCorridors),
      corridorCount,
      valid: corridorsValid,
      detail: !rawCorridors
        ? 'Unset (no surveyed camera corridor masks active).'
        : corridorsValid
          ? `${corridorCount} surveyed camera corridor record(s) validated.`
          : `Invalid corridor configuration: ${corridorError}`,
    },
    BIRD_JUDGE: {
      label: 'Local AI Model & Bird Judge',
      required: false,
      configured: Boolean(rawBirdJudge || (rawCloudAiKey && !isPlaceholder(rawCloudAiKey))),
      mode: birdJudgeMode,
      valid: birdJudgeValid,
      detail: birdJudgeDetail,
    },
    OPENAI_API_KEY: {
      label: 'Tower Copilot Model Key',
      required: false,
      configured: openAiConfigured,
      valid: openAiValid,
      detail: !openAiConfigured
        ? 'Unset (copilot falls back to secondary advisory model).'
        : openAiValid
          ? 'Encrypted runtime key configured.'
          : 'OPENAI_API_KEY contains a placeholder value.',
    },
    SOLANA_SECRET_KEY: {
      label: 'Solana Devnet Memo Key',
      required: false,
      configured: solanaConfigured,
      valid: solanaValid,
      detail: !solanaConfigured
        ? 'Unset (optional devnet report memo stamping disabled).'
        : solanaValid
          ? 'Valid 64-byte devnet keypair array configured.'
          : 'SOLANA_SECRET_KEY must be a JSON array of 64 integers (0-255).',
    },
  };

  // 2. Run or normalize readiness subsystem probe.
  const fallbackChecks = {
    video_detector: 'ready',
    airport_registry: envChecklist.AIRPORT_CODES.valid ? 'ready' : 'not_configured',
    camera_access: (cameraValid || clerkMongoBound) ? 'ready' : 'not_configured',
    tower_access: towerValid ? 'ready' : 'not_configured',
    receipt_storage: mongoConfiguredValid ? 'ready' : 'not_configured',
    receipt_recovery: spoolConfigured && spoolValid ? 'ready' : 'unavailable',
  };

  let probeReady = false;
  let sanitizedChecks = fallbackChecks;
  let readinessProbeError = null;

  if (typeof options.readiness === 'function') {
    try {
      const probeResult = await options.readiness();
      sanitizedChecks = sanitizeChecks(probeResult?.checks, fallbackChecks);
      probeReady = Boolean(
        probeResult?.ready &&
        Object.values(sanitizedChecks).every(state => state === 'ready')
      );
    } catch (err) {
      readinessProbeError = redact(err?.message || 'Readiness probe failed');
      sanitizedChecks = sanitizeChecks(null, {
        video_detector: 'unavailable',
        airport_registry: 'unavailable',
        camera_access: 'unavailable',
        tower_access: 'unavailable',
        receipt_storage: 'unavailable',
        receipt_recovery: 'unavailable',
      });
      probeReady = false;
    }
  } else if (options.readiness && typeof options.readiness === 'object') {
    sanitizedChecks = sanitizeChecks(options.readiness.checks, fallbackChecks);
    probeReady = Boolean(
      options.readiness.ready &&
      Object.values(sanitizedChecks).every(state => state === 'ready')
    );
  } else {
    sanitizedChecks = sanitizeChecks(fallbackChecks, fallbackChecks);
    probeReady = Object.values(sanitizedChecks).every(state => state === 'ready');
  }

  // 3. Build actionable, secret-free remediation guidance.
  const remediation = [];
  const pushRemediation = step => {
    const clean = redact(step);
    if (!remediation.includes(clean)) remediation.push(clean);
  };

  if (!envChecklist.AIRPORT_CODES.valid) {
    pushRemediation(
      'Set AIRPORT_CODES (encrypted SECRET) in DigitalOcean App Platform to one or more AIRPORT=join-code pairs, or run `node scripts/do-deploy-preflight.mjs --generate KPCT` locally.'
    );
  }
  if (!envChecklist.CAMERA_API_KEY.valid) {
    pushRemediation(
      'Configure CAMERA_API_KEY (encrypted SECRET) and set CAMERA_API_AIRPORT to a code registered in AIRPORT_CODES.'
    );
  }
  if (!envChecklist.TOWER_AUTH.valid) {
    pushRemediation(
      'Configure either a distinct TOWER_API_KEY + TOWER_API_AIRPORT bound to AIRPORT_CODES, or both CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY together with MONGODB_URI.'
    );
  }
  if (accessBootError && envChecklist.CAMERA_API_KEY.valid && envChecklist.TOWER_AUTH.valid) {
    pushRemediation(`Resolve startup access constraint: ${accessBootError}`);
  }
  if (!envChecklist.SURVEYED_CORRIDORS_JSON.valid) {
    pushRemediation(
      'Fix SURVEYED_CORRIDORS_JSON: provide a valid JSON array of surveyed webcam records with pose and 3-64 normalized polygon vertices.'
    );
  }
  if (!envChecklist.BIRD_JUDGE.valid) {
    pushRemediation('Set BIRD_JUDGE to local, onnx, or off (or leave unset for default mode).');
  }
  if (!envChecklist.OPENAI_API_KEY.valid) {
    pushRemediation('Replace placeholder OPENAI_API_KEY with a valid encrypted runtime key or clear it.');
  }
  if (!envChecklist.SOLANA_SECRET_KEY.valid) {
    pushRemediation('Format SOLANA_SECRET_KEY as a JSON array of 64 byte integers (0-255) or clear it.');
  }
  if (!envChecklist.RECEIPT_SPOOL_FILE.valid) {
    pushRemediation('Provide an absolute path on a persistent private volume for RECEIPT_SPOOL_FILE, or leave it unset on App Platform.');
  }
  if (!envChecklist.DURABLE_INCIDENT_EVIDENCE.valid) {
    pushRemediation('Set DURABLE_INCIDENT_EVIDENCE to 1 (retain cropped incident JPEGs) or 0 (disable).');
  }
  if (readinessProbeError) {
    pushRemediation(`Investigate readiness probe error: ${readinessProbeError}`);
  }
  if (sanitizedChecks.video_detector !== 'ready') {
    pushRemediation('Verify sharp and jpeg-js runtime installation so the synthetic JPEG video_detector self-check passes.');
  }
  if (sanitizedChecks.receipt_storage !== 'ready') {
    pushRemediation('Configure MONGODB_URI and allow DigitalOcean App Platform outbound access in MongoDB Atlas Network Access.');
  }
  if (sanitizedChecks.tower_access !== 'ready' && envChecklist.TOWER_AUTH.valid) {
    pushRemediation('Verify live Clerk service connectivity and MongoDB role_requests collection readability.');
  }
  if (sanitizedChecks.receipt_recovery !== 'ready') {
    pushRemediation(
      'Restart receipt recovery is unavailable (expected on ephemeral DigitalOcean App Platform containers; configure RECEIPT_SPOOL_FILE only on self-managed persistent volumes).'
    );
  }

  const hasInvalidEnv = Object.values(envChecklist).some(item => !item.valid);
  const status = hasInvalidEnv
    ? 'action_required'
    : probeReady
      ? 'ready'
      : 'degraded';

  const payload = {
    generatedAt: new Date(now()).toISOString(),
    nodeVersion,
    uptimeSec,
    environment,
    status,
    ok: status === 'ready',
    readiness: {
      ready: probeReady,
      checks: sanitizedChecks,
    },
    envChecklist,
    remediation,
  };

  return deepScrubStrings(payload, redact);
}

function setResponseHeader(res, name, value) {
  if (typeof res.set === 'function') {
    res.set(name, value);
  } else if (typeof res.setHeader === 'function') {
    res.setHeader(name, value);
  }
}

function createDeployDiagnosticsHandler(options = {}) {
  return async function deployDiagnosticsHandler(_req, res) {
    setResponseHeader(res, 'Cache-Control', 'private, no-store');
    setResponseHeader(res, 'X-Content-Type-Options', 'nosniff');
    const payload = await buildDeployDiagnostics(options);
    const httpStatus = payload.status === 'ready' ? 200 : 503;
    if (typeof res.status === 'function') {
      res.status(httpStatus);
    } else {
      res.statusCode = httpStatus;
    }
    if (typeof res.json === 'function') {
      return res.json(payload);
    }
    const body = JSON.stringify(payload);
    setResponseHeader(res, 'Content-Type', 'application/json; charset=utf-8');
    return res.end(body);
  };
}

module.exports = {
  buildDeployDiagnostics,
  createDeployDiagnosticsHandler,
};
