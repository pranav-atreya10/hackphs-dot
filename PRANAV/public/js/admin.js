// Admin page (admin.html): list, create, re-code and delete airports via /api/admin/airports.
// Only accounts whose verified email is in the server's ADMIN_EMAILS get past the gate (the server checks too).
import { loadClerk } from '/js/auth.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const gate = html => { $('gate').hidden = false; $('gate').innerHTML = html; };
let clerk = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: `Bearer ${await clerk.session.getToken()}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

function row(a, isNew = false) {
  const tr = document.createElement('tr');
  if (isNew) tr.className = 'new';
  const fromEnv = a.source === 'env';
  tr.innerHTML = `<td><b>${esc(a.code)}</b></td><td>${esc(a.name)}</td>
    <td><code>${esc(a.joinCode)}</code></td>
    <td class="acts"><button class="ghost" data-act="copy">Copy</button>${fromEnv
      ? ' <span class="tag" title="Set in the server’s AIRPORT_CODES; change it in DigitalOcean">From server settings</span>'
      : '<button class="ghost" data-act="rotate">New code</button><button class="danger" data-act="delete">Delete</button>'}</td>`;
  tr.querySelector('[data-act="copy"]').onclick = async e => {
    try { await navigator.clipboard.writeText(a.joinCode); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1500); }
    catch { e.target.textContent = 'Copy failed'; }
  };
  const rotate = tr.querySelector('[data-act="rotate"]'), del = tr.querySelector('[data-act="delete"]');
  if (rotate) rotate.onclick = async () => {
    if (!confirm(`Make a new join code for ${a.code}? The old code stops working for new sign-ups.`)) return;
    try { tr.replaceWith(row(await api(`/api/admin/airports/${encodeURIComponent(a.code)}/rotate`, { method: 'POST' }), true)); $('listErr').textContent = ''; }
    catch (err) { $('listErr').textContent = err.message; }
  };
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${a.code} (${a.name})? Everyone signed up to it loses access.`)) return;
    try { await api(`/api/admin/airports/${encodeURIComponent(a.code)}`, { method: 'DELETE' }); tr.remove(); $('listErr').textContent = ''; }
    catch (err) { $('listErr').textContent = err.message; }
  };
  return tr;
}

const LABEL = { camera: 'Camera station', dashboard: 'Tower dashboard' };
const ago = t => { const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(); };
function showRequestCount() {
  const n = $('reqs').querySelectorAll('li[data-id]').length;
  $('reqCount').textContent = n || '';
  if (!n) $('reqs').innerHTML = '<li class="empty">No requests waiting.</li>';
}
function requestRow(r) {
  const li = document.createElement('li'); li.dataset.id = r._id;
  li.innerHTML = `<div><b>${esc(r.name || r.email || 'Unknown user')}</b>
      <span>${esc(r.email && r.name ? `${r.email} · ` : '')}${esc(r.airport)} · ${LABEL[r.from] || esc(r.from)} → <b>${LABEL[r.to] || esc(r.to)}</b> · ${ago(r.createdAt)}</span>
      ${r.note ? `<q>${esc(r.note)}</q>` : ''}</div>
    <div class="acts"><button data-act="approve" type="button">Approve</button><button class="ghost" data-act="deny" type="button">Deny</button></div>`;
  for (const b of li.querySelectorAll('button')) b.onclick = async () => {
    li.querySelectorAll('button').forEach(x => (x.disabled = true));
    try { await api(`/api/admin/role-requests/${encodeURIComponent(r._id)}/${b.dataset.act}`, { method: 'POST' }); li.remove(); showRequestCount(); $('reqErr').textContent = ''; }
    catch (err) { $('reqErr').textContent = err.message; li.querySelectorAll('button').forEach(x => (x.disabled = false)); }
  };
  return li;
}
async function loadRequests() {
  try { const { requests } = await api('/api/admin/role-requests'); $('reqs').replaceChildren(...requests.map(requestRow)); }
  catch (err) { $('reqs').replaceChildren(); $('reqErr').textContent = err.message; }
  showRequestCount();
}

async function load() {
  const { airports, canSave } = await api('/api/admin/airports');
  $('rows').replaceChildren(...airports.map(a => row(a)));
  if (!airports.length) $('rows').innerHTML = '<tr><td colspan="4" style="color:var(--mute)">No airports yet. Add the first one above.</td></tr>';
  $('addErr').textContent = canSave ? '' : 'MongoDB isn’t connected on the server, so new airports can’t be saved yet.';
}

$('add').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.submitter || $('add').querySelector('button'); btn.disabled = true;
  try {
    const a = await api('/api/admin/airports', { method: 'POST', body: JSON.stringify({ code: $('code').value, name: $('name').value }) });
    $('rows').querySelector('td[colspan]')?.parentElement.remove();
    $('rows').append(row(a, true));
    $('add').reset(); $('addErr').textContent = '';
  } catch (err) { $('addErr').textContent = err.message; }
  btn.disabled = false;
});
$('code').addEventListener('input', () => { $('code').value = $('code').value.toUpperCase(); });

async function main() {
  const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ publishableKey: null }));
  if (!cfg.publishableKey) return gate('<h2>Accounts aren’t on</h2><p>Sign-in isn’t set up on this server, so there are no admins. Airports come from <code>AIRPORT_CODES</code>.</p>');
  clerk = await loadClerk(cfg.publishableKey);
  if (!clerk.user) return gate('<h2>Sign in</h2><p>Sign in with an admin account to manage airports.</p><p><a href="/account.html?mode=sign-in">Sign in</a></p>');
  const me = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${await clerk.session.getToken()}` } }).then(r => r.json()).catch(() => ({}));
  if (!me.admin) return gate(`<h2>Admins only</h2><p>${esc(clerk.user.primaryEmailAddress?.emailAddress || 'This account')} isn’t an admin. Admins are set by email in the server’s <code>ADMIN_EMAILS</code> setting.</p>`);
  $('gate').hidden = true; $('reqPanel').hidden = false; $('addPanel').hidden = false; $('listPanel').hidden = false;
  await Promise.all([load(), loadRequests()]);
}
main().catch(err => gate(`<h2>Something went wrong</h2><p>${esc(err.message)}</p>`));
