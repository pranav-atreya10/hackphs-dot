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
