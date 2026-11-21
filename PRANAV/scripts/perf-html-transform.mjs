// Pure HTML post-processor for generated landing/film pages (used by sync-web.mjs).
// Eliminates render-blocking Google Fonts CSS requests, adds preconnect to fonts.gstatic.com,
// and boosts LCP priority on the hero #filmPoster SVG without altering site copy or disclosures.

const GSTATIC_PRECONNECT = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';

function uniqueTokenPrefix(html, label) {
  let n = 0;
  let prefix = `__SKYSENTRY_${label}_${n}_`;
  while (html.includes(prefix)) {
    n += 1;
    prefix = `__SKYSENTRY_${label}_${n}_`;
  }
  return prefix;
}

function isRelToken(tag, expectedRel) {
  const match = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!match) return false;
  const raw = match[1] ?? match[2] ?? match[3] ?? '';
  return raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .includes(expectedRel.toLowerCase());
}

function getGoogleFontsHref(tag) {
  const match = tag.match(/\bhref\s*=\s*(?:"(https:\/\/fonts\.googleapis\.com\/[^"]*)"|'(https:\/\/fonts\.googleapis\.com\/[^']*)')/i);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function isGstaticPreconnect(tag) {
  return (
    isRelToken(tag, 'preconnect') &&
    /\bhref\s*=\s*(?:"https:\/\/fonts\.gstatic\.com\/?"|'https:\/\/fonts\.gstatic\.com\/?')/i.test(tag)
  );
}

function isGoogleApisPreconnect(tag) {
  return (
    isRelToken(tag, 'preconnect') &&
    /\bhref\s*=\s*(?:"https:\/\/fonts\.googleapis\.com\/?"|'https:\/\/fonts\.googleapis\.com\/?')/i.test(tag)
  );
}

function ensureGstaticPreconnectInHead(html, eol = '\n') {
  return html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, (headBlock) => {
    let seenGstatic = false;
    const normalizedHead = headBlock.replace(/<link\b[^>]*>/gi, (linkTag) => {
      if (!isGstaticPreconnect(linkTag)) return linkTag;
      if (seenGstatic) return '';
      seenGstatic = true;
      if (/\bcrossorigin\b/i.test(linkTag)) return linkTag;
      return linkTag.replace(/\s*\/?>$/, ' crossorigin>');
    });

    if (seenGstatic) return normalizedHead;

    let inserted = false;
    const afterGoogleApis = normalizedHead.replace(/<link\b[^>]*>/gi, (linkTag) => {
      if (!inserted && isGoogleApisPreconnect(linkTag)) {
        inserted = true;
        return `${linkTag}${eol}${GSTATIC_PRECONNECT}`;
      }
      return linkTag;
    });

    if (inserted) return afterGoogleApis;
    return normalizedHead.replace(/<\/head>/i, `${GSTATIC_PRECONNECT}${eol}</head>`);
  });
}

function deferGoogleFontStylesheets(html, eol = '\n') {
  const nsPrefix = uniqueTokenPrefix(html, 'NOSCRIPT');
  const noscriptBlocks = [];
  const masked = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, (block) => {
    const idx = noscriptBlocks.push(block) - 1;
    return `${nsPrefix}${idx}__`;
  });

  const linkWithOptionalNoscript = new RegExp(
    `<link\\b[^>]*>(?:(\\s*)${nsPrefix}(\\d+)__)?`,
    'gi',
  );

  const transformed = masked.replace(linkWithOptionalNoscript, (fullMatch, wsAfter, nsIdxStr) => {
    const suffixLen = nsIdxStr !== undefined ? wsAfter.length + `${nsPrefix}${nsIdxStr}__`.length : 0;
    const linkTag = suffixLen > 0 ? fullMatch.slice(0, fullMatch.length - suffixLen) : fullMatch;

    if (!isRelToken(linkTag, 'stylesheet')) return fullMatch;
    const href = getGoogleFontsHref(linkTag);
    if (!href) return fullMatch;

    const alreadyAsync =
      /\bmedia\s*=\s*(?:"print"|'print')/i.test(linkTag) &&
      /\bonload\s*=\s*(?:"this\.media='all'"|'this\.media="all"')/i.test(linkTag);

    const asyncLink = alreadyAsync
      ? linkTag
      : `${linkTag
          .replace(/\s+\bmedia\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
          .replace(/\s+\bonload\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
          .replace(/\s*\/?>$/, '')} media="print" onload="this.media='all'">`;

    const fallbackBlock = `<noscript><link rel="stylesheet" href="${href}"></noscript>`;

    if (nsIdxStr !== undefined) {
      const existingNs = noscriptBlocks[Number(nsIdxStr)];
      if (existingNs.includes(href)) {
        return `${asyncLink}${wsAfter}${nsPrefix}${nsIdxStr}__`;
      }
      return `${asyncLink}${eol}${fallbackBlock}${wsAfter}${nsPrefix}${nsIdxStr}__`;
    }

    return `${asyncLink}${eol}${fallbackBlock}`;
  });

  return transformed.replace(new RegExp(`${nsPrefix}(\\d+)__`, 'g'), (_, idxStr) => noscriptBlocks[Number(idxStr)]);
}

function prioritizeFilmPoster(html) {
  return html.replace(
    /(<div\b[^>]*\bid\s*=\s*(?:"filmPoster"|'filmPoster')[^>]*>[\s\S]*?<\/div>)/i,
    (posterDiv) =>
      posterDiv.replace(
        /<img\b[^>]*\bsrc\s*=\s*(?:"[^"]*film-poster\.svg(?:\?[^"]*)?"|'[^']*film-poster\.svg(?:\?[^']*)?')[^>]*>/i,
        (imgTag) => {
          let updated = imgTag.replace(/\s*\/?>$/, '');

          if (!/\bfetchpriority\s*=\s*(?:"high"|'high')/i.test(updated)) {
            if (/\bfetchpriority\s*=/i.test(updated)) {
              updated = updated.replace(/\bfetchpriority\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, 'fetchpriority="high"');
            } else {
              updated += ' fetchpriority="high"';
            }
          }

          if (!/\bdecoding\s*=\s*(?:"async"|'async')/i.test(updated)) {
            if (/\bdecoding\s*=/i.test(updated)) {
              updated = updated.replace(/\bdecoding\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, 'decoding="async"');
            } else {
              updated += ' decoding="async"';
            }
          }

          return `${updated}>`;
        },
      ),
  );
}

export function optimizeGeneratedHtml(html, { page = 'index' } = {}) {
  if (typeof html !== 'string') {
    throw new TypeError('optimizeGeneratedHtml expects an HTML string');
  }

  // Mask inline <script> and <style> blocks so embedded JS/CSS literals are never touched.
  const inertPrefix = uniqueTokenPrefix(html, 'INERT');
  const inertBlocks = [];
  let working = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) => {
    const idx = inertBlocks.push(block) - 1;
    return `${inertPrefix}${idx}__`;
  });

  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const normalizedPage = String(page || 'index').replace(/\.html?$/i, '').toLowerCase();
  working = ensureGstaticPreconnectInHead(working, eol);
  working = deferGoogleFontStylesheets(working, eol);
  if (normalizedPage === 'index') {
    working = prioritizeFilmPoster(working);
  }

  return working.replace(new RegExp(`${inertPrefix}(\\d+)__`, 'g'), (_, idxStr) => inertBlocks[Number(idxStr)]);
}
