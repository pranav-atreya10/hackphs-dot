// Copies the team's browser code into PRANAV/public so one server (this one) hosts the whole site.
// DigitalOcean only deploys the PRANAV folder, so the copies are committed. Run after changing
// Vivan's detection engine or Atharv's film/site:  npm run sync-web
//
//   VIVAN/detection/{index.js,src,adapters,test}  -> public/detection/
//   ATHARV/skysentry/dist (film runtime + assets)  -> public/  (film.html = standalone film)
//   ATHARV/skysentry/dist/site.html                -> public/index.html (landing page, film built in)
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const pub = join(repo, 'PRANAV/public');
const vivan = join(repo, 'VIVAN/detection');
const film = join(repo, 'ATHARV/skysentry/dist');

// Vivan's engine, adapters and test pages, unchanged.
rmSync(join(pub, 'detection'), { recursive: true, force: true });
for (const p of ['index.js', 'src', 'adapters', 'test']) cpSync(join(vivan, p), join(pub, 'detection', p), { recursive: true });
writeFileSync(join(pub, 'detection/package.json'), '{ "type": "module" }\n');   // lets the server import the engine without warnings

// Atharv's film runtime. Binary originals (.glb/.bin/.hdr/.gltf) are skipped; the loaders read the .json forms.
const skip = /\.(glb|bin|hdr|gltf)$|_1k\.gltf\.json$|ASSET_CREDITS/;
for (const p of ['cinema.js', 'details.js', 'models.js', 'nature.js', 'optimize.js', 'assetload.js', 'vendor', 'assets']) {
  cpSync(join(film, p), join(pub, p), { recursive: true, filter: (src) => !skip.test(src) });
}
cpSync(join(film, 'assets/ASSET_CREDITS.json'), join(pub, 'assets/ASSET_CREDITS.json'));

const doc = html => html.includes('<!doctype') ? html : `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n</head>\n<body>\n${html}\n</body>\n</html>\n`;

// Shared look (PRANAV/public/css, brand/, js/theme.js): logo, favicon, Geist, light + dark. Atharv's sources stay as they are;
// each page gets its override stylesheet linked after its own styles so the overrides win.
const MARK = '<svg class="mark" viewBox="10 2 80 96" aria-hidden="true"><path fill-rule="evenodd" d="M50 4 L88 16 L88 48 Q88 78 50 96 Q12 78 12 48 L12 16 Z M24 44 Q38 26 50 50 Q62 26 76 44 Q62 34 50 60 Q38 34 24 44 Z"/></svg>';
const HEAD = `<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/brand/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<script src="/js/theme.js"></script>
</head>`;
const must = (html, from, to, what) => { if (!html.includes(from)) throw new Error(`${what} changed; update sync-web.mjs`); return html.replace(from, to); };
const themed = (html, css) => {
  html = doc(html).replace('</head>', HEAD);
  const lastStyle = html.lastIndexOf('</style>');
  return html.slice(0, lastStyle + 8) + `\n<link rel="stylesheet" href="/css/${css}">` + html.slice(lastStyle + 8);
};
const loader = html => must(html, '<span class="load-title">SKYSENTRY</span>', `<span class="load-title">${MARK}SkySentry</span>`, 'film loader title');

let filmPage = readFileSync(join(film, 'index.html'), 'utf8');
filmPage = must(filmPage, '<div class="top"><h1>SkySentry</h1>', `<div class="top"><h1>${MARK}SkySentry</h1>`, 'film.html title');
writeFileSync(join(pub, 'film.html'), themed(loader(filmPage), 'film.css'));

// Landing page: the product site plus links into the live system.
let site = readFileSync(join(film, 'site.html'), 'utf8');
const nav = '<a href="#film">Film</a><a href="#why">Why</a><a href="#how">How it works</a><a href="#risk">Risk levels</a><a href="#system">System</a><a href="#faq">FAQ</a>';
if (!site.includes(nav)) throw new Error('site.html nav changed; update sync-web.mjs');
site = site.replace(nav, '<a href="#film">Film</a><a href="#how">How it works</a><a href="#live">Live system</a><a href="/camera.html">Camera</a><a href="/tower.html">Tower</a><a href="/demo.html">Demos</a><a href="#faq">FAQ</a>');
site = site.replace('<a class="btn-s" href="#how">How it works</a>', '<a class="btn-s" href="/tower.html">Open the tower</a><a class="btn-s" href="/camera.html">Start a camera</a>');
const live = readFileSync(fileURLToPath(new URL('./live-section.html', import.meta.url)), 'utf8');
const anchor = '<section class="sec" id="why">';
if (!site.includes(anchor)) throw new Error('site.html #why section missing; update sync-web.mjs');
site = site.replace(anchor, live + '\n  ' + anchor);
// The "Ask about SkySentry" chat bubble (public/js/guide.js, served by /api/guide).
site = site.includes('</body>') ? site.replace('</body>', '<script src="/js/guide.js" defer></script>\n</body>') : `${site}\n<script src="/js/guide.js" defer></script>\n`;
// Logo in the bar and footer, a theme button, and Geist in place of the serif font link.
site = must(site, '<a class="brand" href="#top"><i></i>SkySentry</a>', `<a class="brand" href="#top">${MARK}SkySentry</a>`, 'site.html brand');
site = must(site, '<span class="tag">hackPHS 2026</span>', '<span class="tag">hackPHS 2026</span><button class="theme-btn" type="button" data-theme-toggle aria-label="Theme"></button>', 'site.html tag');
site = must(site, '<div><b>SkySentry</b>', `<div><b>${MARK}SkySentry</b>`, 'site.html footer');
site = site.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Source\+Serif[^>]*>\n?/, '');
writeFileSync(join(pub, 'index.html'), themed(loader(site), 'site.css'));

console.log('synced: detection engine, film runtime, landing page ->', pub);
if (!existsSync(join(pub, 'chat.html'))) console.warn('note: public/chat.html (the original chat demo) is missing');
