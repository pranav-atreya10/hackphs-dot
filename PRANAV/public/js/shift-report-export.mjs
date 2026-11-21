// Tower shift incident CSV export (with OWASP spreadsheet formula-injection neutralization)
// and standalone FAA-style monochrome Wildlife & UAS Shift Summary print/PDF generator.

export const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

export const CSV_COLUMNS = Object.freeze([
  'incident_id',
  'timestamp_utc',
  'airport',
  'camera_id',
  'risk',
  'type',
  'object_count',
  'direction',
  'confidence',
  'eta_seconds',
  'eta_basis',
  'advisory_label',
  'report',
  'report_hash',
  'solana_status',
  'solana_tx',
]);

const HTML_ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

const LEGACY_ADVISORY_KEY = ['gem', 'ini_label'].join('');

export function neutralizeCsvFormula(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.length > 0 && FORMULA_TRIGGER_RE.test(str)) {
    return `'${str}`;
  }
  return str;
}

export function encodeCsvCell(value) {
  const safe = neutralizeCsvFormula(value);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
}

function toValidDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d;
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const epoch = Number(trimmed);
      if (Number.isFinite(epoch)) {
        const d = new Date(epoch);
        if (Number.isFinite(d.getTime())) return d;
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date();
}

function formatTimestampUtc(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? raw.toISOString() : '';
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return '';
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d.toISOString() : '';
  }
  const str = String(raw);
  const trimmed = str.trim();
  if (!trimmed) return '';
  if (/^\d+$/.test(trimmed)) {
    const epoch = Number(trimmed);
    if (Number.isFinite(epoch)) {
      const d = new Date(epoch);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    }
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return str;
}

function readAdvisoryLabel(inc) {
  if (!inc || typeof inc !== 'object') return '';
  return inc.advisory_label ?? inc.ai_label ?? inc[LEGACY_ADVISORY_KEY] ?? '';
}

function readCorridorEta(inc) {
  if (
    inc &&
    typeof inc === 'object' &&
    inc.eta_basis === 'image_space_corridor' &&
    Number.isFinite(inc.eta_seconds) &&
    inc.eta_seconds >= 0
  ) {
    return {
      etaSeconds: inc.eta_seconds,
      etaBasis: 'image_space_corridor',
    };
  }
  return {
    etaSeconds: '',
    etaBasis: '',
  };
}

function normalizeAirportFilter(airport) {
  if (typeof airport !== 'string') return '';
  const trimmed = airport.trim();
  if (!trimmed || trimmed.toUpperCase() === 'UNSPECIFIED') return '';
  return trimmed;
}

function filterIncidentsByAirport(incidents, airport) {
  const list = Array.isArray(incidents) ? incidents : [];
  const targetAirport = typeof airport === 'string' ? airport.trim() : '';
  const enforceFilter = Boolean(targetAirport && targetAirport.toUpperCase() !== 'UNSPECIFIED');
  return list.filter(inc => {
    if (!inc || typeof inc !== 'object' || Array.isArray(inc)) return false;
    if (!enforceFilter) return true;
    return !inc.airport || inc.airport === targetAirport;
  });
}

function formatNumberOrBlank(val) {
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'number') return Number.isFinite(val) ? val : '';
  return val;
}

function slugifyToken(value, fallback = 'unspecified') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function sanitizeDownloadFilename(filename, airport, now) {
  if (typeof filename === 'string' && filename.trim()) {
    const cleaned = filename.trim().replace(/[\\/\r\n\0]+/g, '-');
    if (cleaned) return cleaned;
  }
  const safeAirport = slugifyToken(airport, 'unspecified');
  const yyyyMmDd = toValidDate(now).toISOString().slice(0, 10);
  return `skysentry-shift-incidents-${safeAirport}-${yyyyMmDd}.csv`;
}

export function buildIncidentsCsv(incidents = [], options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const airport = typeof opts.airport === 'string' ? opts.airport.trim() : '';
  const rows = filterIncidentsByAirport(incidents, airport);
  const effectiveAirport = normalizeAirportFilter(airport);

  const headerLine = CSV_COLUMNS.map(encodeCsvCell).join(',');
  const bodyLines = rows.map(inc => {
    const { etaSeconds, etaBasis } = readCorridorEta(inc);
    const rawTime = inc.time ?? inc.timestamp_utc ?? inc.timestamp ?? inc.receivedAt ?? '';
    const solanaStatus = inc.solana_status ?? (inc.solana_tx ? 'confirmed' : '');
    const record = [
      inc._id ?? inc.incident_id ?? inc.id ?? '',
      formatTimestampUtc(rawTime),
      inc.airport ?? effectiveAirport ?? '',
      inc.camera_id ?? inc.cameraId ?? '',
      inc.risk ?? '',
      inc.type ?? '',
      formatNumberOrBlank(inc.object_count ?? inc.flock_size),
      inc.direction ?? '',
      formatNumberOrBlank(inc.confidence),
      etaSeconds,
      etaBasis,
      readAdvisoryLabel(inc),
      inc.report ?? '',
      inc.report_hash ?? '',
      solanaStatus,
      inc.solana_tx ?? '',
    ];
    return record.map(encodeCsvCell).join(',');
  });

  return `${[headerLine, ...bodyLines].join('\r\n')}\r\n`;
}

export function exportIncidentsCsv(incidents = [], options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const {
    airport,
    filename,
    now = new Date(),
    download = true,
    doc = typeof document !== 'undefined' ? document : null,
    urlApi = globalThis.URL,
  } = opts;

  const filtered = filterIncidentsByAirport(incidents, airport);
  const csv = buildIncidentsCsv(filtered, { airport });
  const resolvedFilename = sanitizeDownloadFilename(filename, airport, now);

  if (
    download &&
    doc &&
    typeof doc.createElement === 'function' &&
    typeof Blob === 'function' &&
    typeof urlApi?.createObjectURL === 'function'
  ) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const href = urlApi.createObjectURL(blob);
    try {
      const link = doc.createElement('a');
      link.href = href;
      link.download = resolvedFilename;
      link.rel = 'noopener';
      link.hidden = true;
      if (typeof link.setAttribute === 'function') {
        link.setAttribute('download', resolvedFilename);
        link.setAttribute('rel', 'noopener');
      }
      if (doc.body && typeof doc.body.appendChild === 'function') {
        doc.body.appendChild(link);
      }
      if (typeof link.click === 'function') {
        link.click();
      }
      if (typeof link.remove === 'function') {
        link.remove();
      } else if (link.parentNode && typeof link.parentNode.removeChild === 'function') {
        link.parentNode.removeChild(link);
      }
    } finally {
      if (typeof urlApi.revokeObjectURL === 'function') {
        urlApi.revokeObjectURL(href);
      }
    }
  }

  return {
    csv,
    filename: resolvedFilename,
    rowCount: filtered.length,
  };
}

function formatConfidenceDisplay(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return '';
  if (confidence >= 0 && confidence <= 1) {
    return `${Math.round(confidence * 100)}%`;
  }
  if (confidence > 1 && confidence <= 100) {
    return `${Math.round(confidence)}%`;
  }
  return String(confidence);
}

function formatEtaDisplay(etaSeconds) {
  return Number.isInteger(etaSeconds) ? String(etaSeconds) : etaSeconds.toFixed(1);
}

const PRINT_STYLESHEET = `
  @page {
    margin: 14mm;
  }
  * {
    box-sizing: border-box;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    font: 10.5pt/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  main.report-sheet {
    max-width: 980px;
    margin: 0 auto;
    padding: 16px;
    background: #fff;
    color: #000;
  }
  header.doc-banner {
    border: 1.5px solid #000;
    padding: 12px 14px;
    margin-bottom: 14px;
  }
  .doc-kicker {
    margin: 0 0 2px;
    font: 700 8pt/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #111;
  }
  .doc-title {
    margin: 0 0 8px;
    font: 700 14pt/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    letter-spacing: 0.01em;
    color: #000;
  }
  .doc-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 20px;
    padding-top: 8px;
    border-top: 1px solid #222;
    font: 600 9pt/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #111;
  }
  .doc-note {
    margin: 8px 0 0;
    padding-top: 7px;
    border-top: 1px solid #ccc;
    font: 400 8.5pt/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #111;
  }
  section.report-section {
    margin: 0 0 16px;
  }
  h2.section-heading {
    margin: 0 0 6px;
    padding-bottom: 3px;
    border-bottom: 1px solid #111;
    font: 700 9.5pt/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #000;
  }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }
  .kpi-card {
    border: 1px solid #222;
    padding: 7px 9px;
    background: #fff;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .kpi-label {
    display: block;
    font: 600 7.5pt/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #111;
  }
  .kpi-value {
    display: block;
    margin-top: 3px;
    font: 700 13pt/1.15 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #000;
    font-variant-numeric: tabular-nums;
  }
  table.faa-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #222;
    font-size: 8.8pt;
    font-variant-numeric: tabular-nums;
  }
  table.faa-table thead {
    display: table-header-group;
  }
  table.faa-table th {
    text-align: left;
    padding: 6px 7px;
    border: 1px solid #222;
    background: #fff;
    color: #000;
    font: 700 7.8pt/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  table.faa-table td {
    vertical-align: top;
    padding: 6px 7px;
    border: 1px solid #ccc;
    color: #111;
    overflow-wrap: anywhere;
  }
  table.faa-table tr.incident-row,
  table.faa-table tr.hourly-row {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  table.faa-table td.mono-cell {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 8.2pt;
  }
  table.faa-table tr.empty-row td {
    text-align: center;
    padding: 12px 8px;
    color: #111;
    font-style: italic;
  }
  .risk-tag {
    display: inline-block;
    padding: 1px 5px;
    border: 1px solid #000;
    font: 700 7.5pt/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    text-transform: uppercase;
    color: #000;
  }
  .proof-meta {
    margin-top: 4px;
    font: 400 7.8pt/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #111;
  }
  footer.doc-footer {
    margin-top: 14px;
    padding-top: 6px;
    border-top: 1px solid #222;
    font: 400 7.8pt/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #111;
  }
  @media print {
    main.report-sheet {
      max-width: none;
      padding: 0;
    }
  }
`;

export function buildShiftSummaryHtml(incidents = [], hourlyRows = [], options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const airportInput = typeof opts.airport === 'string' && opts.airport.trim() ? opts.airport.trim() : 'UNSPECIFIED';
  const filterAirport = normalizeAirportFilter(airportInput);
  const generatedIso = toValidDate(opts.generatedAt ?? new Date()).toISOString();

  const scopedIncidents = filterIncidentsByAirport(incidents, filterAirport);
  const rawHourly = Array.isArray(hourlyRows) ? hourlyRows : [];
  const scopedHourly = rawHourly.filter(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (!filterAirport) return true;
    return !row.airport || row.airport === filterAirport;
  });

  let redCount = 0;
  let yellowCount = 0;
  let droneCount = 0;
  let birdCount = 0;
  let devnetStampedCount = 0;

  for (const inc of scopedIncidents) {
    const riskLower = String(inc.risk ?? '').toLowerCase();
    const typeLower = String(inc.type ?? '').toLowerCase();
    const solanaLower = String(inc.solana_status ?? '').toLowerCase();
    if (riskLower === 'red') redCount++;
    else if (riskLower === 'yellow') yellowCount++;
    if (typeLower === 'drone') droneCount++;
    else if (typeLower === 'bird') birdCount++;
    if (solanaLower === 'confirmed' || Boolean(inc.solana_tx)) devnetStampedCount++;
  }

  let hourlyDetectionsTotal = 0;
  for (const row of scopedHourly) {
    const evCount = Number(row.events ?? row.count ?? 0);
    if (Number.isFinite(evCount)) hourlyDetectionsTotal += evCount;
  }

  const kpis = [
    { label: 'Total Incidents', value: scopedIncidents.length },
    { label: 'Red Alerts', value: redCount },
    { label: 'Yellow Advisories', value: yellowCount },
    { label: 'UAS / Drone Incidents', value: droneCount },
    { label: 'Wildlife / Bird Incidents', value: birdCount },
    { label: 'Devnet-Stamped Reports', value: devnetStampedCount },
    { label: '24h Hourly Detections', value: hourlyDetectionsTotal },
  ];

  const kpiCardsHtml = kpis
    .map(
      kpi =>
        `<div class="kpi-card"><span class="kpi-label">${escapeHtml(kpi.label)}</span><span class="kpi-value">${escapeHtml(kpi.value)}</span></div>`
    )
    .join('');

  const hourlyBodyHtml =
    scopedHourly.length > 0
      ? scopedHourly
          .map(row => {
            const rawHour = row.hour ?? row.bucket ?? row.label ?? '';
            const formattedHour = formatTimestampUtc(rawHour) || String(rawHour || '—');
            const category = row.type ?? row.category ?? 'unspecified';
            const eventsVal = Number(row.events ?? row.count ?? 0);
            const objectsVal = Number(row.total_objects ?? row.objects ?? eventsVal);
            return [
              '<tr class="hourly-row">',
              `<td class="mono-cell">${escapeHtml(formattedHour)}</td>`,
              `<td>${escapeHtml(category)}</td>`,
              `<td class="mono-cell">${escapeHtml(Number.isFinite(eventsVal) ? eventsVal : 0)}</td>`,
              `<td class="mono-cell">${escapeHtml(Number.isFinite(objectsVal) ? objectsVal : 0)}</td>`,
              '</tr>',
            ].join('');
          })
          .join('')
      : '<tr class="empty-row"><td colspan="4">No hourly detection buckets recorded in the current 24-hour window.</td></tr>';

  const incidentBodyHtml =
    scopedIncidents.length > 0
      ? scopedIncidents
          .map(inc => {
            const rawTime = inc.time ?? inc.timestamp_utc ?? inc.timestamp ?? inc.receivedAt ?? '';
            const timeUtc = formatTimestampUtc(rawTime) || '—';
            const incidentId = inc._id ?? inc.incident_id ?? inc.id ?? '—';
            const cameraId = inc.camera_id ?? inc.cameraId ?? '—';
            const riskLabel = inc.risk ? String(inc.risk).toUpperCase() : 'UNSPECIFIED';
            const rawType = inc.type ?? 'unknown';
            const countNum = Number(inc.object_count ?? inc.flock_size);
            const countSuffix = Number.isFinite(countNum) && countNum > 0 ? ` ×${countNum}` : '';
            const confText = formatConfidenceDisplay(inc.confidence);
            const confSuffix = confText ? ` (${confText})` : '';
            const classificationDisplay = `${rawType}${countSuffix}${confSuffix}`;

            const { etaSeconds, etaBasis } = readCorridorEta(inc);
            const bearingParts = [];
            if (inc.direction) bearingParts.push(escapeHtml(inc.direction));
            if (etaBasis === 'image_space_corridor' && etaSeconds !== '') {
              bearingParts.push(`ETA ${escapeHtml(formatEtaDisplay(etaSeconds))}s (${escapeHtml(etaBasis)})`);
            }
            const bearingCellHtml = bearingParts.length > 0 ? bearingParts.join('<br>') : '—';

            const narrativeBlocks = [];
            const advisoryLabel = readAdvisoryLabel(inc);
            if (advisoryLabel) {
              narrativeBlocks.push(`<div><strong>Advisory Label:</strong> ${escapeHtml(advisoryLabel)}</div>`);
            }
            if (inc.report) {
              narrativeBlocks.push(`<div>${escapeHtml(inc.report)}</div>`);
            } else if (inc.alert_text) {
              narrativeBlocks.push(`<div>${escapeHtml(inc.alert_text)}</div>`);
            }

            const proofParts = [];
            if (inc.report_hash) {
              proofParts.push(`SHA-256: ${escapeHtml(inc.report_hash)}`);
            }
            const solanaStatus = inc.solana_status ?? (inc.solana_tx ? 'confirmed' : '');
            if (solanaStatus) {
              proofParts.push(`Solana: ${escapeHtml(solanaStatus)}`);
            }
            if (inc.solana_tx) {
              proofParts.push(`Tx: ${escapeHtml(inc.solana_tx)}`);
            }
            if (proofParts.length > 0) {
              narrativeBlocks.push(`<div class="proof-meta">${proofParts.join(' · ')}</div>`);
            }

            const narrativeHtml = narrativeBlocks.length > 0 ? narrativeBlocks.join('') : '—';

            return [
              '<tr class="incident-row">',
              `<td class="mono-cell">${escapeHtml(timeUtc)}</td>`,
              `<td class="mono-cell">${escapeHtml(incidentId)}</td>`,
              `<td class="mono-cell">${escapeHtml(cameraId)}</td>`,
              `<td class="mono-cell"><span class="risk-tag">${escapeHtml(riskLabel)}</span></td>`,
              `<td>${escapeHtml(classificationDisplay)}</td>`,
              `<td class="mono-cell">${bearingCellHtml}</td>`,
              `<td>${narrativeHtml}</td>`,
              '</tr>',
            ].join('');
          })
          .join('')
      : '<tr class="empty-row"><td colspan="7">No wildlife or UAS shift incidents recorded for this airport scope.</td></tr>';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>SkySentry Shift Summary — ${escapeHtml(airportInput)}</title>`,
    `<style>${PRINT_STYLESHEET}</style>`,
    '</head>',
    '<body>',
    '<main class="report-sheet">',
    '<header class="doc-banner">',
    '<p class="doc-kicker">FAA Airfield Wildlife &amp; UAS Operations Log</p>',
    '<h1 class="doc-title">SKYSENTRY TOWER — WILDLIFE &amp; UAS SHIFT SUMMARY</h1>',
    '<div class="doc-meta">',
    `<span>AIRPORT: ${escapeHtml(airportInput)}</span>`,
    `<span>GENERATED (UTC): ${escapeHtml(generatedIso)}</span>`,
    `<span>INCIDENTS LOGGED: ${escapeHtml(scopedIncidents.length)}</span>`,
    '</div>',
    '<p class="doc-note">Operational Note: Server detection governs live tower risk; SHA-256 and Solana devnet memos attest to report text integrity rather than detection accuracy. Video-only monitoring; not an ATC clearance.</p>',
    '</header>',
    '<section class="report-section" aria-labelledby="shift-kpi-heading">',
    '<h2 id="shift-kpi-heading" class="section-heading">1. Shift KPI Summary</h2>',
    `<div class="kpi-grid">${kpiCardsHtml}</div>`,
    '</section>',
    '<section class="report-section" aria-labelledby="hourly-totals-heading">',
    '<h2 id="hourly-totals-heading" class="section-heading">2. Hourly Detection Totals (24h Window)</h2>',
    '<table class="faa-table">',
    '<thead><tr><th>UTC Hour</th><th>Category</th><th>Detection Events</th><th>Total Objects</th></tr></thead>',
    `<tbody>${hourlyBodyHtml}</tbody>`,
    '</table>',
    '</section>',
    '<section class="report-section" aria-labelledby="incident-log-heading">',
    '<h2 id="incident-log-heading" class="section-heading">3. Detailed Incident Log</h2>',
    '<table class="faa-table">',
    '<thead><tr><th>UTC Time</th><th>Incident ID</th><th>Camera</th><th>Risk</th><th>Classification &amp; Count</th><th>Bearing &amp; Corridor ETA</th><th>Advisory Narrative &amp; Integrity Proof</th></tr></thead>',
    `<tbody>${incidentBodyHtml}</tbody>`,
    '</table>',
    '</section>',
    '<footer class="doc-footer">',
    `End of Shift Summary · Airport ${escapeHtml(airportInput)} · Generated ${escapeHtml(generatedIso)}`,
    '</footer>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

export function openPrintShiftReport(incidents = [], hourlyRows = [], options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const {
    airport = 'UNSPECIFIED',
    generatedAt = new Date(),
    win = typeof window !== 'undefined' ? window : null,
    autoPrint = true,
  } = opts;

  const html = buildShiftSummaryHtml(incidents, hourlyRows, { airport, generatedAt });
  if (!win || typeof win.open !== 'function') {
    return { html, opened: false };
  }

  const popup = win.open('', '_blank');
  if (!popup || !popup.document || typeof popup.document.write !== 'function') {
    return { html, opened: false };
  }

  try {
    popup.opener = null;
  } catch {
    // Ignore read-only opener properties in restricted environments.
  }

  if (typeof popup.document.open === 'function') {
    popup.document.open();
  }
  popup.document.write(html);
  if (typeof popup.document.close === 'function') {
    popup.document.close();
  }
  if (typeof popup.focus === 'function') {
    popup.focus();
  }
  if (autoPrint && typeof popup.print === 'function') {
    popup.print();
  }

  return { html, opened: true };
}

export function mountIncidentExportToolbar(containerEl, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const {
    getIncidents = () => [],
    getHourlyRows = () => [],
    getAirport = () => 'UNSPECIFIED',
    win = typeof window !== 'undefined' ? window : null,
    doc = containerEl?.ownerDocument ?? (typeof document !== 'undefined' ? document : null),
  } = opts;

  const isDomContainer = Boolean(
    containerEl &&
    typeof containerEl === 'object' &&
    (typeof containerEl.appendChild === 'function' || typeof containerEl.append === 'function')
  );

  if (!isDomContainer || !doc || typeof doc.createElement !== 'function') {
    return {
      element: null,
      destroy() {},
    };
  }

  const toolbar = doc.createElement('div');
  toolbar.className = 'sky-incident-toolbar';
  if (typeof toolbar.setAttribute === 'function') {
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Shift incident export tools');
  }

  const csvBtn = doc.createElement('button');
  csvBtn.type = 'button';
  csvBtn.className = 'ghost';
  csvBtn.textContent = 'Export CSV';

  const printBtn = doc.createElement('button');
  printBtn.type = 'button';
  printBtn.className = 'ghost';
  printBtn.textContent = 'Print Shift PDF';

  const handleCsvClick = () => {
    const rawAirport = typeof getAirport === 'function' ? getAirport() : undefined;
    const airport = normalizeAirportFilter(rawAirport) || undefined;
    const incidents = typeof getIncidents === 'function' ? getIncidents() : [];
    return exportIncidentsCsv(incidents, { airport, doc });
  };

  const handlePrintClick = () => {
    const rawAirport = typeof getAirport === 'function' ? getAirport() : 'UNSPECIFIED';
    const airport = typeof rawAirport === 'string' && rawAirport.trim() ? rawAirport.trim() : 'UNSPECIFIED';
    const incidents = typeof getIncidents === 'function' ? getIncidents() : [];
    const hourlyRows = typeof getHourlyRows === 'function' ? getHourlyRows() : [];
    return openPrintShiftReport(incidents, hourlyRows, { airport, win });
  };

  if (typeof csvBtn.addEventListener === 'function') {
    csvBtn.addEventListener('click', handleCsvClick);
  }
  if (typeof printBtn.addEventListener === 'function') {
    printBtn.addEventListener('click', handlePrintClick);
  }

  if (typeof toolbar.appendChild === 'function') {
    toolbar.appendChild(csvBtn);
    toolbar.appendChild(printBtn);
  } else if (typeof toolbar.append === 'function') {
    toolbar.append(csvBtn, printBtn);
  }

  if (typeof containerEl.appendChild === 'function') {
    containerEl.appendChild(toolbar);
  } else if (typeof containerEl.append === 'function') {
    containerEl.append(toolbar);
  }

  return {
    element: toolbar,
    destroy() {
      if (typeof csvBtn.removeEventListener === 'function') {
        csvBtn.removeEventListener('click', handleCsvClick);
      }
      if (typeof printBtn.removeEventListener === 'function') {
        printBtn.removeEventListener('click', handlePrintClick);
      }
      if (typeof toolbar.remove === 'function') {
        toolbar.remove();
      } else if (toolbar.parentNode && typeof toolbar.parentNode.removeChild === 'function') {
        toolbar.parentNode.removeChild(toolbar);
      }
    },
  };
}
