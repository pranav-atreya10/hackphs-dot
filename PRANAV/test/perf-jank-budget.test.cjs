'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pranavRoot = path.join(__dirname, '..');
const repoRoot = path.join(pranavRoot, '..');
const publicDir = path.join(pranavRoot, 'public');
const cssDir = path.join(publicDir, 'css');
const jsDir = path.join(publicDir, 'js');

// ---------------------------------------------------------------------------
// File discovery helpers
// ---------------------------------------------------------------------------

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, out);
    else if (entry.isFile() && predicate(full, entry.name)) out.push(full);
  }
  return out.sort();
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// 1. CSS @keyframes & transition layout-thrashing analyzer
// ---------------------------------------------------------------------------

const LAYOUT_GEOMETRY_EXACT = new Set([
  'top',
  'left',
  'right',
  'bottom',
  'inset',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'inline-size',
  'block-size',
  'min-inline-size',
  'max-inline-size',
  'min-block-size',
  'max-block-size',
  'margin',
  'padding',
  'border-width',
  'font-size',
]);

function isLayoutGeometryProperty(prop) {
  const normalized = prop.trim().toLowerCase();
  if (!normalized || normalized.startsWith('--')) return false;
  if (LAYOUT_GEOMETRY_EXACT.has(normalized)) return true;
  if (/^(?:inset|margin|padding)-/.test(normalized)) return true;
  if (/^border(?:-[a-z]+)*-width$/.test(normalized)) return true;
  return false;
}

function stripCssCommentsPreserveLines(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) {
        out += css[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < css.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < css.length) {
        const c = css[i];
        out += c;
        i++;
        if (c === '\\' && i < css.length) {
          out += css[i];
          i++;
        } else if (c === quote) {
          break;
        }
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findMatchingCssBrace(css, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < css.length; i++) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < css.length) {
        if (css[i] === '\\') i += 2;
        else if (css[i] === quote) break;
        else i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCss(text, delimiter) {
  const parts = [];
  let start = 0;
  let parenDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === quote) break;
        else i++;
      }
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === delimiter && parenDepth === 0) {
      parts.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), offset: start });
  return parts;
}

function parseCssDeclarations(blockBody, blockOffset) {
  const declarations = [];
  for (const item of splitTopLevelCss(blockBody, ';')) {
    const raw = item.text;
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const propRaw = raw.slice(0, colon);
    const prop = propRaw.trim().toLowerCase();
    if (!prop || prop.includes('{') || prop.includes('}')) continue;
    const value = raw.slice(colon + 1).trim();
    const leadWs = propRaw.length - propRaw.trimStart().length;
    declarations.push({
      property: prop,
      value,
      offset: blockOffset + item.offset + leadWs,
    });
  }
  return declarations;
}

function extractTransitionedProperties(propName, value) {
  const cleaned = value.replace(/!important\s*$/i, '').trim();
  if (!cleaned || cleaned === 'none') return [];
  const items = splitTopLevelCss(cleaned, ',');
  const props = [];
  for (const { text } of items) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (propName === 'transition-property') {
      if (trimmed.toLowerCase() !== 'none') props.push(trimmed.toLowerCase());
      continue;
    }
    const tokens = [];
    let cur = '';
    let paren = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '(') {
        paren++;
        cur += ch;
      } else if (ch === ')') {
        if (paren > 0) paren--;
        cur += ch;
      } else if (/\s/.test(ch) && paren === 0) {
        if (cur) tokens.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur) tokens.push(cur);
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      if (/^[+-]?(?:\d+|\d*\.\d+)m?s$/.test(lower)) continue;
      if (/^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|allow-discrete|normal|none|inherit|initial|unset|revert|revert-layer)$/.test(lower)) continue;
      if (/^(?:cubic-bezier|steps|linear|var)\(/.test(lower)) continue;
      props.push(lower);
      break;
    }
  }
  return props;
}

function isDetailsAccordionSelector(selectorContext) {
  return /\bdetails\b|::details-content/i.test(selectorContext);
}

function analyzeCssJank(rawCss, filename = 'inline.css') {
  const css = stripCssCommentsPreserveLines(rawCss);
  const keyframeBlocks = [];
  const keyframeViolations = [];
  const transitionViolations = [];

  function walkRules(regionStart, regionEnd, ancestorSelectors = []) {
    let cursor = regionStart;
    while (cursor < regionEnd) {
      while (cursor < regionEnd && /[\s;]/.test(css[cursor])) cursor++;
      if (cursor >= regionEnd) break;

      const openBrace = css.indexOf('{', cursor);
      if (openBrace === -1 || openBrace >= regionEnd) break;
      const closeBrace = findMatchingCssBrace(css, openBrace);
      if (closeBrace === -1 || closeBrace > regionEnd) break;

      const rawPrelude = css.slice(cursor, openBrace);
      const preludeParts = splitTopLevelCss(rawPrelude, ';');
      const lastPart = preludeParts[preludeParts.length - 1];
      const prelude = lastPart.text.trim();
      const preludeOffset = cursor + lastPart.offset + (lastPart.text.length - lastPart.text.trimStart().length);
      const bodyStart = openBrace + 1;
      const bodyEnd = closeBrace;

      if (/^@(?:-webkit-)?keyframes\b/i.test(prelude)) {
        const name = prelude.replace(/^@(?:-webkit-)?keyframes\s+/i, '').trim();
        const kfLine = lineNumberAt(css, preludeOffset);
        const properties = [];
        let stopCursor = bodyStart;
        while (stopCursor < bodyEnd) {
          while (stopCursor < bodyEnd && /\s/.test(css[stopCursor])) stopCursor++;
          if (stopCursor >= bodyEnd) break;
          const stopOpen = css.indexOf('{', stopCursor);
          if (stopOpen === -1 || stopOpen >= bodyEnd) break;
          const stopClose = findMatchingCssBrace(css, stopOpen);
          if (stopClose === -1 || stopClose > bodyEnd) break;
          const stopSelector = css.slice(stopCursor, stopOpen).trim();
          const stopBody = css.slice(stopOpen + 1, stopClose);
          for (const decl of parseCssDeclarations(stopBody, stopOpen + 1)) {
            properties.push(decl.property);
            if (isLayoutGeometryProperty(decl.property)) {
              keyframeViolations.push({
                file: filename,
                line: lineNumberAt(css, decl.offset),
                keyframe: name,
                stop: stopSelector,
                property: decl.property,
                value: decl.value,
              });
            }
          }
          stopCursor = stopClose + 1;
        }
        keyframeBlocks.push({ file: filename, name, line: kfLine, properties });
      } else if (prelude.startsWith('@')) {
        if (!/^@(?:font-face|property|counter-style|page)\b/i.test(prelude)) {
          walkRules(bodyStart, bodyEnd, ancestorSelectors);
        }
      } else {
        const selectorContext = [...ancestorSelectors, prelude].join(' ').trim();
        // Extract declarations directly at this level (ignoring nested child blocks if CSS nesting is used)
        let declText = '';
        let scan = bodyStart;
        let hasNestedBlock = false;
        while (scan < bodyEnd) {
          const ch = css[scan];
          if (ch === '"' || ch === "'") {
            const q = ch;
            declText += ch;
            scan++;
            while (scan < bodyEnd) {
              declText += css[scan];
              if (css[scan] === '\\' && scan + 1 < bodyEnd) {
                scan++;
                declText += css[scan];
              } else if (css[scan] === q) {
                scan++;
                break;
              }
              scan++;
            }
            continue;
          }
          const nextBrace = css.indexOf('{', scan);
          const nextSemi = css.indexOf(';', scan);
          if (nextBrace !== -1 && nextBrace < bodyEnd && (nextSemi === -1 || nextBrace < nextSemi)) {
            hasNestedBlock = true;
            const nestedClose = findMatchingCssBrace(css, nextBrace);
            if (nestedClose === -1 || nestedClose > bodyEnd) break;
            const padLen = nestedClose - scan + 1;
            for (let p = 0; p < padLen; p++) declText += css[scan + p] === '\n' ? '\n' : ' ';
            scan = nestedClose + 1;
            continue;
          }
          declText += ch;
          scan++;
        }

        const allowAccordionHeight = isDetailsAccordionSelector(selectorContext);
        for (const decl of parseCssDeclarations(declText, bodyStart)) {
          if (decl.property === 'transition' || decl.property === 'transition-property') {
            const transitioned = extractTransitionedProperties(decl.property, decl.value);
            for (const tp of transitioned) {
              if (isLayoutGeometryProperty(tp) && !allowAccordionHeight) {
                transitionViolations.push({
                  file: filename,
                  line: lineNumberAt(css, decl.offset),
                  selector: selectorContext,
                  property: tp,
                  declaration: `${decl.property}: ${decl.value}`,
                });
              }
            }
          }
        }

        if (hasNestedBlock) {
          walkRules(bodyStart, bodyEnd, [...ancestorSelectors, prelude]);
        }
      }

      cursor = closeBrace + 1;
    }
  }

  walkRules(0, css.length, []);
  return { keyframeBlocks, keyframeViolations, transitionViolations };
}

// ---------------------------------------------------------------------------
// 2. HTML initial-load heavy model / 3D asset gate
// ---------------------------------------------------------------------------

const HEAVY_ASSET_PATTERNS = [
  { label: 'TensorFlow.js runtime (~1.4 MB + COCO weights)', pattern: /(?:^|[\/\\@])(?:tf(?:\.min)?\.js|tensorflow\/tfjs)\b/i },
  { label: 'COCO-SSD 17+ MB model/shards', pattern: /(?:coco-ssd|ai-models\/coco\/|group1-shard\d+of\d+)/i },
  { label: 'SkySentry 2.5 MB local classifier JSON/JS', pattern: /skysentry_classifier\.(?:json|js)\b/i },
  { label: '8 MB narrow-body-airliner.glb / heavy 3D scene asset', pattern: /(?:narrow-body-airliner\.(?:glb|gltf(?:\.json)?)|\.glb(?:\?|#|$)|derelict_airfield_01_1k\.hdr)/i },
];

function parseHtmlAttributes(tagContent) {
  const attrs = new Map();
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  let first = true;
  while ((match = attrRegex.exec(tagContent)) !== null) {
    if (first) {
      first = false;
      continue; // tag name
    }
    const name = match[1].toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    attrs.set(name, val);
  }
  return attrs;
}

function stripHtmlCommentsPreserveLines(html) {
  return html.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
}

function findEagerHeavyDownloads(rawHtml, filename = 'page.html') {
  const html = stripHtmlCommentsPreserveLines(rawHtml);
  const violations = [];

  // 1) Check <script src="..."> tags
  const scriptTagRegex = /<script\b[^>]*>/gi;
  let match;
  while ((match = scriptTagRegex.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(match[0].slice(1, -1));
    const src = attrs.get('src');
    if (!src) continue;
    for (const rule of HEAVY_ASSET_PATTERNS) {
      if (rule.pattern.test(src)) {
        violations.push({
          file: filename,
          line: lineNumberAt(html, match.index),
          kind: '<script src>',
          url: src,
          asset: rule.label,
        });
      }
    }
  }

  // 2) Check <link rel="preload|modulepreload" href="..."> tags
  const linkTagRegex = /<link\b[^>]*>/gi;
  while ((match = linkTagRegex.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(match[0].slice(1, -1));
    const relTokens = (attrs.get('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!relTokens.includes('preload') && !relTokens.includes('modulepreload')) continue;
    const href = attrs.get('href') || '';
    for (const rule of HEAVY_ASSET_PATTERNS) {
      if (rule.pattern.test(href)) {
        violations.push({
          file: filename,
          line: lineNumberAt(html, match.index),
          kind: `<link rel="${relTokens.join(' ')}">`,
          url: href,
          asset: rule.label,
        });
      }
    }
  }

  // 3) Check top-level static `import ... from '...'` in inline <script> blocks
  const inlineScriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((match = inlineScriptRegex.exec(html)) !== null) {
    const attrs = parseHtmlAttributes('script ' + match[1]);
    if (attrs.has('src') || (attrs.get('type') || '').toLowerCase() === 'importmap') continue;
    const body = match[2];
    const bodyOffset = match.index + match[0].indexOf('>') + 1;
    const staticImportRegex = /(?:^|[\r\n;])\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    let imp;
    while ((imp = staticImportRegex.exec(body)) !== null) {
      const specifier = imp[1];
      for (const rule of HEAVY_ASSET_PATTERNS) {
        if (rule.pattern.test(specifier)) {
          violations.push({
            file: filename,
            line: lineNumberAt(html, bodyOffset + imp.index),
            kind: 'inline top-level import',
            url: specifier,
            asset: rule.label,
          });
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 3. JS hot-callback forced-reflow DOM read analyzer
// ---------------------------------------------------------------------------

const FORCED_REFLOW_PROPS = new Set([
  'getBoundingClientRect',
  'offsetWidth',
  'offsetHeight',
  'clientWidth',
  'clientHeight',
]);

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'throw', 'case', 'typeof', 'void', 'delete',
  'in', 'instanceof', 'new', 'yield', 'await', 'of', 'else', 'do',
]);

const CONTROL_BLOCK_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'await', 'function',
]);

function canStartRegexLiteral(prevToken) {
  if (!prevToken) return true;
  if (prevToken.type === 'punct') {
    return prevToken.value !== ')' && prevToken.value !== ']' &&
      prevToken.value !== '++' && prevToken.value !== '--';
  }
  if (prevToken.type === 'id') {
    return REGEX_PRECEDING_KEYWORDS.has(prevToken.value);
  }
  return false;
}

function tryScanRegexLiteral(source, startIndex) {
  let i = startIndex + 1;
  let inCharClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') {
      if (i + 1 >= source.length || source[i + 1] === '\n' || source[i + 1] === '\r') return -1;
      i += 2;
      continue;
    }
    if (ch === '[') inCharClass = true;
    else if (ch === ']') inCharClass = false;
    else if (ch === '/' && !inCharClass) {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      return i;
    }
    i++;
  }
  return -1;
}

function tokenizeJs(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let braceDepth = 0;
  const templateBraceStack = [];

  function scanTemplateChunk() {
    const startLine = line;
    let text = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\n') line++;
      if (ch === '\\' && i + 1 < source.length) {
        text += ch + source[i + 1];
        if (source[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (ch === '`') {
        i++;
        tokens.push({ type: 'string', value: text, line: startLine });
        return;
      }
      if (ch === '$' && source[i + 1] === '{') {
        tokens.push({ type: 'string', value: text, line: startLine });
        templateBraceStack.push(braceDepth);
        i += 2;
        return;
      }
      text += ch;
      i++;
    }
    tokens.push({ type: 'string', value: text, line: startLine });
  }

  while (i < source.length) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      if (ch === '\n') line++;
      i++;
      continue;
    }

    // Single-line comment
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      if (i < source.length) i += 2;
      continue;
    }

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      let val = '';
      i++;
      while (i < source.length) {
        const c = source[i];
        if (c === '\n') line++;
        if (c === '\\' && i + 1 < source.length) {
          val += c + source[i + 1];
          if (source[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        val += c;
        i++;
      }
      tokens.push({ type: 'string', value: val, line: startLine });
      continue;
    }

    // Template literal
    if (ch === '`') {
      i++;
      scanTemplateChunk();
      continue;
    }

    // Closing `${ ... }` interpolation inside template literal
    if (ch === '}' && templateBraceStack.length > 0 && braceDepth === templateBraceStack[templateBraceStack.length - 1]) {
      templateBraceStack.pop();
      i++;
      scanTemplateChunk();
      continue;
    }

    // Regex literal
    if (ch === '/') {
      const prev = tokens.length ? tokens[tokens.length - 1] : null;
      if (canStartRegexLiteral(prev)) {
        const regexEnd = tryScanRegexLiteral(source, i);
        if (regexEnd !== -1) {
          tokens.push({ type: 'regex', value: source.slice(i, regexEnd), line });
          i = regexEnd;
          continue;
        }
      }
    }

    // Identifier or private identifier (#foo)
    if (/[A-Za-z_$]/.test(ch) || (ch === '#' && /[A-Za-z_$]/.test(source[i + 1] || ''))) {
      const start = i;
      if (ch === '#') i++;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i++;
      tokens.push({ type: 'id', value: source.slice(start, i), line });
      continue;
    }

    // Numbers
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(source[i + 1] || ''))) {
      const start = i;
      i++;
      while (i < source.length && /[A-Za-z0-9_.]/.test(source[i])) i++;
      tokens.push({ type: 'number', value: source.slice(start, i), line });
      continue;
    }

    // Multi-character punctuators
    const two = source.slice(i, i + 2);
    const three = source.slice(i, i + 3);
    if (three === '===' || three === '!==' || three === '...') {
      tokens.push({ type: 'punct', value: three, line });
      i += 3;
      continue;
    }
    if (
      two === '?.' || two === '=>' || two === '++' || two === '--' ||
      two === '==' || two === '!=' || two === '<=' || two === '>=' ||
      two === '&&' || two === '||' || two === '??'
    ) {
      tokens.push({ type: 'punct', value: two, line });
      i += 2;
      continue;
    }

    if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    tokens.push({ type: 'punct', value: ch, line });
    i++;
  }

  return tokens;
}

function buildBracketPairs(tokens) {
  const match = new Int32Array(tokens.length).fill(-1);
  const stack = [];
  const openToClose = { '{': '}', '(': ')', '[': ']' };
  const closeToOpen = { '}': '{', ')': '(', ']': '[' };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'punct') continue;
    if (openToClose[t.value]) {
      stack.push(i);
    } else if (closeToOpen[t.value]) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (openToClose[tokens[stack[s]].value] === t.value) {
          const openIdx = stack[s];
          stack.length = s;
          match[openIdx] = i;
          match[i] = openIdx;
          break;
        }
      }
    }
  }
  return match;
}

function inferAssignedName(tokens, headIdx) {
  if (headIdx >= 2) {
    const op = tokens[headIdx - 1];
    const lhs = tokens[headIdx - 2];
    if (op.type === 'punct' && (op.value === '=' || op.value === ':') && lhs.type === 'id') {
      return lhs.value;
    }
  }
  return null;
}

function isDrawFunctionName(name) {
  return Boolean(name && /^#?_?draw(?!er\b|ing\b)/i.test(name));
}

function isScrollHandlerName(name) {
  return Boolean(name && /^#?_?(?:onScroll|handleScroll)$/i.test(name));
}

function scanForcedReflowInHotPaths(source, filename = 'module.mjs') {
  const tokens = tokenizeJs(source);
  const pairs = buildBracketPairs(tokens);
  const functions = [];

  // 1. Collect all functions, arrow functions, and object/class methods
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // (a) `function [name](...) { ... }`
    if (tok.type === 'id' && tok.value === 'function') {
      let cursor = i + 1;
      if (tokens[cursor]?.type === 'punct' && tokens[cursor].value === '*') cursor++;
      let name = null;
      if (tokens[cursor]?.type === 'id') {
        name = tokens[cursor].value;
        cursor++;
      }
      if (tokens[cursor]?.type === 'punct' && tokens[cursor].value === '(') {
        const closeParen = pairs[cursor];
        if (closeParen !== -1 && tokens[closeParen + 1]?.value === '{') {
          const openBrace = closeParen + 1;
          const closeBrace = pairs[openBrace];
          if (closeBrace !== -1) {
            const head = tokens[i - 1]?.type === 'id' && tokens[i - 1].value === 'async' ? i - 1 : i;
            functions.push({
              id: functions.length,
              name: name || inferAssignedName(tokens, head),
              tokenStart: head,
              bodyStart: openBrace + 1,
              bodyEnd: closeBrace - 1,
              line: tok.line,
            });
          }
        }
      }
      continue;
    }

    // (b) Arrow function `(...) => ...` or `x => ...`
    if (tok.type === 'punct' && tok.value === '=>') {
      let head = -1;
      if (tokens[i - 1]?.type === 'punct' && tokens[i - 1].value === ')') {
        const openParen = pairs[i - 1];
        if (openParen !== -1) {
          head = tokens[openParen - 1]?.type === 'id' && tokens[openParen - 1].value === 'async'
            ? openParen - 1
            : openParen;
        }
      } else if (tokens[i - 1]?.type === 'id') {
        head = tokens[i - 2]?.type === 'id' && tokens[i - 2].value === 'async' ? i - 2 : i - 1;
      }
      if (head !== -1) {
        const name = inferAssignedName(tokens, head);
        if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '{') {
          const closeBrace = pairs[i + 1];
          if (closeBrace !== -1) {
            functions.push({
              id: functions.length,
              name,
              tokenStart: head,
              bodyStart: i + 2,
              bodyEnd: closeBrace - 1,
              line: tok.line,
            });
          }
        } else if (i + 1 < tokens.length) {
          let end = i + 1;
          while (end < tokens.length) {
            const c = tokens[end];
            if (c.type === 'punct' && (c.value === '(' || c.value === '{' || c.value === '[')) {
              const jumped = pairs[end];
              if (jumped !== -1) {
                end = jumped + 1;
                continue;
              }
            }
            if (c.type === 'punct' && (c.value === ',' || c.value === ';' || c.value === ')' || c.value === ']' || c.value === '}')) {
              break;
            }
            end++;
          }
          functions.push({
            id: functions.length,
            name,
            tokenStart: head,
            bodyStart: i + 1,
            bodyEnd: end - 1,
            line: tok.line,
          });
        }
      }
      continue;
    }

    // (c) Method shorthand `[async] [*|get|set] name(...) { ... }`
    if (
      tok.type === 'id' &&
      !CONTROL_BLOCK_KEYWORDS.has(tok.value) &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === '('
    ) {
      const prev = tokens[i - 1];
      if (prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) continue;
      if (prev?.type === 'id' && prev.value === 'function') continue;
      if (prev?.type === 'punct' && prev.value === '*' && tokens[i - 2]?.value === 'function') continue;
      const closeParen = pairs[i + 1];
      if (closeParen !== -1 && tokens[closeParen + 1]?.type === 'punct' && tokens[closeParen + 1].value === '{') {
        const openBrace = closeParen + 1;
        const closeBrace = pairs[openBrace];
        if (closeBrace !== -1) {
          functions.push({
            id: functions.length,
            name: tok.value,
            tokenStart: i,
            bodyStart: openBrace + 1,
            bodyEnd: closeBrace - 1,
            line: tok.line,
          });
        }
      }
    }
  }

  // Mark ResizeObserver / IntersectionObserver callbacks so nested setup observers aren't treated as hot frame bodies
  const excludedRanges = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    if (
      tokens[i].type === 'id' &&
      tokens[i].value === 'new' &&
      tokens[i + 1].type === 'id' &&
      (tokens[i + 1].value === 'ResizeObserver' || tokens[i + 1].value === 'IntersectionObserver') &&
      tokens[i + 2].type === 'punct' &&
      tokens[i + 2].value === '('
    ) {
      const closeParen = pairs[i + 2];
      if (closeParen !== -1) excludedRanges.push([i + 2, closeParen]);
    }
  }

  const byName = new Map();
  for (const fn of functions) {
    if (fn.name) {
      if (!byName.has(fn.name)) byName.set(fn.name, []);
      byName.get(fn.name).push(fn);
    }
  }

  const hotReasons = new Map(); // fn.id -> reason string
  const markHot = (fn, reason) => {
    if (!hotReasons.has(fn.id)) hotReasons.set(fn.id, reason);
  };
  const markHotByName = (name, reason) => {
    for (const fn of byName.get(name) || []) markHot(fn, reason);
  };

  // Seed 1: `draw*` and `onScroll`/`handleScroll` functions
  for (const fn of functions) {
    if (isDrawFunctionName(fn.name)) markHot(fn, `draw* callback (${fn.name})`);
    else if (isScrollHandlerName(fn.name)) markHot(fn, `scroll callback (${fn.name})`);
  }

  // Helper to split top-level comma arguments inside `( ... )`
  function splitCallArgs(openParen, closeParen) {
    const args = [];
    let start = openParen + 1;
    let cur = start;
    while (cur < closeParen) {
      const t = tokens[cur];
      if (t.type === 'punct' && (t.value === '(' || t.value === '{' || t.value === '[')) {
        const close = pairs[cur];
        if (close !== -1) {
          cur = close + 1;
          continue;
        }
      }
      if (t.type === 'punct' && t.value === ',') {
        args.push([start, cur - 1]);
        start = cur + 1;
      }
      cur++;
    }
    if (start <= closeParen - 1) args.push([start, closeParen - 1]);
    return args;
  }

  function extractCallbackIdent(argStart, argEnd) {
    if (argStart === argEnd && tokens[argStart]?.type === 'id') return tokens[argStart].value;
    if (
      argEnd - argStart === 2 &&
      tokens[argStart]?.type === 'id' &&
      tokens[argStart].value === 'this' &&
      tokens[argStart + 1]?.type === 'punct' &&
      tokens[argStart + 1].value === '.' &&
      tokens[argEnd]?.type === 'id'
    ) {
      return tokens[argEnd].value;
    }
    return null;
  }

  // Seed 2: `requestAnimationFrame(...)`, `addEventListener('scroll', ...)`, `.onscroll = ...`
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (
      tok.type === 'id' &&
      /^(?:requestAnimationFrame|raf|scheduleFrame|enqueueFrame|onFrame)$/.test(tok.value) &&
      tokens[i + 1]?.value === '('
    ) {
      const prev = tokens[i - 1];
      const isDeclaration =
        (prev?.type === 'id' && prev.value === 'function') ||
        (prev?.type === 'punct' && prev.value === '*' && tokens[i - 2]?.value === 'function');
      const closeParen = !isDeclaration ? pairs[i + 1] : -1;
      if (closeParen !== -1 && tokens[closeParen + 1]?.value !== '{') {
        const args = splitCallArgs(i + 1, closeParen);
        if (args.length >= 1) {
          const [aStart, aEnd] = args[0];
          const refName = extractCallbackIdent(aStart, aEnd);
          if (refName) markHotByName(refName, `${tok.value}(${refName})`);
          for (const fn of functions) {
            if (fn.tokenStart >= aStart && fn.tokenStart <= aEnd) {
              markHot(fn, `${tok.value} callback`);
            }
          }
        }
      }
    }

    if (tok.type === 'id' && tok.value === 'addEventListener' && tokens[i + 1]?.value === '(') {
      const closeParen = pairs[i + 1];
      if (closeParen !== -1) {
        const args = splitCallArgs(i + 1, closeParen);
        if (
          args.length >= 2 &&
          args[0][0] === args[0][1] &&
          tokens[args[0][0]]?.type === 'string' &&
          tokens[args[0][0]].value === 'scroll'
        ) {
          const [hStart, hEnd] = args[1];
          const refName = extractCallbackIdent(hStart, hEnd);
          if (refName) markHotByName(refName, `addEventListener('scroll', ${refName})`);
          for (const fn of functions) {
            if (fn.tokenStart >= hStart && fn.tokenStart <= hEnd) {
              markHot(fn, "addEventListener('scroll', ...) callback");
            }
          }
        }
      }
    }

    if (
      tok.type === 'id' &&
      tok.value === 'onscroll' &&
      tokens[i - 1]?.type === 'punct' &&
      (tokens[i - 1].value === '.' || tokens[i - 1].value === '?.') &&
      tokens[i + 1]?.type === 'punct' &&
      tokens[i + 1].value === '='
    ) {
      const rhsIdx = i + 2;
      if (tokens[rhsIdx]?.type === 'id' && tokens[rhsIdx + 1]?.value !== '=>') {
        markHotByName(tokens[rhsIdx].value, `onscroll = ${tokens[rhsIdx].value}`);
      }
      for (const fn of functions) {
        if (fn.tokenStart === rhsIdx) markHot(fn, 'onscroll callback');
      }
    }
  }

  const isTokenExcluded = idx => excludedRanges.some(([s, e]) => idx >= s && idx <= e);

  // Propagate hot status through local helper calls inside hot functions
  const queue = [...hotReasons.keys()];
  while (queue.length > 0) {
    const fnId = queue.shift();
    const fn = functions[fnId];
    const baseReason = hotReasons.get(fnId);
    for (let k = fn.bodyStart; k <= fn.bodyEnd; k++) {
      if (isTokenExcluded(k)) continue;
      const t = tokens[k];
      if (t.type === 'id' && tokens[k + 1]?.type === 'punct' && tokens[k + 1].value === '(') {
        const prev = tokens[k - 1];
        const isBareOrThisCall =
          !prev ||
          prev.type !== 'punct' ||
          (prev.value !== '.' && prev.value !== '?.') ||
          (tokens[k - 2]?.type === 'id' && tokens[k - 2].value === 'this');
        if (isBareOrThisCall && byName.has(t.value)) {
          for (const callee of byName.get(t.value)) {
            if (!hotReasons.has(callee.id)) {
              hotReasons.set(callee.id, `${baseReason} -> ${t.value}()`);
              queue.push(callee.id);
            }
          }
        }
      }
    }
  }

  // Scan hot functions for forced-reflow DOM reads (deduplicating nested hot functions by token index)
  const violations = [];
  const reportedTokenIndices = new Set();

  // Sort hot functions innermost-first so nested hot callbacks report the most specific context
  const hotFunctions = [...hotReasons.keys()]
    .map(id => functions[id])
    .sort((a, b) => (a.bodyEnd - a.bodyStart) - (b.bodyEnd - b.bodyStart));

  for (const fn of hotFunctions) {
    const context = hotReasons.get(fn.id);
    for (let k = fn.bodyStart; k <= fn.bodyEnd; k++) {
      if (reportedTokenIndices.has(k) || isTokenExcluded(k)) continue;
      const tok = tokens[k];

      // 1) `.offsetWidth`, `?.getBoundingClientRect()`, etc.
      if (
        tok.type === 'id' &&
        FORCED_REFLOW_PROPS.has(tok.value) &&
        tokens[k - 1]?.type === 'punct' &&
        (tokens[k - 1].value === '.' || tokens[k - 1].value === '?.')
      ) {
        reportedTokenIndices.add(k);
        violations.push({
          file: filename,
          line: tok.line,
          property: tok.value,
          context,
        });
        continue;
      }

      // 2) Bracket access `el['offsetWidth']` / `el["getBoundingClientRect"]`
      if (
        tok.type === 'punct' &&
        tok.value === '[' &&
        tokens[k + 1]?.type === 'string' &&
        FORCED_REFLOW_PROPS.has(tokens[k + 1].value) &&
        tokens[k + 2]?.type === 'punct' &&
        tokens[k + 2].value === ']'
      ) {
        reportedTokenIndices.add(k + 1);
        violations.push({
          file: filename,
          line: tokens[k + 1].line,
          property: tokens[k + 1].value,
          context,
        });
        continue;
      }

      // 3) Object destructuring `const { offsetWidth, clientHeight: h } = el`
      if (tok.type === 'punct' && tok.value === '{') {
        const closeBrace = pairs[k];
        if (closeBrace !== -1 && tokens[closeBrace + 1]?.type === 'punct' && tokens[closeBrace + 1].value === '=') {
          for (let d = k + 1; d < closeBrace; d++) {
            const dt = tokens[d];
            const prev = tokens[d - 1];
            if (
              dt.type === 'id' &&
              FORCED_REFLOW_PROPS.has(dt.value) &&
              prev?.type === 'punct' &&
              (prev.value === '{' || prev.value === ',') &&
              !reportedTokenIndices.has(d)
            ) {
              reportedTokenIndices.add(d);
              violations.push({
                file: filename,
                line: dt.line,
                property: dt.value,
                context,
              });
            }
          }
        }
      }
    }
  }

  return { hotCallbackCount: hotFunctions.length, violations };
}

function discoverHudAndPerfModules() {
  const targetPattern = /^(?:hud-[^/\\]+|frame-budget|scroll-perf-guard|stat-counter)\.(?:mjs|js)$/i;
  return walkFiles(jsDir, (_full, name) => targetPattern.test(name));
}

// ---------------------------------------------------------------------------
// 4. Non-blocking web font check
// ---------------------------------------------------------------------------

const EXTERNAL_FONT_STYLESHEET_RE = /(?:fonts\.googleapis\.com\/css|fonts\.bunny\.net\/css|use\.typekit\.net)/i;

function findBlockingFontIssues(rawHtml, filename = 'page.html') {
  const withoutComments = stripHtmlCommentsPreserveLines(rawHtml);
  const issues = [];

  // Check inline <style> blocks for render-blocking @import of external font stylesheets
  const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch;
  while ((styleMatch = styleBlockRegex.exec(withoutComments)) !== null) {
    const cssBody = stripCssCommentsPreserveLines(styleMatch[1]);
    const importRegex = /@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/gi;
    let imp;
    while ((imp = importRegex.exec(cssBody)) !== null) {
      if (EXTERNAL_FONT_STYLESHEET_RE.test(imp[1])) {
        const offset = styleMatch.index + styleMatch[0].indexOf('>') + 1 + imp.index;
        issues.push({
          file: filename,
          line: lineNumberAt(withoutComments, offset),
          reason: 'render-blocking @import external font stylesheet inside <style>',
          href: imp[1],
        });
      }
    }
  }

  // Strip <script>, <style>, and <noscript> blocks before scanning live <link> tags
  // (<noscript><link rel="stylesheet" ...></noscript> is the standard non-JS fallback for async fonts)
  const liveMarkup = withoutComments
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, m => m.replace(/[^\n]/g, ' '))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, m => m.replace(/[^\n]/g, ' '))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, m => m.replace(/[^\n]/g, ' '));

  const linkRegex = /<link\b[^>]*>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(liveMarkup)) !== null) {
    const attrs = parseHtmlAttributes(linkMatch[0].slice(1, -1));
    const href = attrs.get('href') || '';
    const relTokens = (attrs.get('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!href) continue;

    const isExternalFontCss = EXTERNAL_FONT_STYLESHEET_RE.test(href);
    const isDirectFontStylesheet = /\.(?:woff2?|ttf|otf)(?:\?|#|$)/i.test(href) && relTokens.includes('stylesheet');
    if (!isExternalFontCss && !isDirectFontStylesheet) continue;

    if (relTokens.includes('stylesheet') && !relTokens.includes('preload')) {
      const media = (attrs.get('media') || '').trim().toLowerCase();
      const onload = (attrs.get('onload') || '').trim();
      const isNonBlockingMediaSwap =
        (media === 'print' || media === 'not all' || media.startsWith('only ')) &&
        onload.length > 0;
      if (!isNonBlockingMediaSwap) {
        issues.push({
          file: filename,
          line: lineNumberAt(liveMarkup, linkMatch.index),
          reason: 'render-blocking <link rel="stylesheet"> without media="print" + onload swap (or preload)',
          href,
        });
      }
    }

    if (/fonts\.googleapis\.com\/css/i.test(href) && !/[?&]display=(?:swap|optional|fallback)\b/i.test(href)) {
      issues.push({
        file: filename,
        line: lineNumberAt(liveMarkup, linkMatch.index),
        reason: 'Google Fonts URL missing font-display parameter (display=swap|optional|fallback)',
        href,
      });
    }
  }

  return issues;
}

function findPerfHtmlTransformPath() {
  const inPranav = walkFiles(pranavRoot, (_full, name) => name === 'perf-html-transform.mjs');
  if (inPranav.length > 0) return inPranav[0];
  const rootScripts = path.join(repoRoot, 'scripts');
  const inRootScripts = walkFiles(rootScripts, (_full, name) => name === 'perf-html-transform.mjs');
  return inRootScripts[0] || null;
}

// ===========================================================================
// Test Suite: Repository Gates + Analyzer Self-Verification
// ===========================================================================

test('Gate 1: CSS @keyframes in PRANAV/public/css/ never animate layout-thrashing geometry properties', () => {
  const cssFiles = walkFiles(cssDir, (_full, name) => name.endsWith('.css'));
  const basenames = cssFiles.map(f => path.basename(f));
  for (const required of ['site.css', 'app.css', 'film.css']) {
    assert.ok(basenames.includes(required), `Expected ${required} in PRANAV/public/css/`);
  }

  let totalKeyframesParsed = 0;
  const allKeyframeViolations = [];
  const allTransitionViolations = [];

  for (const file of cssFiles) {
    const rel = path.relative(pranavRoot, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    const { keyframeBlocks, keyframeViolations, transitionViolations } = analyzeCssJank(content, rel);
    totalKeyframesParsed += keyframeBlocks.length;
    allKeyframeViolations.push(...keyframeViolations);
    allTransitionViolations.push(...transitionViolations);
  }

  // Sanity check: site.css (incl. nested @supports @keyframes dot-pop) + app.css define >= 11 @keyframes
  assert.ok(
    totalKeyframesParsed >= 11,
    `Expected CSS parser to inspect at least 11 @keyframes blocks across public/css/, got ${totalKeyframesParsed}`
  );

  assert.deepEqual(
    allKeyframeViolations,
    [],
    'Layout-inducing geometry properties found inside @keyframes (use transform, opacity, clip-path, filter, background, box-shadow, or stroke-dashoffset):\n' +
      JSON.stringify(allKeyframeViolations, null, 2)
  );

  assert.deepEqual(
    allTransitionViolations,
    [],
    'Layout-inducing geometry transitions found outside explicit <details> accordions:\n' +
      JSON.stringify(allTransitionViolations, null, 2)
  );
});

test('Gate 1 parser self-check: catches @keyframes geometry & non-details transitions while allowing smooth-details ::details-content', () => {
  const badCss = `
    @media (prefers-reduced-motion: no-preference) {
      @supports (animation-timeline: view()) {
        @keyframes janky-slide {
          from { top: 0; width: 40%; margin-top: 8px; }
          50% { padding: 12px; border-width: 2px; }
          to { left: 20px; height: 100px; font-size: 2rem; }
        }
      }
    }
    .card { transition: height 0.2s ease, opacity 0.2s ease; }
  `;
  const badReport = analyzeCssJank(badCss, 'synthetic-bad.css');
  assert.deepEqual(
    badReport.keyframeViolations.map(v => v.property),
    ['top', 'width', 'margin-top', 'padding', 'border-width', 'left', 'height', 'font-size']
  );
  assert.equal(badReport.transitionViolations.length, 1);
  assert.equal(badReport.transitionViolations[0].property, 'height');

  const smoothDetailsCss = `
    details::details-content {
      transition: height 0.24s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0.2s ease, content-visibility 0.24s allow-discrete;
    }
    @keyframes pulse-ring {
      from { transform: scale(0.95); opacity: 0.7; stroke-dashoffset: 24; }
      to { transform: scale(1); opacity: 1; border-bottom-color: var(--line); box-shadow: 0 4px 12px rgba(0,0,0,.2); }
    }
  `;
  const okReport = analyzeCssJank(smoothDetailsCss, 'smooth-details.css');
  assert.deepEqual(okReport.keyframeViolations, []);
  assert.deepEqual(okReport.transitionViolations, []);
});

test('Gate 2: index.html and tower.html have zero eager heavy model or 3D asset downloads on initial page load', () => {
  for (const page of ['index.html', 'tower.html']) {
    const fullPath = path.join(publicDir, page);
    assert.ok(fs.existsSync(fullPath), `Expected ${page} in PRANAV/public/`);
    const html = fs.readFileSync(fullPath, 'utf8');
    const violations = findEagerHeavyDownloads(html, `public/${page}`);
    assert.deepEqual(
      violations,
      [],
      `Eager heavy asset download detected in public/${page}:\n` + JSON.stringify(violations, null, 2)
    );
  }
});

test('Gate 2 scanner self-check: catches eager TF.js/COCO, skysentry_classifier.json, and narrow-body-airliner.glb tags', () => {
  const badHtml = `<!doctype html><html><head>
    <link rel="preload" href="/ai-models/skysentry_classifier.json" as="fetch" crossorigin>
    <link rel="preload" href="/assets/narrow-body-airliner.glb" as="fetch">
    <script src="/ai-models/tf.min.js"></script>
    <script src="/ai-models/coco-ssd.min.js" defer></script>
  </head><body>
    <script type="module">
      import '/ai-models/skysentry_classifier.js';
    </script>
  </body></html>`;
  const found = findEagerHeavyDownloads(badHtml, 'bad.html');
  assert.equal(found.length, 5);
});

test('Gate 3: HUD mjs renderers, frame-budget, scroll-perf-guard, and stat-counter perform zero forced-reflow DOM reads in draw*/scroll/rAF callbacks', () => {
  const modules = discoverHudAndPerfModules();
  const allViolations = [];

  for (const modPath of modules) {
    const rel = path.relative(pranavRoot, modPath).replace(/\\/g, '/');
    const source = fs.readFileSync(modPath, 'utf8');
    const { violations } = scanForcedReflowInHotPaths(source, rel);
    allViolations.push(...violations);
  }

  assert.deepEqual(
    allViolations,
    [],
    'Forced-reflow DOM geometry reads detected inside draw* / scroll / requestAnimationFrame callbacks:\n' +
      JSON.stringify(allViolations, null, 2)
  );
});

test('Gate 3 scanner self-check: catches getBoundingClientRect/offset*/client* in draw*, scroll, and rAF while allowing ResizeObserver caching', () => {
  const cleanHudModule = `
    export function createHudReticle(canvas) {
      let cachedW = 0, cachedH = 0;
      const ro = new ResizeObserver(([entry]) => {
        cachedW = entry.contentRect.width;
        cachedH = entry.contentRect.height;
      });
      ro.observe(canvas);

      function drawReticle(ctx) {
        // Comments mentioning getBoundingClientRect() or offsetWidth must not false-positive
        ctx.clearRect(0, 0, cachedW, cachedH);
      }

      const step = () => {
        drawReticle(canvas.getContext('2d'));
        requestAnimationFrame(step);
      };
      window.addEventListener('scroll', () => {
        document.documentElement.dataset.scrolling = '1';
      }, { passive: true });

      return { drawReticle, step, destroy: () => ro.disconnect() };
    }
  `;
  assert.deepEqual(scanForcedReflowInHotPaths(cleanHudModule, 'hud-clean.mjs').violations, []);

  const jankyModule = `
    function readMetrics(el) {
      return el.offsetHeight + el.clientWidth;
    }
    export function drawHud(ctx, stage) {
      const box = stage.getBoundingClientRect();
      return box.width + readMetrics(stage);
    }
    const tick = () => {
      const { offsetWidth } = document.body;
      return offsetWidth;
    };
    requestAnimationFrame(tick);
    window.addEventListener('scroll', () => {
      const h = document.documentElement.clientHeight;
      return h;
    }, { passive: true });
  `;
  const { violations } = scanForcedReflowInHotPaths(jankyModule, 'hud-janky.mjs');
  const props = violations.map(v => v.property).sort();
  assert.deepEqual(props, [
    'clientHeight',
    'clientWidth',
    'getBoundingClientRect',
    'offsetHeight',
    'offsetWidth',
  ]);
});

test('Gate 4: tower.html & camera.html (and index.html once perf-html-transform.mjs is present) use non-blocking web font loading', async () => {
  for (const page of ['tower.html', 'camera.html']) {
    const fullPath = path.join(publicDir, page);
    assert.ok(fs.existsSync(fullPath), `Expected ${page} in PRANAV/public/`);
    const html = fs.readFileSync(fullPath, 'utf8');
    const issues = findBlockingFontIssues(html, `public/${page}`);
    assert.deepEqual(
      issues,
      [],
      `Render-blocking font stylesheet found in public/${page}:\n` + JSON.stringify(issues, null, 2)
    );
  }

  const transformPath = findPerfHtmlTransformPath();
  if (transformPath) {
    const indexPath = path.join(publicDir, 'index.html');
    const rawIndexHtml = fs.readFileSync(indexPath, 'utf8');
    let directIssues = findBlockingFontIssues(rawIndexHtml, 'public/index.html');

    if (directIssues.length > 0) {
      // Support serve-time middleware mode if server.js applies perf-html-transform.mjs dynamically
      const serverSource = fs.readFileSync(path.join(pranavRoot, 'server.js'), 'utf8');
      if (serverSource.includes('perf-html-transform')) {
        const mod = await import(pathToFileURL(transformPath).href);
        const candidates = [
          mod.transformHtml,
          mod.perfHtmlTransform,
          mod.transformIndexHtml,
          mod.optimizeHtml,
          mod.applyPerfTransforms,
          mod.default,
          ...Object.values(mod),
        ].filter(fn => typeof fn === 'function');
        let transformed = null;
        for (const fn of candidates) {
          try {
            const out = await fn(rawIndexHtml);
            const htmlOut = typeof out === 'string' ? out : out?.html;
            if (typeof htmlOut === 'string' && /<!doctype|<html/i.test(htmlOut)) {
              transformed = htmlOut;
              break;
            }
          } catch {
            // Try next candidate export
          }
        }
        assert.equal(typeof transformed, 'string', 'perf-html-transform.mjs must produce transformed HTML');
        directIssues = findBlockingFontIssues(transformed, 'public/index.html (via perf-html-transform.mjs)');
      }
    }

    assert.deepEqual(
      directIssues,
      [],
      'Render-blocking font stylesheet found in public/index.html with perf-html-transform.mjs present:\n' +
        JSON.stringify(directIssues, null, 2)
    );
  }
});

test('Gate 4 scanner self-check: rejects render-blocking Google Fonts links and accepts media="print" onload swap with <noscript> fallback', () => {
  const blockingHtml = `<!doctype html><html><head>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap">
  </head></html>`;
  assert.equal(findBlockingFontIssues(blockingHtml, 'blocking.html').length, 1);

  const nonBlockingHtml = `<!doctype html><html><head>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap" media="print" onload="this.media='all'">
    <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap"></noscript>
  </head></html>`;
  assert.deepEqual(findBlockingFontIssues(nonBlockingHtml, 'non-blocking.html'), []);
});
