const { timingSafeEqual, createHash } = require("node:crypto");

const CODE = /^[A-Z0-9]{3,5}$/;
const hasCode = (code) => typeof code === "string" && CODE.test(code);
const digest = (value) => createHash("sha256").update(value).digest();
const keyPrincipal = (kind, key) => `${kind}:${digest(key).toString("hex")}`;
function keyMatches(provided, expected) {
  return Boolean(expected && typeof provided === "string" && timingSafeEqual(digest(provided), digest(expected)));
}

function accessConfig(env, fixedAirports) {
  const production = env.NODE_ENV === "production";
  const clerk = Boolean(env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY);
  if (Boolean(env.CLERK_SECRET_KEY) !== Boolean(env.CLERK_PUBLISHABLE_KEY)) {
    throw new Error("configure both Clerk keys or neither");
  }
  const demo = !production && env.ALLOW_UNAUTHENTICATED_TOWER === "true" && !clerk && !env.TOWER_API_KEY;
  for (const [kind, key, airport] of [
    ["CAMERA", env.CAMERA_API_KEY, env.CAMERA_API_AIRPORT],
    ["TOWER", env.TOWER_API_KEY, env.TOWER_API_AIRPORT],
  ]) {
    if (key && (!hasCode(airport) || !fixedAirports.has(airport))) {
      throw new Error(`${kind}_API_AIRPORT must name a registered AIRPORT_CODES entry when ${kind}_API_KEY is set`);
    }
  }
  if (env.CAMERA_API_KEY && env.CAMERA_API_KEY === env.TOWER_API_KEY) {
    throw new Error("camera and tower keys must be distinct");
  }
  if (production && (!env.CAMERA_API_KEY || (!clerk && !env.TOWER_API_KEY) || (clerk && !env.MONGODB_URI))) {
    throw new Error("production requires a bound camera key and either a bound tower key or Clerk with MongoDB");
  }
  return { demo };
}

function resolveRuntimeAccess(env = {}, fixedAirports = new Map()) {
  const production = env.NODE_ENV === "production";
  const warnings = [];
  const hasClerkSecret = Boolean((env.CLERK_SECRET_KEY || "").trim());
  const hasClerkPublishable = Boolean((env.CLERK_PUBLISHABLE_KEY || "").trim());
  const clerkPairComplete = hasClerkSecret && hasClerkPublishable;
  if (hasClerkSecret !== hasClerkPublishable) {
    warnings.push("configure both Clerk keys or neither");
  }
  const hasMongo = Boolean((env.MONGODB_URI || "").trim());
  const clerkEnabled = clerkPairComplete && (!production || hasMongo);
  if (production && clerkPairComplete && !hasMongo) {
    warnings.push("Clerk in production requires MONGODB_URI");
  }

  const keysDistinct = !(env.CAMERA_API_KEY && env.CAMERA_API_KEY === env.TOWER_API_KEY);
  if (!keysDistinct) {
    warnings.push("camera and tower keys must be distinct");
  }

  const cameraAirportBound = Boolean(
    env.CAMERA_API_KEY && hasCode(env.CAMERA_API_AIRPORT) && fixedAirports.has(env.CAMERA_API_AIRPORT)
  );
  if (env.CAMERA_API_KEY && !cameraAirportBound) {
    warnings.push("CAMERA_API_AIRPORT must name a registered AIRPORT_CODES entry when CAMERA_API_KEY is set");
  }
  const cameraKeyValid = cameraAirportBound && keysDistinct;
  const cameraKey = cameraKeyValid ? env.CAMERA_API_KEY : "";
  const cameraAirport = cameraKeyValid ? env.CAMERA_API_AIRPORT : "";
  const cameraKeyMisconfigured = Boolean(env.CAMERA_API_KEY && !cameraKeyValid);

  const towerAirportBound = Boolean(
    env.TOWER_API_KEY && hasCode(env.TOWER_API_AIRPORT) && fixedAirports.has(env.TOWER_API_AIRPORT)
  );
  if (env.TOWER_API_KEY && !towerAirportBound) {
    warnings.push("TOWER_API_AIRPORT must name a registered AIRPORT_CODES entry when TOWER_API_KEY is set");
  }
  const towerKeyValid = towerAirportBound && keysDistinct;
  const towerKey = towerKeyValid ? env.TOWER_API_KEY : "";
  const towerAirport = towerKeyValid ? env.TOWER_API_AIRPORT : "";
  const towerKeyMisconfigured = Boolean(env.TOWER_API_KEY && !towerKeyValid);

  if (production && (!cameraKeyValid || (!clerkEnabled && !towerKeyValid))) {
    warnings.push("production requires a bound camera key and either a bound tower key or Clerk with MongoDB");
  }

  const demo = !production && env.ALLOW_UNAUTHENTICATED_TOWER === "true" && !(hasClerkSecret || hasClerkPublishable) && !env.TOWER_API_KEY;

  return {
    demo,
    clerkEnabled,
    cameraKey,
    cameraAirport,
    towerKey,
    towerAirport,
    cameraKeyMisconfigured,
    towerKeyMisconfigured,
    warnings,
  };
}

function createAccess({ airports, lookup, cameraKey, cameraAirport, towerKey, towerAirport, demo }) {
  const known = (airport) => hasCode(airport) && airports.has(airport);
  function view(grant, requested) {
    if (!grant) return undefined;
    const airport = requested === undefined ? grant.airport : requested;
    if (!known(airport) || (!grant.selectAirport && airport !== grant.airport)) return undefined;
    return airport;
  }
  async function dashboardGrant(token, key) {
    if (keyMatches(key, towerKey)) return known(towerAirport) ? { airport: towerAirport, principal: keyPrincipal("tower", towerKey) } : undefined;
    const access = await lookup(token);
    if (access?.admin) return { airport: access.airport, principal: access.userId, selectAirport: true };
    if (access?.role === "dashboard" && known(access.airport)) return { airport: access.airport, principal: access.userId };
    if (demo && token === undefined && key === undefined) return { principal: "local-demo", selectAirport: true };
  }
  async function towerAccess(token, key, requested) {
    const grant = await dashboardGrant(token, key);
    const airport = view(grant, requested);
    if (airport) return { airport, principal: grant.principal };
  }
  async function cameraAccess(key, token, requested) {
    if (keyMatches(key, cameraKey)) {
      if (known(cameraAirport) && requested === cameraAirport) return { airport: cameraAirport, principal: keyPrincipal("camera", cameraKey) };
      return;
    }
    const access = await lookup(token);
    if (access?.role === "camera" && known(access.airport) && (requested === undefined || requested === access.airport)) {
      return { airport: access.airport, principal: access.userId };
    }
  }
  return { dashboardGrant, towerAccess, cameraAccess, view };
}

function createSocketAccess(namespaces) {
  let epoch = 0;
  function revoke(matches) {
    epoch++;
    for (const namespace of namespaces) {
      for (const socket of namespace.sockets.values()) {
        if (socket.data.grant && matches(socket.data.grant)) socket.disconnect(true);
      }
    }
  }
  function install(namespace, resolve) {
    namespace.use(async (socket, next) => {
      const initialEpoch = epoch;
      const initial = socket.handshake.auth || {};
      let grant;
      try { grant = await resolve(initial); }
      catch { return next(new Error("unauthorized")); }
      if (!grant || initialEpoch !== epoch) return next(new Error("unauthorized"));
      Object.assign(socket.data, { grant, airport: grant.airport, principal: grant.principal });
      let credentials = initial;
      let busy = false;
      let timer;
      let active = true;
      const disconnect = () => { active = false; socket.disconnect(true); };
      const renewLease = () => {
        clearTimeout(timer);
        timer = setTimeout(disconnect, 35_000).unref();
      };
      const stop = () => { active = false; clearTimeout(timer); clearInterval(interval); };
      const check = async (replacement) => {
        if (busy || !active) return;
        busy = true;
        const currentEpoch = epoch;
        try {
          const fresh = await resolve(replacement);
          if (!active) return;
          if (currentEpoch !== epoch || fresh?.airport !== grant.airport || fresh?.principal !== grant.principal) {
            disconnect();
            return;
          }
          credentials = replacement;
          renewLease();
        } catch {
          disconnect();
        } finally {
          busy = false;
        }
      };
      const interval = setInterval(() => {
        if (!socket.connected) return stop();
        void check(credentials);
      }, 15_000).unref();
      socket.once("disconnect", stop);
      socket.on("auth:refresh", (payload) => {
        const token = payload?.token;
        if (typeof token === "string" && credentials.token) void check({ ...credentials, token });
      });
      renewLease();
      next();
    });
  }
  return { revoke, install, epoch: () => epoch };
}

module.exports = { accessConfig, resolveRuntimeAccess, createAccess, createSocketAccess, hasCode, keyMatches };
