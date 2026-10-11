// Landing-page guide: a small "Ask about SkySentry" chat bubble that posts to /api/guide (OpenAI, public facts only).
// Self-contained in a shadow root so the site's styles and this widget never clash. Added by scripts/sync-web.mjs.
(() => {
  const host = document.createElement('div');
  host.id = 'skysentry-guide';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host{--paper:#f4f4f5;--card:#fff;--ink:#0a0a0a;--on-ink:#fff;--mute:#6b7280;--line:#e5e7eb;
    position:fixed;right:16px;bottom:16px;z-index:1000;font:15px/1.45 "Geist",system-ui,-apple-system,sans-serif;color:var(--ink);color-scheme:light}
  :host([data-theme="dark"]){--paper:#1c1c1c;--card:#111;--ink:#fafafa;--on-ink:#0a0a0a;--mute:#a1a1aa;--line:#2a2a2a;color-scheme:dark}
  @media (prefers-color-scheme:dark){:host(:not([data-theme="light"])){--paper:#1c1c1c;--card:#111;--ink:#fafafa;--on-ink:#0a0a0a;--mute:#a1a1aa;--line:#2a2a2a;color-scheme:dark}}
  button{font-family:inherit;font-weight:500;font-size:.9rem;border:0;cursor:pointer}
  .open{display:flex;align-items:center;gap:9px;background:var(--ink);color:var(--on-ink);border-radius:12px;padding:10px 16px 10px 12px;box-shadow:0 8px 24px -8px rgba(0,0,0,.35)}
  .open svg{width:16px;height:19px;fill:currentColor}
  .open:hover{opacity:.88}
  .panel{width:min(360px,calc(100vw - 32px));height:min(480px,calc(100vh - 100px));background:var(--card);border:1px solid var(--line);
    border-radius:14px;box-shadow:0 16px 48px -12px rgba(0,0,0,.3);display:grid;grid-template-rows:auto 1fr auto;overflow:hidden}
  .panel[hidden]{display:none}
  header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line)}
  header b{display:flex;align-items:center;gap:8px;font-weight:600;font-size:.98rem;letter-spacing:-.01em}
  header b svg{width:15px;height:18px;fill:currentColor}
  .x{background:none;color:var(--mute);font-size:1.3rem;line-height:1;padding:2px 6px;border-radius:6px} .x:hover{background:var(--paper);color:var(--ink)}
  ul{list-style:none;margin:0;padding:12px;display:flex;flex-direction:column;gap:8px;overflow:auto}
  li{max-width:85%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;font-size:.93rem}
  li.user{align-self:flex-end;background:var(--ink);color:var(--on-ink)}
  li.bot{align-self:flex-start;background:var(--paper)}
  li.busy{color:var(--mute)}
  form{display:flex;gap:6px;align-items:center;margin:10px;padding:6px 6px 6px 12px;border:1px solid var(--line);border-radius:12px}
  form:focus-within{border-color:var(--mute)}
  input{flex:1;min-width:0;font:inherit;border:0;outline:none;padding:6px 0;background:transparent;color:var(--ink)}
  input::placeholder{color:var(--mute)}
  form button{width:32px;height:32px;padding:0;border-radius:50%;display:grid;place-items:center;background:var(--ink);color:var(--on-ink)}
  form button svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  form button:hover{opacity:.86} form button:disabled{opacity:.4}
  :focus-visible{outline:2px solid var(--ink);outline-offset:2px}
</style>
<button class="open" type="button" aria-expanded="false"><svg viewBox="10 2 80 96" aria-hidden="true"><path fill-rule="evenodd" d="M50 4 L88 16 L88 48 Q88 78 50 96 Q12 78 12 48 L12 16 Z M24 44 Q38 26 50 50 Q62 26 76 44 Q62 34 50 60 Q38 34 24 44 Z"/></svg>Ask about SkySentry</button>
<section class="panel" hidden aria-label="SkySentry guide">
  <header><b><svg viewBox="10 2 80 96" aria-hidden="true"><path fill-rule="evenodd" d="M50 4 L88 16 L88 48 Q88 78 50 96 Q12 78 12 48 L12 16 Z M24 44 Q38 26 50 50 Q62 26 76 44 Q62 34 50 60 Q38 34 24 44 Z"/></svg>SkySentry guide</b><button class="x" type="button" aria-label="Close">×</button></header>
  <ul aria-live="polite"><li class="bot">Hi! Ask me how SkySentry works, what the risk levels mean, or how to set up a camera.</li></ul>
  <form><input placeholder="How does it detect drones?" aria-label="Your question" maxlength="1000" autocomplete="off"><button aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></form>
</section>`;
  // Follow the page's light/dark choice (js/theme.js sets data-theme on <html>); the shadow root can't see <html>.
  const syncTheme = () => { const t = document.documentElement.dataset.theme; if (t) host.dataset.theme = t; else delete host.dataset.theme; };
  syncTheme(); new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const $ = s => root.querySelector(s);
  const open = $('.open'), panel = $('.panel'), log = $('ul'), form = $('form'), input = $('input'), send = $('form button');
  let history = [];

  const toggle = show => { panel.hidden = !show; open.hidden = show; open.setAttribute('aria-expanded', String(show)); if (show) input.focus(); else open.focus(); };
  open.addEventListener('click', () => toggle(true));
  $('.x').addEventListener('click', () => toggle(false));
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });

  const bubble = (cls, text) => { const li = document.createElement('li'); li.className = cls; li.textContent = text; log.append(li); log.scrollTop = log.scrollHeight; return li; };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = input.value.trim(); if (!q) return;
    input.value = ''; send.disabled = true;
    history.push({ role: 'user', content: q }); bubble('user', q);
    const reply = bubble('bot busy', 'Thinking…');
    try {
      const r = await fetch('/api/guide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: history }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      reply.textContent = data.answer; history.push({ role: 'assistant', content: data.answer });
    } catch (err) {
      reply.textContent = `Sorry, I couldn't answer: ${err.message}`; history.pop();
    } finally { reply.classList.remove('busy'); send.disabled = false; history = history.slice(-6); input.focus(); }
  });

  document.body.append(host);
})();
