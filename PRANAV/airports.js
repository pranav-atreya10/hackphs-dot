// Airports and their join codes, from two places:
//   - AIRPORT_CODES in the environment ("KPCT=pct-sky-4821,KTTN=ttn-sky-9310"): fixed, edited in DigitalOcean
//   - the MongoDB "airports" collection: created, re-coded and deleted by admins on admin.html
// Kept in memory (one server instance) and loaded from MongoDB at start-up.
const crypto = require("crypto");

const CODE_RE = /^[A-Z0-9]{3,5}$/;   // ICAO / FAA style, e.g. KPCT, KTTN, 39N

class AirportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseEnv(value) {
  const map = new Map();
  for (const pair of String(value || "").split(",")) {
    const [code, joinCode] = pair.split("=").map((s) => s.trim());
    if (code && joinCode) map.set(code, { code, name: code, joinCode, source: "env" });
  }
  return map;
}

// e.g. "kttn-4821-9310": readable to type in, about 81 million options, and /api/auth/join allows
// only 10 wrong tries per user per 10 minutes.
const newJoinCode = (code) => `${code.toLowerCase()}-${crypto.randomInt(1000, 10000)}-${crypto.randomInt(1000, 10000)}`;

/**
 * @param env        AIRPORT_CODES string
 * @param collection async () => MongoDB collection, or null when MongoDB isn't configured
 * @param matches    (provided, expected) => boolean, a constant-time compare
 */
function createAirports({ env = "", collection = async () => null, matches }) {
  const fixed = parseEnv(env);
  let stored = new Map();

  const fromDoc = (d) => ({ code: d._id, name: d.name, joinCode: d.joinCode, source: "admin", createdAt: d.createdAt, createdBy: d.createdBy });
  const get = (code) => (typeof code === "string" && (fixed.get(code) || stored.get(code))) || null;
  const all = () => [...fixed.values(), ...[...stored.values()].filter((a) => !fixed.has(a.code))];
  async function need() {
    const coll = await collection();
    if (!coll) throw new AirportError(503, "MongoDB isn't connected, so airports can't be saved");
    return coll;
  }
  function editable(code) {
    const airport = get(code);
    if (!airport) throw new AirportError(404, "no airport with that code");
    if (airport.source === "env") throw new AirportError(409, "this airport is set in the server's AIRPORT_CODES; change it in DigitalOcean");
    return airport;
  }
  function uniqueJoinCode(code) {
    let joinCode;
    do joinCode = newJoinCode(code); while (all().some((a) => a.joinCode === joinCode));
    return joinCode;
  }

  return {
    get, all,
    has: (code) => Boolean(get(code)),
    get size() { return all().length; },

    async load() {
      const coll = await collection();
      if (!coll) return;
      stored = new Map((await coll.find({}).toArray()).map((d) => [d._id, fromDoc(d)]));
    },

    // The airport a join code belongs to, comparing every code so timing doesn't leak which one matched.
    forJoinCode(joinCode) {
      let match = null;
      for (const a of all()) if (matches(joinCode, a.joinCode)) match = a.code;
      return match;
    },

    async create({ code, name, by }) {
      code = String(code || "").trim().toUpperCase();
      name = String(name || "").trim().slice(0, 80) || code;
      if (!CODE_RE.test(code)) throw new AirportError(400, "airport code must be 3 to 5 letters or digits, e.g. KTTN");
      if (get(code)) throw new AirportError(409, `${code} already exists`);
      const coll = await need();
      const doc = { _id: code, name, joinCode: uniqueJoinCode(code), createdAt: new Date(), createdBy: by || null };
      try { await coll.insertOne(doc); }
      catch (err) { if (err.code === 11000) throw new AirportError(409, `${code} already exists`); throw err; }
      stored.set(code, fromDoc(doc));
      return fromDoc(doc);
    },

    async rotate(code) {
      editable(code);
      const joinCode = uniqueJoinCode(code);
      await (await need()).updateOne({ _id: code }, { $set: { joinCode } });
      const airport = { ...stored.get(code), joinCode };
      stored.set(code, airport);
      return airport;
    },

    async remove(code) {
      editable(code);
      await (await need()).deleteOne({ _id: code });
      stored.delete(code);
    },
  };
}

module.exports = { createAirports, AirportError, parseEnv };
