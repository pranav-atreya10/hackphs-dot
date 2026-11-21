This is the file for ATHARV. Refer to AI.md for reference.

## Unified website (branch `feature/unified-website`)

### What was built
Everyone's work now runs as **one website on Pranav's server** (`PRANAV/`, the folder DigitalOcean deploys):

| Page | What it is | Built from |
|---|---|---|
| `/` | Landing page with the 3D film, how it works, risk levels, the alert journey, FAQ, and a **Live system** section | Atharv's site + film |
| `/camera.html` | Phone-first camera station. Runs **Vivan's DetectionEngine** on the rear camera, a video clip, or his synthetic sky. Draws tracks, flocks and the runway corridor; sends his contract events (with a snapshot crop for yellow/red) to Pranav's `/camera` namespace. Optional COCO-SSD second opinion, drone-hum microphone, simulated drone, keeps the screen awake. | Vivan's engine + adapters |
| `/tower.html` | Tower dashboard on Pranav's `/tower` namespace: risk across cameras, spoken alerts, Leaflet map with each camera's view cone and threat pins from Vivan's bearings, hourly chart (`/api/hourly`), incident reports (`/api/incidents`), "Ask SkySentry", a **QR code for adding a phone camera**, and **Vivan's beacon** (software, on screen). | Atharv's dashboard, Pranav's API, Vivan's beacon |
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

The homepage shows a static film poster until Play is selected. The standalone film starts from generated scenery while the optional world, cinematic and model passes load concurrently. Nature patches the assembled materials before the optimizer batches geometry. The aircraft and environment use the original GLB and HDR files; the smaller decimated versions of the scanned props are retained.

### Phones need https
Browsers only give a page the camera on `https://` (or `localhost`). Use the deployed DigitalOcean URL, or a temporary https tunnel to a laptop, for the phone camera.

### Tested
Ran the server locally with a test camera key: every page loads; the camera page ran Vivan's synthetic flock scenario (6 birds, 2 s to corridor, 4 Hz, RED) and sent events; a scripted camera + tower confirmed the relay, the incident report and the spoken alert sentence end to end.

## iPhone camera source and credential migration

The native uploader now sends only the authorized rear camera. Demo sky and bundled video stay in local preview; a missing or denied camera is shown as an error instead of being replaced. The app migrates the old camera API key to this device's Keychain, removes the old preference only after successful storage, and replaces the shared `iphone-1` default with a device-specific label. Custom labels are preserved and do not determine the wire identity.

The upgraded app sends source, device and session headers. The server requires these, so upgrade the camera app and service together. The uploader waits for configuration before sending frames, sends Stop for the current session, and drops cached risk if fresh server evidence is missing. Verify upgrade with an existing key on a physical iPhone, including permission denial, backgrounding, a network outage and resume; the production service and a device were not exercised in this change.

## iPhone app (ATHARV/ios)

### What was built
**SkySentry Camera** is a native SwiftUI app (`ATHARV/ios/SkySentryCam.xcodeproj`, iOS 17+, bundle id `com.skysentry.camera`). It turns an iPhone into a runway camera. It streams the rear camera to Pranav's server over the HTTP camera API, and the server bot (Vivan's engine in `PRANAV/bot.js`) does the detection. The phone only streams frames and draws what comes back. No third-party packages: SwiftUI, AVFoundation, CoreLocation and URLSession only.

- **Setup screen** (saved on the phone): server URL, camera key, airport code, camera ID, compass heading, lens width, latitude/longitude ("Use my location & compass" fills these), runway corridor side and width, and video source.
- **Camera screen**: full-screen 1280x720 rear camera. Frames are scaled to 640 px wide, JPEG 0.6, and sent to `POST /api/camera-frame` at up to ~15 fps with one request in flight. Frames are dropped while waiting, so a slow link lowers the fps instead of adding lag. `POST /api/camera-config` (camera position plus corridor) is sent on Start and whenever settings change.
- **Overlay**: runway corridor (terracotta), track boxes coloured bird/drone/unknown, trails, and "flock of N · Xs" boxes, mapped correctly for Fill or Fit. A risk banner (green/yellow/red) shows a line like "Flock of 6 birds · heading south · 9 s to runway". Stats show frames, fps, connection status and server/tower bot.
- **Demo sky**: the simulator has no camera, so the app streams a synthetic sky with a V of six flapping birds, using the same bird model as Vivan's `synthetic.js`. It is used automatically when there is no camera and can be chosen by hand on a phone.
- Keeps the screen awake while streaming. Clear errors for a wrong key (401), an unreachable server (retries) and camera permission (Open Settings button). Works in portrait and landscape.

### Open and run in Xcode
1. Open `ATHARV/ios/SkySentryCam.xcodeproj`, pick the **SkySentryCam** scheme and an iPhone simulator, and press Run.
2. In Setup enter the server URL (default `http://localhost:8095`) and the camera key, then tap **Open camera › Start streaming**.

### Put it on a real iPhone (free Apple ID)
1. Connect the iPhone with a cable and tap Trust. Turn on **Settings › Privacy & Security › Developer Mode** and restart the phone.
2. Xcode › Settings › Accounts: add your Apple ID.
3. Target **SkySentryCam › Signing & Capabilities**: leave automatic signing on and set Team to your **Personal Team**. If Xcode says the bundle id is unavailable, change it to something unique like `com.yourname.skysentry`.
4. Select the iPhone as the destination and press Run.
5. On the phone: **Settings › General › VPN & Device Management ›** your Apple ID **› Trust**. Then open the app and allow the camera.
6. Free-account installs expire after 7 days; press Run again to reinstall.

On the phone, `localhost` is the phone itself. Use the DigitalOcean `https://` URL, or your Mac's Wi-Fi address (`http://192.168.x.x:8095`) on the same network. Plain http is only allowed for local-network addresses.

### Tested
The app built with no errors for the iPhone 17 Pro simulator (Xcode 26.5) and launched. It streamed the demo sky to a local server with a test camera key: the server answered `ok` with the server bot, the app held ~14.6 fps (852 frames in 60 s), and the bot found the flock of 6 (RED, ETA counting down to the corridor). Boxes lined up with the birds. A wrong key showed the 401 message and stopped. The Mac's LAN IP over plain http also worked. Not tested: the real rear camera, CoreLocation/compass, and landscape (these need a physical phone).

## Phone streaming and the server bot (PR #5, #6, #7 and this one)

### How it works now
The iPhone is just the camera. It streams its video to the website, and the **bot runs on the server**:

1. The phone sends JPEG frames (about 15 a second, 640 px wide), from the camera page (`/camera.html`, Socket.IO) or the native app (`POST /api/camera-frame`).
2. `PRANAV/bot.js` runs Vivan's `DetectionEngine` on each camera's frames and sends its events through Pranav's relay: Tiger Data, MongoDB incidents, the AI step, the towers.
3. Every tower at that airport gets the live feed with the bot's boxes drawn on it. The phone gets the same boxes back.

**Fallback:** if the server bot is too slow (over 60 ms per frame on average), errors, or is switched off with `SERVER_BOT=off`, it hands the camera over to the towers. One tower page then runs the engine on the same feed and reports events; the server accepts them from one tower per camera, so alerts aren't duplicated. The server bot tries to take the camera back every 20 s.

A third option on the camera page, **Detect on this phone**, runs the engine on the phone itself and only sends results. Use it on a weak connection.

### Beacon
The beacon is software only: the tower draws it on screen, and **Full-screen beacon** turns a spare monitor into the warning light. The earlier hardware sketches were removed.

### Tested
- A scripted phone streamed 61–98 frames. Every frame and every overlay state reached the tower, and the bot raised yellow, then red, with a spoken alert.
- The native app in the simulator streamed 852 frames at 14.6 fps, and the bot's boxes landed on the demo flock.
- The bot hands over and takes the camera back after the retry window.

## Camera and real-video demos update
Added a server demo library with AVPlayer frame replay through the camera uploader, explicit warmup/shake status, and long-edge 640px upload scaling to reduce portrait payload. All Swift sources pass device SDK type checking. A full Xcode asset build is blocked by unavailable simulator runtime services on this Mac; the installed iPhone app still needs a rebuild and install.

## Film loading recovery
The landing page and standalone film now limit the blocking scenery loader to eight seconds. If an aircraft, texture, or scanned prop stalls, the generated base film becomes playable while detailed assets continue loading. Late completion refreshes the current frame without restarting the timeline. Both `ATHARV/skysentry/dist` sources and the deployed `PRANAV/public` copies include the fix.

## Fast two-phase 3D film loading, crisp quality floor, scroll pause & Local AI Model labels
- **Warm-fetch & two-phase streaming** (`tools/build_site.py`, `dist/film-enhancements.js`, `dist/models.js`, `dist/assetload.js`): `#filmPoster` warm-fetches Three.js, core modules, `narrow-body-airliner.glb`, and `derelict_airfield_01_1k.hdr` at low priority when within `300px` of the viewport or hovered/focused (unless `saveData` is enabled). Phase 1 loads `enhanceWorld`, `enhanceCinema`, and `enhanceNature` first so the detailed airliner and runway mark `stage.dataset.assets = "ready"` immediately; Phase 2 streams the 11 scanned airfield props in 2-item batches with `16 ms` frame yields and runs `optimizeScene` on idle. Embedded `data:` buffers decode via native `fetch(uri).arrayBuffer()` with a pre-allocated loop fallback.
- **Crisp resolution & overdraw reduction** (`dist/cinema.js`, `dist/nature.js`, `dist/index.html`): removed the 10,300 superseded billboard grass tufts, reduced `nature.js` grass blades from 47,000 to 14,000, added a 4-second / `ready` startup grace window to the adaptive quality governor with a `.85` minimum pixel-ratio floor, SMAA retained down to `-2`, and automatic upward quality recovery, and paused `EffectComposer` render passes during active page scroll (`html[data-scrolling="1"]`).
- **Local AI Model copy** (`dist/index.html`, `tools/build_site.py`, `app/tower/tower.js`): updated all website and in-film `"Gemini"` labels to `"Local AI Model"` and regenerated `dist/site.html` + `PRANAV/public`.

