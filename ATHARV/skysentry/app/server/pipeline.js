// How one alert travels through the system (build plan, section 2):
//   1 detect and send  -> 2 save the stream (Tiger Data) -> 3 verify with AI (Gemini)
//   -> 4 store the report (MongoDB) -> 5 stamp drone reports (Solana)
//   -> 6 give it a voice (ElevenLabs) -> 7 tell the tower (Socket.IO)
import { validateEvent } from '../shared/event.js';
import { alertSentence } from '../shared/risk.js';
import { verifyAndReport } from './ai.js';
import { speak } from './voice.js';
import { stampReport } from './solana.js';

const RANK = { green: 0, yellow: 1, red: 2 };

export function createPipeline({ stores, emit, cooldownMs = Number(process.env.INCIDENT_COOLDOWN_MS ?? 30000), log = console }) {
  // While a camera stays yellow or red it keeps sending events every 2 s; only open a new
  // incident when the risk rises, the type changes, or the cooldown has passed.
  const lastIncident = new Map(); // `${camera_id}|${type}` -> {risk, at}

  function shouldOpenIncident(e) {
    if (e.risk === 'green') return false;
    const key = `${e.camera_id}|${e.type}`, prev = lastIncident.get(key), now = Date.parse(e.time);
    if (prev && RANK[e.risk] <= RANK[prev.risk] && now - prev.at < cooldownMs) return false;
    lastIncident.set(key, { risk: e.risk, at: now });
    return true;
  }

  async function handle(raw) {
    // 1. Detect and send (the camera did this); validate and timestamp here.
    const e = { ...raw, time: raw?.time ?? new Date().toISOString() };
    const errors = validateEvent(e);
    if (errors.length) return { ok: false, errors };

    // 2. Save the stream: every event, including green heartbeats. Snapshots stay out of Tiger Data.
    const { snapshot, ...row } = e;
    await stores.detections.insert(row).catch(err => log.error('[tiger] insert failed:', err.message));
    emit('detection', row);

    if (!shouldOpenIncident(e)) return { ok: true, incident: null };

    // 3. Verify with AI and write the report.
    const ai = await verifyAndReport(e);
    const alertText = alertSentence(e);

    // 4. Store the report with its snapshot and Gemini's label.
    const doc = { time: e.time, camera_id: e.camera_id, type: e.type, object_count: e.object_count, direction: e.direction,
                  confidence: e.confidence, risk: e.risk, snapshot, gemini_label: ai.label, report: ai.report,
                  report_source: ai.source, alert_text: alertText };
    let id = null;
    try { id = await stores.incidents.insert(doc); } catch (err) { log.error('[mongo] insert failed:', err.message); }

    // 5. Stamp drone reports so nobody can quietly edit them later.
    let stamp = null;
    if (e.type === 'drone') {
      stamp = await stampReport(ai.report, id ?? 'unsaved');
      if (id) await stores.incidents.update(id, { report_hash: stamp.hash, solana_tx: stamp.tx }).catch(err => log.error('[mongo] update failed:', err.message));
    }

    // 6. Give red alerts a voice.
    const audio = e.risk === 'red' ? await speak(alertText) : null;

    // 7. Tell the tower.
    const incident = { _id: id, ...doc, snapshot: undefined, has_snapshot: !!snapshot, report_hash: stamp?.hash, solana_tx: stamp?.tx, solana_explorer: stamp?.explorer };
    emit('incident', incident);
    if (e.risk === 'red') emit('alert', { text: alertText, audio, risk: e.risk, type: e.type, incident_id: id, time: e.time });
    return { ok: true, incident };
  }

  return { handle };
}
