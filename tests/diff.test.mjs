/* ==========================================================================
   diff.test.mjs — the line diff used to review JARVIS's proposed changes.

   Run:  node tests/diff.test.mjs
   ========================================================================== */

import { diffLines, toUnifiedDiff, diffStats } from '../server/diff.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? `— ${extra}` : ''); }
};

console.log('\n— diff —');

{
  const { identical, hunks } = diffLines('a\nb\nc', 'a\nb\nc');
  t('identical text produces no hunks', identical && hunks.length === 0);
}

{
  const { additions, deletions, hunks } = diffLines('a\nb\nc', 'a\nB\nc');
  t('a single change is counted once on each side', additions === 1 && deletions === 1, `+${additions} -${deletions}`);
  t('the hunk contains the removed and the added line',
    hunks[0].lines.some(l => l.type === '-' && l.text === 'b')
    && hunks[0].lines.some(l => l.type === '+' && l.text === 'B'));
  t('context lines are kept', hunks[0].lines.filter(l => l.type === ' ').length >= 2);
  t('line numbers are 1-based and correct',
    hunks[0].lines.find(l => l.type === '-').oldLine === 2
    && hunks[0].lines.find(l => l.type === '+').newLine === 2,
    JSON.stringify(hunks[0].lines));
}

{
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const after = before.replace('line 5', 'LINE 5').replace('line 30', 'LINE 30');
  const { hunks } = diffLines(before, after);
  t('distant changes produce separate hunks', hunks.length === 2, String(hunks.length));
  t('the first hunk starts before the change', hunks[0].oldStart < 5, String(hunks[0].oldStart));
  t('the second hunk covers the later change',
    hunks[1].lines.some(l => l.text === 'LINE 30'), JSON.stringify(hunks[1].lines.map(l => l.text)));
}

{
  const { additions, deletions } = diffLines('', 'hello\nworld');
  t('a new file counts as pure additions', deletions === 0 && additions === 2, `+${additions} -${deletions}`);
}

{
  const { additions, deletions } = diffLines('hello\nworld', '');
  t('a deleted file counts as pure deletions', additions === 0 && deletions === 2, `+${additions} -${deletions}`);
}

{
  const unified = toUnifiedDiff('src/app.js', 'const a = 1;\n', 'const a = 2;\n');
  t('the unified diff has file headers', unified.includes('--- a/src/app.js') && unified.includes('+++ b/src/app.js'), unified);
  t('the unified diff has a hunk header', /@@ -\d+,\d+ \+\d+,\d+ @@/.test(unified), unified);
  t('the unified diff marks removals and additions', unified.includes('-const a = 1;') && unified.includes('+const a = 2;'), unified);
}

{
  t('stats are a summary', JSON.stringify(diffStats('a\nb', 'a\nc')) === JSON.stringify({ additions: 1, deletions: 1, identical: false }));
}

{
  const huge = Array.from({ length: 5000 }, (_, i) => `l${i}`).join('\n');
  const { truncated } = diffLines(huge, `${huge}\nextra`);
  t('a very large file degrades instead of hanging', truncated === true);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
