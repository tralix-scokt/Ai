/* ==========================================================================
   highlight.js — dependency-free syntax highlighter.

   Deliberately small. One left-to-right tokenizer per language family, so an
   earlier class can never be re-scanned by a later pass (the classic way
   hand-rolled highlighters corrupt their own markup). Input is raw source and
   every emitted token is escaped, so model output can never inject markup.

   Unknown languages fall through to a generic keyword/string/number pass
   instead of failing.
   ========================================================================== */

import { escapeHtml } from './util.js';

const KEYWORDS = {
  js: 'const let var function return if else for while do break continue class extends new this super import export from default async await try catch finally throw typeof instanceof delete in of void yield static get set null undefined true false',
  ts: 'const let var function return if else for while do break continue class extends new super import export from default async await try catch finally throw typeof instanceof delete in of void yield static get set null undefined true false interface type enum implements readonly public private protected namespace declare as any unknown never',
  py: 'def return if elif else for while break continue class import from as pass raise try except finally with lambda global nonlocal yield assert del in is not and or None True False async await self match case',
  rb: 'def end if elsif else unless while until for do break next return class module require yield begin rescue ensure nil true false self puts attr_accessor',
  go: 'package import func return if else for range break continue type struct interface map chan go defer select switch case default var const nil true false',
  rs: 'fn let mut const return if else match for while loop break continue struct enum impl trait use mod pub crate self super as where dyn ref move async await unsafe true false',
  java: 'public private protected class interface extends implements new return if else for while do switch case break continue static final void int long double float boolean char String try catch finally throw throws import package null true false this super enum record',
  c: 'int long short char float double void unsigned signed struct union enum typedef static const return if else for while do switch case break continue goto sizeof extern inline register volatile NULL true false include define',
  sh: 'if then else elif fi for while do done case esac function return in export local readonly set unset echo cd exit source sudo',
  sql: 'select from where insert into update delete join left right inner outer on group by order having limit offset as and or not null values create table alter drop index distinct union count sum avg min max',
  json: 'true false null',
};

/** Language aliases → family key. */
const ALIASES = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts',
  python: 'py', python3: 'py',
  ruby: 'rb',
  golang: 'go',
  rust: 'rs',
  java: 'java', kotlin: 'java', scala: 'java',
  c: 'c', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', cs: 'c', csharp: 'c', objc: 'c',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', terminal: 'sh',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml',
  html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  css: 'css', scss: 'css', less: 'css',
  md: 'text', markdown: 'text', txt: 'text', text: 'text', plaintext: 'text',
  diff: 'diff', patch: 'diff',
};

export function normaliseLang(lang = '') {
  const l = String(lang).trim().toLowerCase();
  return ALIASES[l] || l || 'text';
}

/** Human label shown in the code-block header. */
export function langLabel(lang = '') {
  const raw = String(lang).trim();
  return raw ? raw.slice(0, 16) : 'code';
}

/* ------------------------------ token patterns ----------------------------
   Written as regex literals and composed through `.source`, so the patterns
   are exactly what they look like — no constructor-string escaping traps.
   ------------------------------------------------------------------------- */
const COMMENTS = {
  js: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
  ts: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
  java: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
  c: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
  go: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
  rs: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
  py: /#[^\n]*/,
  rb: /#[^\n]*/,
  sh: /#[^\n]*/,
  sql: /--[^\n]*/,
  css: /\/\*[\s\S]*?\*\//,
  yaml: /#[^\n]*/,
};

const STRINGS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/;
const NUMBERS = /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/;
const IDENTS = /[A-Za-z_$][\w$]*/;

const span = (cls, text) => `<span class="${cls}">${escapeHtml(text)}</span>`;

/**
 * Single-pass tokenizer: comments → strings → numbers → identifiers.
 * @param {string} source raw (unescaped) source
 * @param {string} family normalised language family
 */
function tokenize(source, family) {
  const commentRe = COMMENTS[family];
  const kinds = commentRe ? ['comment', 'string', 'number', 'ident'] : ['string', 'number', 'ident'];
  // Each alternative gets its own capturing group so the match tells us the
  // kind: the child patterns are deliberately free of capturing groups.
  const pattern = [commentRe?.source, STRINGS.source, NUMBERS.source, IDENTS.source]
    .filter(Boolean)
    .map(source => `(${source})`)
    .join('|');
  const re = new RegExp(pattern, 'g');

  const keywords = new Set((KEYWORDS[family] || KEYWORDS.js).split(' ').filter(Boolean));
  let out = '';
  let last = 0;
  let match;

  while ((match = re.exec(source)) !== null) {
    out += escapeHtml(source.slice(last, match.index));
    last = re.lastIndex;

    const kind = kinds.find((_, i) => match[i + 1] !== undefined);
    const text = match[0];

    if (kind === 'comment') out += span('tok-com', text);
    else if (kind === 'string') out += span('tok-str', text);
    else if (kind === 'number') out += span('tok-num', text);
    else if (keywords.has(text)) out += span('tok-key', text);
    else if (/^[A-Z][A-Za-z0-9_$]*$/.test(text)) out += span('tok-type', text);
    else if (source[re.lastIndex] === '(') out += span('tok-fn', text);
    else out += escapeHtml(text);
  }

  out += escapeHtml(source.slice(last));
  return out;
}

/** Markup: colour tag names and attribute values, escape everything else. */
function highlightMarkup(source) {
  return escapeHtml(source)
    .replace(/(&lt;\/?)([\w:-]+)/g, '$1<span class="tok-tag">$2</span>')
    .replace(/([\w:-]+)=(&quot;[^&]*&quot;|&#39;[^&]*&#39;)/g,
      '<span class="tok-attr">$1</span>=<span class="tok-str">$2</span>');
}

/** Unified diff colouring. */
function highlightDiff(source) {
  return String(source).split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return span('tok-com', line);
    if (line.startsWith('+')) return `<span class="tok-add">${escapeHtml(line)}</span>`;
    if (line.startsWith('-')) return `<span class="tok-del">${escapeHtml(line)}</span>`;
    if (line.startsWith('@@')) return span('tok-type', line);
    return escapeHtml(line);
  }).join('\n');
}

/**
 * Highlight source code into HTML.
 * @param {string} code raw source
 * @param {string} lang language hint from the fence
 * @returns {string} safe HTML
 */
export function highlight(code = '', lang = '') {
  const source = String(code);
  const family = normaliseLang(lang);

  if (family === 'text') return escapeHtml(source);
  if (family === 'markup') return highlightMarkup(source);
  if (family === 'diff') return highlightDiff(source);

  return tokenize(source, family);
}
