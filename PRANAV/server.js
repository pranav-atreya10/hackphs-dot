const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const { MongoClient } = require("mongodb");
const { createClerkClient, verifyToken } = require("@clerk/express");
const ai = require("./ai");
const { CameraBot, BOT_ENABLED } = require("./bot");

// Load a local .env file if there is one (dev only; on DigitalOcean env vars come from the dashboard/app spec).
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {}

// DigitalOcean App Platform injects PORT; default to 8080 (its default http_port).
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
// Comma-separated list of allowed origins for cross-origin Socket.IO clients, or "*".
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
// Secret that cameras must present to send events. Required in production.
const CAMERA_API_KEY = process.env.CAMERA_API_KEY || "";
// Optional secret that tower dashboards must present to receive events. Unset = open.
const TOWER_API_KEY = process.env.TOWER_API_KEY || "";
// Clerk keys (dashboard.clerk.com → API keys). When set, people sign in as a "camera" or "dashboard" user.
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || "";
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || "";
// Join codes per airport, e.g. "KPCT=pct-sky-4821,KTTN=ttn-sky-9310". Signing up needs one of these codes,
// and each user only sees their own airport's alerts.
const AIRPORT_CODES = new Map(
  (process.env.AIRPORT_CODES || "")
    .split(",")
    .map((pair) => pair.split("=").map((s) => s.trim()))
    .filter(([airport, code]) => airport && code)
);
// Tiger Data (TimescaleDB) connection string, e.g. postgres://tsdbadmin:<pw>@<host>:<port>/tsdb?sslmode=require
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) console.warn("DATABASE_URL is not set; events will not be stored");

const db = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 5, connectionTimeoutMillis: 5000 }) : null;
// An idle client losing its connection emits on the pool; without a listener that crashes the process.
db?.on("error", (err) => console.error("postgres pool error:", err.message));

// MongoDB Atlas connection string; incident reports (with snapshots) are stored here.
const MONGODB_URI = process.env.MONGODB_URI || "";

if (!MONGODB_URI) console.warn("MONGODB_URI is not set; incidents will not be stored");

// The driver connects lazily and reconnects on its own, except that some failures (e.g. Atlas closing the
// connection because the caller's IP isn't allowed) close the client for good ("Topology is closed").
// withMongo then starts a fresh client, so fixing the cause doesn't need an app restart.
// A short server-selection timeout makes an unreachable cluster fail in 5s, before DigitalOcean's gateway gives up.
let mongo = null;
function newMongo() {
  mongo = new MongoClient(MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
  mongo.db("skysentry").collection("incidents").createIndex({ time: -1 })
    .catch((err) => console.error("failed to index incidents:", err.message));
}
if (MONGODB_URI) newMongo();

// Run fn(db), replacing the client once if it has closed for good.
async function withMongo(fn) {
  const client = mongo;
  try {
    return await fn(client.db("skysentry"));
  } catch (err) {
    if (err.name !== "MongoTopologyClosedError") throw err;
    if (mongo === client) newMongo();
    return fn(mongo.db("skysentry"));
  }
}

// Cameras send loosely-typed JSON; bad values become NULL instead of failing the whole insert.
const toText = (v) => (typeof v === "string" && v ? v.slice(0, 100) : null);
const toNumber = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

// Persist one relayed event (columns per the team plan's event format; the snapshot is not stored here).
// Failures are logged, not thrown, so a DB outage never blocks the live relay.
async function storeDetection(event) {
  if (!db) return;
  const count = toNumber(event.object_count);
  try {
    await db.query(
      `INSERT INTO detections (time, camera_id, type, object_count, direction, confidence, risk)
       VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7)`,
      [
        event.receivedAt,
        event.cameraId,
        toText(event.type),
        count === null ? null : Math.round(count),
        toText(event.direction),
        toNumber(event.confidence),
        toText(event.risk),
      ]
    );
  } catch (err) {
    console.error(`failed to store event ${event.id}:`, err.message);
  }
}

// Save a yellow/red event as an incident report (document shape per the team plan). The AI step fills
// gemini_label, report, and solana_tx later by updating the document with _id = event.id.
async function storeIncident(event) {
  if (!mongo) return;
  try {
    await withMongo((mdb) => mdb.collection("incidents").insertOne({
      _id: event.id,
      time: new Date(event.receivedAt),
      camera_id: event.cameraId,
      airport: event.airport,
      type: toText(event.type),
      object_count: toNumber(event.object_count),
      direction: toText(event.direction),
      confidence: toNumber(event.confidence),
      risk: event.risk,
      snapshot: typeof event.snapshot === "string" ? event.snapshot : null,
      gemini_label: null,
      report: null,
      solana_tx: null,
    }));
  } catch (err) {
    console.error(`failed to store incident ${event.id}:`, err.message);
  }
}

if (!CAMERA_API_KEY) {
  if (process.env.NODE_ENV === "production") {
    console.error("CAMERA_API_KEY is not set; refusing to start in production");
    process.exit(1);
  }
  console.warn("CAMERA_API_KEY is not set; all camera events will be rejected");
}

// Constant-time compare so the key can't be guessed one character at a time.
// Hashing first makes both buffers the same length, which timingSafeEqual requires.
function keyMatches(provided, expected) {
  if (!expected || typeof provided !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const clerk = CLERK_SECRET_KEY ? createClerkClient({ secretKey: CLERK_SECRET_KEY, publishableKey: CLERK_PUBLISHABLE_KEY }) : null;
const ROLES = ["camera", "dashboard"];

if (!clerk) console.warn("CLERK_SECRET_KEY is not set; sign-in is off (dashboards are open, cameras use CAMERA_API_KEY)");
else if (!AIRPORT_CODES.size) console.warn("AIRPORT_CODES is not set; nobody can finish signing up");

// Role and airport live in each Clerk user's publicMetadata, which only this server can write.
// Cached briefly so dashboards polling the API don't hit Clerk's rate limits.
const accessCache = new Map();
const ACCESS_TTL_MS = 60_000;

// Resolve a Clerk session token to { userId, role, airport }, or null if it isn't a valid signed-in session.
async function clerkAccess(token) {
  if (!clerk || typeof token !== "string" || !token) return null;
  try {
    const { sub } = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
    const hit = accessCache.get(sub);
    if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return hit.access;
    const { role, airport } = (await clerk.users.getUser(sub)).publicMetadata || {};
    const access = {
      userId: sub,
      role: ROLES.includes(role) ? role : null,
      airport: AIRPORT_CODES.has(airport) ? airport : null,
    };
    accessCache.set(sub, { at: Date.now(), access });
    return access;
  } catch {
    return null;
  }
}

const bearerToken = (req) => (req.get("authorization") || "").replace(/^Bearer\s+/i, "");

// Find the airport whose join code matches, comparing every code in constant time.
function airportForCode(code) {
  let match = null;
  for (const [airport, expected] of AIRPORT_CODES) if (keyMatches(code, expected)) match = airport;
  return match;
}

// Dashboard-only HTTP routes. With Clerk on, the caller needs a dashboard account (scoped to its airport)
// or TOWER_API_KEY in x-api-key (all airports). With Clerk off, they stay open as before.
async function requireDashboard(req, res, next) {
  if (!clerk) return next();
  if (TOWER_API_KEY && keyMatches(req.get("x-api-key"), TOWER_API_KEY)) return next();
  const access = await clerkAccess(bearerToken(req));
  if (!access) return res.status(401).json({ error: "sign-in required" });
  if (access.role !== "dashboard" || !access.airport) return res.status(403).json({ error: "dashboard account required" });
  req.airport = access.airport;
  next();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",") },
});

// Cameras publish on /camera; tower dashboards listen on /tower.
const cameras = io.of("/camera");
const towers = io.of("/tower");

// Towers join "airport:<code>" for their own airport, or "airport:*" (TOWER_API_KEY / sign-in off) to see all.
// An event with no airport (API-key camera without x-airport) goes to every tower.
const towersFor = (airport) => (airport ? towers.to([`airport:${airport}`, "airport:*"]) : towers);

// Stamp an incoming camera event and forward it to the tower dashboards for its airport.
function relayCameraEvent(cameraId, payload, airport = null) {
  const event = {
    ...payload,
    id: crypto.randomUUID(),
    cameraId: String(cameraId || payload.camera_id || payload.cameraId || "unknown"),
    airport,
    receivedAt: Date.now(),
  };
  towersFor(airport).emit("camera:event", event);
  storeDetection(event);
  if (event.risk === "yellow" || event.risk === "red") {
    // After the incident is stored, the AI step fills gemini_label/report/solana_tx and pushes the
    // finished report (and a spoken alert for red) to this airport's towers. See ai.js.
    storeIncident(event)
      .then(() => ai.processIncident(event, {
        save: (fields) => (mongo ? withMongo((mdb) => mdb.collection("incidents").updateOne({ _id: event.id }, { $set: fields })) : Promise.resolve()),
        emit: (name, data) => towersFor(airport).emit(name, data),
      }))
      .catch((err) => console.error(`AI step failed for ${event.id}:`, err.message));
  }
  return event;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The camera and tower pages may be served from another origin (e.g. Atharv's app), so allow them to call /api.
const allowedOrigins = CORS_ORIGIN === "*" ? null : CORS_ORIGIN.split(",");
app.use("/api", (req, res, next) => {
  const origin = req.get("origin");
  if (origin && (!allowedOrigins || allowedOrigins.includes(origin))) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, content-type, x-api-key, x-camera-id, x-airport",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      Vary: "Origin",
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// The publishable key is public by design; pages fetch it here so it lives in one .env.
app.get("/api/auth/config", (req, res) => {
  res.json({ publishableKey: clerk ? CLERK_PUBLISHABLE_KEY : null });
});

// Wrong-code attempts per user, so airport codes can't be brute-forced.
const joinFailures = new Map();
const MAX_JOIN_FAILURES = 10;
const JOIN_WINDOW_MS = 10 * 60_000;

// Finish sign-up: a signed-in user picks "camera" or "dashboard" and proves which airport they belong to.
// Body: { role, code }. Saves { role, airport } to the user's Clerk publicMetadata.
app.post("/api/auth/join", async (req, res) => {
  if (!clerk) return res.status(503).json({ error: "sign-in is not configured" });
  let userId;
  try {
    ({ sub: userId } = await verifyToken(bearerToken(req), { secretKey: CLERK_SECRET_KEY }));
  } catch {
    return res.status(401).json({ error: "sign-in required" });
  }
  const { role, code } = isPlainObject(req.body) ? req.body : {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: "role must be camera or dashboard" });

  const failures = (joinFailures.get(userId) || []).filter((t) => Date.now() - t < JOIN_WINDOW_MS);
  if (failures.length >= MAX_JOIN_FAILURES) return res.status(429).json({ error: "too many wrong codes, try again later" });
  const airport = airportForCode(typeof code === "string" ? code.trim() : "");
  if (!airport) {
    joinFailures.set(userId, [...failures, Date.now()]);
    return res.status(403).json({ error: "wrong airport code" });
  }
  joinFailures.delete(userId);

  try {
    await clerk.users.updateUserMetadata(userId, { publicMetadata: { role, airport } });
  } catch (err) {
    console.error(`failed to save role for ${userId}:`, err.message);
    return res.status(502).json({ error: "could not save your role, try again" });
  }
  accessCache.delete(userId);
  res.json({ role, airport });
});

// Who am I: lets a page check the signed-in user's role and airport before connecting.
app.get("/api/auth/me", async (req, res) => {
  const access = await clerkAccess(bearerToken(req));
  if (!access) return res.status(401).json({ error: "sign-in required" });
  res.json({ role: access.role, airport: access.airport });
});

// Health check used by DigitalOcean to decide whether the app is up.
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    clients: io.engine.clientsCount,
    cameras: cameras.sockets.size,
    towers: towers.sockets.size,
    ai: ai.status(),
    bot: BOT_ENABLED ? "server bot on" : "server bot off (towers detect)",
  });
});

// Live database check for debugging deploys: "ok", "not configured", or the driver's error (never the password).
// Kept off /health so a slow or broken database can't make DigitalOcean's health check restart the app.
async function dbStatus(check) {
  try {
    await check();
    return "ok";
  } catch (err) {
    return String(err.message).slice(0, 200);
  }
}

app.get("/health/db", async (req, res) => {
  const [tiger, mongodb] = await Promise.all([
    db ? dbStatus(() => db.query("SELECT 1")) : "not configured",
    mongo ? dbStatus(() => withMongo((mdb) => mdb.command({ ping: 1 }))) : "not configured",
  ]);
  const clerkStatus = clerk ? await dbStatus(() => clerk.users.getCount()) : "not configured";
  res.json({ tiger, mongodb, clerk: clerkStatus, airports: AIRPORT_CODES.size });
});

// Hourly detection rollups (the detections_hourly continuous aggregate) for the last 24 hours.
app.get("/api/hourly", requireDashboard, async (req, res) => {
  if (!db) return res.status(503).json({ error: "database not configured" });
  try {
    const { rows } = await db.query(
      "SELECT * FROM detections_hourly WHERE hour > now() - interval '24 hours' ORDER BY hour, type"
    );
    res.json(rows);
  } catch (err) {
    console.error("failed to read detections_hourly:", err.message);
    res.status(500).json({ error: "query failed" });
  }
});

// Latest 20 incident reports, newest first (only the caller's airport for signed-in dashboards).
app.get("/api/incidents", requireDashboard, async (req, res) => {
  if (!mongo) return res.status(503).json({ error: "incident store not configured" });
  try {
    const filter = req.airport ? { airport: req.airport } : {};
    res.json(await withMongo((mdb) => mdb.collection("incidents").find(filter).sort({ time: -1 }).limit(20).toArray()));
  } catch (err) {
    console.error("failed to read incidents:", err.message);
    res.status(500).json({ error: "query failed" });
  }
});

// "Ask SkySentry": answers a tower question from the last 7 days of hourly stats (Gemini when configured).
app.post("/api/ask", requireDashboard, async (req, res) => {
  const question = String(req.body?.question ?? "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "type a question first" });
  let hourly = [];
  if (db) {
    try {
      ({ rows: hourly } = await db.query("SELECT hour, type, events, total_objects FROM detections_hourly WHERE hour > now() - interval '7 days' ORDER BY hour"));
    } catch (err) {
      console.error("failed to read stats for /api/ask:", err.message);
    }
  }
  res.json(await ai.answerQuestion(question, hourly));
});

// HTTP route for cameras that can't hold a socket open (scripts, microcontrollers, webhooks).
// Auth: a signed-in camera account ("Authorization: Bearer <Clerk session token>"), or for scripts and
// microcontrollers "x-api-key: <CAMERA_API_KEY>" (or Bearer <CAMERA_API_KEY>) plus optional "x-airport: <code>".
// Returns the camera's airport (null = all towers), or undefined if not allowed.
async function cameraAirport(key, token, requestedAirport) {
  if (keyMatches(key, CAMERA_API_KEY)) return AIRPORT_CODES.has(requestedAirport) ? requestedAirport : null;
  const access = await clerkAccess(token);
  if (access?.role === "camera" && access.airport) return access.airport;
  return undefined;
}

app.post("/api/camera-events", async (req, res) => {
  const bearer = bearerToken(req);
  const airport = await cameraAirport(req.get("x-api-key") || bearer, bearer, req.get("x-airport"));
  if (airport === undefined) return res.status(401).json({ error: "camera sign-in or camera key required" });
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: "body must be a JSON object" });
  }
  const event = relayCameraEvent(req.get("x-camera-id"), req.body, airport);
  res.status(202).json({ ok: true, id: event.id, towers: towers.sockets.size });
});

// Socket auth: { token: <Clerk session token> } for camera accounts, or { key, airport } for API-key cameras.
cameras.use(async (socket, next) => {
  const { key, token, airport } = socket.handshake.auth;
  const allowed = await cameraAirport(key, token, airport);
  if (allowed === undefined) return next(new Error("unauthorized"));
  socket.data.airport = allowed;
  next();
});

cameras.on("connection", (socket) => {
  const cameraId = socket.handshake.auth.cameraId || socket.id;
  const { airport } = socket.data;
  console.log(`camera connected: ${cameraId}${airport ? ` (${airport})` : ""}`);
  towersFor(airport).emit("camera:status", { cameraId, airport, online: true, at: Date.now() });

  socket.on("camera:event", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!isPlainObject(payload)) return reply({ ok: false, error: "payload must be an object" });
    const event = relayCameraEvent(socket.handshake.auth.cameraId || payload.camera_id || cameraId, payload, airport);
    reply({ ok: true, id: event.id, towers: towers.sockets.size });
  });

  // Live video: the phone streams JPEG frames; the server bot runs Vivan's engine on them (bot.js) and
  // every tower at this airport gets the feed plus the bot's overlay. If the bot hands over, towers detect.
  const live = openLive(cameraId, airport, (name, data) => socket.emit(name, data));
  socket.on("camera:config", (config) => configureLive(live, config));
  socket.on("camera:frame", async (meta, jpegBuf, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!isPlainObject(meta) || !Buffer.isBuffer(jpegBuf) || jpegBuf.length > 900_000) return reply({ ok: false });
    reply({ ok: true, bot: await liveFrame(live, jpegBuf, meta.t) });
  });

  socket.on("disconnect", () => {
    console.log(`camera disconnected: ${cameraId}`);
    if (liveCameras.get(cameraId) === live) liveCameras.delete(cameraId);
    towersFor(airport).emit("camera:status", { cameraId, airport, online: false, at: Date.now() });
  });
});

// Socket auth: { token: <Clerk session token> } for dashboard accounts (their airport only),
// or { key: TOWER_API_KEY } to see every airport. With sign-in off and no TOWER_API_KEY, towers are open.
towers.use(async (socket, next) => {
  const { key, token } = socket.handshake.auth;
  socket.data.airport = null;
  if (TOWER_API_KEY && keyMatches(key, TOWER_API_KEY)) return next();
  if (clerk) {
    const access = await clerkAccess(token);
    if (access?.role === "dashboard" && access.airport) {
      socket.data.airport = access.airport;
      return next();
    }
    return next(new Error("unauthorized"));
  }
  if (!TOWER_API_KEY) return next();
  next(new Error("unauthorized"));
});

// Streaming cameras by id: their server bot, settings, and which tower (if any) is the fallback detector.
const liveCameras = new Map();

// toCamera(name, data) sends bot results back to the streaming device (socket cameras); HTTP cameras read
// the latest state from the response instead.
function openLive(cameraId, airport, toCamera = () => {}) {
  const old = liveCameras.get(cameraId);
  if (old && old.airport === airport) { old.toCamera = toCamera; return old; }
  const live = { cameraId, airport, config: null, fallbackOwner: null, fallbackAt: 0, toCamera, lastState: null, lastSeen: Date.now() };
  live.bot = new CameraBot({
    cameraId,
    onEvent: (ev) => relayCameraEvent(cameraId, ev, airport),
    onState: (state) => {
      live.lastState = state;
      towersFor(airport).emit("bot:state", { cameraId, state });   // small; not volatile, or it's dropped behind the frame
      live.toCamera("bot:state", { cameraId, state });
    },
    onStatus: () => { towersFor(airport).emit("bot:status", live.bot.status()); live.toCamera("bot:status", live.bot.status()); },
  });
  liveCameras.set(cameraId, live);
  towersFor(airport).emit("bot:status", live.bot.status());
  return live;
}
function configureLive(live, config) {
  if (!isPlainObject(config)) return false;
  live.config = { camera: config.camera, corridor: config.corridor, camera_id: live.cameraId };
  live.bot.configure(live.config);
  towersFor(live.airport).emit("camera:config", { cameraId: live.cameraId, ...live.config });
  return true;
}
async function liveFrame(live, jpegBuf, t) {
  live.lastSeen = Date.now();
  towersFor(live.airport).volatile.emit("camera:frame", { cameraId: live.cameraId, t, jpeg: jpegBuf });
  return (await live.bot.frame(jpegBuf, Number(t) || 0)) ? "server" : "tower";
}

// HTTP streaming for native apps (no Socket.IO library needed). Same auth as /api/camera-events.
//   POST /api/camera-config  JSON { camera: {lat, lon, heading_deg, hfov_deg}, corridor: [[x,y],...] }
//   POST /api/camera-frame   body = one JPEG (Content-Type: image/jpeg), header x-frame-time = seconds
//   -> { ok, bot: "server"|"tower", state }   state = the bot's latest tracks/flocks/risk for the app's overlay
async function httpCamera(req, res) {
  const bearer = bearerToken(req);
  const airport = await cameraAirport(req.get("x-api-key") || bearer, bearer, req.get("x-airport"));
  if (airport === undefined) { res.status(401).json({ error: "camera sign-in or camera key required" }); return null; }
  const cameraId = String(req.get("x-camera-id") || "phone").slice(0, 60);
  const fresh = !liveCameras.has(cameraId);
  const live = openLive(cameraId, airport);
  if (fresh) towersFor(airport).emit("camera:status", { cameraId, airport, online: true, at: Date.now() });
  return live;
}
app.post("/api/camera-config", async (req, res) => {
  const live = await httpCamera(req, res); if (!live) return;
  if (!configureLive(live, req.body)) return res.status(400).json({ error: "body must be a JSON object" });
  res.json({ ok: true });
});
app.post("/api/camera-frame", express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: "900kb" }), async (req, res) => {
  const live = await httpCamera(req, res); if (!live) return;
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: "send one JPEG frame as the request body" });
  const bot = await liveFrame(live, req.body, req.get("x-frame-time"));
  res.json({ ok: true, bot, state: live.lastState });
});
// HTTP cameras have no disconnect event; mark them offline after 10 s without frames.
setInterval(() => {
  for (const live of liveCameras.values()) {
    if (live.toCamera.length === 0 && Date.now() - live.lastSeen > 10_000) {
      liveCameras.delete(live.cameraId);
      towersFor(live.airport).emit("camera:status", { cameraId: live.cameraId, airport: live.airport, online: false, at: Date.now() });
    }
  }
}, 5000).unref();
const towerSees = (socket, live) => !socket.data.airport || !live.airport || live.airport === socket.data.airport;

towers.on("connection", (socket) => {
  socket.join(socket.data.airport ? `airport:${socket.data.airport}` : "airport:*");
  for (const live of liveCameras.values()) {
    if (!towerSees(socket, live)) continue;
    socket.emit("bot:status", live.bot.status());
    if (live.config) socket.emit("camera:config", { cameraId: live.cameraId, ...live.config });
  }

  // Fallback detection: when a camera's server bot has handed over, the first tower to report owns that
  // camera's events (others just draw), so alerts are never duplicated. Ownership lapses after 5 s of silence.
  socket.on("tower:bot-event", (ev, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const live = isPlainObject(ev) && liveCameras.get(String(ev.camera_id));
    if (!live || live.bot.active || !towerSees(socket, live)) return reply({ ok: false, reason: "server bot is active" });
    const now = Date.now();
    if (live.fallbackOwner && live.fallbackOwner !== socket.id && now - live.fallbackAt < 5000) return reply({ ok: false, reason: "another tower is detecting" });
    live.fallbackOwner = socket.id; live.fallbackAt = now;
    relayCameraEvent(live.cameraId, { ...ev, detected_by: "tower" }, live.airport);
    reply({ ok: true });
  });
  console.log(`tower connected: ${socket.id}${socket.data.airport ? ` (${socket.data.airport})` : ""}`);
  socket.on("disconnect", () => console.log(`tower disconnected: ${socket.id}`));
});

io.on("connection", (socket) => {
  console.log(`client connected: ${socket.id}`);
  io.emit("presence", { clients: io.engine.clientsCount });

  socket.on("message", (text) => {
    if (typeof text !== "string" || !text.trim()) return;
    io.emit("message", { id: socket.id, text: text.slice(0, 500), at: Date.now() });
  });

  socket.on("disconnect", () => {
    console.log(`client disconnected: ${socket.id}`);
    io.emit("presence", { clients: io.engine.clientsCount });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`server listening on http://${HOST}:${PORT}`);
});

// App Platform sends SIGTERM on redeploys; close cleanly.
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  io.close();
  server.close(async () => {
    await Promise.allSettled([db?.end(), mongo?.close()]);
    process.exit(0);
  });
});
