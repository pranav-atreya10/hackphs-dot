This is the file for Pranav. Refer to AI.md for reference.

## Express + Socket.IO server (ready for DigitalOcean App Platform)

### What was built
A Node.js web server that serves normal HTTP pages (Express) and real-time, two-way messaging (Socket.IO) from the same port. It ships with a small chat demo page so you can see it working right away.

### Files
| File | What it does |
|------|--------------|
| `server.js` | The server. Creates an Express app, wraps it in an HTTP server, and attaches Socket.IO to that same server. |
| `public/index.html` | Demo page. Connects with Socket.IO, shows how many people are online, and lets you send messages everyone sees live. |
| `package.json` | Lists dependencies (`express`, `socket.io`) and the `start` / `dev` scripts. `engines` tells DigitalOcean to use Node 20+. |
| `.do/app.yaml` | DigitalOcean App Platform spec: tells DO where the code is (`source_dir: PRANAV`), how to build (`npm ci`), how to run (`npm start`), and which URL to health-check. |
| `.gitignore` | Keeps `node_modules/` and `.env` out of git. |

### How the server works
- **Port:** reads `process.env.PORT` (DigitalOcean sets this) and falls back to `8080`. It listens on `0.0.0.0` so it's reachable from outside the container.
- **`GET /health`:** returns `{ status: "ok", ... }`. DigitalOcean pings this to know the app is alive; if it fails, DO won't route traffic to it.
- **Static files:** anything in `public/` is served at `/`.
- **Socket events:**
  - `message` (client → server): a string. The server trims empty ones, caps length at 500 chars, and broadcasts it to everyone.
  - `message` (server → clients): `{ id, text, at }`.
  - `presence` (server → clients): `{ clients }`, the number of people connected; sent whenever someone joins or leaves.
- **CORS:** the `CORS_ORIGIN` env var controls which other websites may connect (default `*` = anyone). Set it to e.g. `https://myfrontend.com` once there's a separate frontend.
- **Graceful shutdown:** on `SIGTERM` (what DO sends during redeploys) it closes sockets and the server cleanly.

### Run it locally
```bash
cd PRANAV
npm install
npm run dev        # auto-restarts on file changes
# open http://localhost:8080 in two browser tabs and chat between them
```

### Deploy to DigitalOcean App Platform
Option A, dashboard: Create App → GitHub → `pranav-atreya10/hackphs-dot`, branch `main`, **Source directory `PRANAV`**. DO auto-detects Node, runs `npm start`, and should pick up port 8080. Set the health check path to `/health`.

Option B, CLI (uses the spec file):
```bash
doctl apps create --spec PRANAV/.do/app.yaml
```

WebSockets work on App Platform out of the box, so no extra config is needed. Because `deploy_on_push: true` is set, every push to `main` redeploys automatically.

### Tested
Started the server locally, confirmed `/health` returns ok, the demo page returns 200, and a Socket.IO client could connect, send `hello`, and receive it back.

### Possible next steps
- Scaling past 1 instance needs a shared adapter (e.g. `@socket.io/redis-adapter`) so messages reach clients on every instance.
- Add rooms (`socket.join(room)`) for per-team or per-game channels.

## Camera → Tower relay (API keys from env vars)

### What was built
Cameras send events to the server, and the server instantly forwards each one to **every connected tower dashboard**. Secrets (API keys) are never hard-coded. They're read from environment variables.

### New / changed files
| File | Change |
|------|--------|
| `server.js` | Added the `/camera` and `/tower` Socket.IO namespaces, the `POST /api/camera-events` HTTP route, API-key checks, and `.env` loading. The chat demo still works. |
| `public/tower.html` | A live tower dashboard: shows which cameras are online and every event as it arrives. Open `/tower.html` (or `/tower.html?key=<TOWER_API_KEY>` if a tower key is set). |
| `.env.example` | Template listing every env var. Copy it to `.env` for local dev (`.env` is git-ignored). |
| `.do/app.yaml` | Declares `CAMERA_API_KEY` and `TOWER_API_KEY` as encrypted secrets. Their values are set in the DO dashboard, never in git. |
| `package.json` | Node `>=20.12` (needed for `process.loadEnvFile`, which reads `.env`). |

### Environment variables
| Var | Required? | Purpose |
|-----|-----------|---------|
| `CAMERA_API_KEY` | Yes in production | Cameras must send this to publish events. If it's missing in production (`NODE_ENV=production`), the server **refuses to start**, so you can't accidentally deploy with no protection. Locally it just warns and rejects all camera events. |
| `TOWER_API_KEY` | Optional | If set, dashboards must send it to receive events. If empty, any dashboard can watch. |
| `CORS_ORIGIN` | Optional | Same as before. |
| `PORT` | Set by DO | Same as before. |

Keys are compared with a constant-time check (`crypto.timingSafeEqual`), so an attacker can't learn a key by timing the server's responses.

### How a camera sends an event
The event can be **any JSON object** (e.g. `{ "type": "motion", "zone": "A" }`). Before forwarding, the server adds:
- `id`: a unique id (a UUID)
- `cameraId`: which camera sent it
- `receivedAt`: server timestamp in ms

These three fields always come from the server, so a camera can't fake them.

**Option 1: Socket.IO (best for cameras that stay connected):**
```js
const { io } = require("socket.io-client");
const cam = io("https://<your-app>.ondigitalocean.app/camera", {
  auth: { key: process.env.CAMERA_API_KEY, cameraId: "gate-1" },
});
cam.emit("camera:event", { type: "motion" }, (ack) => console.log(ack));
// ack = { ok: true, id: "...", towers: <how many dashboards got it> }
```

**Option 2: HTTP POST (best for scripts, microcontrollers, webhooks):**
```bash
curl -X POST https://<your-app>.ondigitalocean.app/api/camera-events \
  -H "Authorization: Bearer $CAMERA_API_KEY" \
  -H "x-camera-id: lot-2" \
  -H "content-type: application/json" \
  -d '{"type":"plate","plate":"ABC123"}'
# → 202 { ok: true, id: "...", towers: 1 }   (401 if the key is wrong)
```
`x-api-key: <key>` works in place of the `Authorization` header.

### What tower dashboards receive
Connect to the `/tower` namespace (with `auth: { key }` if `TOWER_API_KEY` is set) and listen for:
- `camera:event`: the stamped event above.
- `camera:status`: `{ cameraId, online, at }` when a socket camera connects or disconnects.

`/health` now also reports how many `cameras` and `towers` are connected.

### Deploying the keys on DigitalOcean
App → Settings → `web` component → Environment Variables → add `CAMERA_API_KEY` (and `TOWER_API_KEY` if wanted), tick **Encrypt**, save. DO redeploys automatically. Generate a strong key with `openssl rand -hex 32`.

### Tested
Ran the server locally with keys set and checked that:
- a tower and a camera connect;
- the camera's Socket.IO event and an HTTP POST both reach the tower, with server-stamped fields (a fake `id` from the camera was overwritten);
- wrong camera/tower keys are rejected (`unauthorized` / HTTP 401);
- `/tower.html` is served and `.env` is loaded;
- `NODE_ENV=production` with no `CAMERA_API_KEY` exits with an error.

## Streaming and AI integration update
JPEG decoding now runs in native workers with a bounded latest-frame queue on Tower. Synthetic startup tests preserve empty-sky behavior and flock alerts; phone warmup uses eight frames. Six licensed H.264 demo excerpts and a gallery are available at /demo.html. Tower can optionally run a same-origin COCO-SSD bird verifier; stale labels are rejected. Alerts appear immediately while Shreyansh's report, speech and devnet stamp run in parallel. Restart instructions are in OPERATIONS.md. Performance numbers are synthetic processing measurements, not accuracy or field validation.

## Clerk sign-in and account security
Clerk JS v6 separates its prebuilt UI from its core bundle. Loading only the core caused the deployed login to fail with “Clerk was not loaded with Ui components.” The browser now loads the instance's Clerk UI bundle first and passes its constructor to Clerk.load. Script failures time out with a clear message. Camera and Tower show an Account security button for signed-in Clerk accounts, opening Clerk's user profile. API-key connections keep their existing behavior.

Validated the real sign-in form using the deployed public key on a local test page without submitting credentials. Three loader regressions and the full 52-test server suite pass. Authenticator enrollment requires enabling Authenticator application in the Clerk dashboard; adding the profile button does not enable or enforce MFA by itself.

## Solana transaction repair
Fixed a signing failure: the blockheight-aware web3 Transaction constructor requires `blockhash` rather than `recentBlockhash`. Memo fees are now estimated before submission. RPC deadlines cancel work and prevent late submission; rejected and expired transactions are shown as failed. Public report verification reads devnet without a private key and rejects missing or failed transactions and changed report text. The full 59-test suite passes, including real web3 signing/serialization and seven transaction regressions. A real deployed transaction must still be checked before claiming live-chain success.

## OpenAI chatbots: tower copilot + website guide
**Why:** the old "Ask SkySentry" box answered one question at a time and could only see hourly totals. Now the tower can hold a real conversation that also checks incident reports and the live cameras. The landing page also gets a chat bubble for visitors.

**What I built**
- `ai-voice/chat.js` is the chatbot brain. It talks to OpenAI's Responses API with plain `fetch` (no new package). The key stays on the server.
  - **Copilot** (`POST /api/chat`, tower sign-in required): the tower sends the whole chat so far, and the server keeps no memory. The model can call four **tools**, which the server runs. Each tool only sees *your* airport's data:
    - `get_hourly_stats`: Tiger Data hourly totals.
    - `get_recent_incidents` and `get_incident`: MongoDB reports. Snapshots are never sent to OpenAI.
    - `get_live_cameras`: what each streaming camera's bot sees right now (risk, learning, shaking, main track).
  - The model can loop "ask a tool, then read the result" up to 4 times within a 15-second budget. On the last round it must answer.
  - Its rules: answer only from tool data, be brief like a tower briefing, ignore instructions hidden in messages, and stay advisory only, never giving clearance.
  - **Fallback:** if there's no OpenAI key or OpenAI fails, it uses the old Gemini answer, then a polite canned message. The demo never breaks.
  - **Guide** (`POST /api/guide`, public): it has no tools and no airport data. It only knows a fixed fact sheet taken from the landing page. It's limited to 10 questions a minute per visitor so nobody can burn the key.
- `/api/ask` still works and now goes through the copilot.
- Tower page: the Ask card is now a chat. Little chips show what it checked ("checked incidents"), and clicking an incident chip opens that report. There's a "New chat" button.
- Landing page: `public/js/guide.js` is the "Ask about SkySentry" bubble. It lives in a Shadow DOM so its styles can't clash with the site, and `npm run sync-web` re-adds it automatically.
- Settings: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-5-mini`) and `OPENAI_GUIDE_MODEL` (default `gpt-5-nano`). They're in `.env.example` and `.do/app.yaml`. `/health` and `/api/integrations` show whether OpenAI is set up.

**Tested:** `test/chat.test.cjs` (9 tests, with OpenAI faked) covers:
- the tool loop runs with your airport;
- the loop always ends;
- the Gemini fallback and the canned reply;
- the key never shows up in errors;
- message cleaning;
- the guide has no tools;
- the rate limit.

**To turn it on:** add `OPENAI_API_KEY=sk-...` to `PRANAV/.env` (locally) or as an encrypted env var on DigitalOcean.

## Modern look: monochrome, light + dark, new shield-gull logo
**Why:** the old warm-paper, serif and clay look read as "old money". The new look follows the Gumloop references: white or near-black surfaces, one clean font (Geist), hairline borders, soft cards, and a left sidebar in the app.

**What changed**
- **Design system** (`public/css/app.css`): one set of color tokens with a light and a dark version. The UI is black and white only; color is kept for safety signals (risk green, yellow and red; detection boxes; map pins) so alerts stand out.
- **Light / dark** (`public/js/theme.js`): it follows the computer's setting by default. The monitor/sun/moon button cycles System → Light → Dark and remembers the choice in this browser. It loads in `<head>` so the page never flashes the wrong theme.
- **Sidebar shell** on Tower, Camera and Demos: logo, nav, a "Status" section (connection, cameras) and the account area at the bottom. Every element ID the scripts use (`conn`, `who`, `cams`, `sound`, `signout`, `accountSecurity`) is unchanged; only its location moved. On phones the sidebar becomes a top bar with a menu button.
- **Logo** (`public/brand/`): the shield-gull mark is inline in the UI so it takes the text color in both themes. There's an SVG favicon that switches with the theme, plus PNG fallbacks and an apple-touch-icon.
- **Tower:** the "Ask SkySentry" input is a composer box with a round send button. The chart reads its colors from the theme and recolors when the theme switches. Map tiles are dimmed in dark mode. The map no longer draws on top of the sign-in screen; this was an older bug where Leaflet's z-indexes leaked out.
- **Sign-in:** the card shows the logo. The Clerk sign-in box gets the page's colors, so it matches in dark mode.
- **Guide bubble** (`js/guide.js`): restyled to match, and it follows the page's theme.
- **Landing + film:** `index.html` and `film.html` are generated from Atharv's files by `npm run sync-web`, so I didn't hand-edit them. The sync script now adds the logo, favicon, theme script and Geist, and links `css/site.css` / `css/film.css` after Atharv's styles so they win. The 3D scene is unchanged. Inside the film, highlights stay amber because they sit behind navy text.
- **iOS app (Atharv's folder):** the app icon is now the white-on-black logo (1024px, no transparency, as iOS requires). AccentColor and LaunchBackground are black and white with dark-mode variants.

**Checked:** headless-Chrome screenshots of Tower, Camera, Demos, the landing page and the film in light and dark. Phone layouts were checked in a 390px frame. The theme button cycles correctly. The 69-test server suite passes. No detection code, models or thresholds were touched, so no benchmark run was needed.

## Scroll and entrance animations
**Landing page** (`css/site.css`):
- The hero text rises in, staggered, when the page loads.
- As you scroll:
  - sections, cards, facts, risk rows, timeline steps and FAQ items rise into place, with neighbors slightly staggered;
  - the film stage settles in from slightly smaller;
  - the hero drifts up and fades;
  - the top bar gains its edge and shadow;
  - a thin reading-progress line fills under it;
  - the risk-level dots pop in.

**App pages** (`css/app.css`):
- Cards rise in, staggered, on load.
- Demo clips rise in as you scroll.
- Opened panels slide in, and the "+" turns as it becomes "−".
- The status dot pulses while connected, and the sign-in card pops in.

**How:**
- The scroll effects use CSS scroll-driven animations (`animation-timeline: view()` / `scroll()`), with no JavaScript. Content that's already on screen is never hidden, and nothing can get stuck invisible.
- Browsers without support (Firefox today) show the page without the scroll effects.
- Everything is turned off for people who set "reduce motion".
- Only wrapper elements animate, so the Tower risk card's red flash still works.
- I scoped the top-bar rules to `header.bar` because the film also uses a `.bar` class for its progress segments.

**Checked:** headless-Chrome captures at the top of the page and scrolled to three depths, plus Tower after load. The 69-test suite passes. This is CSS only; no detection code was touched.

## Landing polish, alt text and sitemap
**Logo alignment:** the film's stylesheet has a global `.bar{display:flex}` that also hit the landing header. It shrink-wrapped the header row and centered it, so the logo started 118px to the right of the hero text. The header is now block layout, and the body's default 8px margin is gone. The logo, hero text, sections and the right edge all share one column.

**Less crowded:**
- The nav has 4 links (Film, How it works, Demos, FAQ) plus one "Open the tower" button. It replaces 7 links and the hackPHS chip.
- The hero has 2 buttons instead of 3.
- The "Live system" cards moved from right after the film to just before "Built with". Two 3-card rows no longer sit back to back.
- The tech labels in the cards are plain small text instead of boxed chips.
- Sections are about 50% further apart, with more padding inside cards, rows and the timeline.
- The film's own 3D scene is unchanged; these are `sync-web.mjs` and `css/site.css` changes.

**Alt text / accessibility:**
- Each Tower live feed is one labeled image ("Live video from camera …").
- The QR code has alt text.
- Demo videos are labeled with their title and what to expect.
- The camera view is labeled.
- Decorative icons are hidden from screen readers because the text beside them already says the same thing.
- Every page has a meta description.

**Sitemap:** `GET /sitemap.xml` and `GET /robots.txt` (`sitemap.js`, wired in `server.js`).
- The URLs must be absolute, so they use `SITE_URL` when set; otherwise they use the domain the request came in on, honoring DigitalOcean's https header.
- A forged Host header gets a 400.
- robots.txt keeps crawlers out of `/api/`.
- 5 new tests; the full suite is 74/74.
- Optional: set `SITE_URL=https://your-domain` once there's a custom domain.

## Sign up / sign in, "Get the app" and the hero buttons
**Top bar:** "Open the tower" is replaced by **Sign in** (text link) and **Sign up** (the highlighted button). Both go to the new `account.html`. On phones, the section links hide, but Sign in and Sign up stay visible.

**Hero:** two buttons. **Sign up** is the highlighted one; **Get the app** is the plain one and opens `app.html`. That page just says "Still Under Progress" and has a link back, and search engines are told not to index it. Sign up is highlighted because it leads to something that works today. The app page is a placeholder, and the main button shouldn't lead to a dead end. When the app ships, swap the two. "Watch the 100-second film" and "How it works" are gone from the hero: the film sits right below it, and both are in the top bar.

**How sign-up works (`account.html` + `js/account.js`):**
- It uses the same Clerk setup the camera and tower pages already use, and the same server endpoints (`/api/auth/config`, `/api/auth/me`, `/api/auth/join`). No server changes.
- `/account.html` shows Clerk's sign-up form. `/account.html?mode=sign-in` shows the sign-in form. Clerk's own "Already have an account?" links switch between them.
- After signing up, the person picks "Tower dashboard" or "Camera station" and enters their airport's join code. This is the same step as before; I moved it out of `signIn()` into `finishSetup()` in `js/auth.js` so both places share it.
- Once set up, the page shows the email, role and airport, plus buttons for Open the tower / Start the camera, Manage account and Sign out.
- If the server has no Clerk keys, the page says accounts aren't on yet and links to the tower and camera pages.
- Note: the production Clerk key only works on the DigitalOcean domain. On localhost the page shows "Could not load the sign-in service". That's expected.

**Where the changes live:** the landing page is generated, so the nav and hero edits are in `scripts/sync-web.mjs`, followed by `npm run sync-web`. Atharv's `site.html` is untouched. The link styling is in `css/site.css`. `test/auth-ui.test.cjs` now strips every `export` from `auth.js` before loading it, because `auth.js` exports more functions. 74/74 tests pass.

## Film → MP4 for YouTube
`npm run record-film` renders the 100-second 3D film (`/film.html`) into a 1080p, 30fps H.264 MP4. It also writes a matching `.srt` subtitle file. Both go to `~/Downloads/SkySentry-film.mp4` by default.

**How it works:** the film is live 3D, so screen-recording would drop frames. Instead, `scripts/record-film.mjs` does this:
- It drives the installed Chrome headlessly over the DevTools protocol, using Node's built-in WebSocket.
- It replaces the page's `performance.now` and `requestAnimationFrame` with a fake clock and steps it exactly 1/30 s per frame. Every frame is perfect, however slow the machine is.
- It shows only the stage, full-frame, with the captions burned in as subtitles.
- It streams JPEG frames into `scripts/mp4-encoder.swift`, a tiny macOS AVFoundation encoder that is compiled once and cached.

No ffmpeg or other downloads are needed.

**Options:**
- `--url` (default `http://localhost:8080/film.html`; the server must be running)
- `--out`, `--fps`, `--width`/`--height`, `--bitrate` (default 12 Mbps)
- `--no-captions` for a clean version
- `--faststart` for web-streaming layout; it needs twice the disk space and YouTube doesn't need it

It checks free disk space before starting and every second while rendering, and stops cleanly rather than filling the disk.

**On YouTube:** upload the MP4. Then go to Subtitles → Add language → Upload file → With timing, and pick the `.srt` for proper CC.

**Checked:** a full render produced a 102 s (100 s + 2 s hold), 1920×1080, 30fps H.264 file of about 150 MB with 23 timed captions. Frames from the opening, the alert journey and the close are correct and sharp.

## Account settings page, theme moved off the website
**No theme button on the website.** The landing page, `account.html` and `app.html` no longer have the light/dark button. The theme is now picked in Settings. The tower, camera and demo dashboards still have their sidebar button for now.

**Settings (`settings.html` + `js/settings.js`):**
- **Account:** name, email, role and airport.
  - A button opens the tower or camera page, or "Finish setting up" if the airport join code hasn't been entered yet.
  - **Profile and security** opens Clerk's account window: name, email, password, two-step verification, signed-in devices and deleting the account.
  - **Sign out** returns to the home page.
- **Appearance:** System / Light / Dark. It's saved in this browser, so it works even when signed out. `js/theme.js` now has `skysentryTheme.set(mode)` and `skysentryTheme.mode()` for this.
- Signed out: the page shows Sign in / Sign up buttons. Accounts off on the server: it says there's nothing to manage yet.

**Getting there:**
- After signing in or finishing sign-up, `account.html` sends you straight to Settings. The old "You're all set" card is gone.
- On the landing page, `js/nav-account.js` checks Clerk's `__client_uat` cookie. If someone is signed in, the top bar shows **Settings** in place of Sign in / Sign up. It doesn't load Clerk, so the landing page stays fast. If the cookie is out of date, Settings just asks you to sign in.

## Top bar: Dashboard button, smaller, with hover and press
- When someone is signed in, the top-right button says **Dashboard** instead of Settings. It opens the tower page, or the camera page for camera-station accounts. The settings page and the tower/camera sign-in remember the role in this browser (`skysentry.role`).
- The top-right button (Sign up / Dashboard) is smaller: 5px × 12px padding, 0.82rem text, 8px corners. A later `.btn-s` rule had been overriding its padding, so the rule is now `header.bar .bar-cta`.
- The gap is fixed: the negative margin that tucks Sign up next to Sign in now only applies when Sign in is there, so Dashboard no longer crowds "FAQ".
- **Hover and press:** every pill button (top bar and hero) lifts 1px with a soft shadow on hover and presses in (scaled to 96%) on click. The Sign in link dims when pressed. All of this is off for people who set "reduce motion".

## Camera page: hint no longer sits on top of the video
**What was wrong:** after you pressed Start, the grey "Point the camera at the sky…" hint stayed on top of the video. Its CSS (`display:grid`) beat the `hidden` attribute, so it never hid. The shaded orange box on the right had no label, so it wasn't clear what it was.

**Fixes (camera.html / js/camera.js, display only; detection untouched):**
- The hint hides once the camera starts (`#empty[hidden]{display:none}`).
- The shaded area is labeled **Runway corridor**. It's the runway approach zone: a bird or flock heading into it turns the risk red. You can redraw it under Settings → Draw runway corridor.
- In stream mode, the pill says "Waiting for the server bot…" until the first result comes back. Before, it said "Ready" while the camera was already running.
- Stop goes back to a clean black view with "Stopped. Press Start to go again." No frozen frame or corridor is left behind.

**Checked:** headless Chrome pressed Start and Stop on the synthetic sky in stream mode, with screenshots at each step. Tests: 74/74.

## Camera no longer gets stuck on "Waiting for the server bot…"
**What was wrong:** in stream mode, the camera only shows boxes and risk that the server's bot sends back. The bot steps aside when the server is too slow (over 60 ms per frame on average) or hits an error. After that it sends nothing back, and only an open tower screen analyses the feed. So with no tower open, the camera sat on "Waiting for the server bot…" with no boxes. Before the last fix, the pill said "Ready" in the same situation, which hid the problem.

**Fix (js/camera.js):** if the server bot hasn't sent anything for 3 seconds, the camera runs the same detector on the device. Boxes, the corridor and the risk pill all work, and the status line says "server bot not responding, so this device is checking" (with the reason when the server gives one). As soon as the bot sends results again, the camera switches back to them.

**Still true:** alerts (tower alarm, voice, reports) come from the server bot or a tower's fallback. The on-device check is display only, so the same alert is never sent twice. If the live server keeps handing over, check DigitalOcean's runtime logs for `server bot for … handed over to towers:`. The usual fix is a bigger instance.

**Checked:** headless Chrome on a local server with `SERVER_BOT=off` shows boxes and a red risk after 3 s. With the bot on, the server's results are used as before. Tests: 74/74.

## Clerk not loading, and an "Upload a video" button for the demo
**Why Clerk fails on the live site:** the site uses a *production* Clerk key (`pk_live_…`). Production Clerk loads from `clerk.<your domain>`, which needs DNS records on a domain you own. `lancerhacks-rvs8r.ondigitalocean.app` belongs to DigitalOcean, so `clerk.lancerhacks-rvs8r.ondigitalocean.app` doesn't exist and Clerk's script never loads. **Fix (no code):** in the Clerk dashboard, switch to the **Development** instance and copy its `pk_test_…` / `sk_test_…` keys into DigitalOcean's `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`. Development keys work on any domain. It's a separate set of users, so people sign up again and re-enter the airport join code. The other option is buying a domain and adding Clerk's DNS records.

**Fallback (js/auth.js):** if Clerk's script can't load, the camera page asks for the camera key (`CAMERA_API_KEY`) and the tower asks for the tower key (`TOWER_API_KEY`) instead of erroring out. The server already accepts these keys with sign-in on. The tower only works this way if `TOWER_API_KEY` is set in DigitalOcean.

**Upload a video (camera page):** a button next to Start. Pick a video on this computer and it plays through the detector right away. In stream mode it also goes to the tower like a live camera. It uses the same path as Settings → "Video file from this device"; the button just makes it one click. Sky-only footage works best: waves, grass or a moving ground make lots of false "unknown" boxes.

**Checked:** headless Chrome on a local server with the live (unreachable) Clerk key showed the camera-key panel and connected with the key. Uploading `clips/geese-beach.mp4` started streaming and showed detections. Tests: 74/74.

## Admin accounts: create airports and join codes
**Who is an admin:** any signed-in account whose *verified* email is in the server's `ADMIN_EMAILS` setting (comma-separated, set in DigitalOcean). Admin can't be picked at sign-up and isn't stored on the account, so nobody can make themselves one. Changing the setting takes effect on redeploy.

**Admin page (`admin.html` + `js/admin.js`):**
- Lists every airport with its join code (and a Copy button).
- **Add an airport:** code (3 to 5 letters or digits, e.g. KTTN) and a name. The server generates the join code, e.g. `kttn-4821-9310`.
- **New code:** replaces the join code, so the old one stops working for new sign-ups.
- **Delete:** removes the airport; everyone signed up to it loses access right away.
- Airports from `AIRPORT_CODES` are shown but marked "From server settings". Change those in DigitalOcean.
- Non-admins see "Admins only"; the server checks too (`/api/admin/*` returns 401/403).

**Server:**
- `airports.js` merges `AIRPORT_CODES` with the MongoDB `airports` collection.
- Sign-up join codes, camera keys and tower access all read from it, so a new airport works immediately, with no redeploy.
- Admins pass `requireDashboard` and the tower socket for every airport, like `TOWER_API_KEY`.
- `/api/auth/me` now also returns `admin` and `airportName`.

**Settings:**
- Admins see "Admin: Yes" and a **Manage airports** button.
- Everyone gets a **Delete my account** button (with a confirmation). It uses Clerk's account deletion, which needs "allow users to delete their accounts" left on in the Clerk dashboard (it's on by default).

**Checked:** 5 new unit tests for `airports.js` (create, join, new code, delete, env airports locked, MongoDB down); the full suite is 79/79. On a local server, `/api/admin/airports` refuses requests that aren't signed in (401), and admin.html shows only the sign-in prompt when signed out. The signed-in admin flow needs the real Clerk secret key, so test it on the live site after deploy.

## Tower: airport picker
**What:** a searchable **Airport** box in the tower sidebar, under Status. Type a code or name (e.g. `kttn`, or `trenton` for admin-created airports with names) and pick from the list, or choose "All airports". The page reconnects showing only that airport: live feeds, camera list, alerts and voice, map pins, incident reports and the assistant's answers. The choice goes in the URL (`tower.html?airport=KTTN`, so the link can be shared) and is remembered in this browser. The title shows "Tower · KTTN".

**Who gets it:**
- **Admins and tower-key users** (who see every airport) can pick any airport.
- **Regular tower accounts** see a locked box with their own airport, since they only ever see that one.

**Server:**
- `GET /api/airports` returns the airports this tower may pick from (codes and names, never join codes).
- An all-access tower that passes `airport` when it connects joins only that airport's room.
- `/api/incidents?airport=` and the chat's `airport` narrow the same way.
- Scoped accounts can't use any of this to see another airport: their own airport always wins.

**Limits:**
- The hourly chart still covers every airport, because the detections table has no airport column. The chart says so when an airport is picked.
- The map has no airport coordinates, so it starts at Princeton and centers on the picked airport's first camera once it reports.

**Checked:** headless Chrome on a local server with KPCT, KTTN and KEWR. With "All airports" the feed showed both a KPCT and a KTTN alert; with KTTN only the KTTN one; typing `kewr` switched to KEWR. Tests: 79/79.

## Each account type only sees its own side
**Camera accounts** (and camera-key devices) no longer see anything that leads to the tower: no **Tower** link in the sidebar of any page. **Tower accounts** no longer see the camera side: no **Camera** sidebar link, no "Add a phone camera" QR card on the tower, and no "Use this demo" buttons on the Demos page (those open the camera). **Admins, tower-key and open dashboards** still see both.

**How:**
- `showRoleLinks(role)` in `js/auth.js` hides every link to the other role's page.
- It runs as soon as a page loads, using the role this browser last signed in with, so nothing flashes. It runs again after sign-in with the real role.
- `signIn()` now returns `role` (`camera`, `dashboard`, `admin` or `null`).
- A global `[hidden]{display:none!important}` in `css/app.css` stops rules like `.side-nav a{display:flex}` from overriding `hidden`. The same bug caused the stuck camera hint and the admin panels.
- The camera's demo hint no longer says "open Tower".

**Switching account types:** not allowed. An account's type and airport are set once, with the join code. To use the other side, sign in with a different account.

**Checked:** headless Chrome. A camera-key session showed Home/Camera/Demos. An open dashboard showed all links plus the QR card. A tower account on Demos showed Home/Tower/Demos and 0 of 6 demo buttons; a camera account showed 6 of 6. Tests: 79/79.

## Admins: an Admin tab, and both camera and tower
**Admin tab:** admins get an **Admin** item in the sidebar on the Tower, Camera and Demos pages. It opens `admin.html`, which now also links to Camera. Other accounts never see it (`[data-admin-only]`, toggled by `showRoleLinks`).

**Both sides (mainly for the demo):** an admin can open the tower *and* the camera without a join code.
- **Tower:** every airport, with the airport picker, as before.
- **Camera:** the first time, it asks "Which airport is this camera at?" and lists the airports. The choice is remembered in this browser, and the camera's alerts go to that airport's tower. A **Change airport** button in the camera sidebar asks again.
- **Server:** `cameraAirport()` accepts a signed-in admin for whichever airport the camera sends (`auth.airport` on the socket, or `x-airport` over HTTP).
- An admin who also joined an airport as camera or tower uses that airport on that page instead.

Everyone else still has exactly one account type (no switching).

**Checked:** headless Chrome. The Demos sidebar shows Home/Tower/Camera/Demos/Admin for admins, Home/Tower/Demos for tower accounts and Home/Camera/Demos for camera accounts. Tests: 79/79. The signed-in admin camera flow needs the live Clerk secret key, so check it on the deployed site.

## Account type shown everywhere, an Account tab, and switch requests
**Account tab (bottom left):** on the Tower, Camera and Demos pages, the sidebar footer is a clickable **Account** tab. It shows the account type in bold (Camera station, Tower dashboard, Admin, Camera station (key), Tower (key) or Open dashboard) and, under it, the airport. It opens Settings. The Demos page has no sign-in, so it shows the last account used in this browser.

**Settings:** an **Account type** badge at the top of the Account panel ("Camera station", "Tower dashboard", "Admin", or "Admin · Tower dashboard" for an admin who also joined an airport).

**Switching account type (asking an admin):**
- *User:* Settings → "Switch account type": an optional note, then **Request switch**. It then shows "Waiting for an admin" with **Cancel request**. A declined or approved request is mentioned the next time.
- *Wrong page:* opening a page your account can't use (e.g. a camera account on the tower) says "This page is for tower dashboard accounts" and shows your type. It offers **Open the camera**, **Request a switch to Tower dashboard**, Account settings and Sign out.
- *Admin:* the **Admin** sidebar tab shows a red count of waiting requests. `admin.html` has a **Switch requests** list at the top with each person's name and email, airport, from → to, note and age, and **Approve** / **Deny** buttons. Approving changes their role right away and keeps their airport.
- *Server:* `role-requests.js` stores one request per user in MongoDB (`role_requests`). Routes: `POST /api/role-requests`, `GET` and `DELETE /api/role-requests/mine`, `GET /api/admin/role-requests`, and `POST /api/admin/role-requests/:id/approve|deny`. Approving writes the new role to Clerk and clears the access cache.

**Removed:** the sidebar "Account security" button. Settings → Profile and security does the same.

**Checked:**
- 4 new unit tests for `role-requests.js` (approve keeps the airport, deny, can't decide twice, bad requests, cancel, MongoDB down); the full suite is 83/83.
- Headless Chrome: the account tab shows the right type on camera (camera key), tower (open) and Demos, and the camera, tower, Demos, settings, admin and account pages have no script errors.
- Not testable locally: the signed-in screens (request, wrong page, admin approve), which need the live Clerk secret key. Check them after deploy.

## Sidebar on the Admin and Settings pages
`admin.html` and `settings.html` now use the same sidebar as Tower and Camera: Home, Tower, Camera, Demos and Admin (admins only), with the Account tab at the bottom left. You can always get back to the dashboard. The current page is highlighted: **Admin** on the admin page, the **Account tab** on Settings. The sidebar's theme button and tower-only parts (status, airport picker, alert sound) are left out, because Settings has Appearance. On phones the sidebar folds into the menu button, like the other pages.

**Fix:** signed out, the Account tab used to keep showing the last account used in this browser (e.g. "Admin"). Now signing out, deleting the account, or opening Settings or Admin signed out clears it (`forgetAccount()` in `js/auth.js`): the tab says "Not signed in" and the Admin tab hides.

**Checked:** headless Chrome. On Admin the sidebar shows Home/Tower/Camera/Demos/Admin with Admin highlighted; signed out, both pages show "Not signed in" and no Admin tab, with no script errors. Tests: 83/83.

## Camera page QR code, and demos for every account
**QR code:** on a laptop, the camera page shows a "Use a phone as this camera" card with a QR code for `/camera.html`. Scan it with a phone, sign in, point it at the sky and press Start. Phones don't show the card (they already are the camera). The QR never contains a camera key.

**Demos for every account:** tower accounts can now run demos. On the Demos page, "Use this demo" shows for every account (`data-any-role` exempts it from `showRoleLinks`). It opens the camera page in demo mode (`?demo=`), where a tower account is let in and its alerts go to its own airport's tower. The "Use my camera" button still hides for tower accounts, and the camera page without `?demo` still sends them to the switch-request screen. Server: `cameraAirport()` accepts tower accounts for their own airport.

**Checked:** headless Chrome. The camera page shows the QR card with no script errors. The Demos page as a tower account shows 6 of 6 demo buttons and no "Use my camera". Tests: 83/83. The signed-in tower-account demo needs the live Clerk key, so check it after deploy.

## Fix: blank "Use this demo" buttons
In the "demos for every account" change I put a `// comment` partway through a line of `demo.js`. JavaScript treats everything after `//` as comment, so it commented out the rest of the line: each button's link and its "Use this demo →" text. The buttons showed as empty white bars and went nowhere. The comment now sits on its own line. I also scanned every file I'd edited for the same mistake and found no others. **Checked:** the button reads "Use this demo →" and links to `/camera.html?demo=gulls-sky.mp4`. Tests: 83/83.

## Fix: incident reports (empty duplicates, and seeing why Gemini fails)
**What was wrong (from the live MongoDB data):** 75 incidents, all real (Demo Airport, ATR), from testing. 53 had no report at all, and the other 22 used the template report even though 21 of them had snapshots.
- **No report:** while birds are in view, a camera repeats its yellow/red alert every 2 seconds, and *every* repeat was saved as a new incident. Reports and voice alerts are rate-limited (12 s per camera and type, unless the risk goes up), so only the first got a report and the rest stayed empty.
- **Template instead of Gemini:** Gemini calls were failing, but `/health` only said "configured" (that just means a key is set). The reason was only in DigitalOcean's logs.

**Fixes:**
- Only a new alert becomes an incident: the first one, or one where the risk goes up. `processIncident` now calls a `create` step after the rate limit, and the server stores the incident there instead of on every event. Every event still goes to the live feed, Tiger Data and the charts; only the incident list is deduplicated. Every stored incident now gets a report.
- `/health` now shows Gemini as `live`, `configured` (key set, not used yet), or `failing (<model>: <reason>)` after a failed call. `ai.js` keeps the last error and success; keys are redacted.

**Not changed:** the 53 old empty incidents are still in MongoDB.

**Checked:** 2 new tests (repeats aren't stored and an escalation is; health shows a failing Gemini); the suite is 85/85. On a local server (with MongoDB off, so real data wasn't touched), 3 repeated yellow alerts and a red one showed 4 rows in the live feed but 2 incidents (yellow, then red), both with reports.
