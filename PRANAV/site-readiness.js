function createReadiness(checks, { report, timeoutMs = 6000, cacheMs = 10000, now = Date.now } = {}) {
  const active = new Map();
  let cached, expires = 0, checking;
  async function check(name, run) {
    let task = active.get(name);
    if (!task) {
      task = Promise.resolve().then(run).catch(error => {
        report?.(name, error);
        return 'unavailable';
      }).finally(() => active.delete(name));
      active.set(name, task);
    }
    let timer;
    try {
      return await Promise.race([task, new Promise(resolve => {
        timer = setTimeout(() => resolve('timed_out'), timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
  return async () => {
    if (now() < expires) return cached;
    return checking ??= Promise.all(Object.entries(checks).map(async ([name, run]) => [name, await check(name, run)]))
      .then(rows => {
        cached = { ready: rows.every(([, state]) => state === 'ready'), checks: Object.fromEntries(rows) };
        expires = now() + cacheMs;
        return cached;
      }).finally(() => { checking = null; });
  };
}

module.exports = { createReadiness };
