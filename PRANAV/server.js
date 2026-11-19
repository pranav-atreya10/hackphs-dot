const path = require("path");
const http = require("http");
const { randomUUID } = require("node:crypto");
const { cameraIdentity, createCameraRegistry, isDeviceId, isJPEG, isLiveSource } = require("./camera-ingress");
const express = require("express");
const compression = require("compression");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const { createClerkClient, verifyToken } = require("@clerk/express");

// Load a local .env file if there is one (dev only; on DigitalOcean env vars come from the dashboard/app spec).
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {}

// Provider and bot modules read configuration as they load.
const { createPipeline } = require("./ai-voice/pipeline");
const { analyzeEvent, verifyBird, cloudEvidenceEnabled } = require("./ai-voice/ai");
const { buildAlertText, createRateLimit } = require("./ai-voice/voice");
const { createSolana } = require("./ai-voice/solana");
const { createEventJournal } = require("./durable-events");
const { createIncidentJob, createEnrichmentWorker, CAP: EVIDENCE_CAP } = require("./incident-enrichment");
const ledger = createSolana();
const ai = createPipeline({ solana: ledger });
const { createChat, createRequestLimit } = require("./ai-voice/chat");
const { createAirports, AirportError, parseEnv } = require("./airports");
const { accessConfig, createAccess, createSocketAccess, keyMatches } = require("./access");
const { airportFilter, hourlyPipeline } = require("./airport-history");
const { assignInitialRole, createRoleRequests, RequestError } = require("./role-requests");
const { localHourLabel } = require("./ai-voice/describe");
const { CameraBot, BOT_ENABLED, cropBirdReview } = require("./bot");
const { createBirdReview } = require("./bird-review");
const { siteOrigin, sitemapXml, robotsTxt } = require("./sitemap");

// DigitalOcean App Platform injects PORT; default to 8080 (its default http_port).
const PORT = process.env.PORT || 8080;
// Comma-separated list of allowed origins for cross-origin Socket.IO clients, or "*".
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
// Secret that cameras must present to send events. Required in production.
const CAMERA_API_KEY = process.env.CAMERA_API_KEY || "";
// Optional airport-bound dashboard credential.
const TOWER_API_KEY = process.env.TOWER_API_KEY || "";
// Clerk keys (dashboard.clerk.com → API keys). When set, people sign in as a "camera" or "dashboard" user.
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || "";
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || "";
// Join codes per airport, e.g. "KPCT=pct-sky-4821,KTTN=ttn-sky-9310". Signing up needs one of these codes,
// and each user only sees their own airport's alerts. Admins can add more airports on admin.html (saved in MongoDB).
const AIRPORT_CODES_ENV = process.env.AIRPORT_CODES || "";
const { demo } = accessConfig(process.env, parseEnv(AIRPORT_CODES_ENV));
const HOST = demo ? "127.0.0.1" : "0.0.0.0";
// Admin accounts, by verified email, e.g. "you@example.com,teammate@example.com". Admins create airports and
// join codes on admin.html and see every airport in the tower.
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
// MongoDB Atlas connection string. Everything is stored here: incident reports (with snapshots), every detection
// (for the hourly chart), bird verdicts, airports and account-switch requests.
const MONGODB_URI = process.env.MONGODB_URI || "";
// Detections are deleted automatically after this many days (keeps the Atlas free tier from filling up;
// the chart needs 24 h and the assistant looks back 7 days).
const DETECTION_DAYS = 8;

if (!MONGODB_URI) console.warn("MONGODB_URI is not set; incidents and detections will not be stored");

// The driver connects lazily and reconnects on its own, except that some failures (e.g. Atlas closing the
// connection because the caller's IP isn't allowed) close the client for good ("Topology is closed").
// withMongo then starts a fresh client, so fixing the cause doesn't need an app restart.
// A short server-selection timeout makes an unreachable cluster fail in 5s, before DigitalOcean's gateway gives up.
let mongo = null;
function newMongo() {
  mongo = new MongoClient(MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
  const mdb = mongo.db("skysentry");
  for (const name of ["incidents", "detections"]) {
    mdb.collection(name).createIndex({ airport: 1, time: -1 })
      .catch((err) => console.error(`failed to index ${name} by airport:`, err.message));
  }
  mdb.collection("incidents").createIndex({ time: -1 })
    .catch((err) => console.error("failed to index incidents:", err.message));
  mdb.collection("detections").createIndex({ time: 1 }, { expireAfterSeconds: DETECTION_DAYS * 86400 })
    .catch((err) => console.error("failed to index detections for expiration:", err.message));
  mdb.collection("detections").createIndex({ "enrichment.due_at": 1 }, { sparse: true })
    .catch((err) => console.error("failed to index incident enrichment:", err.code || err.name));
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
  setRole: async (userId, role, airport, transitionId) => {
    await clerk.users.updateUserMetadata(userId, { publicMetadata: { role, airport, transitionId } });
  },
  readRole: async (userId) => (await clerk.users.getUser(userId)).publicMetadata,
  revoke: (userId) => revokeSockets((grant) => grant.principal === userId),
});

// Cameras send loosely-typed JSON; bad values become NULL instead of failing the whole insert.
const toText = (v) => (typeof v === "string" && v ? v.slice(0, 100) : null);
const toNumber = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

// Persist one relayed event (columns per the team plan's event format; the snapshot is not stored here).
// Failures are logged, not thrown, so a DB outage never blocks the live relay.
// Without MONGODB_URI the last 24 h of detections are kept in memory, so the tower chart still works in a
// demo. With MongoDB configured, the "detections" collection is the source of truth.
const memDetections = [];
function rememberDetection(event) {
  memDetections.push({ airport: event.airport, t: Number(event.receivedAt) || Date.now(), type: toText(event.type), n: toNumber(event.object_count) || 0 });
  const cutoff = Date.now() - 24 * 3600_000;
  while (memDetections.length && (memDetections[0].t < cutoff || memDetections.length > 50_000)) memDetections.shift();
}
function memHourly(airport, hours = 24, type = null) {
  const buckets = new Map();
  for (const d of memDetections) {
    if (d.airport !== airport || !d.type || (type && d.type !== type) || d.t <= Date.now() - hours * 3600_000) continue;
    const hour = new Date(Math.floor(d.t / 3600_000) * 3600_000).toISOString();
    const key = hour + "|" + d.type, b = buckets.get(key) || { hour, type: d.type, events: 0, total_objects: 0 };
    b.events++; b.total_objects += d.n; buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.type.localeCompare(b.type));
}

// Every Gemini bird verdict is kept for the judges' audit trail in MongoDB (skysentry.bird_verdicts).
async function logBirdVerdict(v, airport) {
  const doc = { time: new Date(), airport, verdict: v.verdict, confidence: v.confidence, object: v.object, evidence: v.evidence, source: v.source, model: v.model || null };
  if (mongo) withMongo((mdb) => mdb.collection("bird_verdicts").insertOne(doc)).catch((err) => console.error("failed to store bird verdict:", err.message));
}

const journal = createEventJournal(MONGODB_URI ? withMongo : null);
const memIncidents = [];

const clerk = CLERK_SECRET_KEY ? createClerkClient({ secretKey: CLERK_SECRET_KEY, publishableKey: CLERK_PUBLISHABLE_KEY }) : null;
const ROLES = ["camera", "dashboard"];

if (!clerk) console.warn(`Clerk sign-in is off; unauthenticated tower access is ${demo ? "explicitly enabled for local development" : "disabled"}`);
else if (!ADMIN_EMAILS.size) console.warn("ADMIN_EMAILS is not set; nobody can open admin.html to create airports");

async function clerkSession(token) {
  const { sub, sid } = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
  if (!sub || !sid) throw new Error("Clerk session required");
  const session = await clerk.sessions.getSession(sid);
  if (session.status !== "active" || session.userId !== sub) throw new Error("inactive Clerk session");
  return sub;
}

async function clerkAccess(token) {
  if (!clerk || typeof token !== "string" || !token) return null;
  try {
    const epoch = socketAccessEpoch();
    const sub = await clerkSession(token);
    const user = await clerk.users.getUser(sub);
    const request = mongo && await withMongo((mdb) => mdb.collection("role_requests").findOne({ _id: sub }));
    if (epoch !== socketAccessEpoch() || request?.status === "applying" ||
        (request?.status === "approved" && request.transitionId && request.transitionId !== user.publicMetadata?.transitionId)) return null;
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
    return access;
  } catch {
    return null;
  }
}

const bearerToken = (req) => {
  const header = req.get("authorization");
  return header === undefined ? undefined : (header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null);
};

// Find the airport whose join code matches, comparing every code in constant time.
const airportForCode = (code) => airports.forJoinCode(code);

const { dashboardGrant, towerAccess, cameraAccess, view } = createAccess({
  airports, lookup: clerkAccess, cameraKey: CAMERA_API_KEY, cameraAirport: process.env.CAMERA_API_AIRPORT,
  towerKey: TOWER_API_KEY, towerAirport: process.env.TOWER_API_AIRPORT, demo,
});
const viewAirport = (req, requested) => view(req.towerGrant, requested === undefined ? req.get("x-airport") : requested);
async function requireDashboard(req, res, next) {
  const grant = await dashboardGrant(bearerToken(req), req.get("x-api-key"));
  if (!grant) return res.status(403).json({ error: "dashboard authorization required" });
  req.towerGrant = grant;
  req.airport = grant.airport;
  res.set("Cache-Control", "private, no-store");
  next();
}

function requireAirport(req, res, next) {
  const requested = [req.get("x-airport"), req.query.airport, req.body?.airport].filter((value) => value !== undefined);
  const airport = viewAirport(req, requested[0]);
  if (!airport || requested.some((value) => value !== airport)) return res.status(403).json({ error: "authorized airport required" });
  req.airport = airport;
  next();
}

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

const towerRoom = (airport) => `airport:${airport}`;
const unavailableTowers = { emit: () => false, get volatile() { return this; } };
const towersFor = (airport) => airports.has(airport) ? towers.to(towerRoom(airport)) : unavailableTowers;
const { revoke: revokeSockets, install: installSocketAccess, epoch: socketAccessEpoch } = createSocketAccess([cameras, towers]);

const { readSurveys, surveyedCorridor, sanitizeMetrics } = require("./corridor-calibration");
const surveyedCorridors = readSurveys(process.env.SURVEYED_CORRIDORS_JSON);
const retainIncidentEvidence = process.env.DURABLE_INCIDENT_EVIDENCE === "1";
const shouldAlert = createRateLimit();
const pendingReceipts = new Set();
const worker = createEnrichmentWorker({
  journal, analyze: analyzeEvent, stamp: ledger.stampReport, verify: ledger.verifyReport,
  imageUploadAllowed: () => cloudEvidenceEnabled,
  allowed: airport => airports.has(airport),
  reportError: (err, id) => console.warn(`incident ${id} enrichment failed:`, err.code || err.name),
  project: async (document, revision, fields, evidence) => {
    const { _id, airport, ...base } = document;
    const filter = { _id, ...airportFilter(airport) };
    const options = { writeConcern: { w: "majority", wtimeoutMS: 4000 } };
    const readOptions = { readConcern: { level: "majority" }, projection: { snapshot: 0 } };
    await withMongo(async mdb => {
      const collection = mdb.collection("incidents");
      if (revision === 1) {
        try {
          const result = await collection.insertOne({ ...base, _id, airport, revision, ...(evidence ?
            { snapshot: evidence.bytes, snapshot_sha256: evidence.sha256, snapshot_state: "stored" } : {}) }, options);
          if (!result.acknowledged) throw new Error("incident insert was not acknowledged");
        } catch (err) {
          if (err.code !== 11000 || !await collection.findOne(filter, readOptions)) throw err;
        }
      } else {
        const result = await collection.updateOne({ ...filter, revision: { $lt: revision } }, { $set: { ...fields, revision } }, options);
        if (!result.acknowledged || (!result.matchedCount && !await collection.findOne({ ...filter, revision: { $gte: revision } }, readOptions))) {
          throw new Error("cannot project incident revision");
        }
      }
      const incident = await collection.findOne(filter, readOptions);
      if (!incident) throw new Error("incident projection is not readable");
      towersFor(airport).emit("incident", { ...incident, persistence: "stored" });
    });
  },
});
let enrichmentRunning = false;
async function drainEnrichment() {
  if (!mongo || enrichmentRunning) return;
  enrichmentRunning = true;
  try { for (let i = 0; i < 12 && await worker.runOne(); i++) {} }
  catch (err) { console.warn("incident enrichment worker failed:", err.code || err.name); }
  finally { enrichmentRunning = false; }
}
if (MONGODB_URI) setInterval(drainEnrichment, 5000).unref();

function relayCameraEvent(cameraId, payload, airport, surveyId, detection) {
  if (!airports.has(airport)) return;
  const event = {
    ...sanitizeMetrics(payload, surveyId),
    id: randomUUID(),
    cameraId,
    airport,
    receivedAt: Date.now(),
  };
  const { snapshot, ...liveEvent } = event;
  const tower = towersFor(airport);
  tower.emit("camera:event", liveEvent);
  const incident = ["yellow", "red"].includes(event.risk) && ["bird", "drone", "unknown"].includes(event.type) && shouldAlert(event);
  const text = incident ? buildAlertText(event) : null;
  const alert = incident && event.risk === "red" ? { id: event.id, incident_id: event.id, airport,
    text, type: event.type, risk: event.risk, time: event.receivedAt } : null;
  const count = toNumber(event.flock_size || event.object_count);
  const record = { id: event.id, airport, receivedAt: event.receivedAt, cameraId, risk: event.risk,
    type: toText(event.type), direction: toText(event.direction), confidence: toNumber(event.confidence),
    object_count: count === null ? null : Math.round(count) };
  const document = incident ? {
    _id: event.id, airport, camera_id: cameraId, time: new Date(event.receivedAt), type: record.type, risk: record.risk,
    object_count: record.object_count, direction: record.direction, confidence: record.confidence,
    eta_seconds: event.eta_seconds, eta_basis: event.eta_basis, corridor_survey_id: event.corridor_survey_id,
    alert_text: text, report_state: "pending", snapshot_state: "unavailable", detection,
  } : null;
  const unavailable = () => {
    if (document) tower.emit("incident", { ...document, report_state: "unavailable", persistence: "unavailable" });
    if (alert) tower.emit("alert_pending", { ...alert, storage_failed: true });
  };
  if (!mongo) {
    rememberDetection(record);
    if (document) {
      const preview = { ...document, report_state: "unavailable", persistence: "unavailable", revision: 1 };
      memIncidents.unshift(preview);
      if (memIncidents.length > 50) memIncidents.pop();
      tower.emit("incident", preview);
    }
    if (alert) tower.emit("alert_pending", { ...alert, storage_failed: true });
    return;
  }
  if (alert) tower.emit("alert_pending", alert);
  if (pendingReceipts.size >= 64) {
    console.warn("detector receipt queue full; event not stored");
    unavailable();
    return;
  }
  const job = document && createIncidentJob(event, document, { retainEvidence: retainIncidentEvidence });
  if (job) tower.emit("incident", { ...job.incident, persistence: "pending" });
  pendingReceipts.add(event.id);
  async function persist(attempt) {
    try {
      const receipt = await journal.record(record, alert, job);
      pendingReceipts.delete(event.id);
      if (receipt.acknowledged) tower.emit("alert_acknowledged", { id: event.id, airport });
      if (receipt.alert) tower.emit("alert", receipt.alert);
      if (job) void drainEnrichment();
    } catch (err) {
      console.warn(`detector receipt ${event.id} failed:`, err.code || err.name);
      if (attempt < 5) setTimeout(() => void persist(attempt + 1), 500 * 2 ** attempt).unref();
      else {
        pendingReceipts.delete(event.id);
        unavailable();
      }
    }
  }
  void persist(0);
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
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      Vary: "Origin",
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));
// Gzip text responses (HTML/JS/CSS and the base64 *.json 3D assets shrink a lot). Socket.IO and
// binary camera frames are unaffected; already-compressed media (mp4/jpg) is skipped by the filter.
app.use(compression({ threshold: 1024 }));
// Heavy, rarely-changing files (3D assets, AI model weights, vendored libraries, clips) are cached
// by the browser for a week, so the second visit and the bird check load instantly. HTML and app JS
// revalidate every time so new deploys show up immediately.
const LONG_CACHE = /^\/(assets|ai-models|vendor|clips|promo|brand|detection\/models)\//;
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    const rel = "/" + path.relative(path.join(__dirname, "public"), filePath).split(path.sep).join("/");
    if (LONG_CACHE.test(rel)) res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
    else res.setHeader("Cache-Control", "no-cache");
  },
}));

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
  res.json({ publishableKey: clerk ? CLERK_PUBLISHABLE_KEY : null, demoTower: demo });
});

// Wrong-code attempts per user, so airport codes can't be brute-forced.
const joinFailures = new Map();
const MAX_JOIN_FAILURES = 10;
const JOIN_WINDOW_MS = 10 * 60_000;

// Finish sign-up: a signed-in user picks "camera" or "dashboard" and proves which airport they belong to.
// Body: { role, code }. Saves { role, airport } to the user's Clerk publicMetadata.
app.post("/api/auth/join", async (req, res) => {
  if (!clerk || !mongo) return res.status(503).json({ error: "account setup is not configured" });
  let userId;
  try {
    userId = await clerkSession(bearerToken(req));
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
    await assignInitialRole({
      collection: await withMongo((mdb) => mdb.collection("account_joins")),
      readRole: async (id) => (await clerk.users.getUser(id)).publicMetadata,
      writeRole: async (id, nextRole, nextAirport, joinId) => clerk.users.updateUserMetadata(id, {
        publicMetadata: { role: nextRole, airport: nextAirport, joinId },
      }),
    }, userId, role, airport);
    revokeSockets((grant) => grant.principal === userId);
  } catch (err) {
    if (err instanceof RequestError) return res.status(err.status).json({ error: err.message });
    console.error(`failed to save role for ${userId}:`, err.message);
    return res.status(502).json({ error: "could not save your role, try again" });
  }
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
  try { await roleRequests.cancel(access.userId, req.body?.revision); res.json({ ok: true }); } catch (err) { sendRequestError(res, err); }
});
app.get("/api/admin/role-requests", requireAdmin, async (req, res) => {
  try { res.json({ requests: await roleRequests.pending() }); } catch (err) { sendRequestError(res, err); }
});
app.post("/api/admin/role-requests/:id/:decision", requireAdmin, async (req, res) => {
  if (!["approve", "deny"].includes(req.params.decision)) return res.status(404).json({ error: "approve or deny" });
  try { res.json({ request: await roleRequests.decide(req.params.id, req.body?.revision, req.params.decision === "approve", req.userId) }); }
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
  try { await airports.remove(req.params.code); revokeSockets((grant) => grant.airport === req.params.code); res.json({ ok: true }); }
  catch (err) { sendAirportError(res, err); }
});

// Health check used by DigitalOcean to decide whether the app is up.
app.get("/health", (req, res) => {
  const { gemini } = ai.health();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    clients: io.engine.clientsCount,
    cameras: cameras.sockets.size,
    towers: towers.sockets.size,
    ai: { ...ai.status(), openai: chat.health().configured ? "configured" : "missing" },
    gemini: { state: gemini.state, failure: gemini.failure, lastSuccess: gemini.lastSuccess },
    bot: BOT_ENABLED ? "server video detector enabled (no drone audio)" : "server detector disabled",
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
  const mongodb = mongo ? await dbStatus(() => withMongo((mdb) => mdb.command({ ping: 1 }))) : "not configured";
  const clerkStatus = clerk ? await dbStatus(() => clerk.users.getCount()) : "not configured";
  res.json({ mongodb, clerk: clerkStatus, airports: airports.size });
});

// Hourly detection totals for the caller's airport for the last 24 hours.
app.get("/api/hourly", requireDashboard, requireAirport, async (req, res) => {
  if (!mongo) res.set("X-Data-Source", "memory (set MONGODB_URI for MongoDB Atlas)");
  try {
    res.json(await readHourly(req.airport, 24));
  } catch (err) {
    console.error("failed to read hourly detections:", err.message);
    res.status(500).json({ error: "query failed" });
  }
});

// Latest 20 incident reports, newest first (only the caller's airport for signed-in dashboards).
app.get("/api/incidents", requireDashboard, requireAirport, async (req, res) => {
  const { airport } = req;
  if (!mongo) {
    res.set("X-Data-Source", "memory (set MONGODB_URI for MongoDB Atlas)");
    return res.json(memIncidents.filter((d) => d.airport === airport).slice(0, 20).map(({ snapshot, ...metadata }) => metadata));
  }
  try {
    const filter = airportFilter(airport);
    res.json(await withMongo((mdb) => mdb.collection("incidents").find(filter, { projection: { snapshot: 0 } }).sort({ time: -1 }).limit(20).toArray()));
  } catch (err) {
    console.error("failed to read incidents:", err.message);
    res.status(500).json({ error: "query failed" });
  }
});

// Chart and both chat providers share the same scoped Mongo aggregation.
async function readHourly(airport, hours, type = null) {
  if (!airports.has(airport)) throw new Error("authorized airport required for hourly stats");
  if (!mongo) return memHourly(airport, hours, type);
  const pipeline = hourlyPipeline(airport, new Date(Date.now() - hours * 3600_000), type);
  return withMongo((mdb) => mdb.collection("detections").aggregate(pipeline).toArray());
}

app.get("/api/incidents/:id/snapshot", requireDashboard, requireAirport, async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  if (req.towerGrant?.principal === "local-demo") {
    return res.status(403).json({ error: "authenticated tower required" });
  }
  const { airport } = req;
  const { id } = req.params;
  if (!/^(?:[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}|[\da-f]{64})$/i.test(id)) {
    return res.status(404).json({ error: "snapshot unavailable" });
  }
  try {
    const doc = mongo
      ? await withMongo((mdb) => mdb.collection("incidents").findOne({ _id: id, ...airportFilter(airport) }, { projection: { _id: 0, snapshot: 1 } }))
      : memIncidents.find((d) => d._id === id && d.airport === airport);
    const snapshot = typeof doc?.snapshot === "string" && doc.snapshot.replace(/^data:image\/jpeg;base64,/i, "");
    if (!snapshot || snapshot.length > EVIDENCE_CAP * 4 / 3 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(snapshot)) {
      return res.status(404).json({ error: "snapshot unavailable" });
    }
    const image = Buffer.from(snapshot, "base64");
    if (image.length < 4 || image.length > EVIDENCE_CAP || image.toString("base64") !== snapshot ||
        image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) {
      return res.status(404).json({ error: "snapshot unavailable" });
    }
    res.set("X-Content-Type-Options", "nosniff").type("image/jpeg").send(image);
  } catch (err) {
    console.error("failed to read incident snapshot:", err.message);
    res.status(500).json({ error: "could not load snapshot" });
  }
});

// Incident fields the chatbot may see (never the snapshot), with times in airport local time.
const incidentSummary = (d) => ({
  id: d._id, time: localHourLabel(d.time, true), camera: d.camera_id, type: d.type, count: d.object_count,
  direction: d.direction, confidence: d.confidence, risk: d.risk, ai_label: d.gemini_label, report: d.report,
  eta_seconds: d.eta_basis === "image_space_corridor" ? d.eta_seconds : null,
  eta_basis: d.eta_basis === "image_space_corridor" ? d.eta_basis : null,
  solana: d.solana_status || (d.solana_tx ? "confirmed" : null),
  solana_url: d.solana_tx ? `https://explorer.solana.com/tx/${d.solana_tx}?cluster=devnet` : null,
});
const oneOf = (v, allowed) => (allowed.includes(v) ? v : null);
const clamp = (v, lo, hi, fallback) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

// Tools take their airport from the authorized request context, never model arguments.
const chatTools = {
  async get_hourly_stats({ hours, type } = {}, { airport }) {
    const rows = await readHourly(airport, clamp(hours, 1, 168, 24), oneOf(type, ["bird", "drone"]));
    return { note: "totals cover this airport", rows: rows.map((r) => ({ hour: localHourLabel(r.hour), type: r.type, events: Number(r.events) || 0, total_objects: Number(r.total_objects) || 0 })) };
  },
  async get_recent_incidents({ limit, risk, type } = {}, { airport }) {
    if (!mongo) return { error: "the incident store is not connected" };
    if (!airports.has(airport)) return { error: "authorized airport required" };
    const filter = airportFilter(airport);
    if (oneOf(risk, ["yellow", "red"])) filter.risk = risk;
    if (oneOf(type, ["bird", "drone", "unknown"])) filter.type = type;
    const docs = await withMongo((mdb) => mdb.collection("incidents").find(filter, { projection: { snapshot: 0 } }).sort({ time: -1 }).limit(clamp(limit, 1, 20, 10)).toArray());
    return { incidents: docs.map(incidentSummary) };
  },
  async get_incident({ id } = {}, { airport }) {
    if (!mongo) return { error: "the incident store is not connected" };
    if (typeof id !== "string" || !id || id.length > 100) return { error: "id must be an incident id" };
    if (!airports.has(airport)) return { error: "authorized airport required" };
    const doc = await withMongo((mdb) => mdb.collection("incidents").findOne({ _id: id, ...airportFilter(airport) }, { projection: { snapshot: 0 } }));
    return doc ? { incident: incidentSummary(doc) } : { error: "no incident with that id at this airport" };
  },
  async get_live_cameras(args, { airport }) {
    if (!airports.has(airport)) return { error: "authorized airport required" };
    const list = liveCameras.active().filter((live) => live.airport === airport).map((live) => {
      const st = live.bot.freshState(), bot = live.bot.status();
      return {
        camera: live.cameraId, last_frame_seconds_ago: Math.round((Date.now() - live.lastSeen) / 1000),
        detector: bot.mode === "server" ? "server video only (no drone audio)" : `${bot.mode} (${bot.reason})`,
        risk: st?.risk ?? "unknown", reasons: st?.reasons ?? [], learning_background: st?.learning ?? null, camera_shaking: st?.shake ?? null,
        main_track: st?.primary ?? null, tracks: st?.tracks?.length ?? 0, flocks: st?.flocks?.length ?? 0,
      };
    });
    return { cameras: list, note: list.length ? undefined : "no cameras are streaming right now" };
  },
};

// Gemini "Ask SkySentry" answers from the last 7 days of hourly stats; used when OpenAI is missing or fails.
async function geminiAnswer(question, { airport }) {
  const hourly = await readHourly(airport, 168);
  return (await ai.answerQuestion(question, hourly)).answer;
}
const chat = createChat({ tools: chatTools, fallback: geminiAnswer });
const guideLimit = createRequestLimit({ max: 10, windowMs: 60_000 });

// Tower copilot: { messages: [{role: "user"|"assistant", content}] } -> { answer, source, tools, incident_ids }.
app.post("/api/chat", requireDashboard, requireAirport, async (req, res) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "send messages: [{ role, content }]" });
  res.json(await chat.copilot(messages, { airport: req.airport }));
});

// Airports this tower can pick from (no join codes): just its own for a scoped account, every one otherwise.
app.get("/api/airports", requireDashboard, (req, res) => {
  const scoped = !req.towerGrant.selectAirport;
  const list = scoped ? [airports.get(req.airport)].filter(Boolean) : airports.all();
  res.json({ airports: list.map(({ code, name }) => ({ code, name })), scoped });
});

// "Ask SkySentry" (one question, kept for older clients): now the copilot, with Gemini as its fallback.
app.post("/api/ask", requireDashboard, requireAirport, async (req, res) => {
  const question = String(req.body?.question ?? "").trim().slice(0, 500);
  if (!question) return res.status(400).json({ error: "type a question first" });
  const { answer, source } = await chat.copilot([{ role: "user", content: question }], { airport: req.airport });
  res.json({ answer, source });
});

// Public website guide: open to everyone, so rate-limited per visitor (DigitalOcean passes the client IP).
app.post("/api/guide", async (req, res) => {
  if (!guideLimit(req.get("do-connecting-ip") || req.ip)) return res.status(429).json({ error: "too many questions; wait a minute" });
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "send messages: [{ role, content }]" });
  res.json(await chat.guide(messages));
});

// The tower requests advisory review of a server-observed track, never of caller-supplied pixels.
const birdJudgeLimit = createRequestLimit({ max: 30, windowMs: 60_000 });
const birdReview = createBirdReview({
  findLive: (cameraId, airport) => {
    const live = liveCameras.get(cameraId);
    if (live && live.airport === airport && liveCameras.fresh(live)) return live;
  },
  crop: cropBirdReview, verify: verifyBird,
});
app.get("/api/cloud-evidence-policy", requireDashboard, requireAirport, (_req, res) => {
  res.set("Cache-Control", "no-store").json({ cloudEvidenceEnabled });
});
app.post("/api/verify-bird", requireDashboard, requireAirport, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!clerk && !(TOWER_API_KEY && keyMatches(req.get("x-api-key"), TOWER_API_KEY)))
    return res.status(401).json({ status: "unavailable", reason: "authentication_required" });
  if (!cloudEvidenceEnabled) return res.json({ status: "unavailable", reason: "cloud_evidence_disabled" });
  if (!birdJudgeLimit(req.get("do-connecting-ip") || req.ip))
    return res.status(429).json({ status: "unavailable", reason: "rate_limited" });
  if (!isPlainObject(req.body) || Object.keys(req.body).some(key => !["cameraId", "streamId", "frameId", "trackId"].includes(key)))
    return res.status(400).json({ status: "unavailable", reason: "invalid_reference" });
  try {
    const verdict = await birdReview.review(req.body, req.airport);
    if (verdict.status === "verified") logBirdVerdict(verdict, verdict.evidenceRef.airport);
    res.json(verdict);
  } catch (error) {
    console.warn("Bird evidence review failed:", error.message);
    res.status(503).json({ status: "unavailable", reason: "review_failed" });
  }
});

// HTTP route for cameras that can't hold a socket open (scripts, microcontrollers, webhooks).
app.post("/api/camera-events", async (req, res) => {
  const bearer = bearerToken(req);
  const grant = await cameraAccess(req.get("x-api-key") || bearer, bearer, req.get("x-airport"));
  if (!grant) return res.status(403).json({ error: "airport-bound camera authorization required" });
  return res.status(403).json({ error: "live camera events require server detection; submit frames instead" });
});

// Socket auth: { token: <Clerk session token> } for camera accounts, or { key, airport } for API-key cameras.
installSocketAccess(cameras, ({ key, token, airport, deviceId }) =>
  isDeviceId(deviceId) ? cameraAccess(key, token, airport) : null);

cameras.on("connection", (socket) => {
  const { grant, airport } = socket.data;
  const cameraId = cameraIdentity(grant, "socket", socket.handshake.auth.deviceId);
  let live = null;
  let cameraConfig = null;
  const close = () => {
    if (live) liveCameras.remove(live);
    live = cameraConfig = null;
  };

  socket.on("camera:event", (_payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    reply({ ok: false, error: "live camera events require server detection" });
  });

  socket.on("camera:config", (config) => {
    if (!isPlainObject(config) || !isLiveSource(config.source)) return;
    cameraConfig = config;
    if (live && liveCameras.current(live)) configureLive(live, config);
  });
  socket.on("camera:frame", async (meta, jpegBuf, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!cameraConfig || !isPlainObject(meta) || !isLiveSource(meta.source) || !isJPEG(jpegBuf) ||
        !Number.isFinite(meta.t) || meta.t < 0) {
      return reply({ ok: false, error: "live camera configuration, capture time and JPEG required" });
    }
    if (live && live.lastSeen !== null && !liveCameras.fresh(live)) liveCameras.remove(live);
    const other = liveCameras.get(cameraId);
    if (other && other !== live) return reply({ ok: false, error: "device already has an active stream" });
    if (!live || !liveCameras.current(live)) {
      live = openLive(cameraId, airport, cameraConfig.cameraLabel, (name, data) => {
        if (name === "bot:state") socket.volatile.emit(name, data);
        else socket.emit(name, data);
      });
      configureLive(live, cameraConfig);
    }
    const stream = live;
    const result = await liveFrame(stream, jpegBuf, meta.t);
    reply(liveCameras.fresh(stream) ? { ok: true, ...result } : { ok: false, error: "stream stopped" });
  });
  socket.on("camera:stop", close);
  socket.on("disconnect", close);
});

installSocketAccess(towers, ({ key, token, airport }) => towerAccess(token, key, airport));

const liveCameras = createCameraRegistry({
  onStatus: (live, status) => towersFor(live.airport).emit("camera:status", status),
});
const cameraLabel = (label) => typeof label === "string" && /^[a-z0-9._ -]{1,60}$/i.test(label.trim()) ? label.trim() : "Camera";

// toCamera(name, data) sends bot results back to the streaming device (socket cameras); HTTP cameras read
// the latest state from the response instead.
function openLive(cameraId, airport, label, toCamera = () => {}) {
  const live = { cameraId, cameraLabel: cameraLabel(label), airport, streamId: randomUUID(), frameId: 0,
    config: { camera_id: cameraId }, toCamera, lastState: null, lastSeen: Date.now() };
  live.bot = new CameraBot({
    cameraId,
    onEvent: (ev, frame, state) => {
      if (!liveCameras.fresh(live) || frame.streamId !== live.streamId ||
          state !== live.bot.freshState() || state.t !== frame.t) return;
      relayCameraEvent(cameraId, { ...ev, cameraLabel: live.cameraLabel, source: "live" }, airport, live.config.surveyId,
        { streamId: frame.streamId, frameId: frame.frameId, generation: state.generation, t: frame.t });
    },
    onState: (state, frame) => {
      if (!liveCameras.fresh(live) || frame.streamId !== live.streamId || state.t !== frame.t) return;
      const { streamId, frameId } = frame;
      const result = { cameraId, cameraLabel: live.cameraLabel, streamId, frameId, state, mode: "server",
        at: Date.now(), remaining_ms: live.bot.remainingMs() };
      if (result.remaining_ms <= 0) return;
      live.lastState = state;
      if (cloudEvidenceEnabled) birdReview.record(live, frame, state);
      towersFor(airport).volatile.emit("bot:state", result);
      live.toCamera("bot:state", result);
    },
    onStatus: () => {
      if (!liveCameras.fresh(live)) return;
      const status = live.bot.status();
      if (status.mode !== "server") live.lastState = null;
      towersFor(airport).emit("bot:status", status);
      live.toCamera("bot:status", status);
    },
  });
  live.bot.configure(live.config);
  return liveCameras.add(live);
}
function configureLive(live, config) {
  if (!liveCameras.current(live) || !isPlainObject(config) || !isLiveSource(config.source)) return false;
  live.bot.invalidate("camera configuration changed");
  live.streamId = randomUUID(); live.frameId = 0; live.lastState = null;
  if (config.cameraLabel !== undefined) live.cameraLabel = cameraLabel(config.cameraLabel);
  const preset = [].concat(config.preset || []).filter((x) => typeof x === "string").slice(0, 3);
  const survey = surveyedCorridor(surveyedCorridors, live, config.camera, "webcam");
  live.config = { camera: config.camera, corridor: survey?.polygon || [], surveyId: survey?.surveyId,
    preset: preset.length ? preset : undefined, camera_id: live.cameraId };
  live.bot.configure(live.config);
  live.toCamera("camera:config", live.config);
  if (liveCameras.fresh(live)) towersFor(live.airport).emit("camera:config", { cameraId: live.cameraId, cameraLabel: live.cameraLabel, ...live.config });
  return true;
}
async function liveFrame(live, jpegBuf, t) {
  const wasFresh = liveCameras.fresh(live);
  if (!liveCameras.frame(live)) return null;
  if (!wasFresh) {
    towersFor(live.airport).emit("camera:config", { cameraId: live.cameraId, cameraLabel: live.cameraLabel, ...live.config });
    towersFor(live.airport).emit("bot:status", live.bot.status());
    live.toCamera("bot:status", live.bot.status());
  }
  const frame = { streamId: live.streamId, frameId: ++live.frameId, t, at: live.lastSeen, jpeg: jpegBuf };
  towersFor(live.airport).volatile.emit("camera:frame", { cameraId: live.cameraId, cameraLabel: live.cameraLabel, source: "live", ...frame });
  await live.bot.frame(jpegBuf, t, frame);
  const detector = live.bot.status();
  const state = live.bot.freshState();
  return {
    bot: detector.mode, detector, state, at: Date.now(), remaining_ms: live.bot.remainingMs(),
  };
}
setInterval(() => {
  for (const live of liveCameras.active()) live.bot.expire();
}, 500).unref();

// HTTP streaming for native apps (no Socket.IO library needed). Same auth as /api/camera-events.
//   POST /api/camera-config  JSON { source: "live", camera: {lat, lon, heading_deg, hfov_deg, pitch_deg} }
//   POST /api/camera-frame   body = one JPEG (Content-Type: image/jpeg), header x-frame-time = seconds
//   POST /api/camera-stop    closes only the matching live session
//   -> { ok, bot: "server"|"starting"|"unavailable", detector, state, at, remaining_ms }
async function httpCamera(req, res) {
  const bearer = bearerToken(req);
  const access = await cameraAccess(req.get("x-api-key") || bearer, bearer, req.get("x-airport"));
  if (!access) { res.status(403).json({ error: "airport-bound camera authorization required" }); return null; }
  const deviceId = req.get("x-camera-device"), session = req.get("x-camera-session");
  if (!isLiveSource(req.get("x-camera-source")) || !isDeviceId(deviceId) || !isDeviceId(session)) {
    res.status(400).json({ error: "live camera source, device ID and session ID required" });
    return null;
  }
  const cameraId = cameraIdentity(access, "http", deviceId);
  return { cameraId, airport: access.airport, session, live: liveCameras.get(cameraId) };
}
app.post("/api/camera-config", async (req, res) => {
  const ingress = await httpCamera(req, res); if (!ingress) return;
  if (!isPlainObject(req.body) || !isLiveSource(req.body.source)) return res.status(400).json({ error: "explicit live source required" });
  const { cameraId, airport, session } = ingress;
  if (ingress.live && ingress.live.session !== session) return res.status(409).json({ error: "device already has a configured stream" });
  const live = ingress.live?.session === session ? ingress.live : openLive(cameraId, airport, req.get("x-camera-id"));
  live.session = session;
  configureLive(live, req.body);
  res.json({ ok: true });
});
app.post("/api/camera-frame", express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: "900kb" }), async (req, res) => {
  const ingress = await httpCamera(req, res); if (!ingress) return;
  if (!isJPEG(req.body)) return res.status(400).json({ error: "send one JPEG frame as the request body" });
  const captureTime = req.get("x-frame-time");
  if (!captureTime?.trim() || !Number.isFinite(Number(captureTime)) || Number(captureTime) < 0)
    return res.status(400).json({ error: "valid x-frame-time required" });
  const { live, session } = ingress;
  if (!live || live.session !== session || (live.lastSeen !== null && !liveCameras.fresh(live))) {
    if (live?.session === session) liveCameras.remove(live);
    return res.status(409).json({ error: "configure the live camera before sending frames" });
  }
  const result = await liveFrame(live, req.body, Number(captureTime));
  if (!liveCameras.fresh(live)) return res.status(409).json({ error: "stream stopped" });
  res.json({ ok: true, ...result });
});
app.post("/api/camera-stop", async (req, res) => {
  const ingress = await httpCamera(req, res); if (!ingress) return;
  if (ingress.live?.session === ingress.session) liveCameras.remove(ingress.live);
  res.json({ ok: true });
});
setInterval(() => { liveCameras.sweep(); birdReview.prune(); }, 1000).unref();
const towerSees = (socket, live) => airports.has(socket.data.airport) && socket.data.airport === live.airport;

towers.on("connection", (socket) => {
  const { airport, principal } = socket.data;
  socket.join(towerRoom(airport));
  for (const live of liveCameras.active()) {
    if (!towerSees(socket, live)) continue;
    socket.emit("camera:status", liveCameras.presence(live));
    socket.emit("bot:status", live.bot.status());
    if (live.config) socket.emit("camera:config", { cameraId: live.cameraId, cameraLabel: live.cameraLabel, ...live.config });
  }

  socket.on("tower:label", (_payload, ack) => {
    if (typeof ack === "function") ack({ ok: false, reason: "tower labels cannot modify server detection" });
  });

  socket.on("tower:bot-event", (_ev, ack) => {
    if (typeof ack === "function") ack({ ok: false, reason: "tower fallback is not supported" });
  });
  const validAlertId = id => typeof id === "string" && /^(?:[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}|[\da-f]{64})$/i.test(id);
  socket.on("alert:replay", async (cursor, ack) => {
    if (typeof ack !== "function") return;
    if (!airports.has(airport) || (cursor !== null && !validAlertId(cursor))) return ack({ ok: false });
    try { ack({ ok: true, ...await journal.replay(airport, cursor) }); }
    catch (err) {
      console.warn("alert history unavailable:", err.code || err.name);
      ack({ ok: false });
    }
  });
  socket.on("alert:acknowledge", async (id, ack) => {
    if (typeof ack !== "function") return;
    if (!airports.has(airport) || !principal || principal === "local-demo" || !validAlertId(id)) return ack({ ok: false });
    try {
      const saved = await journal.acknowledge(airport, id, principal);
      if (!saved) return ack({ ok: false });
      towersFor(airport).emit("alert_acknowledged", { id, airport });
      ack({ ok: true });
    } catch (err) {
      console.warn("alert acknowledgment unavailable:", err.code || err.name);
      ack({ ok: false });
    }
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
