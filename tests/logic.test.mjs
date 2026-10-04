/* ==========================================================================
   logic.test.mjs — run with:  node tests/logic.test.mjs
   Covers the pure logic: markdown rendering, memory extraction, prompt build.
   No dependencies, no test framework.
   ========================================================================== */

import { renderMarkdown, stripMarkdown } from '../assets/js/markdown.js';
import { extractMemoryCandidates, buildSystemPrompt, MODELS, bestAvailableModel, setAvailableModels } from '../assets/js/providers.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
};

console.log('\n— markdown —');
const md1 = renderMarkdown('**bold** and *italic* and `code`');
t('bold / italic / inline code',
  md1.includes('<strong>bold</strong>') && md1.includes('<em>italic</em>') && md1.includes('<code>code</code>'), md1);

const md2 = renderMarkdown('```js\nconst x = 1 < 2;\n```');
t('fenced code block escaped + copy button',
  md2.includes('&lt;') && md2.includes('<pre>') && md2.includes('Copy'), md2.slice(0, 120));

const md3 = renderMarkdown('# Title\n\n- one\n- two');
t('heading + bullet list',
  md3.includes('<h1>Title</h1>') && md3.includes('<ul>') && (md3.match(/<li>/g) || []).length === 2, md3);

t('ordered list', renderMarkdown('1. first\n2. second').includes('<ol>'), '');
t('safe link gets target=_blank',
  renderMarkdown('[click](https://ok.com)').includes('target="_blank"'), '');

t('javascript: url blocked',
  !renderMarkdown('[evil](javascript:alert(1))').includes('javascript:alert'), '');

t('raw HTML escaped',
  !renderMarkdown('<script>alert(1)</script>').includes('<script>'), '');

t('markdown table', renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |').includes('<table>'), '');
t('blockquote', renderMarkdown('> quoted').includes('<blockquote>'), '');

t('markdown inside code stays literal',
  renderMarkdown('```\n**not bold**\n```').includes('**not bold**'), '');

t('stripMarkdown for speech',
  stripMarkdown('**Hi** there').includes('Hi there'), '');

console.log('\n— memory extraction —');
t('"remember that my name is X"',
  /Tralix/i.test(extractMemoryCandidates('Remember that my name is Tralix').join(' ')), '');

t('name + location in one line',
  (() => { const r = extractMemoryCandidates('My name is Sarah and I live in Lagos').join(' ');
           return /Sarah/i.test(r) && /Lagos/i.test(r); })(), '');

t('"call me X"', /Mike/i.test(extractMemoryCandidates('Call me Mike').join(' ')), '');
t('"I work as X"', /product designer/i.test(extractMemoryCandidates('I work as a product designer').join(' ')), '');
t('no false positives on a plain question',
  extractMemoryCandidates('What is the weather today?').length === 0, '');

console.log('\n— prompt building —');
const p1 = buildSystemPrompt({ memory: '- name is Tralix', userName: 'Tralix' });
t('memory injected', p1.includes('name is Tralix'), '');
t('user name injected', p1.includes("name is Tralix"), '');
t('current date injected', /Current date:/.test(p1), '');
t('no unresolved placeholders', !p1.includes('{user') && !p1.includes('{userName}'), '');
t('custom persona replaces default',
  buildSystemPrompt({ persona: 'Be terse.' }).startsWith('Be terse.'), '');

console.log('\n— model reconciliation —');
setAvailableModels(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
t('keeps a working model as-is', bestAvailableModel('gemini-3.8-flash') === 'gemini-3.8-flash', '');
t('swaps a retired model for one that works',
  bestAvailableModel('gemini-2.5-pro') === 'gemini-3.8-flash', '');
setAvailableModels(null);
t('with no probe data, leaves the choice alone',
  bestAvailableModel('gemini-2.5-pro') === 'gemini-2.5-pro', '');
t('curated list is non-empty', MODELS.length > 0, '');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
