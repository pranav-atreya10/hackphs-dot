// pipeline.js: what happens to one camera event, from detection to the tower's speaker.
//
// For a yellow or red event that passes the rate limit (one alert per type every 12 s):
//   1. "alert" goes to the tower IMMEDIATELY, with template text. No API is waited on.
//   2. Red only: ElevenLabs voice   -> "alert_update" { id, audio }            (about half a second)
//   3. Gemini checks the snapshot   -> "alert_update" { id, label, report }    (1 to 10 seconds)
//   4. Drones only: Solana stamp    -> "alert_update" { id, solana_tx, solana_url }
// Steps 2 and 3 start at the same time. Step 4 waits for step 3, because it stamps the report.
// Each step has its own try/catch, so one failing API never blocks the others or crashes the server.
// If ElevenLabs fails, the tower gets { audio: null, audio_failed: true } and speaks the text itself.
const crypto = require('crypto');
const { analyzeEvent, answerQuestion } = require('./ai');
const { buildAlertText, speak, shouldAlert } = require('./voice');
const { eventDate } = require('./describe');

const ALERT_TYPES = ['bird', 'drone'];
const ALERT_RISKS = ['yellow', 'red']; // green events do nothing

// Wraps io.emit so a broken socket can never throw into the pipeline.
// `io` can be the Socket.IO server or a namespace such as io.of('/tower'); both have .emit().
function makeSender(io) {
  return (name, payload) => {
    try {
      io.emit(name, payload);
    } catch (err) {
      console.warn(`[pipeline] could not send ${name}: ${err.message}`);
    }
  };
}

// Step 2: spoken alert (red only, as in the build plan's risk table).
async function voiceStep(alert, send) {
  if (alert.risk !== 'red') return 'not spoken (yellow)';
  try {
    const audio = await speak(alert.text);
    if (!audio) throw new Error('no audio returned');
    send('alert_update', { id: alert.id, audio });
    return 'ElevenLabs';
  } catch (err) {
    // Tell the tower right away so it can use the browser's own voice instead of staying silent.
    send('alert_update', { id: alert.id, audio: null, audio_failed: true });
    return `failed (${err.message})`;
  }
}

// Step 3: Gemini label and report (analyzeEvent falls back to a template report on its own).
async function reportStep(event, alert, send) {
  try {
    const result = await analyzeEvent(event);
    send('alert_update', { id: alert.id, label: result.label, report: result.report, report_source: result.source });
    return result;
  } catch (err) {
    console.warn(`[pipeline] report step failed: ${err.message}`);
    return null;
  }
}

// Step 4: tamper-proof stamp of the report on Solana devnet (drones only).
async function stampStep(report, alert, send) {
  if (alert.type !== 'drone' || !report) return null;
  try {
    // Loaded here, not at the top, so the rest of the pipeline works even before solana.js exists.
    const { stampReport, explorerUrl } = require('./solana');
    const signature = await stampReport(report);
    if (!signature) return null;
    send('alert_update', { id: alert.id, solana_tx: signature, solana_url: explorerUrl(signature) });
    return signature;
  } catch (err) {
    console.warn(`[pipeline] Solana stamp skipped: ${err.message.split('\n')[0]}`);
    return null;
  }
}

/**
 * Handles one camera event. Call it for every event; it decides what to do.
 * The "alert" is sent before this function's first await, so the caller does not need to await it.
 * Never throws.
 * @param {object} event  camera event: { id?, camera_id, type, object_count, direction, confidence, risk, snapshot, time? }
 * @param {{emit: Function}} io  where tower messages go, e.g. io.of('/tower')
 * @param {{onDone?: Function}} [options]  onDone(result) runs once every step has finished,
 *   with { id, gemini_label, report, solana_tx }, so the server can save the incident to MongoDB
 * @returns {Promise<null | {id, gemini_label, report, solana_tx}>}  null when no alert was raised
 */
async function handleEvent(event, io, options = {}) {
  try {
    if (!event || typeof event !== 'object') return null;
    if (!ALERT_TYPES.includes(event.type) || !ALERT_RISKS.includes(event.risk)) return null; // green or unknown
    if (!shouldAlert(event.type, event.risk)) return null; // this type already alerted in the last 12 s

    const send = makeSender(io);
    const alert = {
      id: event.id || crypto.randomUUID(), // reuse the server's id so it matches the MongoDB incident
      time: eventDate(event).toISOString(),
      risk: event.risk,
      type: event.type,
      object_count: event.object_count,
      direction: event.direction,
      text: buildAlertText(event),
      label: null,
      report: null,
      audio: null,
      solana_tx: null
    };

    // 1. Tell the tower now.
    send('alert', alert);

    // 2 and 3 start together; neither waits for the other.
    const voicePromise = voiceStep(alert, send);
    const ai = await reportStep(event, alert, send);
    // 4. Needs the finished report.
    const solanaTx = await stampStep(ai && ai.report, alert, send);
    const voice = await voicePromise;

    const result = { id: alert.id, gemini_label: ai ? ai.label : null, report: ai ? ai.report : null, solana_tx: solanaTx };
    console.log(`[pipeline] ${alert.risk} ${alert.type} alert ${alert.id.slice(0, 8)}: ` +
      `voice ${voice} | report ${ai ? ai.source + (ai.model ? ` (${ai.model})` : '') : 'failed'} | ` +
      `stamp ${solanaTx ? 'on Solana' : alert.type === 'drone' ? 'none' : 'not needed'}`);

    if (typeof options.onDone === 'function') {
      try {
        await options.onDone(result);
      } catch (err) {
        console.warn(`[pipeline] onDone failed: ${err.message}`);
      }
    }
    return result;
  } catch (err) {
    console.warn(`[pipeline] unexpected error: ${err.message}`);
    return null;
  }
}

// answerQuestion lives in ai.js; it is passed through here so the server needs only one require.
module.exports = { handleEvent, answerQuestion };
