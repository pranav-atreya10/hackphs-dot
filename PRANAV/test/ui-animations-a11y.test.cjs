// Animation accessibility, prefers-reduced-motion, tower ARIA live-region, and zero-leak authority contract suite.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const PUBLIC_DIR = path.join(__dirname, '../public');
const CSS_DIR = path.join(PUBLIC_DIR, 'css');
const JS_DIR = path.join(PUBLIC_DIR, 'js');
const TOWER_HTML = path.join(PUBLIC_DIR, 'tower.html');

// Explicit target HUD/animation modules plus semantic patterns for any sibling slices merged later.
const EXPLICIT_HUD_MODULE_RE = /^(?:hud-[^/\\]+|flight-forecast|landing-live-ai|alert-choreography|stat-counter|risk-beacon-fx)\.(?:mjs|js)$/i;
const SEMANTIC_ANIM_RE = /(?:^|[-_])(?:hud|fx|anim|animation|animations|motion|choreography|reveal|counter|forecast|beacon-fx|live-ai)(?:[-_.]|$)/i;
const WORKER_FILE_RE = /(?:^|[-_])worker\.(?:mjs|js)$/i;

const BASELINE_NON_HUD_FILES = new Set([
  'account.js',
  'admin.js',
  'alert-player.mjs',
  'auth.js',
  'bird-evidence.js',
  'camera.js',
  'demo.js',
  'detector-status.mjs',
  'feeds.js',
  'guide.js',
  'incident-history.mjs',
  'nav-account.js',
  'settings.js',
  'skysentry-v41-client.mjs',
  'skysentry-v41-schedule.mjs',
  'skysentry-v41-vote.mjs',
  'skysentry-v41-worker.mjs',
  'theme.js',
  'tick-worker.js',
  'tower-layers.mjs',
  'tower-monitoring.mjs',
  'tower.js',
  'visual-ai.js',
  'walkthrough.js',
]);

const BASELINE_CORE_MJS = new Set([
  'alert-player.mjs',
  'detector-status.mjs',
  'incident-history.mjs',
  'skysentry-v41-client.mjs',
  'skysentry-v41-schedule.mjs',
  'skysentry-v41-vote.mjs',
  'tower-layers.mjs',
  'tower-monitoring.mjs',
]);

/* ---------- filesystem auto-discovery ---------- */

function walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full, predicate));
    else if (entry.isFile() && predicate(full, entry.name)) results.push(full);
  }
  return results.sort((a, b) => a.localeCompare(b));
}

function discoverCssFiles(cssDir = CSS_DIR) {
  return walkFiles(cssDir, (_full, name) => name.toLowerCase().endsWith('.css'));
}

function isEsmSource(code, filePath) {
  if (filePath.toLowerCase().endsWith('.mjs')) return true;
  const clean = stripJsComments(code);
  return /(?:^|[\n;{}])\s*(?:import\s+(?:[\w*{]|['"])|export\s+(?:default|function|class|const|let|var|\{|\*))/m.test(clean);
}

function discoverHudAndAnimationModules(jsDir = JS_DIR) {
  const allJs = walkFiles(jsDir, (_full, name) => /\.(?:mjs|js)$/i.test(name));
  const optionalModules = [];
  const animationScripts = [];

  for (const full of allJs) {
    const rel = path.relative(jsDir, full).replace(/\\/g, '/');
    const base = path.basename(full);
    if (WORKER_FILE_RE.test(base)) continue;

    const explicit = EXPLICIT_HUD_MODULE_RE.test(base);
    const semantic = SEMANTIC_ANIM_RE.test(base);
    const isNewFile = !BASELINE_NON_HUD_FILES.has(rel) && rel !== 'reveal.js';

    if (explicit || semantic || isNewFile) {
      animationScripts.push(full);
      const source = fs.readFileSync(full, 'utf8');
      if (explicit || (isNewFile && isEsmSource(source, full)) || full.toLowerCase().endsWith('.mjs')) {
        optionalModules.push(full);
      }
    }
  }

  return { animationScripts, optionalModules };
}

/* ---------- CSS reduced-motion parser & contract ---------- */

function stripCssComments(css) {
  let out = '';
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < css.length) out += css[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) {
        if (css[i] === '\n') out += '\n';
        i++;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function findMatchingBrace(text, openIndex) {
  let depth = 1;
  let quote = null;
  for (let i = openIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function splitTopLevelCommas(text) {
  const parts = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === ',' && paren === 0 && bracket === 0) {
      const slice = text.slice(start, i).trim();
      if (slice) parts.push(slice);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function expandSelectorList(selectorText) {
  const expanded = [];
  for (const raw of splitTopLevelCommas(selectorText)) {
    const match = /^:(?:is|where)\(([\s\S]+)\)$/i.exec(raw.trim());
    if (match) expanded.push(...expandSelectorList(match[1]));
    else expanded.push(raw.trim());
  }
  return expanded;
}

function resolveSelectorChain(nonAtAncestors) {
  if (!nonAtAncestors.length) return [''];
  let current = expandSelectorList(nonAtAncestors[0]);
  for (let i = 1; i < nonAtAncestors.length; i++) {
    const nextList = expandSelectorList(nonAtAncestors[i]);
    const combined = [];
    for (const parent of current) {
      for (const child of nextList) {
        combined.push(child.includes('&') ? child.replace(/&/g, parent) : `${parent} ${child}`.trim());
      }
    }
    current = combined;
  }
  return current;
}

function parseCssRules(cssText) {
  const clean = stripCssComments(cssText);
  const keyframes = [];
  const rules = [];
  let hasNoPreferenceMedia = false;
  let hasReduceMedia = false;

  function visitBlock(body, ancestors) {
    const declarations = [];
    let tokenStart = 0;
    let paren = 0;
    let bracket = 0;
    let quote = null;

    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') paren++;
      else if (ch === ')' && paren > 0) paren--;
      else if (ch === '[') bracket++;
      else if (ch === ']' && bracket > 0) bracket--;
      else if (ch === ';' && paren === 0 && bracket === 0) {
        const decl = body.slice(tokenStart, i).trim();
        if (decl && !decl.startsWith('@')) declarations.push(decl);
        tokenStart = i + 1;
      } else if (ch === '{' && paren === 0 && bracket === 0) {
        const prelude = body.slice(tokenStart, i).trim();
        const closeIdx = findMatchingBrace(body, i);
        const inner = body.slice(i + 1, closeIdx);
        if (/^@media\b[^{]*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/i.test(prelude)) {
          hasNoPreferenceMedia = true;
        }
        if (/^@media\b[^{]*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i.test(prelude)) {
          hasReduceMedia = true;
        }
        if (/^@(?:-[a-z]+-)?keyframes\b/i.test(prelude)) {
          keyframes.push({ prelude, ancestors: [...ancestors] });
        } else {
          visitBlock(inner, [...ancestors, prelude]);
        }
        i = closeIdx;
        tokenStart = closeIdx + 1;
      }
    }

    const trailing = body.slice(tokenStart).trim();
    if (trailing && !trailing.startsWith('@')) declarations.push(trailing);

    if (declarations.length && ancestors.length) {
      const atAncestors = ancestors.filter(a => a.startsWith('@'));
      const selectorAncestors = ancestors.filter(a => !a.startsWith('@'));
      if (selectorAncestors.length) {
        rules.push({
          selectors: resolveSelectorChain(selectorAncestors),
          atAncestors,
          declarations,
        });
      }
    }
  }

  visitBlock(clean, []);
  return { keyframes, rules, hasNoPreferenceMedia, hasReduceMedia };
}

function parseDeclaration(decl) {
  const idx = decl.indexOf(':');
  if (idx <= 0) return null;
  const prop = decl.slice(0, idx).trim().toLowerCase();
  const rawValue = decl.slice(idx + 1).trim();
  const value = rawValue.replace(/!important\s*$/i, '').trim();
  return { prop, value, rawValue };
}

function isNearZeroDuration(value) {
  const parts = splitTopLevelCommas(value);
  return parts.length > 0 && parts.every(part => {
    const m = /^([0-9]*\.?[0-9]+)\s*(ms|s)?$/i.exec(part.trim());
    if (!m) return false;
    const num = Number(m[1]);
    const unit = (m[2] || 's').toLowerCase();
    const ms = unit === 'ms' ? num : num * 1000;
    return ms <= 10;
  });
}

function tokenizeCompoundSelector(compound) {
  let s = compound.trim();
  let pseudoEl = null;
  const pseudoMatch = /(::?(?:before|after))\s*$/i.exec(s);
  if (pseudoMatch) {
    pseudoEl = '::' + pseudoMatch[1].replace(/^:+/, '').toLowerCase();
    s = s.slice(0, pseudoMatch.index).trim();
  }
  const tokens = new Set();
  const tokenRe = /\[[^\]]+\]|#[a-zA-Z0-9_-]+|\.[a-zA-Z0-9_-]+|:[a-zA-Z0-9_-]+(?:\([^)]*\))?|\*|[a-zA-Z][a-zA-Z0-9_-]*/g;
  for (const m of s.matchAll(tokenRe)) {
    let tok = m[0].replace(/\s+/g, '');
    if (tok.startsWith('[') && tok.endsWith(']')) {
      tok = tok.replace(/=\s*['"]([^'"]*)['"]\s*\]$/, '="$1"]').replace(/=\s*([^'"\]\s]+)\s*\]$/, '="$1"]');
    }
    tokens.add(tok);
  }
  return { pseudoEl, tokens };
}

function splitCombinators(selector) {
  const compounds = [];
  let buf = '';
  let paren = 0;
  let bracket = 0;
  let quote = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < selector.length) buf += selector[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') { paren++; buf += ch; continue; }
    if (ch === ')' && paren > 0) { paren--; buf += ch; continue; }
    if (ch === '[') { bracket++; buf += ch; continue; }
    if (ch === ']' && bracket > 0) { bracket--; buf += ch; continue; }

    if (paren === 0 && bracket === 0 && (/\s/.test(ch) || ch === '>' || ch === '+' || ch === '~')) {
      if (buf.trim()) compounds.push(tokenizeCompoundSelector(buf));
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) compounds.push(tokenizeCompoundSelector(buf));
  return compounds;
}

function isSubset(subset, superset) {
  for (const item of subset) {
    if (item === '*') continue;
    if (!superset.has(item)) return false;
  }
  return true;
}

function selectorCovers(disablerSelector, targetSelector) {
  const normA = disablerSelector.replace(/\s+/g, ' ').trim();
  const normB = targetSelector.replace(/\s+/g, ' ').trim();
  if (normA === normB) return true;

  const dChain = splitCombinators(normA);
  const tChain = splitCombinators(normB);
  if (!dChain.length || !tChain.length) return false;

  const dSubj = dChain[dChain.length - 1];
  const tSubj = tChain[tChain.length - 1];
  if (dSubj.pseudoEl !== tSubj.pseudoEl) return false;

  const dAncestors = dChain.slice(0, -1).filter(
    c => !(c.pseudoEl === null && c.tokens.size === 1 && (c.tokens.has('html') || c.tokens.has('body') || c.tokens.has(':root')))
  );

  // Universal subject reset (* / *::before / *::after) with no non-root ancestors covers every element of that pseudo kind.
  if (dSubj.tokens.size === 1 && dSubj.tokens.has('*') && dAncestors.length === 0) {
    return true;
  }

  const meaningfulSubj = [...dSubj.tokens].filter(tok => tok !== '*');
  if (!meaningfulSubj.length || !isSubset(meaningfulSubj, tSubj.tokens)) return false;

  const tAncestors = tChain.slice(0, -1);
  let tIdx = 0;
  for (const dAnc of dAncestors) {
    while (tIdx < tAncestors.length && !isSubset(dAnc.tokens, tAncestors[tIdx].tokens)) tIdx++;
    if (tIdx >= tAncestors.length) return false;
    tIdx++;
  }
  return true;
}

function inspectCssReducedMotion(cssText) {
  const { keyframes, rules, hasNoPreferenceMedia, hasReduceMedia } = parseCssRules(cssText);
  const activeAnimations = [];
  const reduceDisablerSelectors = [];
  const infiniteIterationSelectors = new Set();

  for (const rule of rules) {
    const inNoPreference = rule.atAncestors.some(a =>
      /^@media\b[^{]*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/i.test(a)
    );
    const inReduce = rule.atAncestors.some(a =>
      /^@media\b[^{]*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i.test(a)
    );
    const parsedDecls = rule.declarations.map(parseDeclaration).filter(Boolean);

    const hasInfiniteIter = parsedDecls.some(d =>
      /^(?:-[a-z]+-)?animation-iteration-count$/.test(d.prop) && /\binfinite\b/i.test(d.value)
    );
    if (hasInfiniteIter && !inNoPreference && !inReduce) {
      for (const sel of rule.selectors) infiniteIterationSelectors.add(sel);
    }

    for (const d of parsedDecls) {
      const isAnimShorthand = /^(?:-[a-z]+-)?animation$/.test(d.prop);
      const isAnimName = /^(?:-[a-z]+-)?animation-name$/.test(d.prop);
      const isIterCount = /^(?:-[a-z]+-)?animation-iteration-count$/.test(d.prop);
      const isPlayState = /^(?:-[a-z]+-)?animation-play-state$/.test(d.prop);
      const isDuration = /^(?:-[a-z]+-)?animation-duration$/.test(d.prop);

      if (inReduce) {
        const disables =
          ((isAnimShorthand || isAnimName) && /\b(?:none|initial|unset)\b/i.test(d.value)) ||
          (isAnimShorthand && !/\binfinite\b/i.test(d.value) && /(?:^|\s)(?:0(?:\.0+)?(?:s|ms)?|0?\.\d+ms|[1-9]ms)(?:\s|$)/i.test(d.value)) ||
          (isIterCount && /^(?:0|1)$/i.test(d.value)) ||
          (isPlayState && /\bpaused\b/i.test(d.value)) ||
          (isDuration && isNearZeroDuration(d.value));
        if (disables) reduceDisablerSelectors.push(...rule.selectors);
        continue;
      }

      if (isAnimShorthand || isAnimName) {
        const isDisabledVal = /^(?:none|initial|unset)$/i.test(d.value) ||
          (isAnimShorthand && /^(?:none\b|.*\snone$)/i.test(d.value));
        if (!isDisabledVal) {
          const continuous = hasInfiniteIter || (isAnimShorthand && /\binfinite\b/i.test(d.value));
          activeAnimations.push({
            selectors: rule.selectors,
            prop: d.prop,
            value: d.value,
            inNoPreference,
            continuous,
          });
        }
      }
    }
  }

  for (const anim of activeAnimations) {
    if (!anim.continuous && anim.selectors.some(sel => infiniteIterationSelectors.has(sel))) {
      anim.continuous = true;
    }
  }

  if (keyframes.length === 0 && activeAnimations.length === 0) {
    return { ok: true, animated: false, issues: [] };
  }

  const issues = [];
  if (!hasNoPreferenceMedia && !hasReduceMedia) {
    issues.push('defines @keyframes or animation without any @media (prefers-reduced-motion: ...) rule');
  }

  const ungated = activeAnimations.filter(a => !a.inNoPreference);
  if (ungated.length > 0) {
    if (!hasReduceMedia || reduceDisablerSelectors.length === 0) {
      issues.push(
        `ungated animation on "${ungated[0].selectors.join(', ')}" without an animation-disabling rule inside @media (prefers-reduced-motion: reduce)`
      );
    } else {
      const ungatedContinuous = ungated.filter(a => a.continuous);
      for (const anim of ungatedContinuous) {
        for (const targetSel of anim.selectors) {
          const covered = reduceDisablerSelectors.some(disabler => selectorCovers(disabler, targetSel));
          if (!covered) {
            issues.push(
              `continuous animation "${anim.prop}: ${anim.value}" on "${targetSel}" is neither gated in prefers-reduced-motion: no-preference nor disabled in prefers-reduced-motion: reduce`
            );
          }
        }
      }
    }
  }

  return { ok: issues.length === 0, animated: true, issues };
}

/* ---------- HTML ARIA & safety parser ---------- */

function parseHtmlElementsById(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  const byId = new Map();
  const tagRe = /<([a-zA-Z][a-zA-Z0-9:-]*)(\s(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  for (const tagMatch of stripped.matchAll(tagRe)) {
    const tagName = tagMatch[1].toLowerCase();
    const rawAttrs = tagMatch[2] || '';
    const attrs = new Map();
    for (const attrMatch of rawAttrs.matchAll(attrRe)) {
      const attrName = attrMatch[1].toLowerCase();
      const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      attrs.set(attrName, attrVal);
    }
    const id = attrs.get('id');
    if (id) byId.set(id, { tagName, attrs });
  }
  return byId;
}

function extractInlineStyles(html) {
  const styles = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (const m of html.matchAll(styleRe)) styles.push(m[1]);
  return styles.join('\n');
}

function inspectTowerHtmlA11y(html) {
  const byId = parseHtmlElementsById(html);
  const issues = [];

  for (const liveId of ['sideRisk', 'risk', 'birdReviewStatus']) {
    const el = byId.get(liveId);
    if (!el) {
      issues.push(`missing #${liveId}`);
      continue;
    }
    if (el.attrs.get('aria-live') !== 'polite') {
      issues.push(`#${liveId} must preserve aria-live="polite" (found ${JSON.stringify(el.attrs.get('aria-live'))})`);
    }
    if (el.attrs.get('aria-hidden') === 'true') {
      issues.push(`#${liveId} must not set aria-hidden="true"`);
    }
  }

  for (const riskId of ['sideRisk', 'risk']) {
    const el = byId.get(riskId);
    if (el && el.attrs.get('data-risk') !== 'unavailable') {
      issues.push(`#${riskId} must start fail-closed with data-risk="unavailable" (found ${JSON.stringify(el.attrs.get('data-risk'))})`);
    }
  }

  const unack = byId.get('unacknowledgedAlerts');
  if (!unack) {
    issues.push('missing #unacknowledgedAlerts');
  } else {
    if (unack.attrs.get('aria-hidden') === 'true' || unack.attrs.has('hidden')) {
      issues.push('#unacknowledgedAlerts must remain exposed to assistive technology (not hidden or aria-hidden)');
    }
    const label = (unack.attrs.get('aria-label') || unack.attrs.get('aria-labelledby') || '').trim();
    if (!label) {
      issues.push('#unacknowledgedAlerts must preserve an accessible name (aria-label or aria-labelledby)');
    }
  }

  const birdCheck = byId.get('birdCheck');
  if (!birdCheck || birdCheck.attrs.get('aria-pressed') !== 'false') {
    issues.push('#birdCheck must remain opt-in with aria-pressed="false" by default');
  }

  const cloudReview = byId.get('birdCloudReview');
  if (!cloudReview || cloudReview.attrs.has('checked')) {
    issues.push('#birdCloudReview must remain unchecked by default');
  }

  return { ok: issues.length === 0, issues, byId };
}

/* ---------- JS comment stripper & static zero-leak analyzer ---------- */

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'new', 'yield', 'await', 'else', 'do',
]);

function hasClosingRegexSlashOnSameLine(code, slashIndex) {
  let inClass = false;
  for (let i = slashIndex + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') { i++; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i;
  }
  return -1;
}

function stripJsComments(code) {
  let out = '';
  let canStartRegex = true;
  let lastWord = '';
  const templateBraceStack = [];

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];

    // Single or double quoted string
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < code.length) {
        const c = code[i];
        out += c;
        if (c === '\\' && i + 1 < code.length) out += code[++i];
        else if (c === quote) break;
        i++;
      }
      canStartRegex = false;
      lastWord = '';
      continue;
    }

    // Template literal start or continuation after ${ ... }
    if (ch === '`' || (ch === '}' && templateBraceStack.length && templateBraceStack[templateBraceStack.length - 1] === 0)) {
      if (ch === '}') templateBraceStack.pop();
      out += ch;
      i++;
      while (i < code.length) {
        const c = code[i];
        if (c === '\\' && i + 1 < code.length) {
          out += c + code[++i];
          i++;
          continue;
        }
        if (c === '$' && code[i + 1] === '{') {
          out += '${';
          i++;
          templateBraceStack.push(0);
          canStartRegex = true;
          lastWord = '';
          break;
        }
        out += c;
        if (c === '`') {
          canStartRegex = false;
          lastWord = '';
          break;
        }
        i++;
      }
      continue;
    }

    if (templateBraceStack.length) {
      if (ch === '{') templateBraceStack[templateBraceStack.length - 1]++;
      else if (ch === '}') templateBraceStack[templateBraceStack.length - 1]--;
    }

    // Line comment
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < code.length && code[i] !== '\n') i++;
      if (i < code.length) out += '\n';
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i++;
      continue;
    }

    // Regex literal
    if (ch === '/' && canStartRegex) {
      const endSlash = hasClosingRegexSlashOnSameLine(code, i);
      if (endSlash !== -1) {
        out += code.slice(i, endSlash + 1);
        i = endSlash;
        while (i + 1 < code.length && /[a-z]/i.test(code[i + 1])) out += code[++i];
        canStartRegex = false;
        lastWord = '';
        continue;
      }
    }

    out += ch;

    if (/[a-zA-Z0-9_$]/.test(ch)) {
      lastWord += ch;
      canStartRegex = REGEX_PRECEDING_KEYWORDS.has(lastWord);
    } else {
      if (!/\s/.test(ch)) {
        lastWord = '';
        canStartRegex = '([{,;:=?!~&|^+-*%<>'.includes(ch);
      }
    }
  }
  return out;
}

const ZERO_LEAK_PATTERNS = [
  {
    name: 'references forbidden socket event tower:label',
    re: /['"`]tower:label['"`]/,
  },
  {
    name: 'references forbidden socket event tower:bot-event',
    re: /['"`]tower:bot-event['"`]/,
  },
  {
    name: 'emits authoritative detector/camera event from frontend HUD/animation module',
    re: /\.emit\s*\(\s*['"`](?:tower:label|tower:bot-event|camera:event|bot:state|bot:status|alert|alert_pending)['"`]/,
  },
  {
    name: 'calls DetectionEngine.applyLabel() to mutate track classification',
    re: /\.applyLabel\s*(?:\?\.\s*)?\(/,
  },
  {
    name: 'mutates authoritative track/state .classification property',
    re: /\b(?:track|tr|target|candidate|botState|detectorState|serverState|tracks\s*\[[^\]]+\])\s*\.\s*classification\s*(?:=(?!=)|\?\?=|\|\|=|&&=)|\b(?:track|tr|target|candidate|botState|detectorState|serverState|tracks\s*\[[^\]]+\])\s*\[\s*['"`]classification['"`]\s*\]\s*(?:=(?!=)|\?\?=|\|\|=|&&=)|Object\.assign\s*\(\s*(?:track|tr|tracks\s*\[[^\]]+\]|(?:feed\.)?botState)\b[^)]*\bclassification\s*:/,
  },
  {
    name: 'mutates authoritative botState / detector state directly',
    re: /\b(?:botState|detectorState|serverState)\s*\.\s*(?:risk|tracks|generation|classification)\s*(?:=(?!=)|\?\?=|\|\|=|&&=)/,
  },
  {
    name: 'overwrites feed.botState or feed.detector handle',
    re: /\b(?:feed|tile)\s*\.\s*(?:botState|detector)\s*(?:=(?!=)|\?\?=|\|\|=|&&=)/,
  },
];

function inspectJsZeroLeak(sourceText) {
  const clean = stripJsComments(sourceText);
  const issues = [];
  for (const { name, re } of ZERO_LEAK_PATTERNS) {
    if (re.test(clean)) issues.push(name);
  }
  return { ok: issues.length === 0, issues };
}

/* ---------- Browser global mocking & clean-import / behavioral zero-leak harness ---------- */

const BROWSER_GLOBAL_KEYS = [
  'window',
  'document',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IntersectionObserver',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'localStorage',
  'sessionStorage',
  'CSS',
  'HTMLCanvasElement',
  'HTMLElement',
  'Element',
  'Node',
  'innerWidth',
  'innerHeight',
  'devicePixelRatio',
  'location',
];

class MockNode {}
class MockElement extends MockNode {}
class MockHTMLElement extends MockElement {}
class MockHTMLCanvasElement extends MockHTMLElement {}

function createMockCanvasContext() {
  return new Proxy({
    canvas: { width: 320, height: 240 },
    measureText: text => ({ width: String(text ?? '').length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: (_x, _y, w = 1, h = 1) => ({
      width: Math.max(1, w),
      height: Math.max(1, h),
      data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4),
    }),
  }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function createMockElement(tagName = 'div') {
  const attrs = new Map();
  const classes = new Set();
  const styleStore = new Map();
  const listeners = new Map();
  const el = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    width: 320,
    height: 240,
    offsetWidth: 320,
    offsetHeight: 240,
    clientWidth: 320,
    clientHeight: 240,
    dataset: {},
    children: [],
    parentNode: null,
    parentElement: null,
    style: new Proxy({}, {
      get(_t, prop) {
        if (prop === 'setProperty') return (k, v) => { styleStore.set(k, String(v)); };
        if (prop === 'getPropertyValue') return k => styleStore.get(k) || '';
        if (prop === 'removeProperty') return k => { styleStore.delete(k); };
        return styleStore.get(String(prop)) || '';
      },
      set(_t, prop, val) {
        styleStore.set(String(prop), String(val));
        return true;
      },
    }),
    classList: {
      add(...names) { for (const n of names) classes.add(n); },
      remove(...names) { for (const n of names) classes.delete(n); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, val) { attrs.set(String(name).toLowerCase(), String(val)); },
    getAttribute(name) { return attrs.get(String(name).toLowerCase()) ?? null; },
    hasAttribute(name) { return attrs.has(String(name).toLowerCase()); },
    removeAttribute(name) { attrs.delete(String(name).toLowerCase()); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent() { return true; },
    appendChild(child) { if (child && typeof child === 'object') this.children.push(child); return child; },
    append(...nodes) { for (const n of nodes) if (n && typeof n === 'object') this.children.push(n); },
    prepend(...nodes) { this.children.unshift(...nodes.filter(n => n && typeof n === 'object')); },
    replaceChildren(...nodes) { this.children = nodes.filter(n => n && typeof n === 'object'); },
    remove() {},
    after() {},
    before() {},
    closest() { return null; },
    matches() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 240, width: 320, height: 240 }),
    getContext: () => createMockCanvasContext(),
    animate: () => ({ cancel() {}, finish() {}, pause() {}, play() {}, finished: Promise.resolve() }),
  };
  Object.setPrototypeOf(
    el,
    String(tagName).toLowerCase() === 'canvas' ? MockHTMLCanvasElement.prototype : MockHTMLElement.prototype
  );
  return el;
}

function createMockStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    getItem: k => map.get(String(k)) ?? null,
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: k => { map.delete(String(k)); },
    clear: () => { map.clear(); },
    key: i => [...map.keys()][i] ?? null,
  };
}

function createMockBrowserEnvironment({ reducedMotion = true } = {}) {
  const rafCalls = [];
  let nextTimerId = 1;
  const docElement = createMockElement('html');
  const head = createMockElement('head');
  const body = createMockElement('body');

  class MockObserver {
    constructor(cb) { this.cb = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }

  const matchMedia = query => ({
    media: String(query),
    matches: /prefers-reduced-motion\s*:\s*reduce/i.test(String(query))
      ? Boolean(reducedMotion)
      : /prefers-reduced-motion\s*:\s*no-preference/i.test(String(query))
        ? !reducedMotion
        : false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });

  const requestAnimationFrame = cb => {
    const id = nextTimerId++;
    rafCalls.push({ id, cb });
    return id;
  };
  const cancelAnimationFrame = () => {};

  const document = {
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    documentElement: docElement,
    head,
    body,
    createElement: tag => createMockElement(tag),
    createElementNS: (_ns, tag) => createMockElement(tag),
    createDocumentFragment: () => createMockElement('fragment'),
    createTextNode: text => ({ nodeType: 3, textContent: String(text ?? ''), remove() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };

  const localStorage = createMockStorage();
  const sessionStorage = createMockStorage();
  const getComputedStyle = () => new Proxy({}, {
    get: (_t, prop) => (prop === 'getPropertyValue' ? () => '' : ''),
  });
  const location = {
    protocol: 'https:',
    hostname: 'skysentry.test',
    host: 'skysentry.test',
    origin: 'https://skysentry.test',
    pathname: '/tower.html',
    search: '',
    hash: '',
    href: 'https://skysentry.test/tower.html',
  };
  const CSS = { supports: () => false };

  const window = {
    window: null,
    document,
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    IntersectionObserver: MockObserver,
    MutationObserver: MockObserver,
    ResizeObserver: MockObserver,
    getComputedStyle,
    localStorage,
    sessionStorage,
    CSS,
    HTMLCanvasElement: MockHTMLCanvasElement,
    HTMLElement: MockHTMLElement,
    Element: MockElement,
    Node: MockNode,
    CustomEvent: globalThis.CustomEvent,
    Event: globalThis.Event,
    performance: globalThis.performance,
    navigator: globalThis.navigator ?? { userAgent: 'node-test', hardwareConcurrency: 4 },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    pageYOffset: 0,
    location,
    setTimeout: () => nextTimerId++,
    clearTimeout() {},
    setInterval: () => nextTimerId++,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
  window.window = window;

  return {
    globals: {
      window,
      document,
      matchMedia,
      requestAnimationFrame,
      cancelAnimationFrame,
      IntersectionObserver: MockObserver,
      MutationObserver: MockObserver,
      ResizeObserver: MockObserver,
      getComputedStyle,
      localStorage,
      sessionStorage,
      CSS,
      HTMLCanvasElement: MockHTMLCanvasElement,
      HTMLElement: MockHTMLElement,
      Element: MockElement,
      Node: MockNode,
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      location,
    },
    rafCalls,
    document,
    window,
  };
}

async function withGlobalOverrides(mode, fn) {
  const saved = new Map();
  const savedTimers = {
    setTimeout: Object.getOwnPropertyDescriptor(globalThis, 'setTimeout'),
    clearTimeout: Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout'),
    setInterval: Object.getOwnPropertyDescriptor(globalThis, 'setInterval'),
    clearInterval: Object.getOwnPropertyDescriptor(globalThis, 'clearInterval'),
  };

  for (const key of BROWSER_GLOBAL_KEYS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  let timerSeq = 1000;
  try {
    // Prevent module top-level or probed init timers from keeping the test runner alive or firing after teardown.
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: () => timerSeq++ });
    Object.defineProperty(globalThis, 'clearTimeout', { configurable: true, writable: true, value: () => {} });
    Object.defineProperty(globalThis, 'setInterval', { configurable: true, writable: true, value: () => timerSeq++ });
    Object.defineProperty(globalThis, 'clearInterval', { configurable: true, writable: true, value: () => {} });

    if (mode === 'absent') {
      for (const key of BROWSER_GLOBAL_KEYS) {
        const desc = saved.get(key);
        if (!desc || desc.configurable !== false) delete globalThis[key];
      }
      return await fn(null);
    }

    const env = createMockBrowserEnvironment({ reducedMotion: mode === 'mocked-reduce' });
    for (const [key, value] of Object.entries(env.globals)) {
      const desc = saved.get(key);
      if (!desc || desc.configurable !== false) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      }
    }
    return await fn(env);
  } finally {
    for (const [key, desc] of Object.entries(savedTimers)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
    }
    for (const [key, desc] of saved.entries()) {
      if (desc === undefined) delete globalThis[key];
      else if (desc.configurable !== false) Object.defineProperty(globalThis, key, desc);
    }
  }
}

function createAuthorityGuardFixture() {
  const violations = [];
  const rawTrack = {
    id: 1,
    classification: 'unknown',
    bbox: { x: 0.25, y: 0.25, w: 0.2, h: 0.2 },
    vx: 0.02,
    vy: 0.01,
    age: 8,
  };

  const trackProxy = new Proxy(rawTrack, {
    set(_target, prop, value) {
      violations.push(`mutated authoritative track.${String(prop)} = ${JSON.stringify(value)}`);
      return true;
    },
    defineProperty(_target, prop) {
      violations.push(`redefined authoritative track.${String(prop)}`);
      return true;
    },
    deleteProperty(_target, prop) {
      violations.push(`deleted authoritative track.${String(prop)}`);
      return true;
    },
  });

  const tracksProxy = new Proxy([trackProxy], {
    set(_target, prop, value) {
      violations.push(`mutated authoritative state.tracks[${String(prop)}] = ${JSON.stringify(value)}`);
      return true;
    },
  });

  const rawState = {
    generation: 'gen-guard-1',
    t: 1.2,
    risk: 'yellow',
    learning: false,
    shake: false,
    overflow: false,
    tracks: tracksProxy,
    reasons: ['server motion warning'],
  };

  const stateProxy = new Proxy(rawState, {
    set(_target, prop, value) {
      violations.push(`mutated authoritative state.${String(prop)} = ${JSON.stringify(value)}`);
      return true;
    },
    defineProperty(_target, prop) {
      violations.push(`redefined authoritative state.${String(prop)}`);
      return true;
    },
  });

  const socket = {
    connected: true,
    on() { return this; },
    off() { return this; },
    once() { return this; },
    emit(event) {
      if (['tower:label', 'tower:bot-event', 'camera:event', 'bot:state', 'bot:status', 'alert', 'alert_pending'].includes(event)) {
        violations.push(`emitted forbidden socket event "${event}"`);
      }
      return this;
    },
  };

  const engine = {
    applyLabel(...args) {
      violations.push(`called engine.applyLabel(${JSON.stringify(args)})`);
    },
  };

  const rawFeed = {
    cameraId: 'cam-guard-1',
    mode: 'server',
    source: 'server',
    demo: false,
    botState: stateProxy,
    engine,
  };

  const feed = new Proxy(rawFeed, {
    set(target, prop, value) {
      if (prop === 'botState' || prop === 'detector' || prop === 'mode' || prop === 'source') {
        violations.push(`overwrote authoritative feed.${String(prop)}`);
        return true;
      }
      target[prop] = value;
      return true;
    },
  });

  return { violations, socket, engine, state: stateProxy, tracks: tracksProxy, track: rawTrack, feed };
}

async function probeModuleExportsBehaviorally(mod) {
  const guard = createAuthorityGuardFixture();
  const optionsBag = {
    container: createMockElement('div'),
    root: createMockElement('div'),
    el: createMockElement('div'),
    canvas: createMockElement('canvas'),
    beacon: createMockElement('div'),
    list: createMockElement('ul'),
    socket: guard.socket,
    engine: guard.engine,
    feed: guard.feed,
    state: guard.state,
    tracks: guard.tracks,
    risk: 'yellow',
    level: 'yellow',
    from: 0,
    to: 12,
    value: 12,
    count: 12,
    duration: 0,
    reducedMotion: true,
  };

  const argPairs = [
    [optionsBag, optionsBag],
    [createMockElement('canvas'), optionsBag],
  ];

  for (const [exportName, exported] of Object.entries(mod)) {
    if (typeof exported !== 'function') continue;
    const isClass = /^class\b/.test(Function.prototype.toString.call(exported).trimStart());
    for (const [firstArg, secondArg] of argPairs) {
      let instance = null;
      try {
        instance = isClass ? new exported(firstArg, secondArg) : await exported(firstArg, secondArg);
      } catch (err) {
        if (err instanceof ReferenceError) {
          throw new Error(`Export "${exportName}" threw ReferenceError under mocked DOM: ${err.message}`, { cause: err });
        }
        // Signature-validation errors (TypeError/RangeError/Error) are acceptable when probing generic exports.
      } finally {
        if (instance && typeof instance === 'object') {
          for (const cleanup of ['destroy', 'dispose', 'stop', 'detach', 'close', 'clear']) {
            if (typeof instance[cleanup] === 'function') {
              try { instance[cleanup](); } catch {}
            }
          }
        }
      }
    }
  }

  assert.deepEqual(guard.violations, []);
  assert.equal(guard.track.classification, 'unknown');
  assert.equal(guard.state.risk, 'yellow');
}

let importCounter = 0;
async function verifyCleanDynamicImport(filePath) {
  const baseHref = pathToFileURL(filePath).href;

  // 1. Must import cleanly in Node when window/document/matchMedia/observers are completely absent.
  await withGlobalOverrides('absent', async () => {
    await assert.doesNotReject(
      () => import(`${baseHref}?a11y_env=absent_${++importCounter}`),
      err => {
        assert.fail(
          `${path.relative(PUBLIC_DIR, filePath)} failed dynamic import when window/document are absent: ${err.stack || err}`
        );
      }
    );
  });

  // 2. Must import cleanly AND uphold behavioral zero-leak invariants when window/document are mocked (reduced + normal motion).
  for (const mode of ['mocked-reduce', 'mocked-motion']) {
    await withGlobalOverrides(mode, async () => {
      const mod = await import(`${baseHref}?a11y_env=${mode}_${++importCounter}`);
      await probeModuleExportsBehaviorally(mod);
    });
  }
}

/* ========================================================================== *
 *  1. CSS Reduced-Motion Contract Suite                                      *
 * ========================================================================== */

describe('CSS prefers-reduced-motion contract (PRANAV/public/css/)', () => {
  const cssFiles = discoverCssFiles();

  test('auto-discovers baseline stylesheets in PRANAV/public/css/', () => {
    const names = cssFiles.map(f => path.basename(f));
    for (const expected of ['app.css', 'film.css', 'site.css']) {
      assert.ok(names.includes(expected), `expected to discover ${expected} in public/css/`);
    }
  });

  for (const cssFile of cssFiles) {
    const rel = path.relative(PUBLIC_DIR, cssFile).replace(/\\/g, '/');
    test(`${rel} gates animations in prefers-reduced-motion: no-preference or disables continuous animations in reduce`, () => {
      const css = fs.readFileSync(cssFile, 'utf8');
      const report = inspectCssReducedMotion(css);
      assert.equal(report.ok, true, `${rel} violated reduced-motion contract:\n  - ${report.issues.join('\n  - ')}`);
    });
  }

  test('CSS contract validator accepts valid patterns and catches ungated or uncovered continuous animations', () => {
    // Pattern A: gated inside prefers-reduced-motion: no-preference (like site.css / app.css)
    assert.equal(inspectCssReducedMotion(`
      @keyframes rise { from { opacity: 0 } to { opacity: 1 } }
      @media (prefers-reduced-motion: no-preference) {
        .card { animation: rise .4s ease-out both }
        .live-dot { animation: rise 1.5s linear infinite }
      }
    `).ok, true);

    // Pattern B: ungated continuous animation overridden for matching selector in prefers-reduced-motion: reduce
    assert.equal(inspectCssReducedMotion(`
      @keyframes flash { to { background: red } }
      .risk[data-risk="red"] { animation: flash 1s infinite alternate }
      @media (prefers-reduced-motion: reduce) {
        .risk[data-risk="red"] { animation: none }
      }
    `).ok, true);

    // Pattern C: universal reduced-motion reset covering elements and pseudo-elements
    assert.equal(inspectCssReducedMotion(`
      @keyframes sweep { to { transform: rotate(360deg) } }
      .radar::after { animation: sweep 3s linear infinite }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
        }
      }
    `).ok, true);

    // Pattern D: static stylesheet with no @keyframes or animation (like film.css)
    const staticReport = inspectCssReducedMotion('.btn { transition: border-color .15s; color: #fff }');
    assert.equal(staticReport.ok, true);
    assert.equal(staticReport.animated, false);

    // Failure 1: ungated continuous animation with no prefers-reduced-motion rule at all
    assert.equal(inspectCssReducedMotion(`
      @keyframes spin { to { transform: rotate(1turn) } }
      .reticle { animation: spin 2s linear infinite }
    `).ok, false);

    // Failure 2: prefers-reduced-motion: reduce disables a different selector, leaving continuous animation running
    assert.equal(inspectCssReducedMotion(`
      @keyframes pulse { to { opacity: .4 } }
      .beacon-ring { animation: pulse 1.2s ease-in-out infinite }
      @media (prefers-reduced-motion: reduce) {
        .unrelated { animation: none }
      }
    `).ok, false);

    // Failure 3: pseudo-element ::before continuous animation not covered by plain * (without *::before)
    assert.equal(inspectCssReducedMotion(`
      @keyframes ping { to { transform: scale(2); opacity: 0 } }
      .dot::before { animation: ping 1.5s ease-out infinite }
      @media (prefers-reduced-motion: reduce) {
        * { animation: none }
      }
    `).ok, false);
  });
});

/* ========================================================================== *
 *  2. Tower HTML ARIA Live Regions & Fail-Closed Safety Attributes           *
 * ========================================================================== */

describe('tower.html ARIA live regions and safety attributes', () => {
  test('preserves #sideRisk, #risk, #birdReviewStatus polite live regions, #unacknowledgedAlerts, and inline reduced-motion override', () => {
    const html = fs.readFileSync(TOWER_HTML, 'utf8');
    const report = inspectTowerHtmlA11y(html);
    assert.equal(report.ok, true, `tower.html accessibility/safety regression:\n  - ${report.issues.join('\n  - ')}`);

    const inlineCss = extractInlineStyles(html);
    const cssReport = inspectCssReducedMotion(inlineCss);
    assert.equal(cssReport.ok, true, `tower.html inline <style> reduced-motion regression:\n  - ${cssReport.issues.join('\n  - ')}`);
  });

  test('HTML inspector catches missing live regions, assertive downgrades, hidden alerts, and non-unavailable defaults', () => {
    const baseline = fs.readFileSync(TOWER_HTML, 'utf8');

    const droppedPolite = baseline.replace('id="sideRisk" href="#risk" data-risk="unavailable" aria-live="polite"',
      'id="sideRisk" href="#risk" data-risk="unavailable"');
    assert.equal(inspectTowerHtmlA11y(droppedPolite).ok, false);

    const brokenRisk = baseline.replace('id="risk" data-risk="unavailable" aria-live="polite"',
      'id="risk" data-risk="green" aria-live="polite"');
    assert.equal(inspectTowerHtmlA11y(brokenRisk).ok, false);

    const droppedBirdReview = baseline.replace('id="birdReviewStatus" role="status" aria-live="polite"',
      'id="birdReviewStatus" role="status"');
    assert.equal(inspectTowerHtmlA11y(droppedBirdReview).ok, false);

    const hiddenAlerts = baseline.replace('id="unacknowledgedAlerts" aria-label="Unacknowledged alerts"',
      'id="unacknowledgedAlerts" aria-hidden="true" aria-label="Unacknowledged alerts"');
    assert.equal(inspectTowerHtmlA11y(hiddenAlerts).ok, false);
  });
});

/* ========================================================================== *
 *  3 & 4. Frontend Animation / HUD Modules: Zero-Leak & Clean Node Import    *
 * ========================================================================== */

describe('HUD and animation frontend modules: zero-leak authority & clean Node import', () => {
  const { animationScripts, optionalModules } = discoverHudAndAnimationModules();

  test('baseline tower/advisory and discovered animation/HUD scripts never emit tower:label or tower:bot-event or mutate classification', () => {
    const towerFacingBaseline = [
      'reveal.js',
      'tower.js',
      'feeds.js',
      'visual-ai.js',
      ...BASELINE_CORE_MJS,
    ].map(name => path.join(JS_DIR, name));

    const targets = [...new Set([...towerFacingBaseline, ...animationScripts])];
    assert.ok(targets.length >= towerFacingBaseline.length);

    for (const filePath of targets) {
      const rel = path.relative(PUBLIC_DIR, filePath).replace(/\\/g, '/');
      const source = fs.readFileSync(filePath, 'utf8');
      const report = inspectJsZeroLeak(source);
      assert.equal(report.ok, true, `${rel} failed zero-leak static check:\n  - ${report.issues.join('\n  - ')}`);
    }
  });

  test('reveal.js respects prefers-reduced-motion: reduce behaviorally and never hides content', () => {
    const code = fs.readFileSync(path.join(JS_DIR, 'reveal.js'), 'utf8');

    // When reduced motion is requested, reveal.js must exit before injecting .rv styles or observing DOM nodes.
    const reducedEnv = createMockBrowserEnvironment({ reducedMotion: true });
    let observerConstructed = false;
    reducedEnv.globals.IntersectionObserver = class {
      constructor() { observerConstructed = true; }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    reducedEnv.window.IntersectionObserver = reducedEnv.globals.IntersectionObserver;
    vm.runInNewContext(code, reducedEnv.globals);
    assert.equal(observerConstructed, false, 'IntersectionObserver must not start under prefers-reduced-motion: reduce');
    assert.equal(reducedEnv.document.head.children.length, 0, '.rv opacity-0 stylesheet must not be injected under reduced motion');

    // Under no-preference, reveal.js runs cleanly without ReferenceErrors.
    const motionEnv = createMockBrowserEnvironment({ reducedMotion: false });
    assert.doesNotThrow(() => vm.runInNewContext(code, motionEnv.globals));
  });

  test('baseline non-worker .mjs modules in PRANAV/public/js/ import cleanly in Node when window/document are absent', async () => {
    await withGlobalOverrides('absent', async () => {
      for (const name of BASELINE_CORE_MJS) {
        const full = path.join(JS_DIR, name);
        await assert.doesNotReject(
          () => import(`${pathToFileURL(full).href}?a11y_baseline=${++importCounter}`),
          `${name} must import cleanly without window/document`
        );
      }
    });
  });

  for (const modPath of optionalModules) {
    const rel = path.relative(PUBLIC_DIR, modPath).replace(/\\/g, '/');

    test(`${rel} emits no forbidden tower events and does not mutate authoritative detector classification`, () => {
      const source = fs.readFileSync(modPath, 'utf8');
      const report = inspectJsZeroLeak(source);
      assert.equal(report.ok, true, `${rel} failed zero-leak contract:\n  - ${report.issues.join('\n  - ')}`);
    });

    test(`${rel} dynamically imports cleanly in Node when window/document are absent or mocked`, async () => {
      await verifyCleanDynamicImport(modPath);
    });
  }

  test('auto-discovery, zero-leak static+behavioral guard, and Node import harness cover all named HUD/animation module patterns', async t => {
    const tmpJsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skysentry-a11y-guard-'));
    t.after(() => fs.rmSync(tmpJsDir, { recursive: true, force: true }));

    const expectedNames = [
      'hud-reticle.mjs',
      'flight-forecast.mjs',
      'landing-live-ai.mjs',
      'alert-choreography.mjs',
      'stat-counter.mjs',
      'risk-beacon-fx.mjs',
    ];

    for (const fileName of expectedNames) {
      fs.writeFileSync(path.join(tmpJsDir, fileName), [
        '// Advisory HUD/animation module: never emits tower:label or tower:bot-event in code.',
        'const prefersReduced = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);',
        'export function initEffect(options = {}) {',
        '  const tracks = Array.isArray(options?.tracks) ? options.tracks : [];',
        '  const labels = tracks.map(tr => tr.classification);',
        '  if (typeof document !== "undefined" && !prefersReduced()) {',
        '    const badge = document.createElement("span");',
        '    badge.textContent = labels.join(", ");',
        '  }',
        '  return { reduced: prefersReduced(), count: labels.length, destroy() {} };',
        '}',
      ].join('\n'));
    }
    // Worker files must remain excluded from UI module auto-discovery.
    fs.writeFileSync(path.join(tmpJsDir, 'hud-worker.mjs'), 'self.addEventListener("message", () => {});\n');

    const discovered = discoverHudAndAnimationModules(tmpJsDir);
    assert.deepEqual(
      discovered.optionalModules.map(f => path.basename(f)),
      [...expectedNames].sort((a, b) => a.localeCompare(b))
    );

    for (const modFile of discovered.optionalModules) {
      const report = inspectJsZeroLeak(fs.readFileSync(modFile, 'utf8'));
      assert.equal(report.ok, true);
      await verifyCleanDynamicImport(modFile);
    }

    // Verify static zero-leak guard catches forbidden events & classification mutations while ignoring comments/regex/division.
    assert.equal(inspectJsZeroLeak('const ratio = w / h; // never emit "tower:label" or "tower:bot-event"').ok, true);
    assert.equal(inspectJsZeroLeak('socket.emit("tower:label", { id: 1, label: "bird" });').ok, false);
    assert.equal(inspectJsZeroLeak('socket.emit(`tower:bot-event`, payload);').ok, false);
    assert.equal(inspectJsZeroLeak('feed.engine.applyLabel(1, "drone");').ok, false);
    assert.equal(inspectJsZeroLeak('track.classification = "bird";').ok, false);
    assert.equal(inspectJsZeroLeak('state.botState.risk = "green";').ok, false);

    // Verify clean-import harness rejects unguarded top-level window/document ReferenceErrors when absent.
    const unguardedPath = path.join(tmpJsDir, 'unguarded-hud.mjs');
    fs.writeFileSync(unguardedPath, 'export const width = window.innerWidth;\n');
    await assert.rejects(() => verifyCleanDynamicImport(unguardedPath), /absent|window is not defined/);

    // Verify behavioral probe catches indirect runtime classification mutation or forbidden socket emission.
    const sneakyMutatorPath = path.join(tmpJsDir, 'sneaky-hud.mjs');
    fs.writeFileSync(sneakyMutatorPath, [
      'export function attachHud({ tracks, socket }) {',
      '  const key = ["class", "ification"].join("");',
      '  if (tracks?.[0]) tracks[0][key] = "drone";',
      '  socket?.emit(["tower", "label"].join(":"), {});',
      '}',
    ].join('\n'));
    await assert.rejects(() => verifyCleanDynamicImport(sneakyMutatorPath));
  });
});
