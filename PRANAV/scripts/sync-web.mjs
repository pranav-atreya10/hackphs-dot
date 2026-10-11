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
writeFileSync(join(pub, 'film.html'), doc(readFileSync(join(film, 'index.html'), 'utf8')));

// Landing page: the product site plus links into the live system.
let site = readFileSync(join(film, 'site.html'), 'utf8');
const nav = '<a href="#film">Film</a><a href="#why">Why</a><a href="#how">How it works</a><a href="#risk">Risk levels</a><a href="#system">System</a><a href="#faq">FAQ</a>';
if (!site.includes(nav)) throw new Error('site.html nav changed; update sync-web.mjs');
site = site.replace(nav, '<a href="#film">Film</a><a href="#how">How it works</a><a href="#live">Live system</a><a href="/camera.html">Camera</a><a href="/tower.html">Tower</a><a href="#faq">FAQ</a>');
site = site.replace('<a class="btn-s" href="#how">How it works</a>', '<a class="btn-s" href="/tower.html">Open the tower</a><a class="btn-s" href="/camera.html">Start a camera</a>');
const live = readFileSync(fileURLToPath(new URL('./live-section.html', import.meta.url)), 'utf8');
const anchor = '<section class="sec" id="why">';
if (!site.includes(anchor)) throw new Error('site.html #why section missing; update sync-web.mjs');
site = site.replace(anchor, live + '\n  ' + anchor);
// The "Ask about SkySentry" chat bubble (public/js/guide.js, served by /api/guide).
site = site.includes('</body>') ? site.replace('</body>', '<script src="/js/guide.js" defer></script>\n</body>') : `${site}\n<script src="/js/guide.js" defer></script>\n`;
writeFileSync(join(pub, 'index.html'), doc(site));

console.log('synced: detection engine, film runtime, landing page ->', pub);
if (!existsSync(join(pub, 'chat.html'))) console.warn('note: public/chat.html (the original chat demo) is missing');
