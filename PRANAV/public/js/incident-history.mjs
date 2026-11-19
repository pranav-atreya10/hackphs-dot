export function receiptProgress(state) {
  return ({ pending: 0, retrying_volatile: 1, retrying: 2, unavailable: 3 })[state] ?? 0;
}

function revision(row, source) {
  // Legacy stored reports have no revision but still outrank a provisional live message.
  return Number.isSafeInteger(row.revision) && row.revision > 0 ? row.revision
    : source === 'history' ? 0 : receiptProgress(row.persistence === 'unavailable' ? 'unavailable' : row.receipt_state) - 4;
}

export function reconcileIncidents(current, incoming, source, limit = 40) {
  const rows = new Map(current);
  for (const row of incoming) {
    if (!row || typeof row._id !== 'string' || !Number.isFinite(Date.parse(row.time))) continue;
    const previous = rows.get(row._id);
    const rev = revision(row, source);
    if (previous && rev <= previous.rev) continue;
    rows.set(row._id, { rev, row });
  }
  return new Map([...rows].sort(([aid, a], [bid, b]) =>
    Date.parse(b.row.time) - Date.parse(a.row.time) || aid.localeCompare(bid)).slice(0, limit));
}
