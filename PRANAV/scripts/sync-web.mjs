// Copies the team's browser code into PRANAV/public so one server (this one) hosts the whole site.
// DigitalOcean only deploys the PRANAV folder, so the copies are committed. Run after changing
// Vivan's detection engine or Atharv's film/site: npm run sync-web
//
//   VIVAN/detection/{index.js,src,adapters,models,test}  -> public/detection/
//   ATHARV/skysentry/dist (film runtime + assets)  -> public/  (film.html = standalone film)
//   ATHARV/skysentry/dist/site.html                -> public/index.html (landing page, film built in)
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const pub = join(repo, 'PRANAV/public');
const vivan = join(repo, 'VIVAN/detection');
const film = join(repo, 'ATHARV/skysentry/dist');

const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--check', '--film', '--detector'].includes(arg)) ||
    (args.has('--film') && args.has('--detector'))) {
  throw new Error('Usage: sync-web.mjs [--check] [--film|--detector]');
}
const check = args.has('--check');
const differences = [];
const normalized = data => data.toString('utf8').replace(/\r\n/g, '\n');
const textFile = path => /\.(?:html|js|json|svg|txt|md|css)$/.test(path);
const managed = new Set();
function output(path, content) {
  managed.add(path);
  const dest = join(pub, path);
  const exists = existsSync(dest);
  if (exists) {
    const actual = readFileSync(dest);
    if (textFile(path) ? normalized(actual) === normalized(content) : actual.equals(content)) return;
  }
  if (check) differences.push(`${exists ? 'changed' : 'missing'} ${path}`);
  else {
    mkdirSync(dirname(dest), {recursive: true});
    writeFileSync(dest, content);
  }
}
function* files(root, path) {
  for (const entry of readdirSync(join(root, path), {withFileTypes: true})) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) yield* files(root, next);
    else if (entry.isFile()) yield next;
  }
}
function copy(root, path, prefix = '') {
  output(join(prefix, path), readFileSync(join(root, path)));
}
if (!args.has('--film')) {
  copy(vivan, 'index.js', 'detection');
  for (const p of ['src', 'adapters', 'models', 'test']) {
    for (const path of files(vivan, p)) copy(vivan, path, 'detection');
  }
  output(join('detection', 'package.json'), '{ "type": "module" }\n');
  if (existsSync(join(pub, 'detection'))) {
    for (const path of files(pub, 'detection')) {
      if (!managed.has(path)) differences.push(`unexpected ${path}; review before removing`);
    }
  }
}

if (!args.has('--detector')) {
for (const p of ['cinema.js', 'details.js', 'models.js', 'nature.js', 'optimize.js', 'assetload.js', 'film-enhancements.js', 'film-poster.svg']) {
  copy(film, p);
}
for (const path of files(film, 'vendor')) copy(film, path);
for (const path of files(film, 'assets')) {
  // Keep the existing decimated props. Their full-resolution originals are larger.
  if (/\.(bin|gltf)$|_1k\.gltf\.json$/.test(path)) continue;
  if (['narrow-body-airliner.gltf.json', 'derelict_airfield_01_1k.hdr.json'].includes(basename(path))) continue;
  copy(film, path);
}
const readText = path => normalized(readFileSync(path));

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
const themed = (html, css, description) => {
  html = doc(html).replace('</head>', `<meta name="description" content="${description}">\n${HEAD}`);
  const lastStyle = html.lastIndexOf('</style>');
  return html.slice(0, lastStyle + 8) + `\n<link rel="stylesheet" href="/css/${css}">` + html.slice(lastStyle + 8);
};
const decorative = html => html.replaceAll('<svg viewBox="0 0 36 36"', '<svg aria-hidden="true" viewBox="0 0 36 36"').replaceAll('<svg class="eng"', '<svg aria-hidden="true" class="eng"');
const loader = html => must(html, '<span class="load-title">SKYSENTRY</span>', `<span class="load-title">${MARK}SkySentry</span>`, 'film loader title');

let filmPage = readText(join(film, 'index.html'));
filmPage = must(filmPage, '<div class="top"><h1>SkySentry</h1>', `<div class="top"><h1>${MARK}SkySentry</h1>`, 'film.html title');
output('film.html', themed(decorative(loader(filmPage)), 'film.css', 'A 100-second 3D film of SkySentry spotting birds and drones near a runway and alerting the control tower.'));

// Landing page: the product site plus links into the live system.
let site = readText(join(film, 'site.html'));
site = must(site, 'id="filmLaunch" href="./index.html"', 'id="filmLaunch" href="./film.html"', 'standalone film fallback');
const nav = '<a href="#film">Film</a><a href="#why">Why</a><a href="#how">How it works</a><a href="#risk">Risk levels</a><a href="#system">System</a><a href="#faq">FAQ</a>';
if (!site.includes(nav)) throw new Error('site.html nav changed; update sync-web.mjs');
site = site.replace(nav, '<a href="#film">Film</a><a href="#how">How it works</a><a href="#faq">FAQ</a>');
const live = readText(fileURLToPath(new URL('./live-section.html', import.meta.url)));
const anchor = '<section class="sec" id="stack">';
if (!site.includes(anchor)) throw new Error('site.html #stack section missing; update sync-web.mjs');
site = site.replace(anchor, live + '\n  ' + anchor);
// Promo clips (public/promo/, made from the team's GIFs) right after "How it works".
const promo = readText(fileURLToPath(new URL('./promo-section.html', import.meta.url)));
site = must(site, '<section class="sec" id="risk">', promo + '\n  <section class="sec" id="risk">', 'site.html #risk section');
// The "Ask about SkySentry" chat bubble (public/js/guide.js, served by /api/guide), and the top bar's
// signed-in swap (public/js/nav-account.js: a Dashboard button in place of Sign in / Sign up).
const scripts = '<script src="/js/guide.js" defer></script>\n<script src="/js/nav-account.js" defer></script>\n';
site = site.includes('</body>') ? site.replace('</body>', `${scripts}</body>`) : `${site}\n${scripts}`;
// Logo in the bar and footer, sign in / sign up (account.html; the theme lives in settings.html), and Geist in place of the serif font link.
site = must(site, '<a class="brand" href="#top"><i></i>SkySentry</a>', `<a class="brand" href="#top">${MARK}SkySentry</a>`, 'site.html brand');
site = must(site, '<span class="tag">hackPHS 2026</span>', '<a class="bar-link" href="/account.html?mode=sign-in">Sign in</a><a class="btn-s primary bar-cta" href="/account.html">Sign up</a>', 'site.html tag');
// Hero: Sign up is the main call to action (it works today); the app page is only a placeholder, so it stays secondary.
// The film already sits right below the hero, so it has no button.
site = must(site, '<div class="cta"><a class="btn-s primary" href="#film">Watch the 100-second film</a><a class="btn-s" href="#how">How it works</a></div>',
  '<div class="cta"><a class="btn-s primary" href="/account.html">Sign up</a><a class="btn-s" href="/app.html">Get the app</a></div>', 'site.html hero buttons');
site = must(site, '<div><b>SkySentry</b>', `<div><b>${MARK}SkySentry</b>`, 'site.html footer');
site = site.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Source\+Serif[^>]*>\n?/, '');
output('index.html', themed(decorative(loader(site)), 'site.css', 'SkySentry turns an ordinary phone into an early-warning lookout that spots birds and drones near runways and alerts the control tower.'));
}

if (differences.length) {
  console.error(differences.sort().join('\n'));
  process.exitCode = 1;
} else {
  console.log(`${check ? 'Verified' : 'Synced'} ${managed.size} managed web files`);
}
