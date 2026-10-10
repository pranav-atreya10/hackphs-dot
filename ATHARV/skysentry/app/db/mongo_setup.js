// MongoDB Atlas: the incidents collection holds full reports with snapshots (build plan, section 4).
// Run once: MONGODB_URI=... node app/db/mongo_setup.js
import { MongoClient } from 'mongodb';

export const INCIDENT_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['time', 'camera_id', 'type', 'object_count', 'risk', 'report'],
    properties: {
      time:         { bsonType: 'date', description: 'when the event was detected' },
      camera_id:    { bsonType: 'string' },
      type:         { enum: ['bird', 'drone'] },
      object_count: { bsonType: 'int', minimum: 0 },
      direction:    { bsonType: 'string' },
      confidence:   { bsonType: ['double', 'int'], minimum: 0, maximum: 1 },
      risk:         { enum: ['yellow', 'red'] },
      snapshot:     { bsonType: 'string', description: 'base64 JPEG' },
      gemini_label: { bsonType: 'string', description: 'what Gemini says it sees, e.g. "small quadcopter drone"' },
      report:       { bsonType: 'string', description: 'three-sentence incident report' },
      report_hash:  { bsonType: 'string', description: 'SHA-256 of the report, drones only' },
      solana_tx:    { bsonType: ['string', 'null'], description: 'devnet transaction signature, drones only' },
      alert_text:   { bsonType: 'string', description: 'sentence spoken in the tower' }
    }
  }
};

export async function setupMongo(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB ?? 'skysentry') {
  if (!uri) throw new Error('Set MONGODB_URI to your Atlas connection string.');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const exists = (await db.listCollections({ name: 'incidents' }).toArray()).length > 0;
  if (exists) await db.command({ collMod: 'incidents', validator: INCIDENT_VALIDATOR });
  else await db.createCollection('incidents', { validator: INCIDENT_VALIDATOR });
  await db.collection('incidents').createIndexes([
    { key: { time: -1 } },
    { key: { camera_id: 1, time: -1 } },
    { key: { type: 1, risk: 1, time: -1 } }
  ]);
  await client.close();
  return `incidents collection ready in ${dbName}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setupMongo().then(console.log).catch(e => { console.error(e.message); process.exit(1); });
}
