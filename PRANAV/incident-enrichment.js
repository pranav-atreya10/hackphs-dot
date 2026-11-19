const { createHash } = require('node:crypto');
const { hashReport } = require('./ai-voice/solana');

const CAP = 512 * 1024;
const MAX_ATTEMPTS = 8;
const limit = (value, size) => typeof value === 'string' ? value.slice(0, size) : null;
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = (value, fallback) => typeof value === 'string' && value.length < 50 && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : new Date(fallback).toISOString();

function boundedBirdVerdict(value) {
  const evidence = limit(value?.evidence, 200);
  if (value?.status === 'unavailable') {
    return { status: 'unavailable', verdict: null, isBird: null, confidence: null,
      object: '', evidence, source: 'fallback', reason: limit(value.reason, 40) };
  }
  if (value?.status !== 'verified' || !['bird', 'not_bird', 'uncertain'].includes(value.verdict) ||
      !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return null;
  return { status: 'verified', verdict: value.verdict, isBird: value.verdict === 'uncertain' ? null : value.verdict === 'bird',
    confidence: value.confidence, object: limit(value.object, 80), evidence, source: 'gemini', model: limit(value.model, 80) };
}

function createIncidentJob(event, document, { retainEvidence = false } = {}) {
  const image = event.snapshot;
  const present = image !== null && image !== undefined && image !== '';
  let evidence = null;
  if (present && retainEvidence && typeof image === 'string' && Buffer.byteLength(image) <= CAP * 4 / 3 + 32) {
    const encoded = image.replace(/^data:image\/jpeg;base64,/i, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length >= 4 && bytes.length <= CAP && bytes.toString('base64') === encoded &&
        bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217)
      evidence = { bytes: encoded, sha256: digest(bytes) };
  }
  const input = {
    camera_id: limit(event.cameraId, 120), type: event.type, risk: event.risk,
    object_count: Number.isFinite(event.flock_size) ? event.flock_size : document.object_count,
    direction: limit(document.direction, 120), confidence: document.confidence,
    time: iso(event.time, event.receivedAt),
  };
  return { version: 1, stage: 'report', attempts: 0, input, evidence,
    incident: { ...document, snapshot_state: evidence ? 'pending' : present
      ? retainEvidence ? 'invalid' : 'retention_disabled' : document.snapshot_state } };
}

function createEnrichmentWorker({ journal, analyze, stamp, verify, project, allowed, imageUploadAllowed = () => false, reportError }) {
  async function runOne() {
    const row = await journal.claimEnrichment();
    if (!row) return false;
    const job = row.enrichment;
    const id = row._id;
    const step = (stage, fields = {}, hold = false) => journal.setEnrichment(row, stage, fields, hold);
    try {
      if (job.incident.airport !== row.airport || !allowed(row.airport)) {
        await step(job.stage === 'submitting' ? 'reconciliation_required' : 'incomplete');
        return true;
      }
      if (job.stage === 'report') {
        await project(job.incident, 1, {}, job.evidence);
        const result = await analyze({ ...job.input, snapshot: imageUploadAllowed() ? job.evidence?.bytes : undefined });
        const report = { report: limit(result.report, 8000), gemini_label: limit(result.label, 320),
          report_source: limit(result.source, 40), report_model: limit(result.model, 80), report_state: 'stored' };
        const birdVerdict = boundedBirdVerdict(result.bird_verdict);
        if (birdVerdict) report.bird_verdict = birdVerdict;
        if (!report.report || !report.gemini_label || !report.report_source) throw new Error('Malformed incident report.');
        await step('project_report', { report });
      } else if (job.stage === 'project_report') {
        await project(job.incident, 2, job.report);
        await step(job.input.type === 'drone' ? 'stamp' : 'complete');
      } else if (job.stage === 'project_incomplete') {
        await project(job.incident, 2, { report_state: 'incomplete' });
        await step('incomplete');
      } else if (job.stage === 'stamp') {
        const hash = hashReport(job.report.report);
        const result = await stamp(job.report.report, {
          beforeSubmit: async ({ signature }) => {
            if (!signature) throw new Error('Unsigned transaction cannot be submitted by the durable worker.');
            if (!await step('submitting', { submission: { signature, hash } }, true)) throw new Error('Incident stamp lease lost.');
          },
        });
        if (result.status === 'confirmed') {
          if (job.stage !== 'submitting' || result.tx !== job.submission.signature) throw new Error('Unrecognized stamp confirmation.');
          await step('project_stamp', { stamp: stampFields(result), stampRevision: 3 });
        } else if (job.stage === 'submitting') {
          await step('submitting', { submission: job.submission });
        } else {
          await step('project_stamp', { stamp: stampFields(result), stampRevision: 3 });
        }
      } else if (job.stage === 'submitting') {
        const { signature, hash } = job.submission;
        await project(job.incident, 3, { stamp_state: 'reconciliation_required', report_hash: hash, solana_tx: signature, solana_status: 'pending' });
        const result = await verify(job.report.report, signature);
        if (result.matches !== true) throw new Error('Stamp still needs reconciliation; no new submission made.');
        await step('project_stamp', { stamp: stampFields({ ...result, hash, status: 'confirmed' }), stampRevision: 4 });
      } else if (job.stage === 'project_stamp') {
        await project(job.incident, job.stampRevision, job.stamp);
        await step('complete');
      }
    } catch (error) {
      reportError(error, id);
      if (job.attempts >= MAX_ATTEMPTS) {
        if (job.stage === 'submitting') await step('reconciliation_required');
        else if (job.stage === 'report' || job.stage === 'project_report') await step('project_incomplete');
        else await step('incomplete');
      }
    }
    return true;
  }
  return { runOne };
}

function stampFields(result) {
  return { report_hash: limit(result.hash, 64), solana_tx: limit(result.tx, 100),
    solana_status: limit(result.status, 32), solana_error: limit(result.error, 320), solana_url: limit(result.explorer, 240),
    stamp_state: result.status === 'confirmed' ? 'stored' : 'incomplete' };
}

module.exports = { createIncidentJob, createEnrichmentWorker, CAP };
