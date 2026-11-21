This is the file for Shreyansh. Refer to AI.md for reference.

## Advisory bird verification
The tower loads the shipped v4.1 browser model only when enabled. It copies pixels at native resolution from an exact server frame/tracker match and dispatches at most one worker batch (up to eight rotating tracks). An advisory result appears only after averaging five distinct, chronological probability vectors for the same ongoing track. Losing a track or changing detector generation, stream, camera configuration, or airport/connection scope invalidates old evidence. Recorded previews never enter this live path. The seven-pixel eligibility floor is experimental, not a measured reliability limit.

Evidence review runs independently; the optional cloud path requires deployment permission and a separate operator opt-in for each connection. The server crops its own matching camera frame and track; the browser sends only the evidence reference and the expected provider header. A stale local-only request cannot reach Gemini after a server configuration change. An explicitly configured local server judge remains supported. Judge outcomes remain `bird`, `not_bird`, or `uncertain`; timely results are advisory, while a late verdict for the same session is shown as history. Neither verification path adds live track labels, changes tower risk or alerts, or provides clearance.

## Deployed integration and devnet fixes
The PR #12 AI/voice design is adapted under PRANAV/ai-voice using native HTTP requests so the DigitalOcean PRANAV service includes it. Immediate alerts receive later report/audio/stamp updates using the same incident ID. Solana validates secret bytes, configurable RPC devnet genesis, funding, submission and bounded confirmation; missing/failed providers keep the dashboard usable and expose honest status. /api/integrations returns configuration/status without keys. Live voice and ledger success require runtime credentials.

## Software-only remake: speed, live bird check, Gemini bird judge (branch `feature/software-only-perf-ai`)

**Why:** the site was slow (18.8 MB on first load, no compression or caching), the tower crashed when a CDN
failed, the "Enable trained bird check" never showed results, and the hardware beacon was dropped.

**What changed and how it works**
- **Loading speed** (`PRANAV/server.js`): gzip via `compression` and a one-week browser cache for `assets/`,
  `ai-models/`, `vendor/`, `clips/`, `promo/`. HTML/JS revalidate on every load so deploys show at once.
  Landing page transfer: 18.8 MB → 5.8 MB. Google Fonts no longer block rendering.
- **Tower crash**: Leaflet, Chart.js and the QR library are now in `public/vendor/` instead of a CDN.
- **3D film FPS** (`index.html`, `film.html`, `cinema.js`): no wasted MSAA (SMAA already runs), 1024 px
  PCF shadows instead of 2048 px soft shadows, and a time-based quality governor that lowers resolution,
  bloom and shadow refresh within ~1–2 s on slow machines. The stage's `data-fps` shows the live rate.
- **Live bird check**: demo clips get a VP9 WebM copy for browsers without H.264, camera start errors are
  shown on screen (they used to fail silently), the tower prefetches the bird model while idle, and every
  check result is shown even when it arrives too late to label the track.
- **Gemini bird judge** (`PRANAV/ai-voice/ai.js` → `verifyBird`, `POST /api/verify-bird`): a separate,
  strict yes/no call: forced JSON schema (`bird` / `not_bird` / `uncertain` + confidence), temperature 0,
  a rubric of look-alikes (drones, planes, insects on the lens, leaves, kites, glare), and a 0.7
  confidence floor below which it says `uncertain` instead of guessing. The tower asks it only when the
  on-device COCO model is unsure. Incident analysis runs it in parallel with the report (`bird_verdict`).
  Gemini isn't fine-tuned (that isn't possible in a hackathon window); this is prompt + schema "training".
- **MongoDB + Tiger Data**: every verdict goes to MongoDB `skysentry.bird_verdicts` and a new Tiger Data
  hypertable `bird_checks` (`db/schema.sql`, run `npm run db:setup`). Without keys, the hourly chart and
  incidents use a labelled in-memory fallback (`X-Data-Source` header) instead of returning 503.
- **Software only**: the tower beacon is the on-screen beacon with a Full-screen button for a spare monitor.
  All hardware code and sketches were removed; the project is software only.
- **Scroll animations**: `public/js/reveal.js` reveals sections/cards on scroll in browsers without CSS
  scroll timelines (Safari, Firefox) and on the app pages; it respects reduced motion.
- **Tests**: `test/bird-judge.test.cjs` (6 new). `npm test`: 91 passing.

**Accuracy, honestly:** no detector is right 100% of the time, and the benchmark protocol forbids tuning on
the frozen test sets. The judge is built to say "uncertain" rather than be confidently wrong. Measure it with
`benchmarks/` on the "tune" split before quoting a number.

## Demo footage when there is no camera (branch `feature/demo-feed-fallback`)
- **Tower** (`public/js/feeds.js`): if a camera tile gets no video for 4 s, or no camera is connected at all,
  a recorded clip loops in that spot with a yellow DEMO badge. The detector runs locally on it so the boxes
  show (and the trained bird check can run on it), but it has no event listener: demo footage never creates
  alerts, incidents or database rows. The first real frame from that camera replaces the demo instantly.
- **Camera page** (`public/js/camera.js`): devices with no camera start on a demo clip; if camera access is
  blocked or busy, pressing Start switches to a demo clip automatically and streams it as this camera.

## All hardware removed (software only)
- Deleted `arduino-stuff/`, `VIVAN/hardware/` (sketch + KiCad schematic) and `ATHARV/hardware/` (UNO Q sketches).
- `detection/adapters/beacon.js` (both copies): the Web Serial `BeaconLink` is replaced by a software `BeaconPacer`
  that only paces updates to the on-screen `VirtualBeacon`. No serial, USB or "READY" handshake remains.
- The tower beacon now shows green CLEAR when there are no recent events (it used to show the old
  hardware "OFFLINE" chase pattern), and every page and doc mentioning the hardware beacon was updated.

## Demo / Live switch on every tower feed
Each camera tile has a **Demo / Live** button (remembered per camera). Live is the default: real video when it
arrives, demo footage automatically while there is none. Demo always shows the recorded clip in that tile;
the server bot still analyses the real camera, so real alerts are unaffected.

## Demo footage now drives the risk card and beacon (labelled DEMO)
When no real camera has a recent event, the tower's risk card, sidebar status and beacon follow the demo footage
(1-4 objects yellow, 5+ red, the site's rule), shown as "DEMO · …" with "Recorded demo footage · not a real alert".
Demo footage still never creates alerts, sounds, incident reports or database rows; real camera events always win.

## Fixes to the bird check after an end-to-end test (by Pranav's session)
- `bird-review.js` read `live.lastState`, which `server.js` never sets (it stores `live.lastResult.state`), so every
  server evidence review answered `unknown_evidence` in the real app. Fixed, with a test using the real shape.
- Tower-key towers stayed on "Select an airport" (scoped key, locked airport box); now the single airport is chosen.
- The trained bird check now also accepts answers from a local model (`BIRD_JUDGE=local`), labelled "Local-model".

## Local bird / drone classifier (folder "Shreyansh Local Ai Model")
**Why:** the bird check used Gemini (snapshots leave the airport) and COCO-SSD. This is our own small model
(472,579 parameters, 2.5 MB) that labels each tracked object as bird, drone or other, fully in the browser.

**What's there:** start with `Shreyansh Local Ai Model/HANDOFF.md` (section 00 = latest status, results, approvals
and the plan to wire it into `PRANAV/public/js/visual-ai.js`). Trained on 10 openly licensed sources (Mendeley,
Svanström, AOD-4, DUT Anti-UAV, DCSkyCam, IBERBIRDS, Klim/Skagen, Open Images, two synthetic sets); FBD-SV-2024 is
used only for testing, as a camera the model has never seen. Also: a 30-60 s flight-path forecaster
(`flight_forecast.js`), a script to rename the person-named folders (`rename-folders.sh`), and a Gemini comparison
script (not run: the key is free tier).

**v5 corpus preflight:** The [train/SELECT verification guide](../Shreyansh%20Local%20Ai%20Model/DATASETS.md#5-v5-trainselect-preflight)
defines the ten-source bundle, file hashes, group checks and review evidence required before a fit. It
does not download data or open FBD-SV; that frozen dataset stays reserved for the unseen-source result.

**Results (best model v4.1, footage never trained on):** voting over 5 frames of a track, never-seen-camera birds
91.0% with 2.1% false alarms; Svanström birds 96.1%, drones 96.0%, false alarms 1.0%. Small objects (7-13 px) and
planes/helicopters are still below the 95% target. Earlier versions scored 95%+ on Mendeley but only 1.5% on
real footage from another source: always test on footage from a different source.

**Browser worker client (`v4.1` app integration):** Shipped in `PRANAV/public/ai-models/skysentry_classifier.{js,json}`
and `PRANAV/public/js/skysentry-v41-{client,worker,schedule,vote}.mjs`. An explicit load starts a local module worker.
The client sends one request at a time and transfers only the frame helper's owned RGBA copy. Closing cancels
outstanding work; a new explicit load starts a fresh worker after close, a timeout, or a worker error.

**Remaining gaps:** Full 10-source v5 training and unseen FBD-SV evaluation; the Gemini comparison was not run.
Datasets are not in git (data/ is ignored); the scripts re-download them and check their checksums.

**Independent small-bird evidence:** `small_bird_preflight.py` checks local native-frame metadata for
size coverage and source-group overlap without loading media. See `Shreyansh Local Ai Model/DATASETS.md`
for permission and evaluation requirements. Resized 7/10/13 px tests are stress proxies, not evidence
of recall on real birds of those sizes.

**v5 crop evaluation:** `eval_v4.py` scores a checkpoint already selected on validation data. Run from
`Shreyansh Local Ai Model`, for example `python eval_v4.py --arch mobilenet_v3_large --checkpoint runs\v5_large\best.pt --out results\v5_large_crops`.
`mobilenet_v3_small` and the default `skynetlite` are also supported. Each uses its training-time preprocessing;
votes use softmax probabilities in bird/drone/other order without fitting calibration on test data. The crop report
verifies the official frozen manifest without opening the field holdout, requires a new output directory, and
records the checkpoint hash, crop/group counts and 95% group-bootstrap intervals. FBD-SV stays test-only and
unscored unless `--fbd-pins` names a reviewed JSON file with `crops_sha256` and `metadata_sha256`. A never-seen
headline additionally needs a leakage audit tied to the recorded checkpoint. No v5 benchmark result is implied.

## v5 research result (Svanström only)

MobileNetV3 Large was fine-tuned on [Svanström](https://zenodo.org/records/5500576) only, starting from
`MobileNet_V3_Large_Weights.IMAGENET1K_V2` in TorchVision `0.23.0+cu126`. Baseline trainer: `cce10da`;
published tooling: [`60ac953`](https://github.com/pranav-atreya10/hackphs-dot/commit/60ac9535e512a5e906197ae303e2c35651b30ff7).
The run used seed 44 and fixed TRAIN/SELECT splits (153/35 clips), with eight epochs and 728 optimizer steps.
The loss upweighted aircraft and downweighted generated backgrounds within `other`, normalized to preserve
the nominal total `other` weight without changing bird or drone weights. The checkpoint was selected by
crop-level balanced accuracy on native SELECT (`95.71%`, 95% clip-bootstrap CI `91.86%` to `98.62%`).

- PyTorch checkpoint: `Shreyansh Local Ai Model/runs/v5/best.pt` (`17,031,299` bytes, SHA-256 `2dfc6316ea3077d534ce7d9c4a289d0a7c3e12c06d78c7d5178734b6cec30a6b`)
- ONNX export: `Shreyansh Local Ai Model/runs/v5/best.onnx` (`16,813,521` bytes, SHA-256 `b5623ed44fff65d8d26c350728f371065ad1dd038e8aef4f0904577fba766c6a`; opset 17, inline weights, dynamic batch `crop96_normalised -> logits`, synthetic CPU logit parity max abs error `7.15e-07` at batch 1 and `8.87e-07` at batch 3)
- Run & SELECT artifacts: `Shreyansh Local Ai Model/runs/v5/run.json`, `Shreyansh Local Ai Model/runs/v5/history.json`, `Shreyansh Local Ai Model/results/v5/select_comparison.json`, `Shreyansh Local Ai Model/results/v5/voting_5_select.json`
- Receipt SHA-256: `f372f1a067df5b4821c03e3562932b7ed180643826d53046041f87dcfb6613e7`
- Recipe SHA-256: `0a2e3c9ae6880c7e4bbdfb92d4de1ee903a6a39ede5806f8e8b7a058f177c30c`

**Five-crop votes** averaged class probabilities across 691 non-overlapping, annotation-linked native SELECT
windows on the same split used for the single-crop comparison:

| Measure | Windows | Clips | Rate (95% clip-bootstrap CI) |
| --- | ---: | ---: | ---: |
| Bird recall | 134/137 | 8 | 97.81% (93.33% to 100%) |
| Drone recall | 332/348 | 17 | 95.40% (88.35% to 99.43%) |
| Labelled aircraft classified as bird or drone | 3/206 | 10 | 1.46% (0% to 3.85%) |

Generated backgrounds were excluded from the vote comparison. The windows were not verified object tracks,
the clips were not verified to be independent recording sessions, and there were no native tiny-bird examples.
SELECT was used for development, not as a frozen or independent test. These are not live false-alarm rates
or evidence of 95% independent performance. No new FBD-SV score was produced; the benchmark archive is unchanged.

**Scope and pretrained weight terms.** This v5 checkpoint was trained and selected on CC0 Svanström authors-only
TRAIN/SELECT only — it has not yet been trained on the full 10-source corpus or scored on unseen FBD-SV, while
v4.1 (`Shreyansh Local Ai Model/runs/v4_1/best.pt` + `PRANAV/public/ai-models/skysentry_classifier.{js,json}`) remains
the full 10-source browser model verified on unseen FBD-SV (`91.0%` bird recall, `2.1%` false alarms with 5-frame voting).
Because v5 starts from TorchVision `MobileNet_V3_Large_Weights.IMAGENET1K_V2`, review the
[TorchVision pretrained weights terms note](https://docs.pytorch.org/vision/0.23/models.html#general-information-on-pre-trained-weights)
before any commercial deployment.

## UI, aviation HUD, and 60 fps scroll/load upgrades (`shreyanshnikam-ui-animations-and-hud`)

- **Tower & camera aviation HUD** (`PRANAV/public/js/feeds.js`, `hud-reticles.mjs`, `hud-vote-ring.mjs`, `flight-forecast.mjs`, `hud-forecast-cone.mjs`, `camera-hud.js`): 60 fps corner-bracket reticles, 5-frame v4.1 radial vote progress arcs (`VisualBirdVerifier` `onProgress` + `getTrackVote`), bounded 120-sample Monte Carlo flight-path forecast cones (corridor tinting/ETA gated strictly on surveyed corridors), and camera viewfinder telemetry. Browser HUD visuals remain advisory only and never change server-assigned risk or alerts.
- **Tower motion & map choreography** (`tower-layers.mjs`, `map-hud.css`, `alert-choreography.mjs`, `alerts-motion.css`, `risk-beacon-fx.mjs`, `beacon-risk-motion.css`, `stat-counter.mjs`): live FOV cone risk tinting + radar threat ripples, alert entrance/dismissal transitions, progressive storage/report/Solana enrichment pills, `#risk` escalation shockwaves synced to `#beaconView`, and tabular-odometer counters.
- **Landing sandbox, cross-page View Transitions & 60 fps load/scroll budgets** (`landing-live-ai.mjs`, `landing-live-ai.css`, `film-scrubber.js`, `film-perf-governor.js`, `view-transitions.css`, `smooth-details.{js,css}`, `perf-scroll.css`, `scroll-perf-guard.js`, `frame-budget.mjs`, `perf-html-transform.mjs`, `perf-headers.js`): zero-upload browser-local v4.1 landing demo, chapter hover scrubbing + offscreen WebGL pause on the 3D film, circular theme reveal, `ResizeObserver`-cached zero-reflow canvas sizing + shared frame-budget loop, non-render-blocking Google Fonts + `Vary: Accept-Encoding` static headers, and full `prefers-reduced-motion` / ARIA / zero-jank test gates (`ui-animations-a11y.test.cjs`, `perf-jank-budget.test.cjs`).

## Fast 3D film startup, crisp resolution, zero-jank scroll & Local AI Model copy (`shreyanshnikam-fast-film-scroll-and-local-ai`)

- **Instant 3D film startup & crisp resolution** (`ATHARV/skysentry/dist/{film-enhancements,models,assetload,cinema,nature,index}.*`, `ATHARV/skysentry/tools/build_site.py`, `PRANAV/public/js/film-perf-governor.js`): low-priority warm-fetch of Three.js + hero aircraft/HDR when `#filmPoster` nears within `300px` or receives hover/focus (honoring `saveData`), two-phase scenery loading (hero airliner, PBR runway/grass/HDR, physical sky, and 14k wind grass resolve `detailReady` first while 11 Poly Haven props stream in non-blocking 2-item batches before idle `optimizeScene`), native `fetch(data:)` GLB buffer decode, removal of 10,300 hidden billboard tufts, and an `.85` pixel-ratio floor with 4s startup grace + upward quality recovery.
- **Zero-jank scrolling** (`PRANAV/public/css/{site,perf-scroll,film}.css`, `PRANAV/public/js/{reveal,film-scrubber}.js`, `ATHARV/skysentry/dist/index.html`): removed continuous `animation-timeline: view()` scrubbers on `.hero`, `#film .stage`, and landing sections in favor of `reveal.js`'s one-shot `IntersectionObserver`, removed placeholder `content-visibility: auto` height estimates, disabled `header.bar` `backdrop-filter` blur and paused `EffectComposer` passes during the `140 ms` active-scroll window, and eliminated the 60 fps `fillStyleObserver` / duplicate spring `rAF` in `film-scrubber.js`.
- **Local AI Model copy across website & 3D animation** (`index.html`, `film.html`, `tower.html`, `tower.js`, `chat.js`, `live-section.html`, `build_site.py`): replaced all public-facing and in-film `"Gemini"` labels with `"Local AI Model"` while keeping backend env vars and wire-protocol tokens unchanged.

## Eight-stream platform upgrade (`shreyanshnikam-symmetrical-spork`)

> **Live deployment note:** Until Pranav sets the required DigitalOcean App Platform environment variables (`CAMERA_API_AIRPORT` naming a registered `AIRPORT_CODES` entry when `CAMERA_API_KEY` is set, plus `TOWER_API_KEY`/`TOWER_API_AIRPORT` or Clerk + MongoDB), `https://lancerhacks-rvs8r.ondigitalocean.app/ready` still returns `404` on the pre-PR-#56 build and code merged to `main` is not live yet. `PRANAV/access.js` airport-bound key checks are intentionally preserved.

1. **DigitalOcean deploy preflight & Admin subsystem readiness diagnostics** (`PRANAV/scripts/do-deploy-preflight.mjs`, `PRANAV/deploy-diagnostics.js`, `GET /api/deploy-diagnostics`, `PRANAV/public/js/admin-diagnostics.mjs`, `PRANAV/public/css/admin-diagnostics.css`, `PRANAV/public/admin.html`, `PRANAV/public/js/admin.js`, `PRANAV/OPERATIONS.md`): CLI preflight validates `.do/app.yaml`, checks production env bindings against `access.js` without loosening airport-bound rules, generates in-memory 32-byte hex keys without touching disk, and probes `/health` + `/ready`. `/admin.html` mounts a redacted zero-secret readiness checklist (`#diagPanel`) for signed-in admins and local non-Clerk `ALLOW_UNAUTHENTICATED_TOWER=true` loopback dev.
2. **v5 MobileNetV3-Large ONNX integration (server judge + browser worker)** (`PRANAV/v5-model-route.js`, `PRANAV/ai-voice/onnx-v5-judge.js`, `PRANAV/ai-voice/onnx_v5_worker.py`, `PRANAV/public/js/skysentry-v5-client.mjs`, `PRANAV/public/js/skysentry-v5-worker.mjs`, `PRANAV/public/js/visual-ai.js`): serves `Shreyansh Local Ai Model/runs/v5/best.onnx` after streaming SHA-256 verification (`b5623ed44fff65d8d26c350728f371065ad1dd038e8aef4f0904577fba766c6a`), adds `BIRD_JUDGE=onnx` server evidence review via persistent Python `onnxruntime` subprocess, and supports optional browser v5 ONNX worker inference alongside v4.1 (`skynetlite`) with automatic fallback to v4.1 when `best.onnx` or `onnxruntime-web` is unavailable. Frozen benchmark test sets (`benchmarks/test_sets.json`) were untouched, no new FBD-SV score is claimed (v5 remains CC0 Svanström TRAIN/SELECT only while v4.1 remains the 10-source unseen-FBD-SV model), and verdicts remain strictly advisory.
3. **Advisory multi-camera 2D stereo bearing triangulation** (`PRANAV/stereo-triangulation.js`, `PRANAV/public/js/stereo-triangulation.mjs`, `PRANAV/public/js/tower-stereo-layer.mjs`, `PRANAV/public/css/stereo-map.css`): computes WGS-84 local ENU bearing intersections and 95% chi-square uncertainty ellipses only when two or more live, non-demo cameras in the same airport observe compatible bearings within `2.5 s` and valid geometry (`6°–174°` ray angle, `>= 8 m` baseline). Single-camera bearings never fabricate a 2D map point, and every stereo estimate carries `advisory: true` and `geo_basis: "stereo_bearing_intersection"` (not radar or clearance).
4. **Interactive runway operations & advisory trajectory clash board** (`PRANAV/public/js/runway-ops-store.mjs`, `PRANAV/public/js/runway-clash-board.mjs`, `PRANAV/public/css/runway-clash.css`): lets tower operators log airport-scoped departure/arrival windows (`+30s` / `+60s` / `+90s` presets) and checks overlap against Monte Carlo projected mask-entry windows strictly on live, non-demo cameras with a server-approved `surveyId` corridor mask. Uncalibrated and demo feeds never evaluate clashes, and outputs never alter server risk or provide ATC separation/clearance.
5. **Instant 10-second pre/post-alert incident replay scrubbing** (`PRANAV/public/js/incident-ring-buffer.mjs`, `PRANAV/public/js/incident-replay-ui.mjs`, `PRANAV/public/css/incident-replay.css`): captures a bounded per-camera ring buffer (`~8 s` pre-alert + `~2 s` post-alert) on live non-demo feeds and renders interactive timeline scrubbing, play/pause, `0.5×`/`1×` playback, and read-only track overlays inside incident details without speaking or re-triggering alerts.
6. **Live on-chain Solana devnet proof verification & FAA-style shift report export** (`PRANAV/solana-verify-route.js`, `GET /api/incidents/:id/verify-solana`, `PRANAV/public/js/solana-proof-drawer.mjs`, `PRANAV/public/js/shift-report-export.mjs`, `PRANAV/public/css/incident-tools.css`): verifies local SHA-256 report hashes against recorded Solana devnet memos (`verified_on_chain`, `hash_mismatch`, `hash_only`, `rpc_unavailable`)—explicitly noting that hashes/memos prove post-stamp text integrity, not detection accuracy—and adds OWASP formula-injection-safe CSV export plus a monochrome FAA-style Wildlife & UAS Shift Summary print/PDF view.
7. **Privacy-preserving opt-in acoustic rotor-hum telemetry** (`PRANAV/camera-audio.js`, `PRANAV/public/js/camera-audio-telemetry.mjs`, `PRANAV/public/js/tower-acoustic-pill.mjs`, `PRANAV/public/css/acoustic-hud.css`, `PRANAV/public/camera.html`, `PRANAV/public/js/camera.js`): off-by-default `#acousticTelemetryBtn` on `/camera.html` extracts 80–600 Hz rotor-hum harmonic features strictly in browser memory and sends only the 8-key numeric/boolean summary (`source`, `streamId`, `t`, `droneProb`, `dominantHz`, `harmonicRatio`, `rmsDb`, `humDetected`) over live webcam streams; `hasForbiddenRawAudio` blocks raw PCM, typed arrays, FFT bins, blobs, speech/transcripts, and `data:audio` URIs, with 3 s TTL expiry and automatic mic shutoff on stop, disconnect, or demo/clip/synthetic switch. Advisory HUD pills never change server-assigned video risk.
8. **Standalone PWA App Hub, offline static shell & instant mobile QR pairing** (`PRANAV/public/manifest.webmanifest`, `PRANAV/public/sw.js`, `PRANAV/public/js/pwa-install.mjs`, `PRANAV/public/css/app-hub.css`, `PRANAV/public/app.html`, `PRANAV/scripts/sync-web.mjs`): upgrades `/app.html` into an installable PWA + native iOS SkySentryCam launchpad with secret-free QR/copy camera pairing (`${origin}/camera.html`), iOS Safari Add-to-Home-Screen steps, and a strict static-shell Service Worker (`sw.js`) that never caches `/api/*`, `/socket.io/*`, or authenticated traffic, linked across `index.html`, `film.html`, `camera.html`, `tower.html`, `admin.html`, and app pages.
