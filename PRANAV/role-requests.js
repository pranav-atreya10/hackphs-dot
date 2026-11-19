// Requests to switch account type (camera station <-> tower dashboard). Users can't switch themselves: they ask,
// and an admin approves or denies on admin.html. Approving changes the account's role and keeps its airport.
const { randomUUID } = require("node:crypto");
const ROLE_NAMES = { camera: "Camera station", dashboard: "Tower dashboard" };
const revisionOf = (doc) => doc.revision ?? doc.createdAt?.toISOString();
const generation = (doc) => doc.revision
  ? { _id: doc._id, revision: doc.revision }
  : { _id: doc._id, revision: { $exists: false }, createdAt: doc.createdAt };

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function assignInitialRole({ collection, readRole, writeRole }, userId, role, airport) {
  const actual = await readRole(userId);
  if (actual?.role != null || actual?.airport != null) {
    throw new RequestError(409, "account already has an assignment; use a role request");
  }
  const joinId = randomUUID();
  try {
    await collection.insertOne({ _id: userId, role, airport, joinId, createdAt: new Date() });
  } catch (err) {
    if (err.code === 11000) throw new RequestError(409, "an account assignment was already reserved");
    throw err;
  }
  // Retain the reservation if the provider update returns an ambiguous outcome.
  await writeRole(userId, role, airport, joinId);
}

/**
 * @param collection async () => MongoDB collection, or null when MongoDB isn't configured
 * @param setRole saves the target role and transition ID as one Clerk metadata update
 * @param readRole reads fresh Clerk metadata to reconcile an ambiguous provider response
 */
function createRoleRequests({ collection = async () => null, setRole, readRole, revoke = () => {} }) {
  async function need() {
    const coll = await collection();
    if (!coll) throw new RequestError(503, "MongoDB isn't connected, so requests can't be saved");
    return coll;
  }

  return {
    async submit(user, { to, note } = {}) {
      if (!user.role || !user.airport) throw new RequestError(400, "finish setting up your account first");
      if (!Object.hasOwn(ROLE_NAMES, to)) throw new RequestError(400, "ask for camera or dashboard");
      if (to === user.role) throw new RequestError(400, `this account is already a ${ROLE_NAMES[to].toLowerCase()}`);
      const doc = {
        _id: user.userId, email: user.email || null, name: user.name || null,
        from: user.role, to, airport: user.airport, note: String(note ?? "").trim().slice(0, 300),
        status: "pending", revision: randomUUID(), createdAt: new Date(), decidedAt: null, decidedBy: null,
      };
      try {
        await (await need()).replaceOne({ _id: user.userId, status: { $in: ["approved", "denied", "cancelled"] } }, doc, { upsert: true });
      } catch (err) {
        if (err.code === 11000) throw new RequestError(409, "an open request already exists");
        throw err;
      }
      return doc;
    },

    async mine(userId) {
      const doc = await (await need()).findOne({ _id: userId });
      return doc ? { ...doc, revision: revisionOf(doc) } : null;
    },

    async cancel(userId, revision) {
      const coll = await need();
      const doc = await coll.findOne({ _id: userId });
      if (!doc || doc.status !== "pending") throw new RequestError(404, "no open request to cancel");
      if (!revision || revisionOf(doc) !== revision) throw new RequestError(409, "the request changed; reload and try again");
      const result = await coll.updateOne({ ...generation(doc), status: "pending" }, { $set: { status: "cancelled", decidedAt: new Date() } });
      if (!result.matchedCount) throw new RequestError(409, "the request changed; reload and try again");
    },

    async pending() {
      const docs = await (await need()).find({ status: { $in: ["pending", "applying"] } }).sort({ createdAt: 1 }).toArray();
      return docs.map((doc) => ({ ...doc, revision: revisionOf(doc) }));
    },

    async decide(id, revision, approve, by) {
      const coll = await need();
      const doc = await coll.findOne({ _id: id });
      if (!doc) throw new RequestError(404, "no request with that id");
      if (!revision || revisionOf(doc) !== revision) throw new RequestError(409, "the request changed; reload and try again");
      const filter = generation(doc);
      if (doc.status === "pending") {
        if (!approve) {
          const denied = { status: "denied", decidedAt: new Date(), decidedBy: by || null };
          if (!(await coll.updateOne({ ...filter, status: "pending" }, { $set: denied })).matchedCount) {
            throw new RequestError(409, "the request changed; reload and try again");
          }
          return { ...doc, ...denied };
        }
        const actual = await readRole(id);
        if (actual?.role !== doc.from || actual?.airport !== doc.airport) {
          throw new RequestError(409, "the current role or airport no longer matches the request");
        }
        const applying = { status: "applying", transitionId: randomUUID(), decidedBy: by || null, applyingAt: new Date() };
        if (!(await coll.updateOne({ ...filter, status: "pending" }, { $set: applying })).matchedCount) {
          throw new RequestError(409, "the request changed; reload and try again");
        }
        Object.assign(doc, applying);
        revoke(id);
        try {
          await setRole(id, doc.to, doc.airport, doc.transitionId);
        } catch (err) {
          console.error("role change provider update was not confirmed:", err.message);
        }
      } else if (doc.status !== "applying" || !approve) {
        throw new RequestError(409, `this request is already ${doc.status}`);
      }
      // Reconciliation is read-only at Clerk: an ambiguous write must never be replayed blindly.
      const actual = await readRole(id);
      if (actual?.transitionId !== doc.transitionId || actual?.role !== doc.to || actual?.airport !== doc.airport) {
        throw new RequestError(503, "role change is not confirmed; access remains suspended pending reconciliation");
      }
      const approved = { status: "approved", decidedAt: new Date() };
      if (!(await coll.updateOne({ ...filter, status: "applying", transitionId: doc.transitionId }, { $set: approved })).matchedCount) {
        throw new RequestError(409, "the request changed; reload and try again");
      }
      return { ...doc, ...approved };
    },
  };
}

module.exports = { assignInitialRole, createRoleRequests, RequestError, ROLE_NAMES };
