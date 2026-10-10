# SkySentry app

The working system from the build plan: a phone camera station that spots birds and drones, a server that stores and verifies every event, and a tower dashboard that shows and speaks the alerts.

Everything runs in **demo mode** until you add keys: databases fall back to in-memory stores, Gemini reports fall back to templates, the tower uses the browser's voice instead of ElevenLabs, and drone reports get a hash but no Solana stamp.

## Run it

```bash
cd app
npm install
npm start               # http://localhost:8080/tower/ and /camera/
npm run simulate        # in a second terminal: sends a scripted bird + drone sequence
npm test                # risk rules, tracker, event format, full pipeline
```

Open the tower on one laptop and the camera page on a phone or a second laptop pointed at the sky. On the camera page, **Simulated birds** and **hold D for a drone** let you test without a model, a mic or real birds.

## Layout

```
app/
  shared/        used by both the browser and the server
    event.js       the event format (build plan, section 4) and validation
    risk.js        green / yellow / red rules, drone 0.8-for-1-second gate, alert sentence
    tracker.js     nearest-box tracking, direction, "toward runway" (left side of frame)
  camera/        camera station page (Detection lead)
    detect.js      bird detector plug-in: coco-ssd, simulated, custom
    models/custom.js   <- drop your own bird model in here
    sound.js       drone listener plug-in: Teachable Machine, simulated, off
    main.js        detect -> track -> risk -> send every 2 s and at once on yellow/red
  server/        API server (Backend + AI leads)
    server.js      Express + Socket.IO, routes below
    pipeline.js    the seven steps one alert travels
    db.js          Tiger Data + MongoDB, with in-memory fallbacks
    ai.js          Gemini: verify snapshot + report (A1), answer questions (A4)
    voice.js       ElevenLabs speech (A2)
    solana.js      SHA-256 hash + devnet Memo stamp for drone reports (A3)
    config.js      reads .env
  tower/         tower dashboard (Dashboard lead)
    index.html, tower.js   risk meter, alarm + voice, map, hourly chart, incidents, chat
  db/
    tiger_schema.sql   detections hypertable + hourly continuous aggregate
    mongo_setup.js     incidents collection, validator, indexes
  tools/simulate.js  scripted events for testing without a camera
```

## Plugging in the real pieces

| Piece | Where | What to do |
|---|---|---|
| Your bird model | `camera/models/custom.js` | Return birds as `{x, y, width, height, score}` in video pixels, then pick **Custom model** on the camera page. Nothing downstream changes. |
| Drone sound model | camera page | Train Background Noise / Drone / Birds in Teachable Machine (record background in the actual room), export, paste the model URL. |
| Tiger Data | `.env` `TIGER_DATABASE_URL` | Then `npm run db:tiger` once. |
| MongoDB Atlas | `.env` `MONGODB_URI` | Then `npm run db:mongo` once. |
| Gemini | `.env` `GEMINI_API_KEY` | From Google AI Studio. |
| ElevenLabs | `.env` `ELEVENLABS_API_KEY` | Optional `ELEVENLABS_VOICE_ID`. |
| Solana | `.env` `SOLANA_SECRET_KEY` | Devnet keypair as a JSON array; `npm install @solana/web3.js` if it was skipped. |
| Map position | `tower/tower.js` `AIRPORT`, `CAMERAS` | Set the camera's real location and the direction it faces. |

Copy `.env.example` to `.env`. Never commit `.env`.

## API

| Route | Purpose |
|---|---|
| Socket `camera:event` | Camera sends an event (ack returns validation errors) |
| Socket `tower:join` | Tower subscribes to `detection`, `incident`, `alert`, `cameras` |
| `POST /api/events` | Same as `camera:event`, over HTTP |
| `GET /api/hourly?hours=24` | Hourly rows from `detections_hourly` (max 168) |
| `GET /api/incidents` | Latest 20 reports, newest first, without snapshots |
| `GET /api/incidents/:id` | One report with its snapshot |
| `POST /api/ask` `{question}` | Gemini answer from the last 7 days of hourly stats |
| `GET /api/health` | Which services are live vs demo, connected cameras |

## Event format

```json
{ "camera_id": "runway-east", "type": "bird", "object_count": 6,
  "direction": "toward runway", "confidence": 0.82, "risk": "red",
  "snapshot": "<small JPEG as base64, only for yellow or red>" }
```

`direction` is one of `toward runway`, `away from runway`, `crossing`, `stationary`, `unknown`.

A camera that stays yellow or red keeps sending every 2 seconds. The server opens a new incident (Gemini call, report, voice) only when the risk rises, the type changes, or `INCIDENT_COOLDOWN_MS` (30 s) has passed. That keeps API usage in free tiers.

## Limits

Daylight only. The off-the-shelf bird model works best when birds are reasonably large in the frame. SkySentry is an extra set of eyes for the tower, not a replacement for radar.
