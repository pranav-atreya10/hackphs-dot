This is the file for Shreyansh. Refer to AI.md for reference.

## Deployed integration and devnet fixes
The PR #12 AI/voice design is adapted under PRANAV/ai-voice using native HTTP requests so the DigitalOcean PRANAV service includes it. Immediate alerts receive later report/audio/stamp updates using the same incident ID. Solana validates secret bytes, configurable RPC devnet genesis, funding, submission and bounded confirmation; missing/failed providers keep the dashboard usable and expose honest status. /api/integrations returns configuration/status without keys. Live voice and ledger success require runtime credentials.

## Software-only remake: speed, live bird check, Gemini bird judge (branch `feature/software-only-perf-ai`)

**Why:** the site was slow (18.8 MB on first load, no compression or caching), the tower crashed when a CDN
failed, the "Enable trained bird check" never showed results, and the Arduino beacon didn't work out.

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
  The Web Serial/Arduino link is no longer used.
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
