const { EventEmitter } = require("node:events");
const { setImmediate } = require("node:timers/promises");
const assert = require("node:assert/strict");
const test = require("node:test");
const { accessConfig, resolveRuntimeAccess, createAccess, createSocketAccess } = require("../access");
const { assignInitialRole, createRoleRequests } = require("../role-requests");
const { airportFilter, hourlyPipeline } = require("../airport-history");

const airports = new Set(["AAA", "BBB"]);

test("initial join only writes once and refuses existing or partially assigned accounts", async () => {
  const reserved = new Map(), writes = [];
  const deps = {
    collection: { async insertOne(doc) {
      if (reserved.has(doc._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
      reserved.set(doc._id, doc);
    } },
    readRole: async (id) => id === "assigned" ? { role: "camera" } : id === "partial" ? { airport: "AAA" } : {},
    writeRole: async (...args) => { writes.push(args); },
  };
  await assert.rejects(assignInitialRole(deps, "assigned", "dashboard", "BBB"), { status: 409 });
  await assert.rejects(assignInitialRole(deps, "partial", "dashboard", "BBB"), { status: 409 });
  const results = await Promise.allSettled([
    assignInitialRole(deps, "new", "camera", "AAA"),
    assignInitialRole(deps, "new", "dashboard", "BBB"),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], ["new", reserved.get("new").role, reserved.get("new").airport, reserved.get("new").joinId]);
});

test("the first history stage matches the exact authorized scalar airport before bucketing", () => {
  const cutoff = new Date("2026-01-01T00:00:00Z");
  const pipeline = hourlyPipeline("AAA", cutoff, "bird");
  const { $match: { airport, $expr: { $eq: [field, scope] }, time, type } } = pipeline[0];
  const rows = [
    { _id: 1, airport: "AAA", time: new Date("2026-01-01T01:00Z"), type: "bird" },
    { _id: 2, airport: "BBB", time: new Date("2026-01-01T01:00Z"), type: "bird" },
    { _id: 3, time: new Date("2026-01-01T01:00Z"), type: "bird" },
    { _id: 4, airport: null, time: new Date("2026-01-01T01:00Z"), type: "bird" },
    { _id: 5, airport: ["AAA", "BBB"], time: new Date("2026-01-01T01:00Z"), type: "bird" },
  ];
  assert.deepEqual(rows.filter((row) => row[field.slice(1)] === scope && scope === airport && row.time > time.$gt && row.type === type).map((row) => row._id), [1]);
  assert.ok(pipeline[1].$group);
  assert.throws(() => airportFilter(undefined), /authorized airport/);
});

test("production rejects missing dashboard authorization and unbound keys", () => {
  const env = { NODE_ENV: "production", CAMERA_API_KEY: "fixture-camera", CAMERA_API_AIRPORT: "AAA" };
  assert.throws(() => accessConfig(env, airports), /tower key or Clerk/);
  assert.throws(() => accessConfig({ ...env, TOWER_API_KEY: "fixture-tower" }, airports), /TOWER_API_AIRPORT/);
  assert.throws(() => accessConfig({ ...env, CLERK_SECRET_KEY: "fixture" }, airports), /both Clerk keys/);
  assert.deepEqual(accessConfig({ ...env, TOWER_API_KEY: "fixture-tower", TOWER_API_AIRPORT: "BBB", ALLOW_UNAUTHENTICATED_TOWER: "true" }, airports), { demo: false });
});

test("resolveRuntimeAccess never throws and fail-closes unbound, duplicate, or partial credentials", () => {
  const unboundCam = resolveRuntimeAccess({
    NODE_ENV: "production",
    CAMERA_API_KEY: "secret-cam",
    CAMERA_API_AIRPORT: "",
    CLERK_SECRET_KEY: "sk_test_1",
    CLERK_PUBLISHABLE_KEY: "pk_test_1",
    MONGODB_URI: "mongodb://127.0.0.1:1",
  }, new Map());
  assert.equal(unboundCam.demo, false);
  assert.equal(unboundCam.clerkEnabled, true);
  assert.equal(unboundCam.cameraKey, "");
  assert.equal(unboundCam.cameraAirport, "");
  assert.equal(unboundCam.cameraKeyMisconfigured, true);
  assert.equal(unboundCam.towerKey, "");
  assert.equal(unboundCam.towerKeyMisconfigured, false);
  assert.ok(unboundCam.warnings.some((w) => /CAMERA_API_AIRPORT/.test(w)));

  const duplicateKeys = resolveRuntimeAccess({
    NODE_ENV: "production",
    CAMERA_API_KEY: "same-key",
    CAMERA_API_AIRPORT: "AAA",
    TOWER_API_KEY: "same-key",
    TOWER_API_AIRPORT: "BBB",
  }, airports);
  assert.equal(duplicateKeys.cameraKey, "");
  assert.equal(duplicateKeys.towerKey, "");
  assert.equal(duplicateKeys.cameraKeyMisconfigured, true);
  assert.equal(duplicateKeys.towerKeyMisconfigured, true);
  assert.ok(duplicateKeys.warnings.includes("camera and tower keys must be distinct"));

  const clerkNoMongoProd = resolveRuntimeAccess({
    NODE_ENV: "production",
    CAMERA_API_KEY: "cam-key",
    CAMERA_API_AIRPORT: "AAA",
    CLERK_SECRET_KEY: "sk_test_1",
    CLERK_PUBLISHABLE_KEY: "pk_test_1",
    MONGODB_URI: "   ",
  }, airports);
  assert.equal(clerkNoMongoProd.clerkEnabled, true);
  assert.equal(clerkNoMongoProd.clerkStorageConfigured, false);
  assert.ok(clerkNoMongoProd.warnings.includes("Clerk in production requires MONGODB_URI"));

  const partialClerkDev = resolveRuntimeAccess({
    NODE_ENV: "development",
    CLERK_SECRET_KEY: "sk_only",
    ALLOW_UNAUTHENTICATED_TOWER: "true",
  }, airports);
  assert.equal(partialClerkDev.clerkEnabled, false);
  assert.equal(partialClerkDev.demo, false);
  assert.ok(partialClerkDev.warnings.includes("configure both Clerk keys or neither"));

  const validProd = resolveRuntimeAccess({
    NODE_ENV: "production",
    CAMERA_API_KEY: "cam-key",
    CAMERA_API_AIRPORT: "AAA",
    TOWER_API_KEY: "tower-key",
    TOWER_API_AIRPORT: "BBB",
    ALLOW_UNAUTHENTICATED_TOWER: "true",
  }, airports);
  assert.equal(validProd.demo, false);
  assert.equal(validProd.cameraKey, "cam-key");
  assert.equal(validProd.cameraAirport, "AAA");
  assert.equal(validProd.towerKey, "tower-key");
  assert.equal(validProd.towerAirport, "BBB");
  assert.equal(validProd.cameraKeyMisconfigured, false);
  assert.equal(validProd.towerKeyMisconfigured, false);
  assert.deepEqual(validProd.warnings, []);
});

test("HTTP grants and socket grants agree on exact airport scope", async () => {
  const access = createAccess({
    airports, cameraKey: "fixture-camera", cameraAirport: "AAA", towerKey: "fixture-tower", towerAirport: "BBB",
    lookup: async (token) => ({ dashboard: { role: "dashboard", airport: "AAA", userId: "d" }, camera: { role: "camera", airport: "AAA", userId: "c" }, admin: { admin: true, userId: "a" } })[token],
  });
  for (const [token, key, requested, expected] of [
    [undefined, undefined, "AAA", undefined],
    [undefined, "wrong", "BBB", undefined],
    ["camera", undefined, "AAA", undefined],
    ["dashboard", undefined, undefined, "AAA"],
    ["dashboard", undefined, "BBB", undefined],
    ["dashboard", undefined, ["AAA"], undefined],
    [undefined, "fixture-tower", undefined, "BBB"],
    [undefined, "fixture-tower", "AAA", undefined],
    ["admin", undefined, undefined, undefined],
    ["admin", undefined, "BBB", "BBB"],
  ]) {
    assert.equal(access.view(await access.dashboardGrant(token, key), requested), expected);
    assert.equal((await access.towerAccess(token, key, requested))?.airport, expected);
  }
  assert.equal(await access.cameraAccess("fixture-camera", undefined, undefined), undefined);
  assert.equal(await access.cameraAccess("fixture-camera", undefined, "BBB"), undefined);
  assert.equal(await access.cameraAccess(undefined, "dashboard", "AAA"), undefined);
  assert.equal((await access.cameraAccess("fixture-camera", undefined, "AAA"))?.airport, "AAA");
  assert.deepEqual(await access.cameraAccess(undefined, "camera", undefined), { airport: "AAA", principal: "c" });
});

test("explicit socket revocation disconnects affected sockets and rejects an in-flight grant", async () => {
  const namespace = { sockets: new Map(), use(fn) { this.middleware = fn; } };
  const sockets = createSocketAccess([namespace]);
  function fixture(token) {
    const socket = new EventEmitter();
    Object.assign(socket, {
      connected: true, data: {}, handshake: { auth: { token } },
      disconnect() { this.connected = false; this.emit("disconnect"); },
    });
    return socket;
  }
  let release;
  sockets.install(namespace, ({ token }) => token === "waiting"
    ? new Promise((resolve) => { release = resolve; })
    : Promise.resolve({ airport: "AAA", principal: token }));
  const first = fixture("user");
  await new Promise((resolve, reject) => namespace.middleware(first, (err) => err ? reject(err) : resolve()));
  namespace.sockets.set("connected", first);
  const pending = new Promise((resolve) => namespace.middleware(fixture("waiting"), resolve));
  sockets.revoke((grant) => grant.principal === "user");
  assert.equal(first.connected, false);
  release({ airport: "AAA", principal: "user" });
  assert.match((await pending).message, /unauthorized/);
});

test("socket reauthorization must retain its principal and airport", async () => {
  const namespace = { sockets: new Map(), use(fn) { this.middleware = fn; } };
  createSocketAccess([namespace]).install(namespace, async ({ token }) => ({
    airport: token === "changed" ? "BBB" : "AAA", principal: "user",
  }));
  const socket = new EventEmitter();
  Object.assign(socket, {
    connected: true, data: {}, handshake: { auth: { token: "original" } },
    disconnect() { this.connected = false; this.emit("disconnect"); },
  });
  await new Promise((resolve, reject) => namespace.middleware(socket, (err) => err ? reject(err) : resolve()));
  socket.emit("auth:refresh", { token: "changed" });
  await setImmediate();
  assert.equal(socket.connected, false);
});

function roleFixture({ ambiguous = false } = {}) {
  let row;
  let actual = { role: "camera", airport: "AAA" };
  let writes = 0;
  let revokes = 0;
  let block = ambiguous;
  let transitionId;
  const copy = (doc) => doc && structuredClone(doc);
  const matches = (filter) => row && Object.entries(filter).every(([key, value]) => value?.$in ? value.$in.includes(row[key]) : value === row[key]);
  const coll = {
    async findOne(filter) { return matches(filter) ? copy(row) : null; },
    async replaceOne(filter, doc) {
      if (row && !matches(filter)) throw Object.assign(new Error("duplicate id"), { code: 11000 });
      row = copy(doc);
    },
    async updateOne(filter, { $set }) {
      if (!matches(filter)) return { matchedCount: 0 };
      Object.assign(row, $set);
      return { matchedCount: 1 };
    },
  };
  const service = createRoleRequests({
    collection: async () => coll, readRole: async () => ({ ...actual }), revoke: () => { revokes++; },
    async setRole(user, role, airport, id) { writes++; transitionId = id; if (!block) actual = { role, airport, transitionId }; },
  });
  return {
    service,
    submit: () => service.submit({ userId: "user", role: "camera", airport: "AAA" }, { to: "dashboard" }),
    confirm: () => { block = false; actual = { role: "dashboard", airport: "AAA", transitionId }; },
    counts: () => [writes, revokes],
  };
}

test("cancel and reject compare exact request revision; a stale reviewer cannot decide a replacement", async () => {
  const { service, submit, counts } = roleFixture();
  const first = await submit();
  await assert.rejects(submit(), { status: 409 });
  await service.cancel("user", first.revision);
  const replacement = await submit();
  await assert.rejects(service.decide("user", first.revision, true, "admin"), { status: 409 });
  await assert.rejects(service.cancel("user", first.revision), { status: 409 });
  assert.equal((await service.decide("user", replacement.revision, false, "admin")).status, "denied");
  assert.deepEqual(counts(), [0, 0]);
});

test("concurrent approval and cancellation have one winner", async () => {
  const { service, submit, counts } = roleFixture();
  const { revision } = await submit();
  const results = await Promise.allSettled([service.decide("user", revision, true, "admin"), service.cancel("user", revision)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const final = await service.mine("user");
  assert.ok(["approved", "cancelled"].includes(final.status));
  assert.deepEqual(counts(), final.status === "approved" ? [1, 1] : [0, 0]);
});

test("only one approver may write Clerk, and confirmed uncertainty can be reconciled without a replay", async () => {
  const { service, submit, confirm, counts } = roleFixture({ ambiguous: true });
  const { revision } = await submit();
  const results = await Promise.allSettled([
    service.decide("user", revision, true, "first"),
    service.decide("user", revision, true, "second"),
  ]);
  assert.ok(results.every((item) => item.status === "rejected"));
  assert.equal((await service.mine("user")).status, "applying");
  assert.deepEqual(counts(), [1, 1]);
  confirm();
  assert.equal((await service.decide("user", revision, true, "first")).status, "approved");
  assert.deepEqual(counts(), [1, 1]);
});
