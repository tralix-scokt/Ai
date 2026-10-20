/* ==========================================================================
   diff.js — render a diff JARVIS produced.

   The hunks come from the server (server/diff.js), which computed them from
   the real before/after file contents. This module only renders them — it
   never reconstructs or guesses content.
   ========================================================================== */

import { escapeHtml } from './util.js';

/**
 * @param {Array} hunks      from server/diff.js: {oldStart, oldLines, newStart, newLines, lines[]}
 * @param {object} [opts]
 * @param {number} [opts.maxLines]  cap the rendered lines per file
 * @returns {string} HTML
 */
export function renderDiff(hunks = [], { maxLines = 600 } = {}) {
  if (!Array.isArray(hunks) || !hunks.length) {
    return '<p class="hint">No differences.</p>';
  }

  let rendered = 0;
  let html = '';

  for (const hunk of hunks) {
    html += `<div class="diff-hunk"><div class="diff-line"><span class="dl-no"></span>`
      + `<span class="dl-txt" style="color:var(--text-faint)">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</span></div>`;
    for (const line of hunk.lines || []) {
      if (rendered >= maxLines) {
        html += '<div class="diff-line"><span class="dl-no"></span><span class="dl-txt" style="color:var(--text-faint)">… diff truncated for display</span></div>';
        break;
      }
      const kind = line.type === '+' ? 'add' : line.type === '-' ? 'del' : '';
      const oldNo = line.oldLine ?? '';
      const newNo = line.newLine ?? '';
      html += `<div class="diff-line ${kind}">`
        + `<span class="dl-no">${escapeHtml(String(oldNo))}</span>`
        + `<span class="dl-no">${escapeHtml(String(newNo))}</span>`
        + `<span class="dl-txt">${escapeHtml(String(line.text ?? ''))}</span>`
        + '</div>';
      rendered += 1;
    }
    html += '</div>';
    if (rendered >= maxLines) break;
  }

  return `<div class="diff-body">${html}</div>`;
}

/** `+12 −4` with colour, for compact lists. */
export function diffStatsHtml(additions = 0, deletions = 0) {
  return `<span class="diff-stats"><span class="diff-add">+${Number(additions) || 0}</span> `
    + `<span class="diff-del">−${Number(deletions) || 0}</span></span>`;
}

/** A plain-text unified diff, for copying into a message or an issue. */
export function toPatchText(path, hunks = []) {
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines || []) out.push(`${line.type}${line.text ?? ''}`);
  }
  return `${out.join('\n')}\n`;
}
