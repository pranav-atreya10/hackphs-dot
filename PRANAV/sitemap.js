// sitemap.xml and robots.txt for the public site. URLs must be absolute, so the origin comes from SITE_URL when
// set, otherwise from the request (DigitalOcean's proxy sends x-forwarded-proto). Hosts are validated so a forged
// Host header can't inject markup.
const PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/demo.html', changefreq: 'monthly', priority: '0.8' },
  { path: '/film.html', changefreq: 'monthly', priority: '0.7' },
  { path: '/tower.html', changefreq: 'monthly', priority: '0.5' },
  { path: '/camera.html', changefreq: 'monthly', priority: '0.5' },
];

function siteOrigin({ siteUrl, host, forwardedProto, protocol }) {
  if (siteUrl) {
    try { const u = new URL(siteUrl); if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin; } catch {}
  }
  if (!host || !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return null;
  const proto = String(forwardedProto || protocol || 'http').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host.toLowerCase()}`;
}

function sitemapXml(origin, lastmod) {
  const urls = PAGES.map(p => `  <url><loc>${origin}${p.path}</loc><lastmod>${lastmod}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function robotsTxt(origin) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`;
}

module.exports = { PAGES, siteOrigin, sitemapXml, robotsTxt };
