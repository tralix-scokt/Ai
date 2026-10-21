/* ==========================================================================
   server/diff.js — line diff for reviewing proposed code changes.

   A small Myers-style LCS implementation with a size guard, because a coding
   assistant must be able to show *what changed* without pulling in a
   dependency. Output is a hunk list the frontend renders directly, plus a
   unified-diff string for copy/paste and for commit messages.
   ========================================================================== */

const MAX_LINES = 4000;               // above this we fall back to a whole-file replacement view

function splitLines(text) {
  const raw = String(text ?? '');
  // An empty document has no lines at all — splitting '' would invent one.
  return raw === '' ? [] : raw.split('\n');
}

/** Longest common subsequence table, capped so a huge file cannot hang. */
function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return null;             // too big for DP; caller degrades gracefully
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => table[i * (m + 1) + j];
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] = a[i] === b[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  return { table, at, m };
}

function* walk(a, b, ctx) {
  const { at, m } = ctx;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      yield { type: ' ', text: a[i] };
      i += 1; j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      yield { type: '-', text: a[i] };
      i += 1;
    } else {
      yield { type: '+', text: b[j] };
      j += 1;
    }
  }
  while (i < a.length) { yield { type: '-', text: a[i] }; i += 1; }
  while (j < b.length) { yield { type: '+', text: b[j] }; j += 1; }
}

/**
 * @param {string} before
 * @param {string} after
 * @param {object} [opts]
 * @param {number} [opts.context]      lines of context per hunk
 * @returns {{hunks:Array, additions:number, deletions:number, identical:boolean, truncated:boolean}}
 */
export function diffLines(before, after, { context = 3 } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return {
      hunks: [{
        oldStart: 1, oldLines: a.length, newStart: 1, newLines: b.length,
        lines: [
          { type: '-', text: `[file too large to diff line-by-line — ${a.length} lines]` },
          { type: '+', text: `[file too large to diff line-by-line — ${b.length} lines]` },
        ],
      }],
      additions: b.length,
      deletions: a.length,
      identical: false,
      truncated: true,
    };
  }

  const ctx = lcsTable(a, b);
  if (!ctx) {
    return {
      hunks: [{ oldStart: 1, oldLines: a.length, newStart: 1, newLines: b.length,
        lines: [{ type: ' ', text: '(diff omitted: file too large)' }] }],
      additions: 0, deletions: 0, identical: false, truncated: true,
    };
  }

  const rows = [...walk(a, b, ctx)];
  const identical = rows.every(r => r.type === ' ');
  if (identical) return { hunks: [], additions: 0, deletions: 0, identical: true, truncated: false };

  let additions = 0;
  let deletions = 0;
  // Absolute 1-based line number each row starts at, on both sides.
  const oldAt = new Array(rows.length);
  const newAt = new Array(rows.length);
  let oldNo = 1;
  let newNo = 1;
  for (let i = 0; i < rows.length; i += 1) {
    oldAt[i] = oldNo;
    newAt[i] = newNo;
    if (rows[i].type === '+') { additions += 1; newNo += 1; }
    else if (rows[i].type === '-') { deletions += 1; oldNo += 1; }
    else { oldNo += 1; newNo += 1; }
  }

  // Group changed rows: two changes belong to the same hunk when fewer than
  // 2×context unchanged rows separate them (otherwise they would overlap).
  const groups = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].type === ' ') continue;
    const last = groups[groups.length - 1];
    if (last && i - last.end <= context * 2) last.end = i + 1;
    else groups.push({ start: i, end: i + 1 });
  }

  const hunks = [];
  for (const group of groups) {
    const from = Math.max(0, group.start - context);
    const to = Math.min(rows.length, group.end + context);
    const slice = rows.slice(from, to).map((row, offset) => ({
      type: row.type,
      text: row.text,
      oldLine: row.type === '+' ? null : oldAt[from + offset],
      newLine: row.type === '-' ? null : newAt[from + offset],
    }));

    let oldCount = 0;
    let newCount = 0;
    for (const row of slice) {
      if (row.type !== '+') oldCount += 1;
      if (row.type !== '-') newCount += 1;
    }
    hunks.push({
      oldStart: oldCount ? oldAt[from] : oldAt[Math.max(0, from - 1)] + 1,
      oldLines: oldCount,
      newStart: newCount ? newAt[from] : newAt[Math.max(0, from - 1)] + 1,
      newLines: newCount,
      lines: slice,
    });
  }

  return { hunks, additions, deletions, identical: false, truncated: false };
}

/** Unified diff text (`--- a/path` / `+++ b/path`) for copying and commits. */
export function toUnifiedDiff(path, before, after, { context = 3 } = {}) {
  const { hunks, additions, deletions } = diffLines(before, after, { context });
  if (!hunks.length) return '';
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) out.push(`${line.type}${line.text}`);
  }
  return `${out.join('\n')}\n/* +${additions} -${deletions} */`;
}

/** Compact stats for lists: `+12 −4`. */
export function diffStats(before, after) {
  const { additions, deletions, identical } = diffLines(before, after);
  return { additions, deletions, identical };
}
