// Sign up / sign in page (account.html), linked from the landing page's top bar.
//   /account.html                 -> Clerk sign-up
//   /account.html?mode=sign-in    -> Clerk sign-in
// After sign-up, the same "finish setting up" step as the camera/tower pages (role + airport join code),
// then a small account card with links into the tower or camera page.
import { loadClerk, clerkAppearance, panel, finishSetup } from '/js/auth.js';

const mount = document.getElementById('auth');
const SIGN_UP = '/account.html', SIGN_IN = '/account.html?mode=sign-in';
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

async function main() {
  const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ publishableKey: null }));
  if (!cfg.publishableKey) {
    panel(mount, `<h2>Accounts aren’t on yet</h2>
      <p>This server doesn’t have sign-in set up, so the tower and camera pages work without an account for now.</p>
      <div class="actions"><a href="/tower.html">Open the tower</a><a href="/camera.html">Start a camera</a></div>`);
    return;
  }

  const clerk = await loadClerk(cfg.publishableKey);
  if (!clerk.user) {
    const signingIn = new URLSearchParams(location.search).get('mode') === 'sign-in';
    const card = panel(mount, signingIn
      ? `<h2>Sign in</h2><p>Welcome back to SkySentry.</p><div id="clerk-box"></div>`
      : `<h2>Create your account</h2><p>Run a camera station or a tower dashboard for your airport. You’ll need your airport’s join code.</p><div id="clerk-box"></div>`);
    const opts = { signInUrl: SIGN_IN, signUpUrl: SIGN_UP, forceRedirectUrl: SIGN_UP, signUpForceRedirectUrl: SIGN_UP, appearance: clerkAppearance() };
    if (signingIn) clerk.mountSignIn(card.querySelector('#clerk-box'), opts);
    else clerk.mountSignUp(card.querySelector('#clerk-box'), opts);
    await new Promise(resolve => clerk.addListener(({ user }) => { if (user) resolve(); }));
  }

  const headers = async () => ({ authorization: `Bearer ${await clerk.session.getToken()}` });
  let me = await fetch('/api/auth/me', { headers: await headers() }).then(r => r.json()).catch(() => ({}));
  if (!me.role || !me.airport) me = await finishSetup({ mount, headers });

  const email = clerk.user.primaryEmailAddress?.emailAddress || clerk.user.username || 'Signed in';
  const tower = me.role === 'dashboard';
  const card = panel(mount, `<h2>You’re all set</h2>
    <div class="acct">
      <div><span>Account</span><b>${esc(email)}</b></div>
      <div><span>Role</span><b>${tower ? 'Tower dashboard' : 'Camera station'}</b></div>
      <div><span>Airport</span><b>${esc(me.airport)}</b></div>
    </div>
    <div class="actions"><a href="${tower ? '/tower.html' : '/camera.html'}">${tower ? 'Open the tower' : 'Start the camera'}</a>
      <button class="ghost" id="manage" type="button">Manage account</button><button class="ghost" id="out" type="button">Sign out</button></div>`);
  card.querySelector('#manage').onclick = () => clerk.openUserProfile({ appearance: clerkAppearance() });
  card.querySelector('#out').onclick = () => clerk.signOut().then(() => location.assign('/'));
}

main().catch(err => panel(mount, `<h2>Something went wrong</h2><p>${esc(err.message || err)}</p>
  <div class="actions"><a href="${SIGN_UP}">Try again</a></div>`));
