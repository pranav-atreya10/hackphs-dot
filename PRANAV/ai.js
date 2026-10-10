// The AI step for yellow/red incidents (team plan steps 3, 5 and 6), plus "Ask SkySentry".
//   Gemini      checks the snapshot and writes a three-sentence incident report
//   ElevenLabs  turns the red alert sentence into speech for the tower
//   Solana      writes a SHA-256 hash of drone reports to devnet so they can't be quietly edited
// Every service is optional: without its key the step falls back to a template, the browser's voice,
// or a hash with no chain stamp, so the demo works before the accounts exist.
const crypto = require("crypto");

const env = (k, d = "") => process.env[k] || d;
const GEMINI_API_KEY = env("GEMINI_API_KEY");
const GEMINI_MODEL = env("GEMINI_MODEL", "gemini-2.5-flash");
const ELEVENLABS_API_KEY = env("ELEVENLABS_API_KEY");
const ELEVENLABS_VOICE_ID = env("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM");
const SOLANA_SECRET_KEY = env("SOLANA_SECRET_KEY");
const SOLANA_RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const AIRPORT_NAME = env("AIRPORT_NAME", "Princeton Airport");
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const status = () => ({
  gemini: GEMINI_API_KEY ? "live" : "template",
  elevenlabs: ELEVENLABS_API_KEY ? "live" : "browser voice",
  solana: SOLANA_SECRET_KEY ? "live" : "hash only",
});

const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: env("TZ", "America/New_York") });

// e.g. "Caution, flock of six birds heading toward the runway, nine seconds out."
function alertSentence(ev) {
  if (ev.type === "drone") return ev.direction === "heard, not seen" ? "Caution, drone heard near the runway." : "Caution, drone detected near the runway.";
  const n = ev.flock_size || ev.object_count || 1;
  const word = NUMBERS[n] || String(n);
  const what = n >= 2 ? `flock of ${word} ${ev.type === "unknown" ? "objects" : "birds"}` : ev.type === "unknown" ? "unknown object" : "bird";
  const eta = Number.isFinite(ev.eta_seconds) && ev.eta_seconds > 0 ? `, ${NUMBERS[Math.round(ev.eta_seconds)] || Math.round(ev.eta_seconds)} seconds out` : "";
  const toward = typeof ev.direction === "string" && ev.direction.includes("corridor") && !ev.direction.includes("not toward");
  return `Caution, ${what} ${toward ? "heading toward the runway" : "near the runway"}${eta}.`;
}

function templateReport(ev) {
  const n = ev.flock_size || ev.object_count || 1;
  const what = ev.type === "drone" ? "a drone" : `${n} ${ev.type === "unknown" ? "unidentified object" : "bird"}${n === 1 ? "" : "s"}`;
  return {
    label: ev.type === "drone" ? "possible small drone" : `${n} ${ev.classification || ev.type}${n === 1 ? "" : "s"}`,
    report: `At ${clock(ev.receivedAt)}, camera ${ev.cameraId} detected ${what}, ${ev.direction || "near the runway"}. ` +
            `Detection confidence was ${Math.round((ev.confidence ?? 0) * 100)} percent${ev.flap_hz ? ` with a wingbeat of ${ev.flap_hz} Hz` : ""}. Risk level ${ev.risk}.`,
    source: "template",
  };
}

async function gemini(parts, json) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: json ? { responseMimeType: "application/json", temperature: 0.2 } : { temperature: 0.3 } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
}

async function report(ev) {
  if (!GEMINI_API_KEY || !ev.snapshot) return templateReport(ev);
  try {
    const text = await gemini([
      { text: `You are an airport safety assistant at ${AIRPORT_NAME}. This is a cropped snapshot from camera "${ev.cameraId}". ` +
              `The detector reported: ${JSON.stringify({ type: ev.type, classification: ev.classification, count: ev.flock_size || ev.object_count, direction: ev.direction, eta_seconds: ev.eta_seconds, wingbeat_hz: ev.flap_hz, risk: ev.risk, time: new Date(ev.receivedAt).toISOString() })}. ` +
              'Identify the flying objects you can see, then write a three-sentence airport incident report covering time, type, count, direction and risk. ' +
              'If you cannot confirm the objects from the image, say so plainly. Reply as JSON: {"label": string, "report": string}.' },
      { inline_data: { mime_type: "image/jpeg", data: String(ev.snapshot).replace(/^data:image\/\w+;base64,/, "") } },
    ], true);
    const { label, report: body } = JSON.parse(text);
    return { label: String(label), report: String(body), source: "gemini" };
  } catch (err) {
    console.warn("gemini report failed, using template:", err.message);
    return templateReport(ev);
  }
}

async function speak(text) {
  if (!ELEVENLABS_API_KEY) return null;
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: env("ELEVENLABS_MODEL", "eleven_turbo_v2_5") }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  } catch (err) {
    console.warn("elevenlabs failed:", err.message);
    return null;
  }
}

// Hash the report plus the evidence Vivan's engine attaches (track points), then stamp it on devnet.
async function stamp(id, body, evidence) {
  const hash = crypto.createHash("sha256").update(JSON.stringify({ id, report: body, evidence: evidence || null })).digest("hex");
  if (!SOLANA_SECRET_KEY) return { hash, tx: null };
  try {
    const web3 = require("@solana/web3.js");
    const payer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(SOLANA_SECRET_KEY)));
    const conn = new web3.Connection(SOLANA_RPC_URL, "confirmed");
    const ix = new web3.TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      programId: new web3.PublicKey(MEMO_PROGRAM),
      data: Buffer.from(`skysentry:${id}:${hash}`, "utf8"),
    });
    const tx = await web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(ix), [payer]);
    return { hash, tx };
  } catch (err) {
    console.warn("solana stamp failed:", err.message);
    return { hash, tx: null };
  }
}

// Cameras repeat yellow/red events every 2 s. Every one is still stored; the AI step only runs when the
// risk rises, the threat type changes, or AI_COOLDOWN_MS has passed, which keeps API use in free tiers.
const RANK = { green: 0, yellow: 1, red: 2 };
const lastRun = new Map();
const COOLDOWN = Number(env("AI_COOLDOWN_MS", "30000"));
function shouldRun(ev) {
  const key = `${ev.cameraId}|${ev.type}`, prev = lastRun.get(key);
  if (prev && RANK[ev.risk] <= RANK[prev.risk] && ev.receivedAt - prev.at < COOLDOWN) return false;
  lastRun.set(key, { risk: ev.risk, at: ev.receivedAt });
  return true;
}

/**
 * Runs the AI step for one stored incident. `save(fields)` updates the Mongo document (may be a no-op),
 * `emit(name, data)` sends to the incident's towers.
 */
async function processIncident(ev, { save, emit }) {
  if (!shouldRun(ev)) return;
  const r = await report(ev);
  const alertText = alertSentence(ev);
  const s = ev.type === "drone" ? await stamp(ev.id, r.report, ev.evidence) : null;
  const fields = { gemini_label: r.label, report: r.report, report_source: r.source, alert_text: alertText, ...(s ? { report_hash: s.hash, solana_tx: s.tx } : {}) };
  await save(fields).catch((err) => console.error(`failed to save AI report ${ev.id}:`, err.message));
  emit("incident", {
    _id: ev.id, time: new Date(ev.receivedAt).toISOString(), camera_id: ev.cameraId, airport: ev.airport, type: ev.type,
    object_count: ev.flock_size || ev.object_count, direction: ev.direction, confidence: ev.confidence, risk: ev.risk,
    snapshot: typeof ev.snapshot === "string" ? ev.snapshot : null, ...fields,
  });
  if (ev.risk === "red") emit("alert", { text: alertText, audio: await speak(alertText), risk: ev.risk, type: ev.type, incident_id: ev.id, time: ev.receivedAt });
}

// "Ask SkySentry": answer only from the last 7 days of hourly stats.
async function answerQuestion(question, hourly) {
  if (!hourly.length) return { answer: "There are no detections recorded in the last 7 days yet.", source: "template" };
  if (!GEMINI_API_KEY) {
    const worst = hourly.reduce((a, b) => (Number(b.total_objects) > Number(a.total_objects) ? b : a));
    return { answer: `The busiest hour in the data was ${new Date(worst.hour).toLocaleString("en-US", { weekday: "short", hour: "numeric" })} with ${worst.total_objects} ${worst.type}s across ${worst.events} events. (Add GEMINI_API_KEY for full answers.)`, source: "template" };
  }
  try {
    const text = await gemini([{ text: "You answer questions for an airport control tower. Use ONLY the hourly detection statistics below (JSON, UTC). " +
      `If the data cannot answer the question, say so. Keep the answer to two sentences.\n\nSTATS: ${JSON.stringify(hourly)}\n\nQUESTION: ${question}` }]);
    return { answer: text.trim(), source: "gemini" };
  } catch (err) {
    console.warn("gemini ask failed:", err.message);
    return { answer: "The assistant is unavailable right now. Try again in a moment.", source: "error" };
  }
}

module.exports = { processIncident, answerQuestion, alertSentence, status };
