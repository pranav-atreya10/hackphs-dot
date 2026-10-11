// Landing page top bar: when Clerk's client cookie says someone is signed in on this browser, show a
// Dashboard button in place of Sign in / Sign up: the tower, or the camera page for camera accounts (the role is
// remembered by settings.js / auth.js). Reading the cookie avoids loading Clerk on the landing page; if it's stale,
// the dashboard shows its sign-in screen, so the worst case is one extra click.
(() => {
  const uat = document.cookie.match(/(?:^|;\s*)__client_uat=(\d+)/);
  if (!uat || uat[1] === '0') return;
  document.querySelector('header.bar .bar-link')?.remove();
  const cta = document.querySelector('header.bar .bar-cta');
  let role = '';
  try { role = localStorage.getItem('skysentry.role') || ''; } catch {}
  if (cta) { cta.href = role === 'camera' ? '/camera.html' : '/tower.html'; cta.textContent = 'Dashboard'; }
})();
