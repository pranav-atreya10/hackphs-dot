// First-visit walkthrough for new users on the Tower and Camera pages.
// Shows once per page (remembered in localStorage); "Take the tour" in the side menu replays it.
// Steps whose element isn't on screen (hidden for this account, or the sidebar on a phone) are skipped.
(() => {
  const TOURS = {
    tower: [
      { title: 'Welcome to the tower dashboard', text: 'This page shows what your airport’s cameras see, live, and warns you about birds and drones near the runway. This tour takes about a minute.' },
      { el: '#risk', title: 'Risk level', text: 'Green: the sky is clear. Yellow: a bird or an unidentified object is in view. Red: a drone, a flock of 5 or more, birds gathering fast, or something heading into the runway corridor. The reason is written underneath.' },
      { el: '#feedsCard', title: 'Live camera feeds', text: 'Every camera station at your airport appears here, with boxes around what the detector is tracking.' },
      { el: '#sound', title: 'Alert sound', text: 'Turn this on so new alerts are spoken out loud. Browsers only allow sound after you click once.' },
      { el: '#map', title: 'Airport map', text: 'Shows each camera and what it can see. Pins mark where each threat was spotted.' },
      { el: '#addCamera', title: 'Add a camera', text: 'Scan this QR code with a phone to turn it into a camera station. Point it at the sky along the approach path.' },
      { el: 'section:has(#incidents)', title: 'Incident reports', text: 'Each new alert becomes a short report written by AI. Click one to see the details.' },
      { el: '#chart', title: 'Detections by hour', text: 'How busy the sky has been over the last 24 hours.' },
      { el: '#ask', title: 'Ask the assistant', text: 'Ask questions in plain words, like “When were birds worst today?”' },
      { title: 'You’re all set', text: 'You can replay this tour any time with “Take the tour” in the menu.' },
    ],
    camera: [
      { title: 'Welcome to the camera station', text: 'This page turns this device into a camera that watches the sky and sends what it sees to the tower. This tour takes about a minute.' },
      { el: '#start', title: 'Start watching', text: 'Point the camera at the sky along the runway approach and press Start. Keep the device steady, on a stand if you can.' },
      { el: '#upload', title: 'No camera handy?', text: 'Upload a video of the sky instead, and the detector will run on that.' },
      { el: '#phoneQr', title: 'Use your phone', text: 'On a laptop? Scan this QR code to use your phone as the camera instead.' },
      { el: '#settings', title: 'Settings', text: 'Set which way the camera faces, and draw the runway corridor on the picture so the tower gets warned when something heads into it.' },
      { el: '#risk', title: 'What the detector sees', text: 'The current risk level and the reason for it, the same one the tower sees.' },
      { title: 'You’re all set', text: 'You can replay this tour any time with “Take the tour” in the menu.' },
    ],
  };

  const page = /camera/.test(location.pathname) ? 'camera' : /tower/.test(location.pathname) ? 'tower' : null;
  if (!page) return;
  const KEY = `skysentry.tour.${page}.v1`;
  const store = {
    get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
    set: () => { try { localStorage.setItem(KEY, 'done'); } catch {} },
  };

  const css = `
  .tour-shade{position:fixed;inset:0;z-index:9998;background:rgb(0 0 0/.45)}
  .tour-spot{position:fixed;z-index:9999;border-radius:12px;box-shadow:0 0 0 9999px rgb(0 0 0/.45),0 0 0 2px var(--accent,#0a0a0a);pointer-events:none;transition:all .2s ease}
  .tour-box{position:fixed;z-index:10000;width:min(360px,calc(100vw - 32px));background:var(--card,#fff);color:var(--ink,#0a0a0a);border:1px solid var(--line,#e5e7eb);border-radius:14px;padding:16px 18px;box-shadow:0 12px 32px rgb(0 0 0/.2);font:15px/1.5 var(--sans,system-ui,sans-serif)}
  .tour-box h3{margin:0 0 6px;font-size:1.05rem}
  .tour-box p{margin:0 0 14px;color:var(--ink,#0a0a0a)}
  .tour-row{display:flex;align-items:center;gap:8px}
  .tour-count{margin-right:auto;color:var(--mute,#6b7280);font-size:.85rem}
  .tour-box button{font:500 .9rem var(--sans,system-ui,sans-serif);border-radius:8px;padding:7px 12px;cursor:pointer;border:1px solid var(--line-2,#d4d4d8);background:var(--card,#fff);color:var(--ink,#0a0a0a)}
  .tour-box button.primary{background:var(--accent,#0a0a0a);color:var(--on-accent,#fff);border-color:var(--accent,#0a0a0a)}
  .tour-box button.skip{border:0;background:none;color:var(--mute,#6b7280);padding:7px 4px}
  @media (max-width:640px){.tour-box{left:16px!important;right:16px;bottom:16px;top:auto!important;width:auto}}`;

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };

  let shade, spot, box, steps, i, prevFocus;

  function close() {
    store.set();
    for (const n of [shade, spot, box]) n && n.remove();
    shade = spot = box = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }

  function onKey(e) {
    if (!box) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }

  function place() {
    if (!box) return;
    const s = steps[i];
    const el = s.el && document.querySelector(s.el);
    if (!el) {
      spot.hidden = true; shade.hidden = false;
      box.style.left = `${Math.max(16, (innerWidth - box.offsetWidth) / 2)}px`;
      box.style.top = `${Math.max(16, (innerHeight - box.offsetHeight) / 2)}px`;
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { // couldn't be scrolled into view: show the step without a spotlight
      spot.hidden = true; shade.hidden = false;
      box.style.left = `${Math.max(16, (innerWidth - box.offsetWidth) / 2)}px`;
      box.style.top = `${Math.max(16, (innerHeight - box.offsetHeight) / 2)}px`;
      return;
    }
    const pad = 6;
    shade.hidden = true; spot.hidden = false;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const bh = box.offsetHeight, bw = box.offsetWidth;
    let top = r.bottom + 14;
    if (top + bh > innerHeight - 16) top = r.top - bh - 14;            // no room below: go above
    if (top < 16) top = Math.min(innerHeight - bh - 16, Math.max(16, r.top + 16)); // tall element: overlap its top
    top = Math.max(16, Math.min(innerHeight - bh - 16, top));             // always fully on screen
    const left = Math.min(innerWidth - bw - 16, Math.max(16, r.left));
    box.style.top = `${top}px`;
    box.style.left = `${left}px`;
  }

  function render() {
    const s = steps[i];
    const last = i === steps.length - 1;
    box.innerHTML = `<h3 id="tourTitle"></h3><p id="tourText"></p>
      <div class="tour-row"><span class="tour-count">${i + 1} of ${steps.length}</span>
      ${last ? '' : '<button type="button" class="skip">Skip tour</button>'}
      ${i ? '<button type="button" class="back">Back</button>' : ''}
      <button type="button" class="primary next">${last ? 'Done' : 'Next'}</button></div>`;
    box.querySelector('#tourTitle').textContent = s.title;
    box.querySelector('#tourText').textContent = s.text;
    box.querySelector('.next').onclick = () => (last ? close() : go(1));
    const back = box.querySelector('.back'); if (back) back.onclick = () => go(-1);
    const skip = box.querySelector('.skip'); if (skip) skip.onclick = close;
    const el = s.el && document.querySelector(s.el);
    if (el) el.scrollIntoView({ block: 'center' });
    place();
    box.querySelector('.next').focus();
  }

  function go(d) {
    i = Math.max(0, Math.min(steps.length - 1, i + d));
    render();
  }

  function start() {
    if (box) return;
    // Only steps whose element is on screen right now (or that have no element).
    steps = TOURS[page].filter((s) => !s.el || visible(document.querySelector(s.el)));
    if (!steps.length) return;
    if (!document.getElementById('tourCss')) {
      const st = document.createElement('style'); st.id = 'tourCss'; st.textContent = css; document.head.appendChild(st);
    }
    prevFocus = document.activeElement;
    shade = document.createElement('div'); shade.className = 'tour-shade';
    spot = document.createElement('div'); spot.className = 'tour-spot';
    box = document.createElement('div'); box.className = 'tour-box';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'tourTitle');
    shade.onclick = close;
    document.body.append(shade, spot, box);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    i = 0;
    render();
  }

  // "Take the tour" link in the side menu.
  function addMenuLink() {
    const nav = document.querySelector('.side-nav');
    if (!nav || nav.querySelector('[data-tour]')) return;
    const a = document.createElement('a');
    a.href = '#'; a.dataset.tour = '';
    a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14"/><path d="M12 17h.01"/></svg>Take the tour';
    a.onclick = (e) => { e.preventDefault(); start(); };
    nav.appendChild(a);
  }

  window.SkySentryTour = { start };
  const boot = () => {
    addMenuLink();
    // First visit: wait until the page has settled and nothing is covering it (the sign-in /
    // "Connect this camera" box), then open the tour. Checks every second; gives up after 10 minutes.
    if (store.get()) return;
    let tries = 0;
    const blocked = () => visible(document.getElementById('auth')) || document.visibilityState === 'hidden';
    const timer = setInterval(() => {
      if (++tries > 600 || box) return clearInterval(timer);
      if (tries >= 2 && !blocked()) { clearInterval(timer); start(); }
    }, 1000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
