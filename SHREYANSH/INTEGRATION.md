# SHREYANSH/ — AI + voice pipeline: how to plug it into the server

Owner: Shreyansh (AI + voice lead). This folder is a self-contained CommonJS package:
Gemini incident reports, ElevenLabs spoken alerts, a Solana devnet stamp for drone reports,
and the "Ask SkySentry" answer. Written against `PRANAV/server.js` as of commit `e94e701`.

## What it exports

`require("../SHREYANSH/pipeline")` gives you both functions the server needs:

| Function | What it does |
|---|---|
| `handleEvent(event, target, { onDone })` | Call it for every camera event. Green events and repeats (one alert per type every 12 s, but yellow→red always passes) do nothing. Never throws. |
| `answerQuestion(question, hourlyRows)` | Returns a **string**. Uses only the hourly rows; says "I don't have data on that." otherwise. Never throws. |

`target` is anything with `.emit(name, data)`, for example `io.of("/tower")` or a room.
`onDone(result)` runs once every step has finished, with `{ id, gemini_label, report, solana_tx }`, for saving to MongoDB.

## What the towers receive (same `id` on every message)

1. `alert` — sent **immediately** (no API is awaited):
   `{ id, time, risk, type, object_count, direction, text, label: null, report: null, audio: null, solana_tx: null }`
2. `alert_update` — later, only the new fields, merged by `id`:
   - `{ id, audio }` base64 MP3, **red only** (~0.4 s), or `{ id, audio: null, audio_failed: true }` if ElevenLabs failed
   - `{ id, label, report, report_source }` from Gemini (1–10 s; main model, then a backup model, then a template)
   - `{ id, solana_tx, solana_url }` drones only, once the stamp is confirmed on devnet

Tower rule: play `audio` when it arrives; if `audio_failed`, or nothing within 5 s, speak `text` with
`speechSynthesis`. Browsers need an "Enable sound" click before any audio plays.

## Overlap with `PRANAV/ai.js` (team decision needed)

`PRANAV/ai.js` `processIncident` does the same job, differently:

| | `PRANAV/ai.js` | `SHREYANSH/pipeline.js` |
|---|---|---|
| First tower message | after Gemini (and Solana) finish | `alert` at +0 ms with template text |
| Voice | inside `alert`, after the report | separate `alert_update` ~0.4 s, cached, `audio_failed` signal |
| Tower events | `incident` + `alert {text, audio, ...}` | `alert` + `alert_update` (merge by `id`) |
| `answerQuestion` returns | `{ answer, source }` | a string |

Both use the event name `alert` with **different shapes**, so pick one per tower page.

### To switch the server to this pipeline

In `relayCameraEvent` in `PRANAV/server.js`, replace the `ai.processIncident(...)` call with:

```js
.then(() => pipeline.handleEvent(event, { emit: (name, data) => towersFor(airport).emit(name, data) }, {
  onDone: (r) => mongo && withMongo((mdb) => mdb.collection("incidents").updateOne({ _id: event.id },
    { $set: { gemini_label: r.gemini_label, report: r.report, solana_tx: r.solana_tx } })),
}))
```

and in `/api/ask`: `res.json({ answer: await pipeline.answerQuestion(question, hourly) });`

Near the top (works locally and on DigitalOcean, see below):

```js
const pipeline = require(require("fs").existsSync(path.join(__dirname, "ai-voice")) ? "./ai-voice/pipeline" : "../SHREYANSH/pipeline");
```

The tower page then needs the `alert` / `alert_update` handling above.

## Install and deploy

- **Locally:** `npm install --prefix ../SHREYANSH` once, from `PRANAV/`. Node resolves my packages next to
  my files, so adding them to `PRANAV/package.json` does not help.
- **DigitalOcean:** with `source_dir: PRANAV`, only `PRANAV/` exists at runtime
  ([DO monorepo docs](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-monorepo/)).
  Copy this folder in at build time:
  `build_command: npm ci && cp -r ../SHREYANSH ai-voice && npm ci --prefix ai-voice`
- **Env vars** (encrypted, in the DO dashboard): `GEMINI_API_KEY`, `GEMINI_MODEL` (`gemini-3.5-flash`),
  `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `SOLANA_SECRET_KEY` (JSON array of 64 numbers, devnet).
  `config.js` reads `SHREYANSH/.env` locally but never overrides real environment variables.
- Without keys everything still runs: template reports, `audio_failed` (browser voice), no stamp.

## Files

| File | Purpose |
|---|---|
| `config.js` | The only file that reads keys; `keyStatus()`, `redact()` |
| `describe.js` | Event fields to plain English (local time, direction, number words) |
| `ai.js` | `analyzeEvent` (Gemini snapshot check + 3-sentence report), `answerQuestion` |
| `voice.js` | `buildAlertText`, `speak` (ElevenLabs, cached), `shouldAlert` (rate limit) |
| `solana.js` | `stampReport` (SHA-256 hash as a devnet memo), `explorerUrl`, `verifyReport` |
| `pipeline.js` | `handleEvent`: alert now, then voice + Gemini in parallel, then the stamp |
| `test*.js`, `check-wallet.js`, `new-wallet.js` | Tests and wallet tools (run from inside `SHREYANSH/`) |
| `mock-server.js`, `fake-events.js` | Test stand-in server and fake camera + tower (`node mock-server.js`, then `node fake-events.js`) |
