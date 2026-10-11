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
  for (const a of document.querySelectorAll('a[href^="/tower.html"], a[href^="/camera.html"]')) a.hidden = Boolean(hide) && a.getAttribute('href').startsWith(hide);
  for (const el of document.querySelectorAll('[data-admin-only]')) el.hidden = role !== 'admin';
}

// Admins can run a camera for any airport (handy for demos). They pick it once; it's remembered in this browser.
const ADMIN_CAMERA_AIRPORT = 'skysentry.adminCameraAirport';
async function pickCameraAirport({ mount, headers }) {
  const { airports = [] } = await fetch('/api/airports', { headers: await headers() }).then(r => r.json()).catch(() => ({}));
  const saved = store.get(ADMIN_CAMERA_AIRPORT);
  if (airports.some(a => a.code === saved)) return saved;
  if (!airports.length) {
    panel(mount, '<h2>No airports yet</h2><p>Create an airport on the <a href="/admin.html">admin page</a> first, then come back to start this camera.</p>');
    throw new Error('no airports');
  }
  return new Promise(resolve => {
    const options = airports.map(a => `<option value="${a.code}">${a.code}${a.name && a.name !== a.code ? ` · ${a.name.replace(/[<>&"]/g, '')}` : ''}</option>`).join('');
    const card = panel(mount, `<h2>Which airport is this camera at?</h2>
      <p>You’re an admin, so this camera can report to any airport. Its alerts go to that airport’s tower.</p>
      <form id="pick"><label for="ap">Airport<select id="ap">${options}</select></label><button>Start this camera</button></form>`);
    card.querySelector('#pick').addEventListener('submit', e => {
      e.preventDefault();
      const code = card.querySelector('#ap').value;
      store.set(ADMIN_CAMERA_AIRPORT, code); resolve(code);
    });
  });
}

if (typeof document !== 'undefined' && document.documentElement) showRoleLinks(store.get('skysentry.role'));   // before sign-in finishes, so nothing flashes

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

export async function signIn({ role, mount, onStatus = () => {} }) {
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

    // Admins use both pages without a join code: the tower for every airport, a camera for an airport they pick.
    // (An admin who also joined an airport as this role uses that instead.)
    const asAdmin = me.admin && !(me.role === role && me.airport);
    const adminAirport = asAdmin && role === 'camera' ? await pickCameraAirport({ mount, headers }) : null;
    if (!asAdmin && (!me.role || !me.airport)) me = { ...me, ...(await finishSetup({ mount, role, headers, admin: me.admin })) };
    if (!asAdmin && me.role !== role) {
      panel(mount, `<h2>Wrong account type</h2><p>This account is set up as a ${me.role === 'camera' ? 'camera station' : 'tower dashboard'}. Open the <a href="/${me.role === 'camera' ? 'camera' : 'tower'}.html">${me.role === 'camera' ? 'camera' : 'tower'} page</a> instead, or sign out and use another account.</p><button id="out">Sign out</button>`)
        .querySelector('#out').onclick = () => clerk.signOut().then(() => location.reload());
      throw new Error('wrong role');
    }
    store.set('skysentry.role', me.admin ? 'admin' : me.role);   // the landing page's Dashboard button and showRoleLinks read this
    showRoleLinks(me.admin ? 'admin' : me.role);
    mount.hidden = true;
    const airport = asAdmin ? adminAirport : me.airport;
    return {
      mode: 'clerk', role: me.admin ? 'admin' : me.role, airport,
      label: asAdmin ? `Admin · ${airport || 'all airports'}` : `${me.airport} · signed in`,
      socketAuth: async extra => ({ token: await token(), ...(adminAirport ? { airport: adminAirport } : {}), ...extra }),
      changeAirport: adminAirport ? () => { store.set(ADMIN_CAMERA_AIRPORT, ''); location.reload(); } : null,
      headers: adminAirport ? async () => ({ ...(await headers()), 'x-airport': adminAirport }) : headers,
      manageAccount: () => clerk.openUserProfile(),
      signOut: () => clerk.signOut().then(() => location.reload())
    };
  }

  // ---------- Keys (sign-in not configured, or the sign-in service didn't load) ----------
  const why = clerkDown ? 'The sign-in service didn’t load, so connect with the' : 'Sign-in isn’t set up on this server, so cameras use the';
  if (role === 'camera') {
    let key = params.get('key') || store.get('skysentry.cameraKey');
    let airport = params.get('airport') || store.get('skysentry.airport');
    if (!key) {
      onStatus('Camera key needed');
      ({ key, airport } = await new Promise(resolve => {
        const card = panel(mount, `<h2>Connect this camera</h2>
          <p>${why} camera key from the server’s settings (<code>CAMERA_API_KEY</code>).</p>
          <form id="keyForm"><label for="ck">Camera key<input id="ck" type="password" required autocomplete="off"></label>
          <label for="ap">Airport code (optional, e.g. KPCT)<input id="ap" value="${airport}" autocomplete="off"></label>
          <button>Connect</button></form>`);
        card.querySelector('#keyForm').addEventListener('submit', e => {
          e.preventDefault();
          resolve({ key: card.querySelector('#ck').value.trim(), airport: card.querySelector('#ap').value.trim().toUpperCase() });
        });
      }));
      store.set('skysentry.cameraKey', key); store.set('skysentry.airport', airport);
    }
    mount.hidden = true; showRoleLinks('camera');
    return {
      mode: 'key', role: 'camera', airport: airport || null, label: airport ? `${airport} · camera key` : 'camera key',
      socketAuth: async extra => ({ key, airport: airport || undefined, ...extra }),
      headers: async () => ({ 'x-api-key': key, ...(airport ? { 'x-airport': airport } : {}) }),
      signOut: () => { store.set('skysentry.cameraKey', ''); location.reload(); }
    };
  }
  let key = params.get('key') || store.get('skysentry.towerKey');
  if (!key && clerkDown) {   // the server still wants a sign-in, so ask for the tower key instead of opening a dashboard that gets refused
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
  return {
    mode: 'open', role: null, airport: null, label: key ? 'tower key' : 'open dashboard',
    socketAuth: async extra => ({ key: key || undefined, ...extra }),
    headers: async () => (key ? { 'x-api-key': key } : {}),
    signOut: () => { store.set('skysentry.towerKey', ''); location.reload(); }
  };
}
