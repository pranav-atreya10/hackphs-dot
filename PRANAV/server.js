const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { Pool } = require("pg");

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
// Tiger Data (TimescaleDB) connection string, e.g. postgres://tsdbadmin:<pw>@<host>:<port>/tsdb?sslmode=require
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) console.warn("DATABASE_URL is not set; events will not be stored");

const db = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 5 }) : null;
// An idle client losing its connection emits on the pool; without a listener that crashes the process.
db?.on("error", (err) => console.error("postgres pool error:", err.message));

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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",") },
});

// Cameras publish on /camera; tower dashboards listen on /tower.
const cameras = io.of("/camera");
const towers = io.of("/tower");

// Stamp an incoming camera event and forward it to every connected tower dashboard.
function relayCameraEvent(cameraId, payload) {
  const event = {
    ...payload,
    id: crypto.randomUUID(),
    cameraId: String(cameraId || payload.camera_id || payload.cameraId || "unknown"),
    receivedAt: Date.now(),
  };
  towers.emit("camera:event", event);
  storeDetection(event);
  return event;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Health check used by DigitalOcean to decide whether the app is up.
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    clients: io.engine.clientsCount,
    cameras: cameras.sockets.size,
    towers: towers.sockets.size,
  });
});

// Hourly detection rollups (the detections_hourly continuous aggregate) for the last 24 hours.
app.get("/api/hourly", async (req, res) => {
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

// HTTP route for cameras that can't hold a socket open (scripts, microcontrollers, webhooks).
// Auth: "Authorization: Bearer <CAMERA_API_KEY>" or "x-api-key: <CAMERA_API_KEY>".
app.post("/api/camera-events", (req, res) => {
  const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!keyMatches(req.get("x-api-key") || bearer, CAMERA_API_KEY)) {
    return res.status(401).json({ error: "invalid camera key" });
  }
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: "body must be a JSON object" });
  }
  const event = relayCameraEvent(req.get("x-camera-id"), req.body);
  res.status(202).json({ ok: true, id: event.id, towers: towers.sockets.size });
});

cameras.use((socket, next) => {
  if (keyMatches(socket.handshake.auth.key, CAMERA_API_KEY)) return next();
  next(new Error("unauthorized"));
});

cameras.on("connection", (socket) => {
  const cameraId = socket.handshake.auth.cameraId || socket.id;
  console.log(`camera connected: ${cameraId}`);
  towers.emit("camera:status", { cameraId, online: true, at: Date.now() });

  socket.on("camera:event", (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!isPlainObject(payload)) return reply({ ok: false, error: "payload must be an object" });
    const event = relayCameraEvent(socket.handshake.auth.cameraId || payload.camera_id || cameraId, payload);
    reply({ ok: true, id: event.id, towers: towers.sockets.size });
  });

  socket.on("disconnect", () => {
    console.log(`camera disconnected: ${cameraId}`);
    towers.emit("camera:status", { cameraId, online: false, at: Date.now() });
  });
});

towers.use((socket, next) => {
  if (!TOWER_API_KEY || keyMatches(socket.handshake.auth.key, TOWER_API_KEY)) return next();
  next(new Error("unauthorized"));
});

towers.on("connection", (socket) => {
  console.log(`tower connected: ${socket.id}`);
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
    await db?.end();
    process.exit(0);
  });
});
