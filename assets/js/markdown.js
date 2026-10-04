/* ==========================================================================
   markdown.js — small, safe Markdown → HTML renderer
   No dependencies. Escapes everything first, then applies formatting.
   Supports: fenced code, inline code, headings, lists, tables, quotes,
   links, bold/italic/strike, hr.
   ========================================================================== */

import { escapeHtml, safeUrl } from './util.js';

const CODE_PLACEHOLDER = '\u0000CODE';

/**
 * @param {string} src markdown
 * @returns {string} html
 */
export function renderMarkdown(src = '') {
  const codeBlocks = [];

  // 1. pull fenced code blocks out of the way so nothing inside gets formatted
  let text = String(src).replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, body) => {
    const cleanLang = (lang || '').trim().toLowerCase();
    const idx = codeBlocks.push(
      `<div class="pre-head"><span>${escapeHtml(cleanLang || 'code')}</span>` +
      `<button type="button" data-copy="${escapeHtml(body.replace(/^\n/, ''))}">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/>` +
      `<path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>Copy</button></div>` +
      `<code>${escapeHtml(body.replace(/^\n/, '').replace(/\n$/, ''))}</code>`
    ) - 1;
    return `${CODE_PLACEHOLDER}${idx}\u0000`;
  });

  // 2. now it is safe to escape the rest
  text = escapeHtml(text);

  // 3. block-level: headings, hr, quotes
  text = text
    .replace(/^###### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^##### (.*)$/gm,  '<h4>$1</h4>')
    .replace(/^#### (.*)$/gm,   '<h4>$1</h4>')
    .replace(/^### (.*)$/gm,    '<h3>$1</h3>')
    .replace(/^## (.*)$/gm,     '<h2>$1</h2>')
    .replace(/^# (.*)$/gm,      '<h1>$1</h1>')
    .replace(/^\s*(?:---|\*\*\*|___)\s*$/gm, '<hr>')
    .replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>');

  // 4. inline: images → links, links, bold, italic, strike, code
  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) =>
      `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener">${alt || 'image'}</a>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
      `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 5. lists — group consecutive bullet / numbered lines
  text = text.replace(/(?:^|\n)((?:[ \t]*(?:[-*+]|\d+\.)[ \t]+.*(?:\n|$))+)/g, (block) => {
    const lines = block.trim().split('\n').filter(Boolean);
    const ordered = /^[ \t]*\d+\./.test(lines[0]);
    const items = lines.map(l =>
      '<li>' + l.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/, '') + '</li>').join('');
    return `\n<${ordered ? 'ol' : 'ul'}>${items}</${ordered ? 'ol' : 'ul'}>\n`;
  });

  // 6. tables (| a | b |)
  text = text.replace(
    /(?:^|\n)\|(.+)\|\n\|[ \t]*:?-{2,}:?[ \t]*\|(.+)\|\n((?:\|.*\|\n?)*)/g,
    (_m, head, _sep, body) => {
      const th = head.split('|').map(c => `<th>${c.trim()}</th>`).join('');
      const rows = body.trim().split('\n').filter(Boolean).map(r =>
        '<tr>' + r.replace(/^\||\|$/g, '').split('|').map(c => `<td>${c.trim()}</td>`).join('') + '</tr>'
      ).join('');
      return `\n<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>\n`;
    });

  // 7. paragraphs — wrap leftover loose lines
  const blocks = text.split(/\n{2,}/).map(chunk => {
    const t = chunk.trim();
    if (!t) return '';
    if (/^<(h[1-4]|ul|ol|pre|table|blockquote|hr|div)/.test(t)) return t;
    if (t.includes(CODE_PLACEHOLDER)) return t.replace(/\n/g, '<br>');
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  });

  let out = blocks.filter(Boolean).join('\n');

  // 8. restore code blocks
  out = out.replace(new RegExp(CODE_PLACEHOLDER + '(\\d+)\\u0000', 'g'),
    (_m, i) => `<pre>${codeBlocks[Number(i)]}</pre>`);

  return out;
}

/** Plain text version, used for speech synthesis and titles. */
export function stripMarkdown(md = '') {
  return String(md)
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[#>\-*+]+\s*/gm, '')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/\|/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
