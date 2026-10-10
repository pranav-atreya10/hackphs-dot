// Two stores, each doing what it is best at (build plan, "Why two databases?"):
//   Tiger Data  - the constant stream of small detection events and fast hourly charts
//   MongoDB     - the bigger, irregular incident reports with snapshots
// Without connection strings both fall back to in-memory stores with the same interface.
import { config } from './config.js';

/* ---------------- Tiger Data (detections) ---------------- */

class MemoryDetections {
  constructor() { this.rows = []; }
  async insert(e) { this.rows.push({ ...e, time: new Date(e.time) }); if (this.rows.length > 50_000) this.rows.shift(); }
  async hourly(hours = 24) {
    const since = Date.now() - hours * 3600e3, buckets = new Map();
    for (const r of this.rows) {
      if (r.time.getTime() < since) continue;
      const hour = new Date(Math.floor(r.time.getTime() / 3600e3) * 3600e3).toISOString();
      const key = hour + '|' + r.type;
      const b = buckets.get(key) ?? { hour, type: r.type, events: 0, total_objects: 0, red_events: 0, yellow_events: 0 };
      b.events++; b.total_objects += r.object_count;
      if (r.risk === 'red') b.red_events++; if (r.risk === 'yellow') b.yellow_events++;
      buckets.set(key, b);
    }
    return [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  }
  async close() {}
}

class TigerDetections {
  constructor(pool) { this.pool = pool; }
  async insert(e) {
    await this.pool.query(
      'INSERT INTO detections (time, camera_id, type, object_count, direction, confidence, risk) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [e.time, e.camera_id, e.type, e.object_count, e.direction, e.confidence, e.risk]);
  }
  async hourly(hours = 24) {
    const { rows } = await this.pool.query(
      `SELECT hour, type, events::int, total_objects::int, red_events::int, yellow_events::int
         FROM detections_hourly WHERE hour > now() - make_interval(hours => $1) ORDER BY hour`, [hours]);
    return rows.map(r => ({ ...r, hour: new Date(r.hour).toISOString() }));
  }
  async close() { await this.pool.end(); }
}

/* ---------------- MongoDB (incidents) ---------------- */

class MemoryIncidents {
  constructor() { this.docs = []; this.nextId = 1; }
  async insert(doc) { const d = { _id: String(this.nextId++), ...doc }; this.docs.push(d); return d._id; }
  async update(id, fields) { const d = this.docs.find(x => x._id === id); if (d) Object.assign(d, fields); }
  async latest(limit = 20) { return this.docs.slice(-limit).reverse().map(({ snapshot, ...d }) => ({ ...d, has_snapshot: !!snapshot })); }
  async get(id) { return this.docs.find(x => x._id === id) ?? null; }
  async close() {}
}

class MongoIncidents {
  constructor(client, ObjectId) { this.client = client; this.ObjectId = ObjectId; this.col = client.db(config.mongoDb).collection('incidents'); }
  async insert(doc) { const r = await this.col.insertOne({ ...doc, time: new Date(doc.time) }); return String(r.insertedId); }
  async update(id, fields) { await this.col.updateOne({ _id: new this.ObjectId(id) }, { $set: fields }); }
  async latest(limit = 20) {
    const docs = await this.col.find({}, { projection: { snapshot: 0 } }).sort({ time: -1 }).limit(limit).toArray();
    return docs.map(d => ({ ...d, _id: String(d._id), has_snapshot: true }));
  }
  async get(id) { const d = await this.col.findOne({ _id: new this.ObjectId(id) }); return d && { ...d, _id: String(d._id) }; }
  async close() { await this.client.close(); }
}

/* ---------------- factory ---------------- */

export async function openStores() {
  let detections = new MemoryDetections(), incidents = new MemoryIncidents();
  if (config.tigerUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.tigerUrl, ssl: { rejectUnauthorized: false }, max: 5 });
    await pool.query('SELECT 1');
    detections = new TigerDetections(pool);
  }
  if (config.mongoUri) {
    const { MongoClient, ObjectId } = await import('mongodb');
    const client = new MongoClient(config.mongoUri);
    await client.connect();
    incidents = new MongoIncidents(client, ObjectId);
  }
  return { detections, incidents, close: () => Promise.all([detections.close(), incidents.close()]) };
}
