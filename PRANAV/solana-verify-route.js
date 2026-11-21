'use strict';

const { hashReport: defaultHashReport, explorerUrl: defaultExplorerUrl } = require('./ai-voice/solana');
const { createRequestLimit } = require('./ai-voice/chat');

const VALID_INCIDENT_ID_RE = /^[A-Za-z0-9_:-]{1,100}$/;
const VALID_SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

function createSolanaVerifyHandler({
  findIncident,
  solana,
  hashReport = defaultHashReport,
  explorerUrl = defaultExplorerUrl,
  rateLimit,
} = {}) {
  if (typeof findIncident !== 'function') {
    throw new TypeError('findIncident must be a function');
  }
  if (typeof hashReport !== 'function') {
    throw new TypeError('hashReport must be a function');
  }
  if (typeof explorerUrl !== 'function') {
    throw new TypeError('explorerUrl must be a function');
  }

  const limiter = rateLimit === undefined
    ? createRequestLimit({ max: 20, windowMs: 60_000 })
    : rateLimit;

  return async function verifySolanaHandler(req, res) {
    if (typeof res.set === 'function') res.set('Cache-Control', 'private, no-store');
    else if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'private, no-store');

    const airport = typeof req?.airport === 'string' ? req.airport.trim() : '';
    if (!airport) {
      return res.status(403).json({ error: 'airport authorization required' });
    }

    if (typeof limiter === 'function') {
      const clientIp = (typeof req?.get === 'function' ? req.get('do-connecting-ip') : req?.headers?.['do-connecting-ip']) || req?.ip || 'unknown';
      const key = `${airport}:${clientIp}`;
      if (!limiter(key, req)) {
        return res.status(429).json({ status: 'rate_limited', error: 'too many verification requests; wait a minute' });
      }
    }

    const id = typeof req?.params?.id === 'string' ? req.params.id.trim() : '';
    if (!VALID_INCIDENT_ID_RE.test(id)) {
      return res.status(404).json({ error: 'incident not found' });
    }

    let incident;
    try {
      incident = await findIncident(id, airport);
    } catch (_err) {
      return res.status(503).json({ error: 'incident store unavailable' });
    }

    if (!incident || typeof incident !== 'object' || Array.isArray(incident) || incident.airport !== airport) {
      return res.status(404).json({ error: 'incident not found' });
    }

    if (typeof incident.report !== 'string' || !incident.report.trim()) {
      return res.status(409).json({
        status: 'report_unavailable',
        matches: null,
        reportHash: null,
        onChainHash: null,
        tx: null,
        error: 'incident report unavailable',
      });
    }

    const reportHash = hashReport(incident.report);
    const rawTx = typeof incident.solana_tx === 'string' ? incident.solana_tx.trim() : '';

    if (!rawTx) {
      return res.status(200).json({
        status: 'hash_only',
        matches: null,
        reportHash,
        onChainHash: null,
        tx: null,
      });
    }

    if (!VALID_SOLANA_SIG_RE.test(rawTx) || !solana || typeof solana.verifyReport !== 'function') {
      return res.status(200).json({
        status: 'rpc_unavailable',
        matches: false,
        chainStatus: !VALID_SOLANA_SIG_RE.test(rawTx) ? 'invalid_signature' : 'unavailable',
        reportHash,
        onChainHash: null,
        tx: VALID_SOLANA_SIG_RE.test(rawTx) ? rawTx : null,
        explorer: VALID_SOLANA_SIG_RE.test(rawTx) ? explorerUrl(rawTx) : null,
      });
    }

    try {
      const result = await solana.verifyReport(incident.report, rawTx);
      const status = result.matches
        ? 'verified_on_chain'
        : result.status === 'confirmed'
          ? 'hash_mismatch'
          : 'rpc_unavailable';
      const safeTx = typeof result.tx === 'string' && VALID_SOLANA_SIG_RE.test(result.tx) ? result.tx : rawTx;
      return res.status(200).json({
        status,
        matches: Boolean(result.matches),
        chainStatus: result.status || 'unavailable',
        reportHash,
        onChainHash: result.onChainHash ?? null,
        tx: safeTx,
        explorer: result.explorer || explorerUrl(safeTx),
      });
    } catch (_err) {
      return res.status(200).json({
        status: 'rpc_unavailable',
        matches: false,
        chainStatus: 'unavailable',
        reportHash,
        onChainHash: null,
        tx: rawTx,
        explorer: explorerUrl(rawTx),
      });
    }
  };
}

module.exports = { createSolanaVerifyHandler, VALID_INCIDENT_ID_RE, VALID_SOLANA_SIG_RE };
