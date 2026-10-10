This is the file for ATHARV. Refer to AI.md for reference.

## Unified website (branch `feature/unified-website`)

### What was built
Everyone's work now runs as **one website on Pranav's server** (`PRANAV/`, the folder DigitalOcean deploys):

| Page | What it is | Built from |
|---|---|---|
| `/` | Landing page with the 3D film, how it works, risk levels, the alert journey, FAQ, and a **Live system** section | Atharv's site + film |
| `/camera.html` | Phone-first camera station. Runs **Vivan's DetectionEngine** on the rear camera, a video clip, or his synthetic sky. Draws tracks, flocks and the runway corridor; sends his contract events (with a snapshot crop for yellow/red) to Pranav's `/camera` namespace. Optional COCO-SSD second opinion, drone-hum microphone, simulated drone, keeps the screen awake. | Vivan's engine + adapters |
| `/tower.html` | Tower dashboard on Pranav's `/tower` namespace: risk across cameras, spoken alerts, Leaflet map with each camera's view cone and threat pins from Vivan's bearings, hourly chart (`/api/hourly`), incident reports (`/api/incidents`), "Ask SkySentry", a **QR code for adding a phone camera**, and **Vivan's beacon** (on-screen, plus the Arduino over Web Serial). | Atharv's dashboard, Pranav's API, Vivan's beacon |
| `/film.html` | The standalone film | Atharv |
| `/detection/test/` | Vivan's engine tests and accuracy table | Vivan |
| `/chat.html` | Pranav's original chat demo (moved from `/`) | Pranav |

### Server additions (`PRANAV/ai.js`, small hooks in `PRANAV/server.js`)
- After Pranav's server stores a yellow/red incident, the **AI step** fills `gemini_label`, `report` and (drones) `report_hash` + `solana_tx`, then pushes `incident` and, for red, `alert` (sentence + ElevenLabs audio) to that airport's towers. Runs on escalation or every `AI_COOLDOWN_MS`, so the 2-second camera heartbeats don't burn API quota.
- `POST /api/ask`: answers from the last 7 days of `detections_hourly`.
- `/health` reports which AI services are live.
- Without keys everything still works: template reports, the browser's voice, hash without a chain stamp.

### Sign-in (`PRANAV/public/js/auth.js`)
Matches Pranav's server: with Clerk configured, people sign in and finish sign-up once with a role and airport code; sockets and API calls carry the Clerk token. Without Clerk, cameras enter `CAMERA_API_KEY` once (saved on the device) and towers are open (or `?key=TOWER_API_KEY`).

### Keeping copies in sync
DigitalOcean only deploys `PRANAV/`, so Vivan's engine and the film are copied into `PRANAV/public` by `npm run sync-web` (`PRANAV/scripts/sync-web.mjs`). Edit them in `VIVAN/` and `ATHARV/`, then run the sync.

### Phones need https
Browsers only give a page the camera on `https://` (or `localhost`). Use the deployed DigitalOcean URL, or a temporary https tunnel to a laptop, for the phone camera.

### Tested
Ran the server locally with a test camera key: every page loads; the camera page ran Vivan's synthetic flock scenario (6 birds, 2 s to corridor, 4 Hz, RED) and sent events; a scripted camera + tower confirmed the relay, the incident report and the spoken alert sentence end to end.
