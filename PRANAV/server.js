const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const { MongoClient } = require("mongodb");
const { createClerkClient, verifyToken } = require("@clerk/express");

// Load a local .env file if there is one (dev only; on DigitalOcean env vars come from the dashboard/app spec).
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {}

// Provider and bot modules read configuration as they load.
const ai = require("./ai");
const { createChat, createRequestLimit } = require("./ai-voice/chat");
const { createAirports, AirportError } = require("./airports");
const { createRoleRequests, RequestError } = require("./role-requests");
const { localHourLabel } = require("./ai-voice/describe");
const { CameraBot, BOT_ENABLED } = require("./bot");
const { siteOrigin, sitemapXml, robotsTxt } = require("./sitemap");

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
// and each user only sees their own airport's alerts. Admins can add more airports on admin.html (saved in MongoDB).
const AIRPORT_CODES_ENV = process.env.AIRPORT_CODES || "";
// Admin accounts, by verified email, e.g. "you@example.com,teammate@example.com". Admins create airports and
// join codes on admin.html and see every airport in the tower.
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
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

// Airports + join codes: AIRPORT_CODES from the environment, plus the ones admins add (MongoDB "airports").
const airports = createAirports({
  env: AIRPORT_CODES_ENV,
  collection: async () => (mongo ? withMongo(async (mdb) => mdb.collection("airports")) : null),
  matches: keyMatches,
});
airports.load().catch((err) => console.error("failed to load airports from MongoDB:", err.message));

// Account-type switch requests (camera station <-> tower dashboard), approved by admins on admin.html.
const roleRequests = createRoleRequests({
  collection: async () => (mongo ? withMongo(async (mdb) => mdb.collection("role_requests")) : null),
  setRole: async (userId, role, airport) => {
    await clerk.users.updateUserMetadata(userId, { publicMetadata: { role, airport } });
    accessCache.delete(userId);
  },
});

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
else if (!ADMIN_EMAILS.size) console.warn("ADMIN_EMAILS is not set; nobody can open admin.html to create airports");

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
    const user = await clerk.users.getUser(sub);
    const { role, airport } = user.publicMetadata || {};
    const verified = (user.emailAddresses || []).filter((e) => e.verification?.status === "verified").map((e) => e.emailAddress.toLowerCase());
    const access = {
      userId: sub,
      role: ROLES.includes(role) ? role : null,
      airport: airports.has(airport) ? airport : null,
      admin: verified.some((e) => ADMIN_EMAILS.has(e)),
      email: user.primaryEmailAddress?.emailAddress || verified[0] || null,
      name: user.fullName || user.username || null,
    };
    accessCache.set(sub, { at: Date.now(), access });
    return access;
  } catch {
    return null;
  }
}

const bearerToken = (req) => (req.get("authorization") || "").replace(/^Bearer\s+/i, "");

// Find the airport whose join code matches, comparing every code in constant time.
const airportForCode = (code) => airports.forJoinCode(code);

// Dashboard-only HTTP routes. With Clerk on, the caller needs a dashboard account (scoped to its airport)
// or TOWER_API_KEY in x-api-key (all airports). With Clerk off, they stay open as before.
async function requireDashboard(req, res, next) {
  if (!clerk) return next();
  if (TOWER_API_KEY && keyMatches(req.get("x-api-key"), TOWER_API_KEY)) return next();
  const access = await clerkAccess(bearerToken(req));
  if (!access) return res.status(401).json({ error: "sign-in required" });
  if (access.admin) return next();   // admins see every airport, like TOWER_API_KEY
  if (access.role !== "dashboard" || !access.airport) return res.status(403).json({ error: "dashboard account required" });
  req.airport = access.airport;
  next();
}

// All-access towers (admins, TOWER_API_KEY, sign-in off) can narrow the view to one airport with the tower
// page's airport picker. Scoped dashboard accounts always see only their own airport.
const viewAirport = (req, requested) => req.airport || (typeof requested === "string" && airports.has(requested) ? requested : null);

// Admin-only routes (admin.html): a signed-in account whose verified email is in ADMIN_EMAILS.
async function requireAdmin(req, res, next) {
  if (!clerk) return res.status(503).json({ error: "sign-in is not configured" });
  const access = await clerkAccess(bearerToken(req));
  if (!access) return res.status(401).json({ error: "sign-in required" });
  if (!access.admin) return res.status(403).json({ error: "admin account required" });
  req.userId = access.userId;
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
    // Show warnings immediately. Persistence and provider work proceed without blocking the feed.
    // Only new alerts become incidents (the pipeline calls create); a camera's 2-second repeats of the same alert
    // used to be stored too, leaving dozens of incidents with no report.
    ai.processIncident(event, {
        create: () => storeIncident(event),
        save: async (fields) => {
          if (mongo) await withMongo((mdb) => mdb.collection("incidents").updateOne({ _id: event.id }, { $set: fields }));
        },
        emit: (name, data) => towersFor(airport).emit(name, data),
      })
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

// Search engines: sitemap.xml and robots.txt with absolute URLs for whatever domain is serving the site.
const SITE_BUILT = new Date().toISOString().slice(0, 10);
function originFor(req) {
  return siteOrigin({ siteUrl: process.env.SITE_URL, host: req.get("host"), forwardedProto: req.get("x-forwarded-proto"), protocol: req.protocol });
}
app.get("/sitemap.xml", (req, res) => {
  const origin = originFor(req);
  if (!origin) return res.sendStatus(400);
  res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(sitemapXml(origin, SITE_BUILT));
});
app.get("/robots.txt", (req, res) => {
  const origin = originFor(req);
  if (!origin) return res.sendStatus(400);
  res.type("text/plain").set("Cache-Control", "public, max-age=3600").send(robotsTxt(origin));
});

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
  res.json({ role: access.role, airport: access.airport, admin: access.admin, airportName: airports.get(access.airport)?.name ?? null });
});

// ---------- Account-type switch requests ----------
const sendRequestError = (res, err) => {
  if (err instanceof RequestError) return res.status(err.status).json({ error: err.message });
  console.error("role request failed:", err.message);
  res.status(500).json({ error: "could not save, try again" });
};
async function signedIn(req, res) {
  const access = await clerkAccess(bearerToken(req));
  if (!access) res.status(401).json({ error: "sign-in required" });
  return access;
}
// The signed-in user's latest request (or null). Body for POST: { to: "camera"|"dashboard", note? }.
app.get("/api/role-requests/mine", async (req, res) => {
  const access = await signedIn(req, res); if (!access) return;
  try { res.json({ request: await roleRequests.mine(access.userId) }); } catch (err) { sendRequestError(res, err); }
});
app.post("/api/role-requests", async (req, res) => {
  const access = await signedIn(req, res); if (!access) return;
  try { res.status(201).json({ request: await roleRequests.submit(access, isPlainObject(req.body) ? req.body : {}) }); }
  catch (err) { sendRequestError(res, err); }
});
app.delete("/api/role-requests/mine", async (req, res) => {
  const access = await signedIn(req, res); if (!access) return;
  try { await roleRequests.cancel(access.userId); res.json({ ok: true }); } catch (err) { sendRequestError(res, err); }
});
app.get("/api/admin/role-requests", requireAdmin, async (req, res) => {
  try { res.json({ requests: await roleRequests.pending() }); } catch (err) { sendRequestError(res, err); }
});
app.post("/api/admin/role-requests/:id/:decision", requireAdmin, async (req, res) => {
  if (!["approve", "deny"].includes(req.params.decision)) return res.status(404).json({ error: "approve or deny" });
  try { res.json({ request: await roleRequests.decide(req.params.id, req.params.decision === "approve", req.userId) }); }
  catch (err) { sendRequestError(res, err); }
});

// ---------- Admin: airports and join codes ----------
const sendAirportError = (res, err) => {
  if (err instanceof AirportError) return res.status(err.status).json({ error: err.message });
  console.error("airport admin failed:", err.message);
  res.status(500).json({ error: "could not save, try again" });
};
app.get("/api/admin/airports", requireAdmin, async (req, res) => {
  try { await airports.load(); } catch (err) { console.error("failed to reload airports:", err.message); }
  res.json({ airports: airports.all(), canSave: Boolean(mongo) });
});
app.post("/api/admin/airports", requireAdmin, async (req, res) => {
  try {
    const body = isPlainObject(req.body) ? req.body : {};
    res.status(201).json(await airports.create({ code: body.code, name: body.name, by: req.userId }));
  } catch (err) { sendAirportError(res, err); }
});
app.post("/api/admin/airports/:code/rotate", requireAdmin, async (req, res) => {
  try { res.json(await airports.rotate(req.params.code)); } catch (err) { sendAirportError(res, err); }
});
app.delete("/api/admin/airports/:code", requireAdmin, async (req, res) => {
  try { await airports.remove(req.params.code); accessCache.clear(); res.json({ ok: true }); }   // its users lose access right away
  catch (err) { sendAirportError(res, err); }
});

// Health check used by DigitalOcean to decide whether the app is up.
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    clients: io.engine.clientsCount,
    cameras: cameras.sockets.size,
    towers: towers.sockets.size,
    ai: { ...ai.status(), openai: chat.health().configured ? "configured" : "missing" },
    bot: BOT_ENABLED ? "server bot on" : "server bot off (towers detect)",
  });
});

app.get("/api/integrations", requireDashboard, (req, res) => res.json({ ...ai.health(), openai: chat.health() }));

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
  res.json({ tiger, mongodb, clerk: clerkStatus, airports: airports.size });
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
    const airport = viewAirport(req, req.query.airport);
    const filter = airport ? { airport } : {};
    res.json(await withMongo((mdb) => mdb.collection("incidents").find(filter).sort({ time: -1 }).limit(20).toArray()));
  } catch (err) {
    console.error("failed to read incidents:", err.message);
    res.status(500).json({ error: "query failed" });
  }
});

// Hourly detection totals for the last `hours` hours (optionally one type). Empty when Tiger Data isn't set up.
async function readHourly(hours, type = null) {
  if (!db) return [];
  const { rows } = await db.query(
    "SELECT hour, type, events, total_objects FROM detections_hourly WHERE hour > now() - make_interval(hours => $1) AND ($2::text IS NULL OR type = $2) ORDER BY hour",
    [hours, type]
  );
  return rows;
}

// Incident fields the chatbot may see (never the snapshot), with times in airport local time.
const incidentSummary = (d) => ({
  id: d._id, time: localHourLabel(d.time, true), camera: d.camera_id, type: d.type, count: d.object_count,
  direction: d.direction, confidence: d.confidence, risk: d.risk, ai_label: d.gemini_label, report: d.report,
  solana: d.solana_status || (d.solana_tx ? "confirmed" : null),
  solana_url: d.solana_tx ? `https://explorer.solana.com/tx/${d.solana_tx}?cluster=devnet` : null,
});
const oneOf = (v, allowed) => (allowed.includes(v) ? v : null);
const clamp = (v, lo, hi, fallback) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

// Tools the tower copilot can call (ai-voice/chat.js). Each one only sees the caller's airport
// (null = every airport, for TOWER_API_KEY or sign-in off), the same as /api/incidents and the socket rooms.
const chatTools = {
  async get_hourly_stats({ hours, type } = {}) {
    if (!db) return { error: "the detections database is not connected" };
    const rows = await readHourly(clamp(hours, 1, 168, 24), oneOf(type, ["bird", "drone"]));
    return { note: "totals cover every camera", rows: rows.map((r) => ({ hour: localHourLabel(r.hour), type: r.type, events: Number(r.events) || 0, total_objects: Number(r.total_objects) || 0 })) };
  },
  async get_recent_incidents({ limit, risk, type } = {}, { airport }) {
    if (!mongo) return { error: "the incident store is not connected" };
    const filter = { ...(airport ? { airport } : {}) };
    if (oneOf(risk, ["yellow", "red"])) filter.risk = risk;
    if (oneOf(type, ["bird", "drone", "unknown"])) filter.type = type;
    const docs = await withMongo((mdb) => mdb.collection("incidents").find(filter, { projection: { snapshot: 0 } }).sort({ time: -1 }).limit(clamp(limit, 1, 20, 10)).toArray());
    return { incidents: docs.map(incidentSummary) };
  },
  async get_incident({ id } = {}, { airport }) {
    if (!mongo) return { error: "the incident store is not connected" };
    if (typeof id !== "string" || !id || id.length > 100) return { error: "id must be an incident id" };
    const doc = await withMongo((mdb) => mdb.collection("incidents").findOne({ _id: id, ...(airport ? { airport } : {}) }, { projection: { snapshot: 0 } }));
    return doc ? { incident: incidentSummary(doc) } : { error: "no incident with that id at this airport" };
  },
  async get_live_cameras(args, { airport }) {
    const list = [...liveCameras.values()].filter((live) => !airport || live.airport === airport).map((live) => {
      const st = live.lastState, bot = live.bot.status();
      return {
        camera: live.cameraId, last_frame_seconds_ago: Math.round((Date.now() - live.lastSeen) / 1000),
        detector: bot.mode === "server" ? "server" : `tower fallback (${bot.reason})`,
        risk: st?.risk ?? "unknown", reasons: st?.reasons ?? [], learning_background: st?.learning ?? null, camera_shaking: st?.shake ?? null,
        main_track: st?.primary ?? null, tracks: st?.tracks?.length ?? 0, flocks: st?.flocks?.length ?? 0,
      };
    });
    return { cameras: list, note: list.length ? undefined : "no cameras are streaming right now" };
  },
};

// Gemini "Ask SkySentry" answers from the last 7 days of hourly stats; used when OpenAI is missing or fails.
async function geminiAnswer(question) {
  let hourly = [];
  try { hourly = await readHourly(168); }
  catch (err) { console.error("failed to read stats for the chat fallback:", err.message); }
  return (await ai.answerQuestion(question, hourly)).answer;
}
const chat = createChat({ tools: chatTools, fallback: geminiAnswer });
const guideLimit = createRequestLimit({ max: 10, windowMs: 60_000 });

// Tower copilot: { messages: [{role: "user"|"assistant", content}] } -> { answer, source, tools, incident_ids }.
app.post("/api/chat", requireDashboard, async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "send messages: [{ role, content }]" });
  res.json(await chat.copilot(messages, { airport: viewAirport(req, req.body?.airport) }));
});

// Airports this tower can pick from (no join codes): just its own for a scoped account, every one otherwise.
app.get("/api/airports", requireDashboard, (req, res) => {
  const list = req.airport ? [airports.get(req.airport)].filter(Boolean) : airports.all();
  res.json({ airports: list.map(({ code, name }) => ({ code, name })), scoped: Boolean(req.airport) });
});

// "Ask SkySentry" (one question, kept for older clients): now the copilot, with Gemini as its fallback.
app.post("/api/ask", requireDashboard, async (req, res) => {
  const question = String(req.body?.question ?? "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "type a question first" });
  const { answer, source } = await chat.copilot([{ role: "user", content: question }], { airport: req.airport ?? null });
  res.json({ answer, source });
});

// Public website guide: open to everyone, so rate-limited per visitor (DigitalOcean passes the client IP).
app.post("/api/guide", async (req, res) => {
  if (!guideLimit(req.get("do-connecting-ip") || req.ip)) return res.status(429).json({ error: "too many questions; wait a minute" });
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "send messages: [{ role, content }]" });
  res.json(await chat.guide(messages));
});

// HTTP route for cameras that can't hold a socket open (scripts, microcontrollers, webhooks).
// Auth: a signed-in camera account ("Authorization: Bearer <Clerk session token>"), or for scripts and
// microcontrollers "x-api-key: <CAMERA_API_KEY>" (or Bearer <CAMERA_API_KEY>) plus optional "x-airport: <code>".
// Returns the camera's airport (null = all towers), or undefined if not allowed.
async function cameraAirport(key, token, requestedAirport) {
  if (keyMatches(key, CAMERA_API_KEY)) return airports.has(requestedAirport) ? requestedAirport : null;
  const access = await clerkAccess(token);
  // Camera accounts, and tower accounts running a demo clip, send for their own airport.
  if ((access?.role === "camera" || access?.role === "dashboard") && access.airport) return access.airport;
  if (access?.admin) return airports.has(requestedAirport) ? requestedAirport : null;   // admins run a camera for any airport
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
    if (access?.admin) return next();   // admins watch every airport
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
  // Until the camera sends its own settings, assume the runway approach is the left 30% of the frame,
  // so the bot can judge "heading toward the runway" from the very first frame.
  const live = { cameraId, airport, config: { corridor: [[0, 0], [0.3, 0], [0.3, 1], [0, 1]], camera_id: cameraId }, fallbackOwner: null, fallbackAt: 0, toCamera, lastState: null, lastSeen: Date.now() };
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
  live.bot.configure(live.config);
  liveCameras.set(cameraId, live);
  towersFor(airport).emit("bot:status", live.bot.status());
  return live;
}
function configureLive(live, config) {
  if (!isPlainObject(config)) return false;
  const preset = [].concat(config.preset || []).filter((x) => typeof x === "string").slice(0, 3);
  live.config = { camera: config.camera, corridor: config.corridor, preset: preset.length ? preset : undefined, camera_id: live.cameraId };
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
  // An all-access tower that picked one airport (auth.airport) joins only that airport's room.
  const requested = socket.handshake.auth?.airport;
  if (!socket.data.airport && typeof requested === "string" && airports.has(requested)) socket.data.view = requested;
  const scope = socket.data.airport || socket.data.view;
  socket.join(scope ? `airport:${scope}` : "airport:*");
  for (const live of liveCameras.values()) {
    if (!towerSees(socket, live) || (socket.data.view && live.airport && live.airport !== socket.data.view)) continue;
    socket.emit("bot:status", live.bot.status());
    if (live.config) socket.emit("camera:config", { cameraId: live.cameraId, ...live.config });
  }

  // Trained checks run on tower crops; accept only fresh results for this airport's active tracks.
  let lastLabelAt = 0;
  const trackLabelsAt = new Map();
  socket.on("tower:label", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const live = isPlainObject(payload) && liveCameras.get(String(payload.cameraId));
    if (!live || !live.bot.active || !towerSees(socket, live)) return reply({ ok: false });
    const now = Date.now(), trackKey = `${live.cameraId}:${payload.trackId}`;
    if (now - lastLabelAt < 400 || now - (trackLabelsAt.get(trackKey) || 0) < 2000) return reply({ ok: false });
    if (!live.bot.applyLabel(payload)) return reply({ ok: false });
    lastLabelAt = now; trackLabelsAt.set(trackKey, now);
    // Keep this connection's bookkeeping bounded during long demos.
    for (const [id, at] of trackLabelsAt) if (now - at > 60000) trackLabelsAt.delete(id);
    reply({ ok: true });
  });

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
