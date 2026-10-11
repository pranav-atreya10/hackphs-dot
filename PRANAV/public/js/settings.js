// Account settings (settings.html): profile, airport access, security, sign out, and the light/dark theme.
// The theme works for everyone (saved in this browser by js/theme.js); the account part needs Clerk sign-in.
import { loadClerk, clerkAppearance, ROLE_LABEL, showAccount, requestSwitch } from '/js/auth.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const account = $('account');
const show = html => { account.innerHTML = `<h2>Account</h2>${html}`; };

/* ---------- appearance ---------- */
const theme = window.skysentryTheme;
for (const input of document.querySelectorAll('#theme input')) {
  input.checked = input.value === theme.mode();
  input.addEventListener('change', () => theme.set(input.value));
}

/* ---------- account ---------- */
async function main() {
  const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ publishableKey: null }));
  if (!cfg.publishableKey) {
    show('<p>Accounts aren’t turned on for this server, so there’s nothing to manage here yet.</p>');
    return;
  }
  const clerk = await loadClerk(cfg.publishableKey);
  if (!clerk.user) {
    show(`<p>Sign in to see your account settings.</p>
      <div class="actions"><a href="/account.html?mode=sign-in">Sign in</a><a class="ghost" href="/account.html">Sign up</a></div>`);
    return;
  }

  const user = clerk.user;
  const me = await fetch('/api/auth/me', { headers: { authorization: `Bearer ${await clerk.session.getToken()}` } })
    .then(r => r.json()).catch(() => ({}));
  const tower = me.role === 'dashboard';
  const type = me.admin ? (me.role ? `Admin · ${ROLE_LABEL[me.role]}` : 'Admin') : ROLE_LABEL[me.role] || 'Not set up yet';
  try { if (me.role || me.admin) localStorage.setItem('skysentry.role', me.admin ? 'admin' : me.role); } catch {}   // the landing page's Dashboard button reads this
  showAccount(me.admin ? { role: 'admin', type: 'Admin', sub: me.airport || 'All airports' } : me.role ? { role: me.role, type: ROLE_LABEL[me.role], sub: me.airport } : null);
  const airport = me.airport ? `${esc(me.airport)}${me.airportName && me.airportName !== me.airport ? ` · ${esc(me.airportName)}` : ''}` : '';
  const access = `<div><span>Account type</span><b><span class="type-badge">${esc(type)}</span></b></div>`
    + (me.admin ? '<div><span>Admin</span><b>Manages airports, join codes and switch requests</b></div>' : '')
    + (me.airport ? `<div><span>Airport</span><b>${airport}</b></div>` : '');
  const open = (me.admin ? '<a href="/admin.html">Manage airports</a>' : '') + (me.role && me.airport
    ? `<a class="${me.admin ? 'ghost' : ''}" href="${tower ? '/tower.html' : '/camera.html'}">${tower ? 'Open the tower' : 'Start the camera'}</a>`
    : me.admin ? '<a class="ghost" href="/tower.html">Open the tower (all airports)</a>' : '<a href="/account.html">Finish setting up</a>');

  show(`<div class="rows">
      <div><span>Name</span><b>${esc(user.fullName || user.username || '—')}</b></div>
      <div><span>Email</span><b>${esc(user.primaryEmailAddress?.emailAddress || '—')}</b></div>
      ${access}
    </div>
    <div class="actions">${open}<button class="ghost" id="manage" type="button">Profile and security</button><button class="ghost" id="out" type="button">Sign out</button></div>
    <p class="hint">Profile and security covers your name, email, password, two-step verification and signed-in devices.</p>
    ${me.role && me.airport ? '<div class="switch" id="switchBox"></div>' : ''}
    <div class="rows"><div><span>Delete account</span><button class="danger-btn" id="delete" type="button">Delete my account</button></div></div>`);
  $('manage').onclick = () => clerk.openUserProfile({ appearance: clerkAppearance() });
  if (me.role && me.airport) switchSection(clerk, me);
  $('out').onclick = () => clerk.signOut().then(() => location.assign('/'));
  $('delete').onclick = async () => {
    if (!confirm('Delete your SkySentry account? This can’t be undone.')) return;
    try { await user.delete(); await clerk.signOut().catch(() => {}); location.assign('/'); }
    catch (err) { show(`<p class="danger">${esc(err.errors?.[0]?.longMessage || err.message || 'Could not delete the account.')}</p><div class="actions"><a href="/settings.html">Back</a></div>`); }
  };
}

/* ---------- switching account type: ask an admin ---------- */
async function switchSection(clerk, me) {
  const box = $('switchBox'), to = me.role === 'camera' ? 'dashboard' : 'camera', wanted = ROLE_LABEL[to];
  const headers = async () => ({ authorization: `Bearer ${await clerk.session.getToken()}` });
  const render = request => {
    if (request?.status === 'pending') {
      box.innerHTML = `<h3>Switch account type</h3><p>You asked to switch to <b>${esc(ROLE_LABEL[request.to])}</b>. Waiting for an admin.</p>
        <div class="actions"><button class="ghost" id="cancelReq" type="button">Cancel request</button></div>`;
      $('cancelReq').onclick = async () => {
        await fetch('/api/role-requests/mine', { method: 'DELETE', headers: await headers() }).catch(() => {});
        render(null);
      };
      return;
    }
    const before = request?.status === 'denied' ? '<p class="hint">An admin declined your last request.</p>'
      : request?.status === 'approved' ? `<p class="hint">An admin switched this account to ${esc(ROLE_LABEL[request.to])}.</p>` : '';
    box.innerHTML = `<h3>Switch account type</h3>${before}<p>Need the other side? Ask an admin to make this account a <b>${wanted}</b>. You keep your airport.</p>
      <form class="req" id="reqForm"><input id="reqNote" maxlength="300" placeholder="Why? (optional)" autocomplete="off"><button>Request switch</button></form><p class="danger" id="reqErr"></p>`;
    $('reqForm').onsubmit = async e => {
      e.preventDefault();
      try { render(await requestSwitch(headers, to, $('reqNote').value)); } catch (err) { $('reqErr').textContent = err.message; }
    };
  };
  const { request = null } = await fetch('/api/role-requests/mine', { headers: await headers() }).then(r => r.json()).catch(() => ({}));
  render(request);
}

main().catch(err => show(`<p class="danger">${esc(err.message || err)}</p><div class="actions"><a href="/settings.html">Try again</a></div>`));
