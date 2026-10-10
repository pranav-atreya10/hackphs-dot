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
