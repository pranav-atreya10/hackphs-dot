This is the file for Shreyansh. Refer to AI.md for reference.

## Advisory bird verification
The tower loads the existing COCO assets only on opt-in and shows runtime, weight, and warmup progress. Local bird checks continue while an optional cloud review is pending. The server crops its own matching camera frame and track; the browser sends only the evidence reference. Gemini outcomes remain `bird`, `not_bird`, or `uncertain`, and late outcomes are shown as history. Neither verification path changes tower risk or provides clearance.

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

**Results (best model v4.1, footage never trained on):** voting over 5 frames of a track, never-seen-camera birds
91.0% with 2.1% false alarms; Svanström birds 96.1%, drones 96.0%, false alarms 1.0%. Small objects (7-13 px) and
planes/helicopters are still below the 95% target. Earlier versions scored 95%+ on Mendeley but only 1.5% on
real footage from another source: always test on footage from a different source.

**Not done yet:** the app wiring (approved), v5 (bigger pretrained model, needs a GPU), the Gemini comparison.
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
