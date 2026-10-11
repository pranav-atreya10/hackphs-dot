// mock-server.js: a TEST STAND-IN for Pranav's server (PRANAV/server.js). Never deployed.
// It copies the parts of his server that matter to my pipeline:
//   - cameras connect to the /camera namespace with auth { key: CAMERA_API_KEY, cameraId }
//   - they send "camera:event"; the server adds id, cameraId, receivedAt and relays it to /tower
//   - then it calls handleEvent exactly as in the snippet I gave Pranav
// Usage, from inside SHREYANSH/:  node mock-server.js [port]     (default port 8080, like Pranav's)
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const config = require('./config');
const pipeline = require('./pipeline');

const PORT = Number(process.argv[2]) || 8080;
const server = http.createServer((req, res) => res.end('SkySentry mock server (test stand-in for PRANAV/server.js)\n'));
const io = new Server(server, { cors: { origin: '*' } });
const cameras = io.of('/camera');
const towers = io.of('/tower');

// Same idea as Pranav's camera key check. If no CAMERA_API_KEY is set, any camera may connect (test only).
cameras.use((socket, next) => {
  if (!config.CAMERA_API_KEY || socket.handshake.auth.key === config.CAMERA_API_KEY) return next();
  next(new Error('unauthorized'));
});

cameras.on('connection', socket => {
  const cameraId = socket.handshake.auth.cameraId || socket.id;
  console.log(`[mock] camera connected: ${cameraId}`);

  socket.on('camera:event', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!payload || typeof payload !== 'object') return reply({ ok: false, error: 'payload must be an object' });

    // Same stamping as Pranav's relayCameraEvent.
    const event = { ...payload, id: crypto.randomUUID(), cameraId: String(cameraId), receivedAt: Date.now() };
    towers.emit('camera:event', event);
    console.log(`[mock] camera:event ${event.type} x${event.object_count} ${event.risk} -> relayed to ${towers.sockets.size} tower(s)`);

    // The exact line from the snippet for Pranav (storeIncident replaced by a log line here).
    pipeline.handleEvent(event, towers, { onDone: r => console.log(`[mock] would save incident ${r.id.slice(0, 8)} to MongoDB`) });

    reply({ ok: true, id: event.id, towers: towers.sockets.size });
  });

  socket.on('disconnect', () => console.log(`[mock] camera disconnected: ${cameraId}`));
});

towers.on('connection', socket => console.log(`[mock] tower connected: ${socket.id}`));

server.listen(PORT, () => {
  console.log(`[mock] SkySentry mock server on http://localhost:${PORT}`);
  console.log(`[mock] camera key check: ${config.CAMERA_API_KEY ? 'on (CAMERA_API_KEY is set)' : 'off (CAMERA_API_KEY not set; any camera may connect)'}`);
});
