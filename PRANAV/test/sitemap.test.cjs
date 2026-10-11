const test = require('node:test');
const assert = require('node:assert/strict');
const { PAGES, siteOrigin, sitemapXml, robotsTxt } = require('../sitemap');

test('origin prefers SITE_URL and keeps only its origin', () => {
  assert.equal(siteOrigin({ siteUrl: 'https://skysentry.example/some/path', host: 'evil.test' }), 'https://skysentry.example');
});

test('origin falls back to the request, honoring the proxy protocol', () => {
  assert.equal(siteOrigin({ host: 'App-xyz.ondigitalocean.app', forwardedProto: 'https, http', protocol: 'http' }), 'https://app-xyz.ondigitalocean.app');
  assert.equal(siteOrigin({ host: 'localhost:8080', protocol: 'http' }), 'http://localhost:8080');
});

test('forged hosts and bad SITE_URL values are rejected', () => {
  assert.equal(siteOrigin({ host: 'a.test"><script>' }), null);
  assert.equal(siteOrigin({ host: '' }), null);
  assert.equal(siteOrigin({ siteUrl: 'javascript:alert(1)', host: 'ok.test' }), 'http://ok.test');
});

test('sitemap lists every public page with absolute URLs', () => {
  const xml = sitemapXml('https://s.test', '2026-10-11');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  for (const p of PAGES) assert.ok(xml.includes(`<loc>https://s.test${p.path}</loc>`), p.path);
  assert.equal((xml.match(/<url>/g) || []).length, PAGES.length);
});

test('robots.txt points at the sitemap and keeps crawlers out of the API', () => {
  const txt = robotsTxt('https://s.test');
  assert.match(txt, /Disallow: \/api\//);
  assert.match(txt, /Sitemap: https:\/\/s\.test\/sitemap\.xml/);
});
