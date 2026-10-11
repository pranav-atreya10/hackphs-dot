// Light / dark / system theme. Loaded (not deferred) in <head> so the page never flashes the wrong theme.
// Buttons marked [data-theme-toggle] cycle System → Light → Dark; [data-side-toggle] opens the mobile sidebar.
// Fires a "themechange" event on <html> so canvas-drawn things (charts) can recolour.
(() => {
  const KEY = 'skysentryTheme', root = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)');
  const read = () => { try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; } };
  const isDark = () => root.dataset.theme ? root.dataset.theme === 'dark' : dark.matches;
  const label = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
  const icon = {
    system: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    light: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>'
  };
  function apply(mode) {
    if (mode === 'system') delete root.dataset.theme; else root.dataset.theme = mode;
    document.querySelectorAll('[data-theme-toggle]').forEach(b => { b.innerHTML = icon[mode]; b.setAttribute('aria-label', label[mode]); b.title = label[mode]; });
    root.dispatchEvent(new CustomEvent('themechange', { detail: { dark: isDark() } }));
  }
  let current = read();   // kept in memory too, so the toggle still works when storage is blocked
  window.skysentryTheme = { isDark };
  apply(current);
  dark.addEventListener('change', () => { if (current === 'system') apply('system'); });
  document.addEventListener('DOMContentLoaded', () => {
    apply(current);
    document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', () => {
      current = { system: 'light', light: 'dark', dark: 'system' }[current];
      try { localStorage.setItem(KEY, current); } catch {}
      apply(current);
    }));
    document.querySelectorAll('[data-side-toggle]').forEach(b => b.addEventListener('click', () => {
      const side = document.getElementById(b.getAttribute('aria-controls'));
      const open = !side.hasAttribute('data-open');
      side.toggleAttribute('data-open', open); b.setAttribute('aria-expanded', String(open));
    }));
  });
})();
