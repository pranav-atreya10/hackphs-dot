const fs = require('node:fs/promises');
const { isAbsolute } = require('node:path');
const { createHash } = require('node:crypto');
const { hasCode } = require('./access');

const LIMIT = 64;
const ROW_BYTES = 4096;
const PAGE_BYTES = LIMIT * ROW_BYTES + 1024;
const HEADER_BYTES = 48;
const MAGIC = 'SSR1';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hash = (header, body) => createHash('sha256').update(header).update(body).digest();

function fromPage(page) {
  const seq = page.readDoubleBE(4);
  const size = page.readUInt32BE(12);
  if (page.toString('ascii', 0, 4) !== MAGIC || !Number.isSafeInteger(seq) || seq < 1 ||
      size < 2 || size > PAGE_BYTES - HEADER_BYTES) return null;
  const body = page.subarray(HEADER_BYTES, HEADER_BYTES + size);
  if (!hash(page.subarray(0, 16), body).equals(page.subarray(16, HEADER_BYTES))) return null;
  const rows = JSON.parse(body);
  if (!Array.isArray(rows) || rows.length > LIMIT || !rows.every(({ record, alert, job }) =>
    record && uuid.test(record.id) && hasCode(record.airport) && /^[a-f0-9]{64}$/.test(record.cameraId) &&
    Number.isSafeInteger(record.receivedAt) && record.receivedAt >= 0 &&
    ['yellow', 'red'].includes(record.risk) && (record.risk === 'red') === Boolean(alert) &&
    (!alert || (alert.id === record.id && alert.incident_id === record.id && alert.airport === record.airport &&
      alert.time === record.receivedAt && alert.risk === record.risk && alert.type === record.type)) &&
    job?.version === 1 && job.stage === 'report' && !job.evidence &&
    job.incident?._id === record.id && job.incident.airport === record.airport &&
    job.incident.camera_id === record.cameraId && job.incident.risk === record.risk &&
    job.incident.detection && uuid.test(job.incident.detection.streamId) &&
    uuid.test(job.incident.detection.generation) && Number.isSafeInteger(job.incident.detection.frameId) &&
    job.incident.detection.frameId > 0 && Number.isFinite(job.incident.detection.t) &&
    new Date(job.incident.time).getTime() === record.receivedAt) ||
    new Set(rows.map(({ record }) => record.id)).size !== rows.length) throw new Error('Invalid receipt spool records');
  for (const { job } of rows) job.incident.time = new Date(job.incident.time);
  return { seq, rows };
}

async function readPages(file, size) {
  if (size === 0) return { seq: 0, slot: 1, rows: [] };
  if (size > 2 * PAGE_BYTES) throw new Error('Invalid receipt spool size');
  const buf = Buffer.alloc(2 * PAGE_BYTES);
  for (let at = 0; at < size;) {
    const { bytesRead } = await file.read(buf, at, size - at, at);
    if (!bytesRead) throw new Error('Incomplete receipt spool read');
    at += bytesRead;
  }
  const pages = [0, 1].map(slot => {
    const page = fromPage(buf.subarray(slot * PAGE_BYTES, (slot + 1) * PAGE_BYTES));
    return page && { ...page, slot };
  }).filter(Boolean).sort((a, b) => b.seq - a.seq);
  if (!pages.length || pages[0].seq === pages[1]?.seq) throw new Error('No valid receipt spool checkpoint');
  return pages[0];
}

async function checkpoint(file, slot, seq, rows) {
  const page = Buffer.alloc(PAGE_BYTES);
  const body = Buffer.from(JSON.stringify(rows));
  if (body.length > PAGE_BYTES - HEADER_BYTES) throw new Error('Receipt spool checkpoint too large');
  page.write(MAGIC, 0, 'ascii');
  page.writeDoubleBE(seq, 4);
  page.writeUInt32BE(body.length, 12);
  hash(page.subarray(0, 16), body).copy(page, 16);
  body.copy(page, HEADER_BYTES);
  fromPage(page);
  for (let at = 0; at < page.length;) {
    const { bytesWritten } = await file.write(page, at, page.length - at, slot * PAGE_BYTES + at);
    if (!bytesWritten) throw new Error('Incomplete receipt spool write');
    at += bytesWritten;
  }
  await file.sync();
}

function createReceiptSpool(path) {
  let tail = Promise.resolve(), identity;
  // Two checksummed pages in a pre-existing, exclusive file avoid a directory rename/flush on each receipt.
  function run(transform) {
    const task = tail.then(async () => {
      if (!isAbsolute(path)) throw new Error('Receipt spool path must be absolute');
      const entry = await fs.lstat(path);
      if (!entry.isFile() || entry.nlink !== 1 || (process.platform !== 'win32' && (entry.mode & 0o077))) {
        throw new Error('Receipt spool must be a private regular file');
      }
      const file = await fs.open(path, 'r+');
      try {
        const { dev, ino, size } = await file.stat();
        const key = `${dev}:${ino}`;
        if (dev !== entry.dev || ino !== entry.ino || (identity && identity !== key)) throw new Error('Receipt spool was replaced');
        identity = key;
        const { seq, slot, rows } = await readPages(file, size);
        const next = transform?.(rows);
        if (next !== undefined) await checkpoint(file, 1 - slot, seq + 1, next);
        else if (transform) await file.sync(); // A previous attempt may have returned an ambiguous sync error.
        return next ?? rows;
      } finally {
        await file.close();
      }
    });
    tail = task.catch(() => {}); // Failure is returned to the caller; later independent operations can retry.
    return task;
  }
  return {
    rows: () => run(),
    probe: () => run(rows => rows),
    put(row) {
      if (Buffer.byteLength(JSON.stringify(row)) > ROW_BYTES) throw new Error('Receipt spool record too large');
      return run(rows => {
        if (rows.some(({ record }) => record.id === row.record.id)) return; // Do not change a staged receipt.
        if (rows.length >= LIMIT) throw new Error('Receipt spool full');
        return [...rows, row];
      });
    },
    remove: id => run(rows => rows.some(({ record }) => record.id === id) ?
      rows.filter(({ record }) => record.id !== id) : undefined),
    flush: () => tail,
  };
}

module.exports = { createReceiptSpool, LIMIT };
