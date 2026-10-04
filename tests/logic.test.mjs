/* ==========================================================================
   logic.test.mjs — run with:  node tests/logic.test.mjs
   Covers markdown, memory, prompt, and chat scroll/viewport logic.
   No dependencies, no test framework.
   ========================================================================== */

import { renderMarkdown, stripMarkdown } from '../assets/js/markdown.js';
import { isNearBottom, bindVisualViewport } from '../assets/js/scrolling.js';
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

console.log('\n— chat scrolling —');
const chatScroller = { scrollHeight: 900, scrollTop: 600, clientHeight: 300 };
t('detects a chat already at the bottom', isNearBottom(chatScroller), '');
chatScroller.scrollTop = 400;
t('does not treat an older-message position as the bottom', !isNearBottom(chatScroller), '');
chatScroller.scrollTop = 600;

function mockVisualViewport(height, offsetTop = 0) {
  const listeners = new Map();
  return {
    height,
    offsetTop,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type) { for (const listener of listeners.get(type) || []) listener(); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
}

const visualViewport = mockVisualViewport(800);
const appStyle = {};
const scheduledFrames = [];
const bottomScrolls = [];
const unbindViewport = bindVisualViewport({
  app: { style: appStyle },
  chat: chatScroller,
  visualViewport,
  scrollToBottom: (instant) => bottomScrolls.push(instant),
  scheduleFrame: (callback) => scheduledFrames.push(callback),
});
t('fits the app to the initial visual viewport', appStyle.height === '800px', appStyle.height);
t('initial viewport fit does not cause an unnecessary scroll', scheduledFrames.length === 0, '');
visualViewport.height = 520;
visualViewport.emit('resize');
t('resizes the app when the keyboard reduces the visual viewport', appStyle.height === '520px', appStyle.height);
t('schedules a bottom correction when the reader was following the latest reply', scheduledFrames.length === 1, '');
scheduledFrames.shift()();
t('uses an instant correction after viewport resize', bottomScrolls.length === 1 && bottomScrolls[0] === true, '');

chatScroller.scrollTop = 100;
visualViewport.height = 800;
visualViewport.emit('resize');
t('does not force the reader back to the bottom after resizing', scheduledFrames.length === 0, '');
visualViewport.offsetTop = 18;
visualViewport.emit('scroll');
t('tracks a shifted visual viewport', appStyle.transform === 'translateY(18px)', appStyle.transform);
t('does not interrupt an upward-reading position when the viewport shifts', scheduledFrames.length === 0, '');
unbindViewport();
t('removes visual viewport listeners on cleanup',
  visualViewport.listenerCount('resize') === 0 && visualViewport.listenerCount('scroll') === 0, '');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
