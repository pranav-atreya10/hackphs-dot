// Sign-in gate for the camera and tower pages (Clerk). The rules live on the SkySentry API server
// (PRANAV/server.js): it checks the airport code, saves the role, and enforces it on sockets and /api.
//
//   const auth = await requireRole('camera');   // or 'dashboard'
//   auth.getToken()  -> Clerk session token to send as { auth: { token } } or "Authorization: Bearer"
//
// If the API server has no Clerk keys, the gate stays out of the way and the page works as before.

const DEFAULT_SERVER = 'https://lancerhacks-rvs8r.ondigitalocean.app';
// ?server=http://localhost:8080 points the gate at a local API server while developing.
export const AUTH_SERVER = new URLSearchParams(location.search).get('server') || DEFAULT_SERVER;

const OTHER_PAGE = { camera: '../tower/', dashboard: '../camera/' };
const LABEL = { camera: 'camera', dashboard: 'dashboard' };

const css = `
#ssAuth{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:16px;
  background:var(--paper,#f4efe6);color:var(--ink,#1f1b16);font:15px/1.5 var(--sans,system-ui,sans-serif)}
#ssAuth .box{width:min(420px,100%);background:var(--card,#fbf8f2);border:1px solid var(--line,#ddd2bf);border-radius:12px;padding:20px;display:grid;gap:12px}
#ssAuth .box h2{margin:0;font:500 1.4rem var(--serif,Georgia,serif)}
#ssAuth .box p{margin:0;color:var(--mute,#6e6458)}
#ssAuth .box label{display:grid;gap:4px;font:500 .8rem var(--sans,system-ui);color:var(--mute,#6e6458)}
#ssAuth .box input{font:inherit;padding:8px;border:1px solid var(--line,#ddd2bf);border-radius:8px;background:#fff;color:var(--ink,#1f1b16)}
#ssAuth .box .roles{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#ssAuth .box .roles label{flex-direction:row;display:flex;align-items:center;gap:8px;border:1px solid var(--line,#ddd2bf);border-radius:8px;padding:10px;color:var(--ink,#1f1b16);font-size:.95rem;cursor:pointer}
#ssAuth .box button{font:600 1rem var(--sans,system-ui);background:var(--ink,#1f1b16);color:var(--paper,#f4efe6);border:0;border-radius:99px;padding:11px;cursor:pointer}
#ssAuth .box button.link{background:none;color:var(--clay,#c2643f);padding:4px;font-weight:500}
#ssAuth .box .err{color:var(--stop,#c0392b);min-height:1.2em}
#ssBadge{position:fixed;right:12px;top:12px;z-index:9998;display:flex;gap:8px;align-items:center;
  background:var(--card,#fbf8f2);border:1px solid var(--line,#ddd2bf);border-radius:99px;padding:4px 6px 4px 12px;
  font:500 .75rem var(--mono,ui-monospace,monospace);color:var(--mute,#6e6458)}
#ssBadge button{font:inherit;background:none;border:0;color:var(--clay,#c2643f);cursor:pointer}
`;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Full-screen panel; each step replaces its contents.
function overlay() {
  let root = document.getElementById('ssAuth');
  if (!root) {
    document.head.append(el('style', { textContent: css }));
    root = el('div', { id: 'ssAuth' });
    document.body.append(root);
  }
  return root;
}

function show(...children) {
  const box = el('div', { className: 'box' }, children);
  overlay().replaceChildren(box);
  return box;
}

async function api(path, token, options = {}) {
  const res = await fetch(AUTH_SERVER + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `server error ${res.status}`);
  return body;
}

function loadScript(src, attrs = {}) {
  return new Promise((resolve, reject) => {
    const s = el('script', { src, async: true, crossOrigin: 'anonymous' });
    Object.assign(s.dataset, attrs);
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

// Clerk's publishable key encodes its Frontend API host, which serves the browser SDK and, separately
// since clerk-js v6, the UI bundle that draws the sign-in form.
async function loadClerk(publishableKey) {
  const host = atob(publishableKey.split('_')[2]).replace(/\$$/, '');
  await Promise.all([
    loadScript(`https://${host}/npm/@clerk/ui@1/dist/ui.browser.js`),
    loadScript(`https://${host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { clerkPublishableKey: publishableKey }),
  ]);
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return window.Clerk;
}

// Wait until someone is signed in, showing Clerk's sign-in / sign-up form meanwhile.
function signedIn(Clerk) {
  if (Clerk.user) return Promise.resolve();
  const mount = el('div');
  overlay().replaceChildren(mount);
  Clerk.mountSignIn(mount, { fallbackRedirectUrl: location.href, signUpFallbackRedirectUrl: location.href });
  return new Promise((resolve) => {
    Clerk.addListener(({ user }) => {
      if (!user) return;
      Clerk.unmountSignIn(mount);
      resolve();
    });
  });
}

// First visit after sign-up: pick camera or dashboard and enter the airport code.
function joinForm(Clerk, wanted) {
  return new Promise((resolve) => {
    const roleInput = (role) =>
      el('label', {}, [el('input', { type: 'radio', name: 'ssRole', value: role, checked: role === wanted }), `${LABEL[role][0].toUpperCase()}${LABEL[role].slice(1)}`]);
    const code = el('input', { id: 'ssCode', autocomplete: 'off', required: true, placeholder: 'from your airport' });
    const err = el('p', { className: 'err' });
    const submit = el('button', { type: 'submit', textContent: 'Continue' });
    const form = el('form', { className: 'box' }, [
      el('h2', { textContent: 'Finish setting up' }),
      el('p', { textContent: 'Is this account a camera station or a tower dashboard? Your airport gives you a code to join.' }),
      el('div', { className: 'roles' }, [roleInput('camera'), roleInput('dashboard')]),
      el('label', { htmlFor: 'ssCode' }, ['Airport code', code]),
      err,
      submit,
    ]);
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.textContent = '';
      try {
        const role = form.querySelector('input[name="ssRole"]:checked').value;
        resolve(await api('/api/auth/join', await Clerk.session.getToken(), { method: 'POST', body: JSON.stringify({ role, code: code.value }) }));
      } catch (error) {
        err.textContent = error.message;
        submit.disabled = false;
      }
    };
    overlay().replaceChildren(form);
    code.focus();
  });
}

const signOut = (Clerk) => Clerk.signOut().then(() => location.reload());

export async function requireRole(wanted) {
  show(el('p', { textContent: 'Checking sign-in…' }));
  let config;
  try {
    config = await api('/api/auth/config');
  } catch {
    show(el('h2', { textContent: 'Server unreachable' }), el('p', { textContent: `Could not reach ${AUTH_SERVER}. Check your connection and reload.` }));
    return new Promise(() => {});
  }
  // Sign-in is off on the server: let the page run as before.
  if (!config.publishableKey) {
    document.getElementById('ssAuth')?.remove();
    return { role: null, airport: null, getToken: async () => null };
  }

  let Clerk;
  try {
    Clerk = await loadClerk(config.publishableKey);
  } catch (error) {
    show(el('h2', { textContent: 'Sign-in unavailable' }), el('p', { textContent: `${error.message}. Check your connection and reload.` }));
    return new Promise(() => {});
  }
  await signedIn(Clerk);

  let access = await api('/api/auth/me', await Clerk.session.getToken()).catch(() => ({}));
  if (!access.role || !access.airport) access = await joinForm(Clerk, wanted);

  if (access.role !== wanted) {
    show(
      el('h2', { textContent: `This is a ${LABEL[access.role]} account` }),
      el('p', { textContent: `It can't open the ${LABEL[wanted]} page. Sign in with a ${LABEL[wanted]} account, or go to the ${LABEL[access.role]} page.` }),
      el('button', { textContent: `Open the ${LABEL[access.role]} page`, onclick: () => location.assign(OTHER_PAGE[wanted] + location.search) }),
      el('button', { className: 'link', textContent: 'Sign out', onclick: () => signOut(Clerk) })
    );
    return new Promise(() => {});
  }

  document.getElementById('ssAuth')?.remove();
  document.body.append(
    el('div', { id: 'ssBadge' }, [
      `${access.airport} · ${LABEL[access.role]}`,
      el('button', { textContent: 'Sign out', onclick: () => signOut(Clerk) }),
    ])
  );
  return { role: access.role, airport: access.airport, getToken: () => Clerk.session.getToken() };
}
