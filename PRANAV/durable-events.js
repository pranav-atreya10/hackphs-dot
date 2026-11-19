const { randomUUID } = require('node:crypto');
const { airportFilter } = require('./airport-history');

const durable = { writeConcern: { w: 'majority', wtimeoutMS: 4000 } };
const majority = { readConcern: { level: 'majority' } };
const probeId = 'skysentry:readiness:v1';

async function checkReceiptStorage(db, retentionSeconds) {
  const detections = db.collection('detections');
  const indexes = await detections.listIndexes().toArray();
  if (!indexes.some(({ key, expireAfterSeconds }) =>
    Object.keys(key).length === 1 && key.time === 1 && expireAfterSeconds === retentionSeconds)) {
    return 'retention_unverified';
  }
  // Use one unscoped synthetic row per collection, not an alert, report or operator credential.
  for (const collection of [detections, db.collection('incidents')]) {
    const marker = randomUUID();
    const result = await collection.updateOne({ _id: probeId }, { $set: { marker, time: new Date() } },
      { ...durable, upsert: true });
    if (result.acknowledged !== true || !await collection.findOne({ _id: probeId, marker }, majority)) {
      return 'majority_unverified';
    }
  }
  return 'ready';
}

function createEventJournal(withMongo) {
  const run = fn => {
    if (!withMongo) throw new Error('detection storage not configured');
    return withMongo(mdb => fn(mdb.collection('detections'), mdb));
  };
  async function record(event, alert, enrichment = null) {
    const filter = { _id: event.id, ...airportFilter(event.airport) };
    const time = new Date(event.receivedAt);
    const doc = { _id: event.id, time, airport: event.airport, camera_id: event.cameraId, type: event.type,
      object_count: event.object_count, direction: event.direction, confidence: event.confidence, risk: event.risk };
    if (alert) doc.alert = alert;
    if (enrichment) {
      doc.enrichment = { ...enrichment, due_at: time };
    }
    return run(async collection => {
      try {
        const result = await collection.insertOne(doc, durable);
        if (!result.acknowledged) throw new Error('receipt not acknowledged');
        return { alert };
      } catch (err) {
        if (err.code !== 11000) throw err;
        const saved = await collection.findOne(filter, {
          projection: { alert: 1, acknowledged_at: 1 }, ...majority,
        });
        if (!saved) throw err;
        return { alert: saved.alert && !saved.acknowledged_at ? saved.alert : null,
          acknowledged: Boolean(saved.acknowledged_at) };
      }
    });
  }
  async function replay(scope, cursor = null) {
    const rows = await run(collection => collection.find({
      ...airportFilter(scope), alert: { $exists: true }, acknowledged_at: { $exists: false },
      ...(cursor ? { _id: { $gt: cursor } } : {}),
    }, { projection: { alert: 1 }, ...majority }).sort({ _id: 1 }).limit(101).toArray());
    return { alerts: rows.slice(0, 100).map(row => row.alert), next: rows.length > 100 ? rows[99]._id : null };
  }
  async function acknowledge(scope, id, operator) {
    return run(async collection => {
      const filter = { _id: id, ...airportFilter(scope), alert: { $exists: true } };
      // Do not ACK a locally visible insert that has not yet been majority confirmed.
      if (!await collection.findOne(filter, { ...majority, projection: { _id: 1 } })) return null;
      const saved = await collection.findOneAndUpdate(
        filter,
        [{ $set: { acknowledged_at: { $ifNull: ['$acknowledged_at', '$$NOW'] },
          acknowledged_by: { $ifNull: ['$acknowledged_by', { $literal: operator }] } } }],
        { ...durable, returnDocument: 'after', projection: { _id: 1 } });
      if (!saved) return null;
      return collection.findOne({ ...filter, acknowledged_at: { $exists: true } }, { ...majority, projection: { airport: 1 } });
    });
  }
  async function claimEnrichment() {
    const now = new Date();
    return run(collection => collection.findOneAndUpdate(
      { 'enrichment.due_at': { $lte: now } },
      { $set: { 'enrichment.lease': randomUUID(), 'enrichment.due_at': new Date(now.getTime() + 60000) },
        $inc: { 'enrichment.attempts': 1 } },
      { ...durable, sort: { 'enrichment.due_at': 1 }, returnDocument: 'after' }));
  }
  async function setEnrichment(row, stage, fields, hold) {
    const terminal = ['complete', 'incomplete', 'reconciliation_required'].includes(stage);
    const set = { 'enrichment.stage': stage, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`enrichment.${k}`, v])) };
    const unset = hold ? {} : { 'enrichment.lease': '' };
    if (stage !== row.enrichment.stage) set['enrichment.attempts'] = 0;
    if (terminal) Object.assign(unset, { 'enrichment.due_at': '', 'enrichment.evidence': '', 'enrichment.input': '' });
    else if (!hold) set['enrichment.due_at'] = new Date(stage === 'submitting' ? Date.now() + 30000 : Date.now());
    const result = await run(collection => collection.updateOne({
      _id: row._id, ...airportFilter(row.airport), 'enrichment.stage': row.enrichment.stage,
      'enrichment.lease': row.enrichment.lease, 'enrichment.due_at': { $gt: new Date() },
    }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, durable));
    if (result.acknowledged && result.matchedCount && hold) Object.assign(row.enrichment, fields, { stage, attempts: 0 });
    return result.acknowledged === true && result.matchedCount === 1;
  }
  return { record, replay, acknowledge, claimEnrichment, setEnrichment };
}

module.exports = { createEventJournal, checkReceiptStorage };
