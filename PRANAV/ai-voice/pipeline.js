// Adapter of SHREYANSH/pipeline.js for PRANAV's incident persistence and tower protocol.
const config = require('./config');
const ai = require('./ai');
const { createRateLimit, buildAlertText } = require('./voice');
const { createSolana } = require('./solana');
function createPipeline({ analyzeEvent = ai.analyzeEvent, answer = ai.answerQuestion, solana = createSolana(), shouldAlert = createRateLimit(), settings = config } = {}) {
  // create() stores the incident; it's only called for a new alert. Cameras repeat a yellow/red event every couple
  // of seconds, and those repeats (inside the alert cooldown, same or lower risk) are not new incidents.
  async function processIncident(ev, { create = () => Promise.resolve(), save = () => Promise.resolve(), emit, allowImageReview = false }) {
    if (!ev || !['bird', 'drone', 'unknown'].includes(ev.type) || !['yellow', 'red'].includes(ev.risk) || !shouldAlert(ev)) return false;
    const send = (name, data) => { try { emit(name, data); } catch (err) { console.warn(`[pipeline] delivery failed: ${config.redact(err.message)}`); } };
    const created = Promise.resolve().then(create).catch(err => console.warn(`[pipeline] store failed: ${config.redact(err.message)}`));
    const persist = async fields => { try { await created; await save(fields); } catch (err) { console.warn(`[pipeline] save failed: ${config.redact(err.message)}`); } };
    const alertText = buildAlertText(ev);
    const incident = {
      _id: ev.id, time: new Date(ev.receivedAt || Date.now()).toISOString(), camera_id: ev.cameraId || ev.camera_id,
      airport: ev.airport, type: ev.type, object_count: ev.flock_size || ev.object_count, direction: ev.direction,
      confidence: ev.confidence, risk: ev.risk, snapshot: typeof ev.snapshot === 'string' ? ev.snapshot : null,
      alert_text: alertText,
    };
    send('incident', incident);
    // Visible warnings are emitted before the first await; provider latency cannot delay them.
    // The tower speaks alertText with the browser's voice straight away (no server audio).
    if (ev.risk === 'red') send('alert', { id: ev.id, incident_id: ev.id, text: alertText, audio: null,
      voice_pending: false, risk: ev.risk, type: ev.type, time: ev.receivedAt });
    const reportPromise = (async () => {
      const report = await analyzeEvent({ ...ev, snapshot: allowImageReview ? ev.snapshot : null,
        object_count: ev.flock_size || ev.object_count });
      const fields = { gemini_label: report.label, report: report.report, report_source: report.source, alert_text: alertText };
      if (report.bird_verdict) fields.bird_verdict = report.bird_verdict;
      send('incident', { ...incident, ...fields });
      send('alert_update', { id: ev.id, incident_id: ev.id, label: report.label, report: report.report, report_source: report.source });
      await persist(fields);
      if (ev.type === 'drone') {
        const stamp = await solana.stampReport(report.report);
        const stampFields = { report_hash: stamp.hash, solana_tx: stamp.tx, solana_status: stamp.status, solana_error: stamp.error, solana_url: stamp.explorer || null };
        send('incident', { ...incident, ...fields, ...stampFields });
        send('alert_update', { id: ev.id, incident_id: ev.id, ...stampFields });
        await persist(stampFields);
      }
    })();
    const result = await Promise.allSettled([reportPromise]);
    for (const row of result) if (row.status === 'rejected') console.warn(`[pipeline] ${config.redact(row.reason?.message || row.reason)}`);
    return true;
  }
  async function answerQuestion(question, hourly) {
    return { answer: await answer(question, hourly), source: settings.GEMINI_API_KEY ? 'gemini or fallback' : 'template' };
  }
  function health() {
    const g = ai.geminiState || {};
    const configured = Boolean(settings.GEMINI_API_KEY);
    return { gemini: { configured, model: settings.GEMINI_MODEL, backupModel: settings.GEMINI_BACKUP_MODEL,
        state: !configured ? 'not_configured' : g.lastFailure ? 'unavailable' : g.lastSuccessAt ? 'available' : 'untested',
        failure: !configured ? { reason: 'not_configured', httpStatus: null, action: ai.failureMessages.not_configured } : g.lastFailure,
        lastError: g.lastError, lastSuccess: g.lastSuccessAt ? new Date(g.lastSuccessAt).toISOString() : null },
      solana: solana.health() };
  }
  function status() {
    const h = health();
    return { gemini: !h.gemini.configured ? 'template' : h.gemini.lastError ? `failing (${h.gemini.lastError})` : h.gemini.lastSuccess ? 'live' : 'configured',
      voice: 'browser voice',
      solana: h.solana.lastError ? 'hash only (stamp error)' : h.solana.lastSuccess ? 'live devnet' : h.solana.configured ? 'configured devnet' : 'hash only' };
  }
  return { processIncident, answerQuestion, health, status };
}
module.exports = { createPipeline };
