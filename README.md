# SkySentry

SkySentry is a video-only monitoring prototype. An authorized camera sends JPEGs to the Node server in `PRANAV`, which assigns risk and shows warnings in a tower dashboard. The native camera app is in `ATHARV/ios`. JPEGs contain no drone audio, and even “No detections in monitored video” is not clearance. The prototype is not qualified for airport operations.

**Live site:** https://lancerhacks-rvs8r.ondigitalocean.app (deployed from `main` on DigitalOcean App Platform)

> ## ⚠️ DigitalOcean environment variable checklist (Pranav)
> Production now boots cleanly on DigitalOcean App Platform (`GET /health` returns `200`), while keeping any unbound
> `CAMERA_API_KEY` or `TOWER_API_KEY` **fail-closed disabled** until bound to a registered airport. To enable API-key
> camera/tower access, open DigitalOcean → the app → Settings → web → Environment Variables (tick "Encrypt" for secrets)
> and set:
> 1. `CAMERA_API_AIRPORT` = an airport code listed in `AIRPORT_CODES` (e.g. `KPCT`). If `AIRPORT_CODES` is empty there,
>    add it too, e.g. `KPCT=<long secret join code>` (or generate a bundle locally with `npm --prefix PRANAV run preflight:do -- --generate KPCT`).
> 2. If `TOWER_API_KEY` is set: `TOWER_API_AIRPORT` = an airport code listed in `AIRPORT_CODES`.
>
> Save to redeploy; verify status anytime in `/admin.html` Diagnostics or `https://lancerhacks-rvs8r.ondigitalocean.app/ready`
> (`503 not_ready` with `receipt_recovery: unavailable` is expected on ephemeral App Platform disks once `camera_access` and `tower_access` report `ready`). Optional cleanup while there: delete `DATABASE_URL` and any `ELEVENLABS_*` variables (no longer used).

## The app

| Page | What it's for | Who can open it |
|---|---|---|
| `/` | Landing page: the 100-second film, how it works, demos, and the "Ask about SkySentry" chat | Everyone |
| `/account.html` | Sign up / sign in (Clerk), then pick an account type and enter an airport join code | Everyone |
| `/camera.html` | **Camera station.** Streams live video from this device. Uploads and synthetic scenes stay in local preview. | Airport-bound camera accounts, or a bound camera key; demos stay local |
| `/tower.html` | **Tower dashboard.** Server-assigned risk and coverage, fresh alerts with optional browser speech, reports, a camera map, chart, software beacon and advisory assistant | Tower accounts, admins, or an airport-bound tower key |
| `/demo.html` | Demo library: recorded bird and drone clips. Not linked from any menu (camera stations pick demo clips in their own settings); still works by URL | Everyone |
| `/settings.html` | Account type, airport, profile and security (Clerk), switch-type requests, delete account, light/dark theme | Signed-in users (theme for everyone) |
| `/admin.html` | Create airports and join codes; approve or deny account-type switch requests | Admins |
| `/app.html` | Placeholder for the mobile app ("Still Under Progress") | Everyone |

### First-visit walkthrough

The first time someone opens the **Tower** or **Camera** page, a short guided tour highlights each part (risk level, feeds, map, adding a camera, reports, assistant / Start, upload, settings). It waits until sign-in is done, shows once per browser, and **Take the tour** in the side menu replays it. Code: `PRANAV/public/js/walkthrough.js`.

### Accounts

- **Camera station** and **Tower dashboard** accounts belong to one airport. They join with that airport's code and only see their own side and airport. The sidebar's bottom-left Account tab shows the type.
- **Switching type** needs an admin: request it in Settings, or from a page your account can't open. The admin approves it on the admin page, and you keep your airport.
- **Admins** are configured by verified email in `ADMIN_EMAILS`. They can create airports and choose one registered airport per dashboard connection.
- Without Clerk, use separate camera and tower keys bound to registered airports. Keyless tower access is opt-in for loopback demos only and does not pass readiness.

### How an alert travels

The server evaluates current frames from an authorized airport. If the detector is stale or unavailable, the tower shows the coverage gap, not a green result. Live warnings can precede MongoDB confirmation; only stored alerts can be acknowledged and replayed. Browser speech is opt-in for fresh alerts, and recovery is silent. Delivery and reports can be delayed or incomplete. Snapshot retention and optional cloud image review are separate, default-off settings. A Solana devnet hash can help compare exact drone report text; it is not tamper-proof storage or proof of accuracy.

## Run it locally

```bash
cd PRANAV
npm ci                    # follow repository download policy
cp .env.example .env      # use only approved local settings; remove dummy provider values
npm run dev               # http://localhost:8080 (or PORT)
npm test                  # server, auth, airports, switch requests, pipeline
```

On a Mac you can instead double-click **Restart SkySentry.command**. Browser camera access requires HTTPS or localhost. See [the runbook](PRANAV/OPERATIONS.md) for isolated synthetic verification; do not test against the public site.

Other scripts: `npm run sync-web` (copy Vivan's detection engine and Atharv's film/site into `PRANAV/public`), `npm run record-film` (render the film to MP4).

## Settings (`PRANAV/.env` locally, encrypted env vars in DigitalOcean)

| Variable | What it does |
|---|---|
| `CAMERA_API_KEY`, `CAMERA_API_AIRPORT` | Required in production. Device key and its single registered airport. |
| `TOWER_API_KEY`, `TOWER_API_AIRPORT` | Optional distinct tower key and its single registered airport. |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Sign-in. On `*.ondigitalocean.app`, use the Clerk **Development** keys (`pk_test_` / `sk_test_`); production keys need a domain you own. |
| `ADMIN_EMAILS` | Comma-separated emails of admins (must be verified in Clerk). |
| `AIRPORT_CODES` | Fixed airports and join codes, e.g. `KPCT=pct-sky-4821`. Admins can add more on the admin page (saved in MongoDB). |
| `MONGODB_URI` | Everything stored: incident reports, every detection (hourly chart; deleted after 8 days), bird verdicts, admin-created airports, switch requests. |
| `RECEIPT_SPOOL_FILE` | Absolute private file on a supported persistent local volume for restart recovery. Without it, `/ready` is not ready. Do not configure it on ephemeral App Platform storage. |
| `GEMINI_API_KEY` (`GEMINI_MODEL`, `GEMINI_BACKUP_MODEL`) | Optional advisory reports and text fallback; reports can use a template when unavailable. |
| `DURABLE_INCIDENT_EVIDENCE`, `GEMINI_CLOUD_EVIDENCE_ENABLED` | Independent opt-ins for retaining incident images and sending eligible images to Gemini. |
| `BIRD_JUDGE` (`LOCAL_JUDGE_URL`, `LOCAL_JUDGE_MODEL`, `LOCAL_JUDGE_KEY`) | Who double-checks birds: `gemini` (default), `local` (a vision model on your own computer through Ollama, LM Studio, llama.cpp or vLLM) or `off`. The rubric and answer format are in `PRANAV/ai-voice/bird-judge.spec.json`. |
| `SAVE_JUDGE_IMAGES` | `on` keeps the crop with each confident bird verdict, for building a local-model training set (`npm run export-judge`). Off by default (uses storage). |
| `OPENAI_API_KEY` (`OPENAI_MODEL`, `OPENAI_GUIDE_MODEL`) | Tower assistant and the landing-page chat. |
| `SOLANA_SECRET_KEY` (`SOLANA_RPC_URL`) | Devnet stamp on drone reports. |
| `SERVER_BOT`, `BOT_PRESET` | Server-side detection on streamed video (`on` by default). |
| `AIRPORT_NAME`, `SITE_URL`, `CORS_ORIGIN`, `PORT` | Display name, sitemap origin, allowed origins, port. |

**Checks:** `/health` is process liveness, not readiness. `/ready` checks required software capabilities, not live coverage or clearance. `/health/db` reports storage and Clerk diagnostics.

## Repo layout

| Folder | Owner | What's there |
|---|---|---|
| `PRANAV/` | Pranav | Express + Socket.IO server, website (`public/`), sign-in, admin, AI/voice/Solana pipeline (`ai-voice/`), tests. Notes in `PRANAV/PRANAV.md`, deploy steps in `PRANAV/OPERATIONS.md`. |
| `VIVAN/detection/` | Vivan | The detection engine (tracking, flocks, debris, drone hum, risk). Copied into `PRANAV/public/detection` by `npm run sync-web`. |
| `ATHARV/` | Atharv | The 3D film and landing-page source (`skysentry/`) and the iPhone camera app (`ios/`, see [its README](ATHARV/ios/README.md)). |
| `SHREYANSH/` | Shreyansh | The original AI, voice and Solana pipeline that `PRANAV/ai-voice` adapts. |
| `benchmarks/`, `testbench/`, `models/` | Vivan | Detection benchmarks; follow `benchmarks/BENCHMARK_PROTOCOL.md`. |

Models, settings and weights (and how to run them locally, including a local bird judge) are in `MODELS.md`.

Team workflow (a branch and a PR per change, notes per person) is in `AI.md`.
