# SkySentry

SkySentry connects an iPhone camera to a live tower dashboard, detects moving birds and drones near a runway corridor, double-checks birds with a strict Gemini bird judge, and turns alerts into incident reports stored in MongoDB and Tiger Data. It is software only: no extra hardware, the tower beacon is drawn on screen. The Node server and deployed website are in `PRANAV`; the native iPhone app is in `ATHARV/ios`.

**Live site:** https://lancerhacks-rvs8r.ondigitalocean.app (deployed from `main` on DigitalOcean App Platform)

## The app

| Page | What it's for | Who can open it |
|---|---|---|
| `/` | Landing page: the 100-second film, how it works, demos, and the "Ask about SkySentry" chat | Everyone |
| `/account.html` | Sign up / sign in (Clerk), then pick an account type and enter an airport join code | Everyone |
| `/camera.html` | **Camera station.** Uses this device's camera (or **Upload a video**), detects birds and drones, and streams to the tower. On a laptop, a QR code opens it on a phone. | Camera accounts, admins; tower accounts only for demo clips |
| `/tower.html` | **Tower dashboard.** Live risk (also in the sidebar), camera feeds with the detector's boxes, map pins, spoken alerts, AI incident reports, hourly chart, beacon, and the assistant | Tower accounts, admins |
| `/demo.html` | Demo library: recorded bird and drone clips to run through the detector | Everyone; "Use this demo" works for any account |
| `/settings.html` | Account type, airport, profile and security (Clerk), switch-type requests, delete account, light/dark theme | Signed-in users (theme for everyone) |
| `/admin.html` | Create airports and join codes; approve or deny account-type switch requests | Admins |
| `/app.html` | Placeholder for the mobile app ("Still Under Progress") | Everyone |

### Accounts

- **Camera station** and **Tower dashboard** accounts belong to one airport. They join with that airport's code and only see their own side and airport. The sidebar's bottom-left Account tab shows the type.
- **Switching type** needs an admin: request it in Settings, or from a page your account can't open. The admin approves it on the admin page, and you keep your airport.
- **Admins** are set by email in `ADMIN_EMAILS`. They use both the camera and the tower without a join code; the tower has an airport picker to show one airport or all of them. Admins create airports and join codes.
- Without Clerk keys, sign-in is off. Cameras then use `CAMERA_API_KEY`, and the tower is open (or uses `TOWER_API_KEY`).

### How an alert travels

Camera (browser or iPhone app) → streams frames to the server → the server bot runs the detection engine (`VIVAN/detection`), or the camera or tower runs it if the server is busy → a yellow or red alert goes to the tower live. It's spoken with ElevenLabs (or the browser's voice), checked and written up by Gemini, stored in MongoDB (incidents) and Tiger Data (every detection, for the hourly chart), and drone reports are stamped on Solana devnet. Only a *new* alert becomes an incident; a camera's 2-second repeats don't.

## Run it locally

```bash
cd PRANAV
npm install
cp .env.example .env      # then fill in what you have; everything except CAMERA_API_KEY is optional
npm run dev               # http://localhost:8080 (or PORT)
npm test                  # server, auth, airports, switch requests, pipeline
```

On a Mac you can instead double-click **Restart SkySentry.command**; keep its terminal open while streaming. Phones need **https** to use their camera, so test phones against the live site.

Other scripts: `npm run db:setup` (create the Tiger Data table and hourly rollup), `npm run sync-web` (copy Vivan's detection engine and Atharv's film/site into `PRANAV/public`), `npm run record-film` (render the film to MP4).

## Settings (`PRANAV/.env` locally, encrypted env vars in DigitalOcean)

| Variable | What it does |
|---|---|
| `CAMERA_API_KEY` | **Required in production.** Key for cameras and scripts when not using sign-in. |
| `TOWER_API_KEY` | Optional key that opens the tower for every airport. |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Sign-in. On `*.ondigitalocean.app`, use the Clerk **Development** keys (`pk_test_` / `sk_test_`); production keys need a domain you own. |
| `ADMIN_EMAILS` | Comma-separated emails of admins (must be verified in Clerk). |
| `AIRPORT_CODES` | Fixed airports and join codes, e.g. `KPCT=pct-sky-4821`. Admins can add more on the admin page (saved in MongoDB). |
| `MONGODB_URI` | Incident reports, admin-created airports, switch requests. |
| `DATABASE_URL` | Tiger Data (TimescaleDB): every detection and the hourly chart. |
| `GEMINI_API_KEY` (`GEMINI_MODEL`, `GEMINI_BACKUP_MODEL`) | Snapshot checks and incident reports. Without it, reports use a template. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (`ELEVENLABS_MODEL`) | Spoken tower alerts. Without them, the browser's voice is used. |
| `OPENAI_API_KEY` (`OPENAI_MODEL`, `OPENAI_GUIDE_MODEL`) | Tower assistant and the landing-page chat. |
| `SOLANA_SECRET_KEY` (`SOLANA_RPC_URL`) | Devnet stamp on drone reports. |
| `SERVER_BOT`, `BOT_PRESET` | Server-side detection on streamed video (`on` by default). |
| `AIRPORT_NAME`, `SITE_URL`, `CORS_ORIGIN`, `PORT` | Display name, sitemap origin, allowed origins, port. |

**Check it's working:** `/health` shows each provider as `live`, `configured`, `failing (reason)` or a fallback. `/health/db` shows Tiger Data, MongoDB, Clerk and the airport count.

## Repo layout

| Folder | Owner | What's there |
|---|---|---|
| `PRANAV/` | Pranav | Express + Socket.IO server, website (`public/`), sign-in, admin, AI/voice/Solana pipeline (`ai-voice/`), tests. Notes in `PRANAV/PRANAV.md`, deploy steps in `PRANAV/OPERATIONS.md`. |
| `VIVAN/detection/` | Vivan | The detection engine (tracking, flocks, debris, drone hum, risk). Copied into `PRANAV/public/detection` by `npm run sync-web`. |
| `ATHARV/` | Atharv | The 3D film and landing-page source (`skysentry/`) and the iPhone camera app (`ios/`, see [its README](ATHARV/ios/README.md)). |
| `SHREYANSH/` | Shreyansh | The original AI, voice and Solana pipeline that `PRANAV/ai-voice` adapts. |
| `benchmarks/`, `testbench/`, `models/` | Vivan | Detection benchmarks; follow `benchmarks/BENCHMARK_PROTOCOL.md`. |

Team workflow (a branch and a PR per change, notes per person) is in `AI.md`.
