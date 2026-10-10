const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// DigitalOcean App Platform injects PORT; default to 8080 (its default http_port).
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
// Comma-separated list of allowed origins for cross-origin Socket.IO clients, or "*".
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",") },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Health check used by DigitalOcean to decide whether the app is up.
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), clients: io.engine.clientsCount });
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
  server.close(() => process.exit(0));
});
