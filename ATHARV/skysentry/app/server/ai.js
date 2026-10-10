// Gemini (Google AI Studio): verifies snapshots, writes incident reports, answers tower questions.
// Prompts A1 and A4 in the build plan. Only the server calls Gemini, so the key stays secret.
import { config } from './config.js';

const ENDPOINT = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

async function gemini(parts, { json = false } = {}) {
  const res = await fetch(ENDPOINT(config.geminiModel), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.2 } : { temperature: 0.3 }
    })
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
}

const clock = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** Demo-mode report built from the event alone, used when there is no key or the call fails. */
function templateReport(e) {
  const what = e.type === 'drone' ? 'a drone' : `${e.object_count} bird${e.object_count === 1 ? '' : 's'}`;
  return {
    label: e.type === 'drone' ? 'possible small drone (audio detection)' : `${e.object_count} birds`,
    report: `At ${clock(e.time)}, camera ${e.camera_id} detected ${what} ${e.direction === 'toward runway' ? 'moving toward the runway' : 'near the runway'}. ` +
            `Detection confidence was ${Math.round(e.confidence * 100)} percent. Risk level ${e.risk}.`,
    source: 'template'
  };
}

/**
 * Prompt A1: identify the flying objects in the snapshot and write a three-sentence report.
 * @returns {Promise<{label:string, report:string, source:'gemini'|'template'}>}
 */
export async function verifyAndReport(e) {
  if (!config.geminiKey || !e.snapshot) return templateReport(e);
  try {
    const text = await gemini([
      { text: `You are an airport safety assistant at ${config.airportName}. Look at this camera snapshot from camera "${e.camera_id}". ` +
              `The detector reported: type=${e.type}, count=${e.object_count}, direction=${e.direction}, risk=${e.risk}, time=${e.time}. ` +
              'Identify the flying objects you can see, then write a three-sentence airport incident report covering time, type, count, direction and risk. ' +
              'If you cannot confirm the objects, say so plainly. Reply as JSON: {"label": string, "report": string}.' },
      { inline_data: { mime_type: 'image/jpeg', data: e.snapshot.replace(/^data:image\/\w+;base64,/, '') } }
    ], { json: true });
    const { label, report } = JSON.parse(text);
    return { label: String(label), report: String(report), source: 'gemini' };
  } catch (err) {
    console.warn('[gemini] report failed, using template:', err.message);
    return templateReport(e);
  }
}

/**
 * Prompt A4: answer a question using only the last 7 days of hourly stats.
 * @param {string} question
 * @param {Array} hourly rows from detections.hourly(168)
 */
export async function answerQuestion(question, hourly) {
  if (!hourly.length) return { answer: 'There are no detections recorded in the last 7 days yet.', source: 'template' };
  if (!config.geminiKey) {
    const worst = hourly.reduce((a, b) => (b.total_objects > a.total_objects ? b : a));
    return { answer: `Demo mode: the busiest hour in the data was ${new Date(worst.hour).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })} with ${worst.total_objects} ${worst.type}s across ${worst.events} events.`, source: 'template' };
  }
  try {
    const answer = await gemini([{ text:
      'You answer questions for an airport control tower. Use ONLY the hourly detection statistics below (JSON, times in UTC). ' +
      'If the data cannot answer the question, say so. Keep the answer to two sentences.\n\n' +
      `STATS: ${JSON.stringify(hourly)}\n\nQUESTION: ${question}` }]);
    return { answer: answer.trim(), source: 'gemini' };
  } catch (err) {
    console.warn('[gemini] ask failed:', err.message);
    return { answer: 'The assistant is unavailable right now. Try again in a moment.', source: 'error' };
  }
}
