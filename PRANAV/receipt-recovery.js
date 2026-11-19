const { LIMIT } = require('./receipt-spool');

const retryDelay = attempts => Math.min(60_000, 500 * 2 ** (attempts - 1));

function createReceiptRecovery({ spool, journal, allowed, publish, report, maxAgeMs, now = Date.now }) {
  const pending = new Map(), admitting = new Set(), failures = new Map();
  let loaded = !spool, loading, running, stagingSlots = 0, stopping = false;

  function recover() {
    if (loaded) return true;
    return loading ??= spool.rows().then(rows => {
      for (const item of rows) {
        const id = item.record.id;
        const current = pending.get(id);
        if (current) current.staged = true;
        else pending.set(id, { ...item, staged: true, attempts: 0, due: 0, state: 'retrying' });
      }
      return loaded = true;
    }).catch(error => {
      report('spool load', error);
      return false;
    }).finally(() => { loading = null; });
  }

  function fail(item) {
    const id = item.record.id;
    failures.set(id, { record: item.record, alert: item.alert, job: { incident: item.job.incident }, state: 'unavailable' });
    if (failures.size > LIMIT) failures.delete(failures.keys().next().value);
    publish(item, 'unavailable');
  }

  async function stage(item) {
    if (!spool || item.staged) return;
    const { record, alert, job } = item;
    // The restart spool holds metadata only. An opted-in image can go into Mongo on the original process.
    const backup = { record, alert, job: { ...job, evidence: null, incident: { ...job.incident,
      snapshot_state: job.evidence ? 'unavailable' : job.incident.snapshot_state } } };
    try {
      await spool.put(backup);
      item.staged = true;
    } catch (error) {
      report('spool checkpoint', error, record.id);
      if (item.state !== 'retrying_volatile') publish(item, item.state = 'retrying_volatile');
    }
  }

  async function attempt(item) {
    const { record, alert, job } = item;
    try {
      if (!item.receipt && !item.expired) {
        if (!await allowed(record.airport) || now() - record.receivedAt >= maxAgeMs) {
          item.expired = true;
          report('receipt expired or airport no longer authorized', null, record.id);
          fail(item);
        } else {
          await stage(item);
          item.receipt = await journal.record(record, alert, job);
          publish(item, 'confirmed', item.receipt);
        }
      }
      if (item.staged) await spool.remove(record.id);
      pending.delete(record.id);
    } catch (error) {
      report(item.receipt ? 'spool cleanup' : 'majority receipt', error, record.id);
      item.due = now() + retryDelay(++item.attempts);
      if (!item.receipt && !item.expired) {
        if (!item.staged && item.attempts >= 6) {
          fail(item);
          pending.delete(record.id);
        } else {
          const state = item.staged ? 'retrying' : 'retrying_volatile';
          if (item.state !== state) publish(item, item.state = state);
        }
      }
    }
  }

  function drain() {
    if (stopping) return;
    return running ??= (async () => {
      if (!await recover() && pending.size === 0) return;
      const due = [...pending.values()].filter(item => item.admitted !== false && item.due <= now()).slice(0, 8);
      for (const item of due) {
        if (stopping) break;
        await attempt(item);
      }
    })().finally(() => { running = null; });
  }

  function submit(record, alert, job) {
    const item = { record, alert, job, state: 'pending', admitted: false, staged: false, attempts: 0, due: 0 };
    if (stopping || pending.size + stagingSlots >= LIMIT) {
      report('receipt queue at capacity or stopping', null, record.id);
      fail(item);
      return;
    }
    stagingSlots++;
    const task = (async () => {
      await recover();
      stagingSlots--;
      if (pending.size >= LIMIT) {
        report('receipt queue at capacity', null, record.id);
        fail(item);
        return;
      }
      pending.set(record.id, item);
      await stage(item); // No majority write until the restart checkpoint has been attempted.
      item.admitted = true;
      void drain();
    })().finally(() => admitting.delete(task));
    admitting.add(task);
    return task;
  }

  async function forAirport(airport) {
    await recover();
    const rows = [...pending.values(), ...failures.values()]
      .filter(item => !item.receipt && !item.expired && item.record.airport === airport &&
        now() - item.record.receivedAt < maxAgeMs);
    return rows.map(({ alert, job, state }) => ({ alert, incident: job.incident, state }));
  }

  return {
    submit, drain, forAirport,
    unavailable: (record, alert, incident) => fail({ record, alert, job: { incident } }),
    async check() {
      if (stopping) return 'unavailable';
      if (!spool) return 'not_configured';
      if (!await recover() || stopping) return 'unavailable';
      await spool.probe();
      return pending.size + stagingSlots >= LIMIT ? 'full' : [...pending.values()].some(item => item.attempts || item.state === 'retrying_volatile')
        ? 'retrying' : 'ready';
    },
    async stop() {
      stopping = true;
      await Promise.allSettled([...admitting, running]);
      await spool?.flush();
    },
  };
}

module.exports = { createReceiptRecovery };
