// Account settings (settings.html): profile, airport access, security, sign out, and the light/dark theme.
// The theme works for everyone (saved in this browser by js/theme.js); the account part needs Clerk sign-in.
import { loadClerk, clerkAppearance } from '/js/auth.js';

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
  const access = me.role && me.airport
    ? `<div><span>Role</span><b>${tower ? 'Tower dashboard' : 'Camera station'}</b></div><div><span>Airport</span><b>${esc(me.airport)}</b></div>`
    : '<div><span>Airport access</span><b>Not set up yet</b></div>';
  const open = me.role && me.airport
    ? `<a href="${tower ? '/tower.html' : '/camera.html'}">${tower ? 'Open the tower' : 'Start the camera'}</a>`
    : '<a href="/account.html">Finish setting up</a>';

  show(`<div class="rows">
      <div><span>Name</span><b>${esc(user.fullName || user.username || '—')}</b></div>
      <div><span>Email</span><b>${esc(user.primaryEmailAddress?.emailAddress || '—')}</b></div>
      ${access}
    </div>
    <div class="actions">${open}<button class="ghost" id="manage" type="button">Profile and security</button><button class="ghost" id="out" type="button">Sign out</button></div>
    <p class="hint">Profile and security covers your name, email, password, two-step verification, signed-in devices and deleting your account.</p>`);
  $('manage').onclick = () => clerk.openUserProfile({ appearance: clerkAppearance() });
  $('out').onclick = () => clerk.signOut().then(() => location.assign('/'));
}

main().catch(err => show(`<p class="danger">${esc(err.message || err)}</p><div class="actions"><a href="/settings.html">Try again</a></div>`));
