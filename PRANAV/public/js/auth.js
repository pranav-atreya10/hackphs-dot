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
function loadClerk(publishableKey) {
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

function panel(mount, html) {
  mount.hidden = false;
  mount.innerHTML = `<div class="auth-card">${html}</div>`;
  return mount.firstElementChild;
}

export async function signIn({ role, mount, onStatus = () => {} }) {
  const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ publishableKey: null }));
  const params = new URLSearchParams(location.search);

  // ---------- Clerk sign-in ----------
  if (cfg.publishableKey) {
    onStatus('Sign in to connect');
    const clerk = await loadClerk(cfg.publishableKey);
    if (!clerk.user) {
      const card = panel(mount, '<h2>Sign in</h2><p>Use your SkySentry account.</p><div id="clerk-sign-in"></div>');
      clerk.mountSignIn(card.querySelector('#clerk-sign-in'), { forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
      await new Promise(resolve => clerk.addListener(({ user }) => { if (user) resolve(); }));
    }
    const token = () => clerk.session.getToken();
    const headers = async () => ({ authorization: `Bearer ${await token()}` });
    let me = await fetch('/api/auth/me', { headers: await headers() }).then(r => r.json()).catch(() => ({}));

    if (!me.role || !me.airport) {
      me = await new Promise(resolve => {
        const card = panel(mount, `<h2>Finish setting up</h2>
          <p>Choose what this account does and enter your airport’s join code.</p>
          <form id="join"><label for="role">This account is a
            <select id="role"><option value="dashboard">Tower dashboard</option><option value="camera">Camera station</option></select></label>
            <label for="code">Airport join code<input id="code" autocomplete="off" required></label>
            <button>Continue</button><p class="auth-err" id="joinErr"></p></form>`);
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
    if (me.role !== role) {
      panel(mount, `<h2>Wrong account type</h2><p>This account is set up as a ${me.role === 'camera' ? 'camera station' : 'tower dashboard'}. Open the <a href="/${me.role === 'camera' ? 'camera' : 'tower'}.html">${me.role === 'camera' ? 'camera' : 'tower'} page</a> instead, or sign out and use another account.</p><button id="out">Sign out</button>`)
        .querySelector('#out').onclick = () => clerk.signOut().then(() => location.reload());
      throw new Error('wrong role');
    }
    mount.hidden = true;
    return {
      mode: 'clerk', airport: me.airport, label: `${me.airport} · signed in`,
      socketAuth: async extra => ({ token: await token(), ...extra }),
      headers,
      manageAccount: () => clerk.openUserProfile(),
      signOut: () => clerk.signOut().then(() => location.reload())
    };
  }

  // ---------- Keys (sign-in not configured) ----------
  if (role === 'camera') {
    let key = params.get('key') || store.get('skysentry.cameraKey');
    let airport = params.get('airport') || store.get('skysentry.airport');
    if (!key) {
      onStatus('Camera key needed');
      ({ key, airport } = await new Promise(resolve => {
        const card = panel(mount, `<h2>Connect this camera</h2>
          <p>Sign-in isn’t set up on this server, so cameras use the camera key from the server’s settings (<code>CAMERA_API_KEY</code>).</p>
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
    mount.hidden = true;
    return {
      mode: 'key', airport: airport || null, label: airport ? `${airport} · camera key` : 'camera key',
      socketAuth: async extra => ({ key, airport: airport || undefined, ...extra }),
      headers: async () => ({ 'x-api-key': key, ...(airport ? { 'x-airport': airport } : {}) }),
      signOut: () => { store.set('skysentry.cameraKey', ''); location.reload(); }
    };
  }
  const key = params.get('key') || store.get('skysentry.towerKey');
  if (params.get('key')) store.set('skysentry.towerKey', key);
  mount.hidden = true;
  return {
    mode: 'open', airport: null, label: key ? 'tower key' : 'open dashboard',
    socketAuth: async extra => ({ key: key || undefined, ...extra }),
    headers: async () => (key ? { 'x-api-key': key } : {}),
    signOut: () => { store.set('skysentry.towerKey', ''); location.reload(); }
  };
}
