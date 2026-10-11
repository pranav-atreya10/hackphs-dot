// Requests to switch account type (camera station <-> tower dashboard). Users can't switch themselves: they ask,
// and an admin approves or denies on admin.html. Approving changes the account's role and keeps its airport.
// One request per user in MongoDB ("role_requests", _id = Clerk user id); a new request replaces the old one.
const ROLE_NAMES = { camera: "Camera station", dashboard: "Tower dashboard" };

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * @param collection async () => MongoDB collection, or null when MongoDB isn't configured
 * @param setRole    async (userId, role, airport) => saves the new role (Clerk publicMetadata)
 */
function createRoleRequests({ collection = async () => null, setRole }) {
  async function need() {
    const coll = await collection();
    if (!coll) throw new RequestError(503, "MongoDB isn't connected, so requests can't be saved");
    return coll;
  }

  return {
    async submit(user, { to, note } = {}) {
      if (!user.role || !user.airport) throw new RequestError(400, "finish setting up your account first");
      if (!ROLE_NAMES[to]) throw new RequestError(400, "ask for camera or dashboard");
      if (to === user.role) throw new RequestError(400, `this account is already a ${ROLE_NAMES[to].toLowerCase()}`);
      const doc = {
        _id: user.userId, email: user.email || null, name: user.name || null,
        from: user.role, to, airport: user.airport, note: String(note ?? "").trim().slice(0, 300),
        status: "pending", createdAt: new Date(), decidedAt: null, decidedBy: null,
      };
      await (await need()).replaceOne({ _id: user.userId }, doc, { upsert: true });
      return doc;
    },

    async mine(userId) {
      return (await need()).findOne({ _id: userId });
    },

    async cancel(userId) {
      const coll = await need();
      const doc = await coll.findOne({ _id: userId });
      if (!doc || doc.status !== "pending") throw new RequestError(404, "no open request to cancel");
      await coll.deleteOne({ _id: userId });
    },

    async pending() {
      return (await need()).find({ status: "pending" }).sort({ createdAt: 1 }).toArray();
    },

    async decide(id, approve, by) {
      const coll = await need();
      const doc = await coll.findOne({ _id: id });
      if (!doc) throw new RequestError(404, "no request with that id");
      if (doc.status !== "pending") throw new RequestError(409, `this request was already ${doc.status}`);
      if (approve) await setRole(doc._id, doc.to, doc.airport);
      const decided = { status: approve ? "approved" : "denied", decidedAt: new Date(), decidedBy: by || null };
      await coll.updateOne({ _id: id }, { $set: decided });
      return { ...doc, ...decided };
    },
  };
}

module.exports = { createRoleRequests, RequestError, ROLE_NAMES };
