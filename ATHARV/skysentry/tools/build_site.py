"""Builds dist/site.html: a product site for SkySentry with the film embedded.

The film's styles, stage markup and scripts are taken from dist/index.html so the
site always plays the current film. Run: python3 tools/build_site.py
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "dist"
film = (ROOT / "index.html").read_text()

body = film[film.index("<body>") + len("<body>"):] if "<body>" in film else film
body = body.replace("</body>\n</html>", "").replace("</body></html>", "")
head_end = body.index('<div class="wrap">')
script_start = body.index('<script type="importmap">')
film_head = body[:head_end].replace("<title>SkySentry in Motion</title>", "")
film_stage = body[head_end:script_start]
film_scripts = body[script_start:]

# On a long page, Space should scroll unless the film is on screen.
key_guard = 'document.addEventListener("keydown", e => {\n'
assert key_guard in film_scripts
film_scripts = film_scripts.replace(key_guard, key_guard + '    { const r = stage.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return; }\n', 1)

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
@media (max-width:720px){.risk-row{grid-template-columns:1fr;gap:6px}.risk-row.head{display:none}}

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
  "ear": '<svg viewBox="0 0 36 36" fill="none" stroke="#c2643f" stroke-width="2" stroke-linecap="round"><path d="M6 18h2M11 12v12M16 8v20M21 13v10M26 10v16M31 16v4"/></svg>',
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
      <p>SkySentry turns an ordinary phone into a lookout that spots birds and drones near a runway and alerts the control tower, out loud and on screen, before a plane takes off into danger.</p>
      <div class="cta"><a class="btn-s primary" href="#film">Watch the 100-second film</a><a class="btn-s" href="#how">How it works</a></div>
    </div>
    <dl class="sheet" aria-label="At a glance">
      <div><dt>Detects</dt><dd>Birds with the camera, drones with the microphone</dd></div>
      <div><dt>Alerts</dt><dd>Spoken and on-screen alerts in the tower within seconds</dd></div>
      <div><dt>Built for</dt><dd>Small airports that can’t afford bird radar</dd></div>
      <div><dt>Costs</dt><dd>A phone per runway plus free-tier cloud tools</dd></div>
    </dl>
  </section>

  <section id="film" aria-label="SkySentry film">
{film_stage}
  <p class="film-note">Illustrated prototype. Detection readings, alerts, reports and charts in the film are simulated.</p>
  </section>

  <section class="sec" id="why">
    <div class="sec-head"><span class="eyebrow-s">Why it matters</span><h2>The sky over a runway is crowded</h2>
      <p>Birds and drones share the same low airspace that every departing aircraft climbs through. Big airports pay for radar to watch it. Most small airports watch it by eye.</p></div>
    <div class="facts">
      <div class="fact"><span>Jan 15, 2009 · LaGuardia</span><b>2 of 2</b><p>engines lost when geese struck US Airways Flight 1549 minutes after takeoff, forcing the “Miracle on the Hudson” landing.</p></div>
      <div class="fact"><span>December 2018 · Gatwick</span><b>≈1,000</b><p>flights disrupted when repeated drone sightings shut down London’s Gatwick Airport over three days.</p></div>
      <div class="fact"><span>The gap</span><b class="warn">No radar</b><p>at small airports like Princeton and Trenton-Mercer, which usually can’t buy bird radar or counter-drone systems.</p></div>
    </div>
  </section>

  <section class="sec" id="how">
    <div class="sec-head"><span class="eyebrow-s">How it works</span><h2>It sees, it hears, it speaks up</h2>
      <p>One phone on a tripod at the runway edge does the watching. A second laptop in the tower shows and speaks the alerts.</p></div>
    <div class="steps3">
      <div class="step3">{ICON["eye"]}<h3>Sees birds</h3><p>A ready-made AI model runs in the phone’s browser and boxes every bird. Tracking counts them and shows which way each one is heading.</p><code>TensorFlow.js · COCO-SSD</code></div>
      <div class="step3">{ICON["ear"]}<h3>Hears drones</h3><p>Drones are hard to see but easy to hear. A sound model trained on background noise, drones and birds listens for the buzz.</p><code>Teachable Machine audio</code></div>
      <div class="step3">{ICON["tower"]}<h3>Tells the tower</h3><p>Risky events reach the tower screen in seconds with a spoken alert, an AI-written incident report and a pin on the airport map.</p><code>Socket.IO · ElevenLabs · Gemini</code></div>
    </div>
  </section>

  <section class="sec" id="risk">
    <div class="sec-head"><span class="eyebrow-s">Risk levels</span><h2>Three levels, one clear rule each</h2>
      <p>The phone scores every moment as green, yellow or red, so the tower only hears about what matters.</p></div>
    <div class="risk" role="table" aria-label="Risk levels">
      <div class="risk-row head" role="row"><span role="columnheader">Level</span><span role="columnheader">When</span><span role="columnheader">What happens</span></div>
      <div class="risk-row r-go" role="row"><span class="lvl" style="color:#2f7a4d"><i style="background:var(--go)"></i>GREEN</span><p>No birds, no drone sound</p><p>Quiet status update every few seconds</p></div>
      <div class="risk-row r-warn" role="row"><span class="lvl" style="color:#9a6a00"><i style="background:var(--warn)"></i>YELLOW</span><p>1 to 4 birds, not heading toward the runway</p><p>On-screen caution, snapshot checked by Gemini, logged</p></div>
      <div class="risk-row r-stop" role="row"><span class="lvl" style="color:#b23a2c"><i style="background:var(--stop)"></i>RED</span><p>5 or more birds, any bird heading toward the runway, or any drone sound</p><p>Alarm, spoken alert, Gemini report and map pin; drone reports also get a Solana stamp</p></div>
    </div>
  </section>

  <section class="sec" id="system">
    <div class="split2">
      <div>
        <div class="sec-head"><span class="eyebrow-s">The system</span><h2>How one alert travels</h2>
          <p>Every alert follows the same seven steps from the runway to the tower. Each service does one job.</p></div>
        <div class="limits">
          <h3>What it can’t do yet</h3>
          <ul>
            <li>It works in daylight only. Night would need a thermal camera.</li>
            <li>The off-the-shelf model works best when birds are reasonably large in the frame.</li>
            <li>It is an extra set of eyes for the tower, not a replacement for radar.</li>
          </ul>
        </div>
      </div>
      <ol class="journey">
        <li><em>Camera station</em><b>Detect and send</b><span>The phone spots birds or a drone, scores the risk and sends an event with type, count, direction and confidence.</span></li>
        <li><em>Tiger Data</em><b>Save the stream</b><span>Every event is stored with a timestamp, and hourly summaries feed the tower’s charts.</span></li>
        <li><em>Gemini</em><b>Verify with AI</b><span>For yellow and red events, Gemini checks the snapshot and writes a short incident report.</span></li>
        <li><em>MongoDB Atlas</em><b>Store the report</b><span>The report, snapshot and Gemini’s label are saved together.</span></li>
        <li><em>Solana devnet</em><b>Stamp drone reports</b><span>A hash of each drone report goes on chain, so nobody can quietly edit it later.</span></li>
        <li><em>ElevenLabs</em><b>Give it a voice</b><span>The alert sentence becomes a spoken tower announcement.</span></li>
        <li><em>Socket.IO</em><b>Tell the tower</b><span>The alert, report and audio arrive on the tower dashboard instantly.</span></li>
      </ol>
    </div>
  </section>

  <section class="sec" id="stack">
    <div class="sec-head"><span class="eyebrow-s">Built with</span><h2>Free tools, each doing a real job</h2></div>
    <div class="stack">
      <div><b>ElevenLabs</b><span>Speaks every alert in the tower</span></div>
      <div><b>Gemini</b><span>Verifies snapshots, writes reports, answers questions</span></div>
      <div><b>Tiger Data</b><span>Time-stamped detections and hourly charts</span></div>
      <div><b>DigitalOcean</b><span>Hosts the server and keeps API keys safe</span></div>
      <div><b>MongoDB Atlas</b><span>Incident reports with snapshots</span></div>
      <div><b>Solana</b><span>Tamper-proof stamps on drone reports</span></div>
    </div>
  </section>

  <section class="sec" id="faq">
    <div class="sec-head"><span class="eyebrow-s">Questions</span><h2>What people ask</h2></div>
    <div class="faq">
      <details><summary>How accurate is it?</summary><p>The team measures it on a set of test clips before judging and reports the result, for example how many of 20 clips it caught. Treat it as an extra set of eyes, not a replacement for radar.</p></details>
      <details><summary>Can it see small, far-away birds?</summary><p>The free model works best when birds are reasonably large in the frame. A zoom lens or a model trained on sky footage would improve that.</p></details>
      <details><summary>Does it work at night?</summary><p>Not yet. Night detection would need a thermal camera, which is a natural next step.</p></details>
      <details><summary>What about privacy?</summary><p>The camera points at the sky, and snapshots are saved only when there’s an alert.</p></details>
      <details><summary>Why use a blockchain?</summary><p>So drone incident records can’t be quietly changed later, which matters if they are used as evidence for police or the FAA.</p></details>
      <details><summary>Isn’t this already done?</summary><p>Big airports use radar and commercial counter-drone systems. SkySentry is a low-cost version for the small airports that can’t afford those.</p></details>
      <details><summary>What would it cost a real airport?</summary><p>A phone or cheap camera per runway, plus small cloud bills.</p></details>
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
    if (!e.isIntersecting && btn.textContent === "Pause") { btn.click(); autoPaused = true; }
    else if (e.isIntersecting && autoPaused && btn.textContent === "Play") { btn.click(); autoPaused = false; }
  }, {threshold: .25}).observe(stage);
  btn.addEventListener("click", e => { if (e.isTrusted) autoPaused = false; });
})();
</script>
"""

(ROOT / "site.html").write_text("<title>SkySentry</title>\n" + film_head + SITE_HEAD + SITE_BODY + film_scripts + AUTOPAUSE)
print("wrote", ROOT / "site.html")
