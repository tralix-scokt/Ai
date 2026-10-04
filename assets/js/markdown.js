/* ==========================================================================
   markdown.js — safe Markdown → HTML renderer, no dependencies.

   Strategy: parse block structure line by line, escape every piece of model
   output before it becomes markup, and only then apply formatting. Raw HTML in
   a reply is escaped, never executed. Fenced code is pulled out first and run
   through the syntax highlighter (which itself only ever sees escaped text).
   ========================================================================== */

import { escapeHtml, safeUrl } from './util.js';
import { highlight, langLabel } from './highlight.js';

const PLACEHOLDER = '\u0000BLOCK';

/* ------------------------------ inline level ------------------------------ */
function inline(text = '') {
  let out = text;

  // inline code first — its content must stay literal
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, body) => {
    codes.push(`<code>${body}</code>`);
    return `${PLACEHOLDER}${codes.length - 1}\u0000`;
  });

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt) => `<span class="md-img">🖼 ${alt || 'image'}</span>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      const href = safeUrl(url);
      const ext = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${ext}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])__([^_]+)__(?=[\s).,!?]|$)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\b(https?:\/\/[^\s<)]+)/g, (m) => (m.includes('</a>') ? m : `<a href="${safeUrl(m)}" target="_blank" rel="noopener noreferrer">${m}</a>`));

  return out.replace(new RegExp(`${PLACEHOLDER}(\\d+)\\u0000`, 'g'), (_m, i) => codes[Number(i)]);
}

/* ------------------------------ block level ------------------------------- */
function codeBlock(code, lang, index) {
  const family = langLabel(lang);
  const id = `tralix-code-${index}`;
  return `<div class="code-block">
  <div class="code-head"><span class="code-lang">${escapeHtml(family)}</span>` +
    `<button type="button" class="code-copy" data-copy-target="${id}" aria-label="Copy code">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>` +
      `<span>Copy</span></button></div>` +
    `<pre class="code-body" tabindex="0"><code id="${id}">${highlight(code, lang)}</code></pre>
</div>`;
}

function renderTable(rows) {
  // rows: [header, ...body] already split into cells
  const [head, ...body] = rows;
  const th = head.map(c => `<th>${inline(c)}</th>`).join('');
  const trs = body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

const splitRow = (line) => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const isDivider = (line) => /^\|?[\s:|-]*-{2,}[\s:|-]*\|?$/.test(line) && line.includes('-');

/**
 * Render markdown to safe HTML.
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src = '') {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  let codeIndex = 0;

  const stash = (html) => {
    blocks.push(html);
    return `${PLACEHOLDER}${blocks.length - 1}\u0000`;
  };

  const out = [];

  while (i < lines.length) {
    const line = lines[i];

    /* fenced code */
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;                                            // consume closing fence
      // raw body: the highlighter escapes every token it emits
      out.push(stash(codeBlock(body.join('\n'), lang, codeIndex++)));
      continue;
    }

    /* heading */
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 5);   // h1 → h2 (h1 is the product title)
      out.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    /* horizontal rule */
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    /* blockquote (with a note for callouts) */
    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    /* table */
    if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(renderTable(rows));
      continue;
    }

    /* lists (with one nesting level and task items) */
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      let listIndent = line.match(/^\s*/)[0].length;
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        const indent = lines[i].match(/^\s*/)[0].length;
        const content = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
        if (indent > listIndent && items.length) {
          items[items.length - 1].children.push(content);
        } else {
          const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
          items.push({
            text: task ? task[2] : content,
            checked: task ? task[1].toLowerCase() === 'x' : null,
            children: [],
          });
          listIndent = indent;
        }
        i++;
      }
      const render = (list) => list.map(({ text, checked, children }) => {
        const box = checked === null ? '' : `<input type="checkbox" disabled ${checked ? 'checked' : ''}> `;
        const nested = children.length
          ? `<ul>${children.map(c => `<li>${inline(escapeHtml(c))}</li>`).join('')}</ul>`
          : '';
        return `<li>${box}${inline(escapeHtml(text))}${nested}</li>`;
      }).join('');
      out.push(`<${ordered ? 'ol' : 'ul'} class="${ordered ? 'md-ol' : 'md-ul'}">${render(items)}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    /* blank line */
    if (!line.trim()) { i++; continue; }

    /* paragraph — collect until a blank line or a block starter */
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim()
      && !/^\s*(?:```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isDivider(lines[i + 1]))) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join('\n')))}</p>`);
  }

  let html = out.join('\n').replace(/\n{2,}/g, '\n');
  html = html.replace(new RegExp(`${PLACEHOLDER}(\\d+)\\u0000`, 'g'), (_m, idx) => blocks[Number(idx)]);
  return html;
}

/** Plain-text version for speech synthesis, titles and copy-as-text. */
export function stripMarkdown(md = '') {
  return String(md)
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, ' '))
    .replace(/^\s*[-:|\s]+$/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Copy-friendly plain text: decoration is dropped but code blocks keep their
 * content, because people copying a reply usually want the code.
 */
export function toCopyText(md = '') {
  const withCode = String(md).replace(/```[\w+#.-]*\n?([\s\S]*?)(?:```|$)/g, (_m, body) => `\n\n${body.trim()}\n\n`);
  return stripMarkdown(withCode).replace(/\n{3,}/g, '\n\n').trim();
}
