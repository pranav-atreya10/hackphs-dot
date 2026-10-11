// Landing-page guide: a small "Ask about SkySentry" chat bubble that posts to /api/guide (OpenAI, public facts only).
// Self-contained in a shadow root so the site's styles and this widget never clash. Added by scripts/sync-web.mjs.
(() => {
  const host = document.createElement('div');
  host.id = 'skysentry-guide';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host{--paper:#f4efe6;--card:#fbf8f2;--ink:#1f1b16;--mute:#6e6458;--line:#ddd2bf;--clay:#c2643f;
    position:fixed;right:16px;bottom:16px;z-index:1000;font:15px/1.45 "DM Sans","IBM Plex Sans",system-ui,sans-serif;color:var(--ink)}
  button{font-family:inherit;font-weight:600;font-size:.9rem;border:0;cursor:pointer}
  .open{background:var(--ink);color:var(--paper);border-radius:99px;padding:12px 18px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
  .open:hover{background:var(--clay)}
  .panel{width:min(360px,calc(100vw - 32px));height:min(480px,calc(100vh - 100px));background:var(--card);border:1px solid var(--line);
    border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.2);display:grid;grid-template-rows:auto 1fr auto;overflow:hidden}
  .panel[hidden]{display:none}
  header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line)}
  header b{font:500 1.05rem "Source Serif 4",Georgia,serif}
  .x{background:none;color:var(--mute);font-size:1.3rem;line-height:1;padding:2px 6px}
  ul{list-style:none;margin:0;padding:12px;display:flex;flex-direction:column;gap:8px;overflow:auto}
  li{max-width:85%;padding:8px 12px;border-radius:12px;white-space:pre-wrap}
  li.user{align-self:flex-end;background:var(--ink);color:var(--paper);font-size:.9rem}
  li.bot{align-self:flex-start;background:var(--paper)}
  li.busy{color:var(--mute)}
  form{display:flex;gap:6px;padding:10px;border-top:1px solid var(--line)}
  input{flex:1;min-width:0;font:inherit;border:1px solid var(--line);border-radius:99px;padding:8px 12px;background:#fff;color:var(--ink)}
  form button{background:var(--ink);color:var(--paper);border-radius:99px;padding:8px 14px}
  form button:hover{background:var(--clay)} form button:disabled{opacity:.45}
  :focus-visible{outline:2px solid var(--clay);outline-offset:2px}
</style>
<button class="open" type="button" aria-expanded="false">Ask about SkySentry</button>
<section class="panel" hidden aria-label="SkySentry guide">
  <header><b>SkySentry guide</b><button class="x" type="button" aria-label="Close">×</button></header>
  <ul aria-live="polite"><li class="bot">Hi! Ask me how SkySentry works, what the risk levels mean, or how to set up a camera.</li></ul>
  <form><input placeholder="How does it detect drones?" aria-label="Your question" maxlength="1000" autocomplete="off"><button>Send</button></form>
</section>`;
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
