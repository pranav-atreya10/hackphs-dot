"""Builds dist/site.html: a product site for SkySentry with the film embedded.

The film's styles, stage markup and scripts are taken from dist/index.html so the
site always plays the current film. Run: python3 tools/build_site.py
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent / "dist"
film = (ROOT / "index.html").read_text(encoding="utf-8")

body = film[film.index("<body>") + len("<body>"):] if "<body>" in film else film
body = body.replace("</body>\n</html>", "").replace("</body></html>", "")
head_end = body.index('<div class="wrap">')
script_start = body.index('<script type="importmap">')
film_head = body[:head_end].replace("<title>SkySentry in Motion</title>", "")
film_stage = body[head_end:script_start]
film_scripts = body[script_start:]

stage_tag = '<div class="stage" id="stage">'
assert stage_tag in film_stage
film_stage = film_stage.replace(stage_tag, stage_tag + """
      <div class="film-poster" id="filmPoster">
        <img src="./film-poster.svg" alt="" width="1280" height="720">
        <a class="btn-s primary" id="filmLaunch" href="./index.html">Play the 100-second film</a>
        <span id="filmLaunchStatus" role="status"></span>
      </div>""", 1)

# On a long page, Space should scroll unless the film is on screen.
key_guard = 'document.addEventListener("keydown", e => {\n'
assert key_guard in film_scripts
film_scripts = film_scripts.replace(key_guard, key_guard + '    { const r = stage.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return; }\n', 1)

launch = 'startFilm().catch(showFilmError);'
assert launch in film_scripts
film_scripts = film_scripts.replace(launch, """
const film = document.getElementById("film");
const filmPoster = document.getElementById("filmPoster");
const launch = document.getElementById("filmLaunch");
const status = document.getElementById("filmLaunchStatus");
let warmFetched = false;
const warmFilmAssets = () => {
  if (warmFetched || filmPoster?.dataset.warmFetched === "1" || navigator.connection?.saveData) return;
  warmFetched = true;
  if (filmPoster) filmPoster.dataset.warmFetched = "1";
  warmObserver?.disconnect();
  for (const url of [
    "./vendor/three.module.js",
    "./film-enhancements.js",
    "./details.js",
    "./cinema.js",
    "./assets/narrow-body-airliner.glb",
    "./assets/derelict_airfield_01_1k.hdr"
  ]) fetch(url, {priority: "low"}).catch(() => {});
};
const warmObserver = typeof IntersectionObserver === "function" && filmPoster
  ? new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) warmFilmAssets(); }, {rootMargin: "300px"})
  : null;
if (filmPoster) {
  warmObserver?.observe(filmPoster);
  filmPoster.addEventListener("pointerenter", warmFilmAssets, {once: true, passive: true});
  filmPoster.addEventListener("focusin", warmFilmAssets, {once: true});
}
let launching = false, failed = false;
launch.addEventListener("click", async event => {
  if (failed || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  if (launching) return;
  launching = true;
  status.textContent = "Starting film…";
  try {
    await startFilm({userInitiated: true});
    film.classList.add("film-started");
    if (document.activeElement === launch) document.getElementById("play").focus();
    document.getElementById("filmPoster").remove();
  } catch (error) {
    showFilmError(error);
    failed = true;
    status.textContent = "The embedded film could not start.";
    launch.textContent = "Try the standalone film";
  }
});""", 1)

SITE_HEAD = """<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;1,8..60,400&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Layout: one 1080px column on warm paper; serif headlines, quiet sans text, the film framed as the centrepiece. Single committed light look. */
:root{
  --paper:#f4efe6; --paper-2:#ebe3d4; --card:#fbf8f2; --ink-s:#1f1b16; --mute-s:#6e6458; --line-s:#ddd2bf; --clay:#c2643f;
  --serif:"Source Serif 4",Georgia,"Times New Roman",serif; --sans:"DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif; --mono-s:"JetBrains Mono",ui-monospace,Menlo,monospace;
  color-scheme:light;
}
html,body{background:var(--paper)!important;color:var(--ink-s)!important}
body{font-family:var(--sans)}
html{scroll-behavior:smooth;scroll-padding-top:72px}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
::selection{background:#e9c9b6}
.site{max-width:1080px;margin:0 auto;padding-inline:24px;padding-block:0 64px}
.bar{position:sticky;top:env(safe-area-inset-top,0px);z-index:50;background:var(--paper);border-bottom:1px solid var(--line-s)}
.bar-in{max-width:1080px;margin:0 auto;padding-inline:24px;height:60px;display:flex;align-items:center;gap:28px}
.brand{font:500 1.35rem/1 var(--serif);color:var(--ink-s);text-decoration:none;display:flex;align-items:center;gap:10px}
.brand i{width:9px;height:9px;border-radius:50%;background:var(--clay)}
.nav{display:flex;gap:24px;margin-left:auto}
.nav a{font:500 .9rem var(--sans);color:var(--mute-s);text-decoration:none}
.nav a:hover,.nav a:focus-visible{color:var(--ink-s)}
.tag{font:500 .72rem var(--mono-s);letter-spacing:.06em;color:var(--mute-s);border:1px solid var(--line-s);border-radius:99px;padding:5px 11px}
@media (max-width:820px){.nav{display:none}.bar-in .tag{margin-left:auto}}

.hero{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:56px;align-items:end;padding-block:80px 44px}
.eyebrow-s{font:500 .78rem var(--mono-s);letter-spacing:.04em;color:var(--clay)}
.hero h1{margin:16px 0 0;font:400 clamp(2.5rem,5.6vw,4.2rem)/1.04 var(--serif);letter-spacing:-.02em;color:var(--ink-s);text-wrap:balance}
.hero h1 em{font-style:italic;color:var(--clay)}
.hero p{margin:22px 0 0;font:400 1.13rem/1.65 var(--sans);color:var(--mute-s);max-width:50ch}
.cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:30px}
.btn-s{display:inline-flex;align-items:center;gap:8px;font:500 .95rem var(--sans);text-decoration:none;padding:11px 18px;border-radius:99px;border:1px solid var(--line-s);color:var(--ink-s);background:var(--card)}
.btn-s.primary{background:var(--ink-s);border-color:var(--ink-s);color:var(--paper)}
.btn-s:hover{border-color:var(--clay)}
.btn-s.primary:hover{background:var(--clay);border-color:var(--clay)}
.btn-s:focus-visible,.nav a:focus-visible,summary:focus-visible,#film .btn:focus-visible,#film .seg:focus-visible{outline:2px solid var(--clay);outline-offset:3px}
.sheet{margin:0;display:grid;border-top:1px solid var(--ink-s)}
.sheet div{display:grid;grid-template-columns:6.5rem minmax(0,1fr);gap:14px;padding:13px 0;border-bottom:1px solid var(--line-s)}
.sheet dt{font:500 .74rem var(--mono-s);color:var(--mute-s);padding-top:3px}
.sheet dd{margin:0;font:400 .98rem/1.45 var(--sans);color:var(--ink-s)}
@media (max-width:860px){.hero{grid-template-columns:1fr;gap:34px;padding-block:52px 28px}}

/* The film keeps its own 3D stage; its frame, captions and controls take the paper palette and these typefaces. */
#film{scroll-margin-top:72px;--surround:var(--paper);--surround-2:var(--card);--on-surround:var(--ink-s);--on-surround-mute:var(--mute-s);--sign:var(--clay);--display:var(--serif);--body:var(--sans);--mono:var(--mono-s)}
#film .wrap{max-width:none;padding-inline:0;padding-block:8px 0}
#film .top{display:none}
/* Frosted-glass blur over a moving 3D canvas is re-rendered every frame; use solid panels instead. */
#film *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
#film .glass,#film .callout .lb{background:rgba(251,248,242,.96)}
#film .dash{background:rgba(14,28,46,.97)}
#film .stage{border-radius:16px;box-shadow:0 1px 0 var(--line-s),0 24px 60px -24px rgba(60,40,20,.35)}
#film:not(.film-started) :is(.caption,.transport,.bar,.hint,#assetLoader){display:none}
.film-poster{position:absolute;inset:0;z-index:25;display:grid;align-content:center;justify-items:center;gap:14px;background:#13283d;color:white;text-align:center;padding:16px}
.film-poster img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.film-poster :is(a,span){position:relative}
.film-poster span:not(:empty){padding:4px 8px;background:#13283d;border-radius:4px}
#film .caption{font-family:var(--serif);font-size:clamp(1.05rem,2vw,1.3rem);color:var(--ink-s)}
#film .btn{background:var(--card);border-color:var(--line-s);color:var(--ink-s);border-radius:99px}
#film .btn.primary{background:var(--ink-s);border-color:var(--ink-s);color:var(--paper)}
#film .btn:hover{border-color:var(--clay)}
#film .seg i{background:var(--line-s)}
#film .seg i b{background:var(--clay)}
#film #creditsToggle{border-top-color:var(--line-s)}
#film #creditsToggle summary{color:var(--mute-s)}
#film #creditsToggle a{color:var(--clay)}
#film #assetStatus{color:var(--clay)}
#film #assetLoader{background:var(--paper-2);color:var(--ink-s)}
#film .load-title{font-family:var(--serif);font-weight:400;letter-spacing:.02em}
#film .load-note{color:var(--mute-s)}
#film .title-block h2,#film .close h2{font-weight:500;letter-spacing:-.02em}
.film-note{font:400 .86rem var(--sans);color:var(--mute-s);margin:8px 0 0}

.sec{padding-block:96px 0}
.sec-head{display:grid;gap:12px;max-width:620px;margin-bottom:36px}
.sec h2{margin:0;font:400 clamp(2rem,3.6vw,2.7rem)/1.1 var(--serif);letter-spacing:-.015em;color:var(--ink-s);text-wrap:balance}
.sec-head p{margin:0;font:400 1.04rem/1.65 var(--sans);color:var(--mute-s)}

.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px;border-top:1px solid var(--ink-s);padding-top:26px}
.fact{display:grid;gap:10px;align-content:start}
.fact b{font:400 3rem/1 var(--serif);letter-spacing:-.02em;color:var(--ink-s);font-variant-numeric:tabular-nums}
.fact b.warn{color:var(--clay);font-style:italic}
.fact span{font:500 .74rem var(--mono-s);color:var(--mute-s)}
.fact p{margin:0;font:400 .99rem/1.6 var(--sans);color:var(--ink-s)}

.steps3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
.step3{background:var(--card);border:1px solid var(--line-s);border-radius:14px;padding:26px;display:grid;gap:12px;align-content:start}
.step3 svg{width:34px;height:34px}
.step3 h3{margin:0;font:500 1.45rem/1.1 var(--serif);color:var(--ink-s)}
.step3 p{margin:0;font:400 .98rem/1.6 var(--sans);color:var(--mute-s)}
.step3 code{font:500 .74rem var(--mono-s);color:var(--clay)}

.risk{display:grid;border-top:1px solid var(--ink-s)}
.risk-row{display:grid;grid-template-columns:8.5rem minmax(0,1fr) minmax(0,1.1fr);gap:24px;padding:20px 0;border-bottom:1px solid var(--line-s);align-items:baseline}
.risk-row.head{padding-block:12px}
.risk-row.head span{font:500 .74rem var(--mono-s);color:var(--mute-s)}
.lvl{display:inline-flex;align-items:center;gap:9px;font:500 1.15rem var(--serif)}
.lvl i{width:10px;height:10px;border-radius:50%}
.risk-row p{margin:0;font:400 .99rem/1.55 var(--sans);color:var(--ink-s)}
.risk-row p + p{color:var(--mute-s)}
@media (max-width:720px){
  .risk-row{grid-template-columns:1fr;gap:6px}
  .risk-row.head{position:absolute;width:1px;height:1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
}

.journey{list-style:none;padding:0;display:grid;counter-reset:j;border-left:1px solid var(--line-s);margin:0 0 0 15px}
.journey li{counter-increment:j;position:relative;padding:0 0 24px 36px;display:grid;gap:4px}
.journey li::before{content:counter(j);position:absolute;left:-15px;top:-3px;width:30px;height:30px;border-radius:50%;background:var(--card);border:1px solid var(--clay);display:grid;place-items:center;font:500 .8rem var(--mono-s);color:var(--clay)}
.journey li:last-child{padding-bottom:0}
.journey b{font:500 1.15rem var(--serif);color:var(--ink-s)}
.journey span{font:400 .96rem/1.55 var(--sans);color:var(--mute-s);max-width:60ch}
.journey em{font:500 .72rem var(--mono-s);font-style:normal;color:var(--clay)}
.split2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:56px;align-items:start}
@media (max-width:860px){.split2{grid-template-columns:1fr;gap:36px}}

.stack{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 40px;border-top:1px solid var(--ink-s)}
.stack div{padding:18px 0;border-bottom:1px solid var(--line-s);display:grid;gap:4px}
.stack b{font:500 1.12rem var(--serif);color:var(--ink-s)}
.stack span{font:400 .93rem/1.5 var(--sans);color:var(--mute-s)}
@media (max-width:860px){.facts,.steps3,.stack{grid-template-columns:1fr}.facts{gap:28px}}
@media (min-width:600px) and (max-width:860px){.stack{grid-template-columns:repeat(2,minmax(0,1fr))}}

.limits{background:var(--paper-2);border-radius:14px;padding:24px 26px;display:grid;gap:10px}
.limits h3{margin:0;font:500 1.3rem var(--serif);color:var(--ink-s)}
.limits ul{margin:0;padding-left:18px;display:grid;gap:7px;font:400 .97rem/1.55 var(--sans);color:var(--mute-s)}

.faq{display:grid;border-top:1px solid var(--ink-s)}
.faq details{border-bottom:1px solid var(--line-s)}
.faq summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:16px;padding:20px 2px;font:400 1.2rem var(--serif);color:var(--ink-s)}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font:400 1.4rem var(--sans);color:var(--clay);line-height:1}
.faq details[open] summary::after{content:"\\2212"}
.faq p{margin:0 0 20px;font:400 1rem/1.65 var(--sans);color:var(--mute-s);max-width:68ch}

.foot{margin-top:96px;padding-top:26px;border-top:1px solid var(--line-s);display:flex;flex-wrap:wrap;gap:14px 32px;justify-content:space-between;font:400 .88rem/1.6 var(--sans);color:var(--mute-s)}
.foot b{font:500 1.2rem var(--serif);color:var(--ink-s)}
</style>
"""

ICON = {
  "eye": '<svg viewBox="0 0 36 36" fill="none" stroke="#c2643f" stroke-width="2"><path d="M3 18s5.5-9 15-9 15 9 15 9-5.5 9-15 9S3 18 3 18Z"/><circle cx="18" cy="18" r="4.5"/></svg>',
  "server": '<svg viewBox="0 0 36 36" fill="none" stroke="#c2643f" stroke-width="2" stroke-linecap="round"><rect x="5" y="6" width="26" height="10" rx="2"/><rect x="5" y="20" width="26" height="10" rx="2"/><path d="M10 11h2M10 25h2"/></svg>',
  "tower": '<svg viewBox="0 0 36 36" fill="none" stroke="#c2643f" stroke-width="2" stroke-linejoin="round"><path d="M11 9h14l-2 7H13Z"/><path d="M15 16v15h6V16M10 31h16"/><path d="M27 6c2 1.5 3 3.3 3 5.5M30 3c3 2.3 4.5 5 4.5 8.5" stroke-linecap="round"/></svg>',
}

SITE_BODY = f"""
<header class="bar"><div class="bar-in">
  <a class="brand" href="#top"><i></i>SkySentry</a>
  <nav class="nav" aria-label="Sections">
    <a href="#film">Film</a><a href="#why">Why</a><a href="#how">How it works</a><a href="#risk">Risk levels</a><a href="#system">System</a><a href="#faq">FAQ</a>
  </nav>
  <span class="tag">hackPHS 2026</span>
</div></header>

<main class="site" id="top">
  <section class="hero">
    <div>
      <span class="eyebrow-s">Into the skies · Small-airport safety</span>
      <h1>An early-warning system for <em>birds and drones</em> near runways</h1>
      <p>SkySentry is a prototype that sends camera video to a server and shows potential hazards on a tower dashboard. It is advisory only, not a source of runway clearance.</p>
      <div class="cta"><a class="btn-s primary" href="#film">Watch the 100-second film</a><a class="btn-s" href="#how">How it works</a></div>
    </div>
    <dl class="sheet" aria-label="At a glance">
      <div><dt>Coverage</dt><dd>Monitored video only; streamed JPEGs have no drone audio</dd></div>
      <div><dt>Alerts</dt><dd>On-screen warnings; optional speech for fresh alerts</dd></div>
      <div><dt>Built for</dt><dd>Exploring supplemental monitoring at small airports</dd></div>
      <div><dt>Readiness</dt><dd>Prototype, not qualified for airport operations</dd></div>
    </dl>
  </section>

  <section id="film" aria-label="SkySentry film">
{film_stage}
  <p class="film-note">Illustrated prototype. Detection readings, alerts, reports and charts in the film are simulated.</p>
  </section>

  <section class="sec" id="why">
    <div class="sec-head"><span class="eyebrow-s">Why it matters</span><h2>The sky over a runway is crowded</h2>
      <p>Birds and drones can share the low airspace that departing aircraft climb through. A video feed covers only part of that space.</p></div>
    <div class="facts">
      <div class="fact"><span>Jan 15, 2009 · LaGuardia</span><b>2 of 2</b><p>engines lost when geese struck US Airways Flight 1549 minutes after takeoff, forcing the “Miracle on the Hudson” landing.</p></div>
      <div class="fact"><span>December 2018 · Gatwick</span><b>≈1,000</b><p>flights disrupted when repeated drone sightings shut down London’s Gatwick Airport over three days.</p></div>
      <div class="fact"><span>Prototype scope</span><b class="warn">Video only</b><p>SkySentry supplements observation. It is not radar and does not detect every hazard.</p></div>
    </div>
  </section>

  <section class="sec" id="how">
    <div class="sec-head"><span class="eyebrow-s">How it works</span><h2>From camera frames to tower warnings</h2>
      <p>An authorized camera sends live JPEG frames. The server runs the video detector and assigns risk for that airport.</p></div>
    <div class="steps3">
      <div class="step3">{ICON["eye"]}<h3>Streams video</h3><p>The camera sends images, not risk decisions. Recorded uploads and synthetic scenes stay in the local preview.</p><code>Live JPEG · no audio</code></div>
      <div class="step3">{ICON["server"]}<h3>Evaluates video on the server</h3><p>The detector tracks motion and estimates risk. An optional image review is advisory and does not change server-assigned risk.</p><code>Motion · tracking · risk</code></div>
      <div class="step3">{ICON["tower"]}<h3>Warns the tower</h3><p>The dashboard shows warnings and coverage gaps. Voice is opt-in for fresh alerts; replay is silent. Map coverage isn’t a measured object location.</p><code>Socket.IO · browser voice</code></div>
    </div>
  </section>

  <section class="sec" id="risk">
    <div class="sec-head"><span class="eyebrow-s">Risk levels</span><h2>What each dashboard state means</h2>
      <p>Risk comes from the live server detector. No detections in monitored video, degraded coverage and unavailable monitoring are not clearance.</p></div>
    <div class="risk" role="table" aria-label="Risk levels">
      <div class="risk-row head" role="row"><span role="columnheader">Level</span><span role="columnheader">When</span><span role="columnheader">What happens</span></div>
      <div class="risk-row r-go" role="row"><span class="lvl" role="rowheader"><i style="background:var(--go)" aria-hidden="true"></i>GREEN</span><p role="cell">No detections in monitored video</p><p role="cell">Status only, not evidence that the airspace is clear</p></div>
      <div class="risk-row r-warn" role="row"><span class="lvl" role="rowheader"><i style="background:var(--warn)" aria-hidden="true"></i>YELLOW</span><p role="cell">Video detection warrants caution</p><p role="cell">On-screen caution; a report may follow</p></div>
      <div class="risk-row r-stop" role="row"><span class="lvl" role="rowheader"><i style="background:var(--stop)" aria-hidden="true"></i>RED</span><p role="cell">Higher-risk video detection</p><p role="cell">On-screen warning; sound only if enabled</p></div>
      <div class="risk-row" role="row"><span class="lvl" role="rowheader">DEGRADED / UNAVAILABLE</span><p role="cell">Monitoring is limited or lacks usable data</p><p role="cell">Existing warnings may remain; missing data is not a green result</p></div>
    </div>
  </section>

  <section class="sec" id="system">
    <div class="split2">
      <div>
        <div class="sec-head"><span class="eyebrow-s">The system</span><h2>How one alert travels</h2>
          <p>Live warnings can appear before storage confirms them. Network or service failure can delay delivery, leave an alert unconfirmed, or leave a report incomplete.</p></div>
        <div class="limits">
          <h3>What it can’t do yet</h3>
          <ul>
            <li>The JPEG stream carries no microphone signal. Small or distant objects and poor visibility can limit detection.</li>
            <li>Projected entry into a surveyed image mask is not a runway arrival time.</li>
            <li>This prototype does not replace radar, approved procedures or human judgment.</li>
          </ul>
        </div>
      </div>
      <ol class="journey">
        <li><em>Camera station</em><b>Send live frames</b><span>The server associates each stream with an authorized airport and assigns risk from video.</span></li>
        <li><em>Socket.IO</em><b>Show the warning</b><span>An in-session warning can arrive before storage confirms it.</span></li>
        <li><em>Browser voice</em><b>Speak fresh alerts only</b><span>Operators can turn sound on. Acknowledgment and replay do not trigger speech.</span></li>
        <li><em>MongoDB Atlas</em><b>Confirm storage</b><span>Stored receipts support acknowledgment and replay. The hourly chart counts stored detections.</span></li>
        <li><em>Local AI Model</em><b>Optionally review evidence</b><span>Reports use detector readings. The Local AI Model checks tracks in the browser; optional server review requires separate opt-in and does not change warnings.</span></li>
        <li><em>MongoDB Atlas</em><b>Save the report when available</b><span>Report work can be delayed or incomplete; incident snapshot retention is off unless separately enabled.</span></li>
        <li><em>Solana devnet</em><b>Optionally verify a report hash</b><span>A confirmed hash can be compared with the exact report text. It does not protect stored records from edits or prove the report accurate.</span></li>
      </ol>
    </div>
  </section>

  <section class="sec" id="stack">
    <div class="sec-head"><span class="eyebrow-s">Built with</span><h2>The services behind the prototype</h2></div>
    <div class="stack">
      <div><b>Browser voice</b><span>Opt-in speech for new alerts</span></div>
      <div><b>Local AI Model</b><span>In-browser bird and drone verification</span></div>
      <div><b>DigitalOcean</b><span>Hosts the server and keeps API keys safe</span></div>
      <div><b>MongoDB Atlas</b><span>Alert receipts, incident reports and hourly charts</span></div>
      <div><b>Solana devnet</b><span>Optional drone-report hash comparison</span></div>
    </div>
  </section>

  <section class="sec" id="faq">
    <div class="sec-head"><span class="eyebrow-s">Questions</span><h2>What people ask</h2></div>
    <div class="faq">
      <details><summary>How accurate is it?</summary><p>The film and synthetic scenarios illustrate the software; they do not establish field accuracy or airport qualification.</p></details>
      <details><summary>Can it monitor the whole airport?</summary><p>No. It can only assess usable video in view. Poor visibility, distance or a stalled detector can leave coverage gaps. Night performance is not established.</p></details>
      <details><summary>What about privacy?</summary><p>Live video goes to the SkySentry server, while the Local AI Model checks tracks directly in your browser. Incident snapshot retention and sending eligible camera images for optional AI review are separate settings, both off by default. Enabling one does not authorize the other.</p></details>
      <details><summary>What does a devnet hash prove?</summary><p>It lets someone compare the fingerprint of exact report text against a confirmed memo. It is not tamper-proof storage, proof of accuracy, or a chain of custody.</p></details>
    </div>
  </section>

  <footer class="foot">
    <div><b>SkySentry</b><br>Built in 24 hours at hackPHS 2026 · Theme: Into the skies</div>
    <div>Prototype demonstration. Film scenery is illustrative and readings are simulated.<br>3D assets: Poly Haven and Innerscene (CC0), Three.js (MIT). Full credits are under the film.</div>
  </footer>
</main>
"""

AUTOPAUSE = """
<script>
// Pause the film while it is scrolled out of view, resume when it comes back.
(() => {
  const stage = document.getElementById("stage"), btn = document.getElementById("play");
  let autoPaused = false;
  new IntersectionObserver(([e]) => {
    if (!stage.closest(".film-started")) return;
    if (e.intersectionRatio < .25 && btn.textContent === "Pause") { btn.click(); autoPaused = true; }
    else if (e.intersectionRatio >= .25 && autoPaused && btn.textContent === "Play") { btn.click(); autoPaused = false; }
  }, {threshold: .25}).observe(stage);
  btn.addEventListener("click", e => { if (e.isTrusted) autoPaused = false; });
})();
</script>
"""

site = ROOT / "site.html"
output = "<title>SkySentry</title>\n" + film_head + SITE_HEAD + SITE_BODY + film_scripts + AUTOPAUSE
if sys.argv[1:] == ["--check"]:
    if not site.exists() or site.read_text(encoding="utf-8") != output:
        sys.exit("dist/site.html is stale; run python ATHARV/skysentry/tools/build_site.py")
elif not sys.argv[1:]:
    site.write_text(output, encoding="utf-8", newline="\n")
    print("wrote", site)
else:
    sys.exit("Usage: build_site.py [--check]")
