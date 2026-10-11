// Landing page top bar: when Clerk's client cookie says someone is signed in on this browser, show a
// Settings link in place of Sign in / Sign up. Reading the cookie avoids loading Clerk on the landing page;
// if it's stale, settings.html shows the sign-in prompt, so the worst case is one extra click.
(() => {
  const uat = document.cookie.match(/(?:^|;\s*)__client_uat=(\d+)/);
  if (!uat || uat[1] === '0') return;
  document.querySelector('header.bar .bar-link')?.remove();
  const cta = document.querySelector('header.bar .bar-cta');
  if (cta) { cta.href = '/settings.html'; cta.textContent = 'Settings'; }
})();
