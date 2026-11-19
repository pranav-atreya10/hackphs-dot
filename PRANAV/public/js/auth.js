// Sign-in for the camera and tower pages, matching server.js:
//   - Clerk on (server has CLERK_* keys): sign in, then finish sign-up once with a role and an airport code.
//     Sockets and API calls carry the Clerk session token.
//   - Clerk off: cameras use CAMERA_API_KEY (+ optional airport); towers are open or use TOWER_API_KEY.
//
// Usage: const auth = await signIn({ role: 'camera' | 'dashboard', mount: element });
//   auth.socketAuth()  -> object for io('/camera' | '/tower', { auth })
//   auth.headers()     -> headers for fetch('/api/...')
//   auth.label         -> short text for the page header

const CLERK_VERSION = '6.39.0';
let clerkLoading = null;
const store = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};

function frontendApi(publishableKey) {
  try {
    if (!/^pk_(test|live)_/.test(publishableKey)) throw new Error();
    const domain = atob(publishableKey.split('_')[2].replace(/-/g, '+').replace(/_/g, '/')).replace(/\$$/, '');
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain) || !domain.includes('.')) throw new Error();
    return `https://${domain}`;
  } catch { throw new Error('The sign-in service has an invalid publishable key.'); }
}
function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => fail(), 15000);
    const fail = () => {
      clearTimeout(timer); script.remove();
      reject(new Error('Could not load the sign-in service. Check your connection and refresh.'));
    };
    script.src = src; script.async = true; script.crossOrigin = 'anonymous';
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = fail;
    document.head.appendChild(script);
  });
}
export function loadClerk(publishableKey) {
  if (clerkLoading) return clerkLoading;
  clerkLoading = (async () => {
    const origin = frontendApi(publishableKey);
    // ClerkJS v6's core no longer contains the prebuilt SignIn/UserProfile UI.
    // Load the separate UI constructor before initializing the core, as Clerk's JS quickstart specifies.
    if (!window.__internal_ClerkUICtor) await loadScript(`${origin}/npm/@clerk/ui@1/dist/ui.browser.js`);
    if (!window.__internal_ClerkUICtor) throw new Error('The sign-in screen did not load. Refresh to try again.');
    if (!window.Clerk) await loadScript(`${origin}/npm/@clerk/clerk-js@${CLERK_VERSION}/dist/clerk.browser.js`, publishableKey);
    if (!window.Clerk) throw new Error('The sign-in service did not initialize. Refresh to try again.');
    await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    return window.Clerk;
  })().catch(err => { clerkLoading = null; throw err; });
  return clerkLoading;
}

export const MARK = '<svg class="mark" viewBox="10 2 80 96" aria-hidden="true"><path fill-rule="evenodd" d="M50 4 L88 16 L88 48 Q88 78 50 96 Q12 78 12 48 L12 16 Z M24 44 Q38 26 50 50 Q62 26 76 44 Q62 34 50 60 Q38 34 24 44 Z"/></svg>';
// Clerk's sign-in box takes the page's current light/dark tokens (css/app.css).
export function clerkAppearance() {
  const css = getComputedStyle(document.documentElement), v = name => css.getPropertyValue(name).trim();
  return { variables: { colorPrimary: v('--accent'), colorPrimaryForeground: v('--on-accent'), colorBackground: v('--card'), colorForeground: v('--ink'),
    colorMutedForeground: v('--mute'), colorInput: v('--card'), colorInputForeground: v('--ink'), colorBorder: v('--line'), fontFamily: v('--sans'), borderRadius: '8px' } };
}
// Each account type sees only its own side: camera accounts get no tower links, tower accounts no camera links.
// Admins, tower-key and open dashboards see both. Runs on load from the role this browser last signed in with,
// then again with the real one from signIn().
export function showRoleLinks(role) {
  const hide = { camera: '/tower.html', dashboard: '/camera.html' }[role];
  document.documentElement.dataset.role = role || '';
  for (const a of document.querySelectorAll('a[href^="/tower.html"]:not([data-any-role]), a[href^="/camera.html"]:not([data-any-role])')) a.hidden = Boolean(hide) && a.getAttribute('href').startsWith(hide);
  for (const el of document.querySelectorAll('[data-admin-only]')) el.hidden = role !== 'admin';
}

// The account tab at the bottom of the sidebar: what kind of account this is, and where Settings are.
// Remembered so pages without sign-in (Demos) can show it too.
export const ROLE_LABEL = { camera: 'Camera station', dashboard: 'Tower dashboard', admin: 'Admin' };
export function showAccount(account) {
  if (account) store.set('skysentry.account', JSON.stringify(account));
  let a = account;
  if (!a) try { a = JSON.parse(store.get('skysentry.account') || 'null'); } catch { a = null; }
  const who = document.getElementById('who'), sub = document.getElementById('whoSub');
  if (who) who.textContent = a?.type || 'Not signed in';
  if (sub) sub.textContent = a ? `${a.sub ? `${a.sub} · ` : ''}Settings` : 'Sign in or sign up';
  document.documentElement.dataset.account = a?.role || '';
}
// Signed out: forget the remembered account so the tab and links don't show the last person's.
export function forgetAccount() {
  for (const k of ['skysentry.account', 'skysentry.role']) try { localStorage.removeItem(k); } catch {}
  showAccount(); showRoleLinks(null);
}
// Ask an admin to switch this account to the other type. Resolves with the saved request.
export async function requestSwitch(headers, to, note = '') {
  const r = await fetch('/api/role-requests', { method: 'POST', headers: { ...(await headers()), 'content-type': 'application/json' }, body: JSON.stringify({ to, note }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Could not send the request.');
  return data.request;
}

// Admins can run a camera for any airport (handy for demos). They pick it once; it's remembered in this browser.
if (typeof document !== 'undefined' && document.documentElement) { showRoleLinks(store.get('skysentry.role')); showAccount(); }   // before sign-in finishes, so nothing flashes

export function panel(mount, html) {
  mount.hidden = false;
  mount.innerHTML = `<div class="auth-card">${MARK}${html}</div>`;
  return mount.firstElementChild;
}

// One-time step after a Clerk sign-up: pick "camera" or "dashboard" and enter the airport's join code.
// Resolves with { role, airport } once the server has saved them.
export function finishSetup({ mount, role = 'dashboard', headers, admin = false }) {
  return new Promise(resolve => {
    const card = panel(mount, `<h2>Finish setting up</h2>
      <p>Choose what this account does and enter your airport’s join code.</p>
      <form id="join"><label for="role">This account is a
        <select id="role"><option value="dashboard">Tower dashboard</option><option value="camera">Camera station</option></select></label>
        <label for="code">Airport join code<input id="code" autocomplete="off" required></label>
        <button>Continue</button><p class="auth-err" id="joinErr"></p></form>
      <p class="auth-help">${admin
        ? 'You’re an admin: get or create a join code on the <a href="/admin.html">admin page</a>.'
        : 'No code? Your SkySentry admin creates airports and their join codes. Ask them for yours.'}</p>
      <p class="auth-help"><a href="/">Home</a> · <a href="/settings.html">Settings</a> · <button class="linkbtn" id="setupOut" type="button">Sign out</button></p>`);
    card.querySelector('#setupOut').onclick = () => (window.Clerk?.signOut() ?? Promise.resolve()).then(() => location.assign('/'));
    card.querySelector('#role').value = role;
    card.querySelector('#join').addEventListener('submit', async e => {
      e.preventDefault();
      const body = { role: card.querySelector('#role').value, code: card.querySelector('#code').value.trim() };
      const r = await fetch('/api/auth/join', { method: 'POST', headers: { ...(await headers()), 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) resolve(data); else card.querySelector('#joinErr').textContent = data.error || 'That did not work. Try again.';
    });
  });
}

export function refreshSocketAuth(socket, auth) {
  if (auth.mode !== 'clerk') return;
  let interval;
  socket.on('connect', () => {
    clearInterval(interval);
    interval = setInterval(async () => {
      try {
        const { token } = await auth.socketAuth();
        if (socket.connected && token) socket.emit('auth:refresh', { token });
      } catch {
        socket.disconnect();
      }
    }, 10_000);
  });
  socket.on('disconnect', () => clearInterval(interval));
}

export async function signIn({ role, mount, onStatus = () => {}, demo = false }) {
  const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ publishableKey: null }));
  const params = new URLSearchParams(location.search);

  // ---------- Clerk sign-in ----------
  // If Clerk's script can't load (e.g. a production key on a domain without Clerk's DNS records), fall back to
  // the camera / tower keys below: the server accepts CAMERA_API_KEY and TOWER_API_KEY even with sign-in on.
  let clerkDown = false;
  const clerk = cfg.publishableKey ? await loadClerk(cfg.publishableKey).catch(err => { console.warn(err); clerkDown = true; return null; }) : null;
  if (clerk) {
    onStatus('Sign in to connect');
    if (!clerk.user) {
      const card = panel(mount, '<h2>Sign in</h2><p>Use your SkySentry account.</p><div id="clerk-sign-in"></div>');
      clerk.mountSignIn(card.querySelector('#clerk-sign-in'), { forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href, appearance: clerkAppearance() });
      await new Promise(resolve => clerk.addListener(({ user }) => { if (user) resolve(); }));
    }
    const token = () => clerk.session.getToken();
    const headers = async () => ({ authorization: `Bearer ${await token()}` });
    let me = await fetch('/api/auth/me', { headers: await headers() }).then(r => r.json()).catch(() => ({}));

    // Administrator status allows selecting a tower airport, not publishing camera data.
    const asAdmin = role === 'dashboard' && me.admin && !(me.role === role && me.airport);
    if (!asAdmin && (!me.role || !me.airport)) me = { ...me, ...(await finishSetup({ mount, role, headers, admin: me.admin })) };
    // A tower user may still open the local demo UI, but cannot obtain camera ingress authorization.
    const demoTower = demo && role === 'camera' && me.role === 'dashboard' && me.airport;
    if (!asAdmin && !demoTower && me.role !== role) {
      const mine = ROLE_LABEL[me.role], wanted = ROLE_LABEL[role], own = me.role === 'camera' ? 'camera' : 'tower';
      showAccount({ role: me.role, type: mine, sub: me.airport });
      const card = panel(mount, `<h2>This page is for ${wanted.toLowerCase()} accounts</h2>
        <p>You’re signed in as a <b class="type-badge">${mine}</b> at ${me.airport}. Open your own page, or ask an admin to switch this account.</p>
        <div class="auth-actions"><a class="btn-link" href="/${own}.html">Open the ${own}</a><button class="ghost" id="ask" type="button">Request a switch to ${wanted}</button></div>
        <p class="auth-help" id="askStatus" role="status"></p>
        <p class="auth-help"><a href="/settings.html">Account settings</a> · <button class="linkbtn" id="out" type="button">Sign out</button></p>`);
      card.querySelector('#out').onclick = () => clerk.signOut().then(forgetAccount).then(() => location.assign('/'));
      const ask = card.querySelector('#ask'), status = card.querySelector('#askStatus');
      const waiting = () => { ask.disabled = true; status.textContent = `Request sent: switch to ${wanted}. An admin will review it. Once it’s approved, reload this page.`; };
      fetch('/api/role-requests/mine', { headers: await headers() }).then(r => r.json()).then(({ request }) => { if (request?.status === 'pending' && request.to === role) waiting(); }).catch(() => {});
      ask.onclick = async () => {
        ask.disabled = true;
        try { await requestSwitch(headers, role); waiting(); } catch (err) { status.textContent = err.message; ask.disabled = false; }
      };
      throw new Error('wrong role');
    }
    store.set('skysentry.role', me.admin ? 'admin' : me.role);   // the landing page's Dashboard button and showRoleLinks read this
    showRoleLinks(me.admin ? 'admin' : me.role);
    mount.hidden = true;
    const airport = me.airport;
    showAccount(asAdmin ? { role: 'admin', type: 'Admin', sub: airport || 'Select an airport' } : { role: me.role, type: ROLE_LABEL[me.role], sub: me.airport });
    if (me.admin) {   // pending switch requests, as a count on the Admin tab
      fetch('/api/admin/role-requests', { headers: await headers() }).then(r => r.json()).then(({ requests = [] }) => {
        for (const a of document.querySelectorAll('a[href="/admin.html"]')) {
          a.querySelector('.count')?.remove();
          if (requests.length) a.append(Object.assign(document.createElement('span'), { className: 'count', textContent: requests.length, title: `${requests.length} switch request${requests.length > 1 ? 's' : ''}` }));
        }
      }).catch(() => {});
    }
    return {
      mode: 'clerk', role: me.admin ? 'admin' : me.role, airport,
      label: asAdmin ? `Admin · ${airport || 'select an airport'}` : `${me.airport} · signed in`,
      socketAuth: async extra => ({ token: await token(), ...extra }),
      headers,
      manageAccount: () => clerk.openUserProfile(),
      signOut: () => clerk.signOut().then(forgetAccount).then(() => location.reload())
    };
  }

  // ---------- Keys (sign-in not configured, or the sign-in service didn't load) ----------
  const why = clerkDown ? 'The sign-in service didn’t load, so connect with the' : 'Sign-in isn’t set up on this server, so cameras use the';
  if (role === 'camera') {
    let key = params.get('key') || store.get('skysentry.cameraKey');
    let airport = params.get('airport') || store.get('skysentry.airport');
    if (!key || !/^[A-Z0-9]{3,5}$/.test(airport || '')) {
      onStatus('Camera key needed');
      ({ key, airport } = await new Promise(resolve => {
        const card = panel(mount, `<h2>Connect this camera</h2>
          <p>${why} camera key from the server’s settings (<code>CAMERA_API_KEY</code>).</p>
          <form id="keyForm"><label for="ck">Camera key<input id="ck" type="password" required autocomplete="off"></label>
          <label for="ap">Airport code (e.g. KPCT)<input id="ap" required autocomplete="off"></label>
          <button>Connect</button></form>`);
        card.querySelector('#keyForm').addEventListener('submit', e => {
          e.preventDefault();
          resolve({ key: card.querySelector('#ck').value.trim(), airport: card.querySelector('#ap').value.trim().toUpperCase() });
        });
      }));
      store.set('skysentry.cameraKey', key); store.set('skysentry.airport', airport);
    }
    mount.hidden = true; showRoleLinks('camera');
    showAccount({ role: 'camera', type: 'Camera station', sub: `${airport || 'no airport'} · camera key` });
    return {
      mode: 'key', role: 'camera', airport: airport || null, label: airport ? `${airport} · camera key` : 'camera key',
      socketAuth: async extra => ({ key, airport: airport || undefined, ...extra }),
      headers: async () => ({ 'x-api-key': key, ...(airport ? { 'x-airport': airport } : {}) }),
      signOut: () => { store.set('skysentry.cameraKey', ''); location.reload(); }
    };
  }
  let key = params.get('key') || store.get('skysentry.towerKey');
  if (!key && !cfg.demoTower) {
    onStatus('Tower key needed');
    key = await new Promise(resolve => {
      const card = panel(mount, `<h2>Open the tower</h2>
        <p>${why} tower key from the server’s settings (<code>TOWER_API_KEY</code>).</p>
        <form id="keyForm"><label for="tk">Tower key<input id="tk" type="password" required autocomplete="off"></label><button>Connect</button></form>`);
      card.querySelector('#keyForm').addEventListener('submit', e => { e.preventDefault(); resolve(card.querySelector('#tk').value.trim()); });
    });
  }
  if (key) store.set('skysentry.towerKey', key);
  mount.hidden = true; showRoleLinks(null);
  showAccount({ role: 'dashboard', type: key ? 'Tower (key)' : 'Local demo tower', sub: 'One airport per connection' });
  return {
    mode: 'open', role: null, airport: null, label: key ? 'tower key' : 'open dashboard',
    socketAuth: async extra => ({ key: key || undefined, ...extra }),
    headers: async () => (key ? { 'x-api-key': key } : {}),
    signOut: () => { store.set('skysentry.towerKey', ''); location.reload(); }
  };
}
