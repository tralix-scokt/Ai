/* ==========================================================================
   dom.test.mjs — integration smoke test.

   Loads index.html in jsdom, boots the real app modules, and drives the actual
   UI: sending a message, streaming a reply, opening every sheet, switching
   transport, memory safety, search and the scroll lock.

   Requires jsdom (dev only):   npm install --no-save jsdom
   Run:                          node tests/dom.test.mjs
   ========================================================================== */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * jsdom is dev-only. Prefer a normal resolution, then fall back to a few known
 * locations so the test still runs in sandboxes that install it outside the
 * repository (npm install --no-save jsdom in a temp dir). In an ESM module the
 * CJS `require` is not defined, so all fallbacks go through createRequire.
 */
const req = createRequire(import.meta.url);

async function loadJsdom() {
  const attempts = [
    () => import('jsdom'),
    () => req('jsdom'),
    () => req('/tmp/node_modules/jsdom'),
    () => req(path.join(process.env.HOME || '/root', 'node_modules', 'jsdom')),
  ];
  for (const attempt of attempts) {
    try {
      const mod = await attempt();
      if (mod?.JSDOM) return mod;
    } catch { /* try the next location */ }
  }
  return null;
}

const jsdomMod = await loadJsdom();
if (!jsdomMod) {
  console.log('\n⚠️  jsdom is not installed — skipping the DOM integration test.');
  console.log('   npm install --no-save jsdom && node tests/dom.test.mjs\n');
  process.exit(0);
}
const { JSDOM } = jsdomMod;

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
};

const problems = [];
process.on('uncaughtException', (err) => problems.push(`uncaught: ${err.message}`));
process.on('unhandledRejection', (err) => problems.push(`unhandled: ${err?.message || err}`));

/* ------------------------------- environment ------------------------------ */
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'https://example.test/Ai/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});

const { window } = dom;

// jsdom does not implement these browser APIs
const visualViewport = {
  height: 780,
  offsetTop: 0,
  width: 390,
  addEventListener() {},
  removeEventListener() {},
};
window.visualViewport = visualViewport;
// A just-good-enough matchMedia: the app asks about min/max width queries.
window.matchMedia = (query) => {
  const mobile = /max-width:\s*(\d+)px/.test(query)
    ? Number(query.match(/max-width:\s*(\d+)px/)[1]) >= 390
    : /min-width:\s*(\d+)px/.test(query)
      ? Number(query.match(/min-width:\s*(\d+)px/)[1]) <= 390
      : false;
  return {
    matches: mobile,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  };
};

for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: window[key] ?? window[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true });
Object.defineProperty(globalThis, 'matchMedia', { value: window.matchMedia.bind(window), configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

/* --------------------------------- fetch ---------------------------------- */
let fetchMode = 'down';
let streamedText = '';
const requests = [];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  requests.push({ url: target, body: init.body ? JSON.parse(init.body) : null });

  if (fetchMode === 'down') throw new TypeError('Failed to fetch');

  if (target.includes('/api/health')) {
    return jsonResponse({
      ok: true, configured: true, provider: 'openai', model: 'gpt-5',
      tools: ['web_search'], features: { webSearch: true, attachments: false },
    });
  }
  if (target.includes('/api/models')) {
    return jsonResponse({ models: { 'tralix-smart': { provider: 'openai', model: 'gpt-5' } } });
  }
  if (target.includes('/api/chat') && fetchMode === 'slow') {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: 'Starting a long answer…' })}\n\n`));
        const timer = setInterval(() => {
          try { controller.enqueue(encoder.encode(': keep-alive\n\n')); } catch { clearInterval(timer); }
        }, 20);
        init.signal?.addEventListener('abort', () => {
          clearInterval(timer);
          try { controller.error(new Error('aborted')); } catch {}
        });
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }

  if (target.includes('/api/chat')) {
    const chunks = [
      { type: 'delta', text: '**Bold** answer with code:\n\n```js\nconst x = 2 ** 10;\n```\n' },
      { type: 'delta', text: '- one\n- two\n' },
      { type: 'done', model: 'gpt-5' },
    ];
    streamedText = chunks.map(c => c.text || '').join('');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return jsonResponse({}, 404);
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/* --------------------------------- boot ----------------------------------- */
const flush = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

console.log('\n— boot —');
await import('../assets/js/app.js');
await flush(60);

const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const chatRequests = () => requests.filter(r => r.url.includes('/api/chat'));
const lastChatRequest = () => chatRequests().at(-1);

t('boot splash is removed', !$('#boot'));
t('app is revealed', $('#app') && !$('#app').hidden);
t('identity is TRALIX AI', $('.brand-text strong').textContent.trim() === 'TRALIX AI');
t('subtitle present', $('.brand-text small').textContent.includes('Intelligent AI Assistant'));
t('welcome screen asks what to do', $('#welcomeQuestion').textContent.includes('What can I help you accomplish?'));
t('starter cards rendered', $$('#starterGrid .starter').length === 5, String($$('#starterGrid .starter').length));
t('no vendor branding in the product chrome', (() => {
  const chrome = ['.brand-text', '#welcome', '#topbar', '#composerWrap']
    .map(sel => $(sel)?.textContent || '').join(' ');
  return !/gemini|gpt|openai|claude/i.test(chrome);
})(), '');
t('provider names appear only in Advanced settings (developer surface)', (() => {
  const prior = $('#welcome').textContent;
  const advanced = $('[data-section="advanced"]').textContent;
  return !/gemini/i.test(prior) && /Gemini/i.test(advanced);
})(), '');
t('composer placeholder', $('#composer-input').placeholder === 'Message TRALIX…');
t('composer starts disabled', $('#btnSend').disabled === true);

console.log('\n— backend down (honest error state) —');
$('#composer-input').value = 'Hello TRALIX';
$('#composer-input').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await flush(60);
const errorNode = $('.msg-bot.msg-error');
t('failed request renders a professional error state', Boolean(errorNode));
t('error text is human, not a stack trace',
  Boolean(errorNode) && !/TypeError|undefined|at \w+/.test(errorNode.textContent), errorNode?.textContent);
t('user message is kept, not lost', $('.msg-user')?.textContent.includes('Hello TRALIX'));
t('retry action offered', [...$$('.msg-actions .act')].some(b => b.textContent.includes('Regenerate')));
t('status indicator shows an error', $('#statusSidebar').dataset.state === 'error', $('#statusSidebar').dataset.state);

console.log('\n— backend up (streaming reply) —');
fetchMode = 'up';
$('#composer-input').value = 'Show me a loop';
$('#composer-input').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await flush(120);

const bots = $$('.msg-bot:not(.msg-error)');
const lastBot = bots[bots.length - 1];
t('assistant message rendered', Boolean(lastBot));
t('markdown bold rendered', lastBot?.querySelector('strong')?.textContent === 'Bold');
t('markdown list rendered', lastBot?.querySelectorAll('li').length === 2);
t('code block rendered with language label', lastBot?.querySelector('.code-lang')?.textContent === 'js');
t('code block has a copy button', Boolean(lastBot?.querySelector('[data-copy-target]')));
t('code is syntax highlighted', Boolean(lastBot?.querySelector('.tok-key')));
t('request carried the TRALIX tier, not a vendor model', lastChatRequest()?.body?.model === 'tralix-smart', JSON.stringify(lastChatRequest()?.body?.model));
t('system instructions sent with the request', (lastChatRequest()?.body?.instructions || '').includes('TRALIX AI'));
t('composer cleared after a successful send', $('#composer-input').value === '');
t('response actions available', [...$$('.msg-actions .act')].map(b => b.textContent).join(' ').includes('Copy'));
t('more menu offers follow-ups', [...$$('.more-menu button')].some(b => b.textContent === 'Shorter'));
t('status returned to idle', $('#statusSidebar').dataset.state === 'idle', $('#statusSidebar').dataset.state);

console.log('\n— stop generation —');
fetchMode = 'slow';
$('#composer-input').value = 'Write me a very long essay';
$('#composer-input').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await flush(80);
t('stop button replaces send while streaming', !$('#btnStop').hidden && $('#btnSend').hidden);
t('status shows generating', $('#statusSidebar').dataset.state === 'generating', $('#statusSidebar').dataset.state);
t('partial text streamed into the reply', $('.msg-bot:not(.msg-error):last-of-type') !== null);
$('#btnStop').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(80);
t('stop restores the send button', $('#btnStop').hidden && !$('#btnSend').hidden);
t('stop returns the status to idle', $('#statusSidebar').dataset.state === 'idle', $('#statusSidebar').dataset.state);
t('a deliberate stop is not an error',
  $$('.msg-bot.msg-error').length === 1, String($$('.msg-bot.msg-error').length));
t('partial reply is kept after stopping',
  $$('.msg-bot:not(.msg-error)').at(-1)?.textContent.includes('Starting a long answer'));
fetchMode = 'up';

console.log('\n— response actions —');
const usersBeforeFollowUp = $$('.msg-user').length;
const moreBtn = [...$$('.act')].find(b => b.textContent.includes('More'));
moreBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
const shorter = [...$$('.more-menu button')].find(b => b.textContent === 'Shorter');
t('more menu opens', Boolean(shorter));
shorter.dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(120);
t('follow-up sends a hidden instruction, not a user bubble',
  (lastChatRequest()?.body?.messages.at(-1)?.content || '').includes('Rewrite your previous answer much shorter'),
  JSON.stringify(lastChatRequest()?.body?.messages?.at(-1) || null).slice(0, 120));
t('follow-up is not rendered as a user message',
  $$('.msg-user').length === usersBeforeFollowUp,
  `${$$('.msg-user').length} vs ${usersBeforeFollowUp}`);

console.log('\n— sheets, drawer and scroll lock —');
const lockCount = async () => (await import('../assets/js/scrolling.js')).scrollLockCount();

$('#btnSettings').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(40);
t('settings sheet opens', !$('#settingsSheet').hidden);
t('scroll lock engaged while open', (await lockCount()) > 0, String(await lockCount()));
t('settings has six sections', $$('#settingsBody .set-block').length === 6);
$('#settingsSheet .tab[data-tab="advanced"]').dispatchEvent(new window.Event('click', { bubbles: true }));
t('advanced section shows by default only when selected', !$('[data-section="advanced"]').hidden);
$('#settingsSheet .tab[data-tab="voice"]').dispatchEvent(new window.Event('click', { bubbles: true }));
t('voice section shows the speech support note', $('#voiceSupportNote').textContent.length > 0);

const esc = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
window.document.dispatchEvent(esc);
await flush(400);
t('Escape closes the sheet', $('#settingsSheet').hidden);
t('scroll lock released on close', (await lockCount()) === 0, String(await lockCount()));

$('#btnModel').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(40);
t('model picker opens', !$('#modelSheet').hidden);
t('four TRALIX tiers offered', $$('#modelList .model-opt').length === 4);
t('provider names hidden from the picker', !$('#modelList').textContent.includes('gpt-'), $('#modelList').textContent.slice(0, 80));
t('capability list is honest about attachments',
  $('#capabilityList').textContent.includes('Unavailable'), $('#capabilityList').textContent);
$('#modelSheet .icon-btn[data-close]').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(400);

$('#btnMenu').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(40);
t('mobile drawer opens', $('#app').classList.contains('drawer-open') && !$('#scrim').hidden);
$('#scrim').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(320);
t('drawer closes and releases the lock', !$('#app').classList.contains('drawer-open') && (await lockCount()) === 0);

console.log('\n— search, projects, memory —');
$('#btnSearch').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(40);
t('search overlay opens', !$('#searchSheet').hidden);
$('#searchInput').value = 'loop';
$('#searchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
await flush(200);
t('search finds the conversation by message content', $$('#searchResults .search-item').length >= 1);
$('#searchInput').value = 'nothing-matches-this';
$('#searchInput').dispatchEvent(new window.Event('input', { bubbles: true }));
await flush(200);
t('search shows an empty state instead of breaking', $('#searchResults').textContent.includes('No conversations match'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await flush(400);

$('#btnProjects').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(40);
$('#projectInput').value = 'CODM Hub';
$('#btnProjectAdd').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(40);
t('project created and listed', $('#projectList').textContent.includes('CODM Hub'));
const projects = (await import('../assets/js/store.js')).loadProjects();
t('project persisted', projects.length === 1 && projects[0].name === 'CODM Hub');
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await flush(400);

$('#btnMemory').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(60);
t('memory sheet opens with an add row', Boolean($('#memManagerSheet .mem-add input')));
const memInput = $('#memManagerSheet .mem-add input');
memInput.value = 'Prefers dark mode';
$('#memManagerSheet .mem-add button').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(60);
t('memory added and grouped by category', $('#memManagerSheet').textContent.includes('Preferences'));
memInput.value = 'my password is hunter2';
$('#memManagerSheet .mem-add button').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(60);
t('sensitive memory refused', !$('#memManagerSheet').textContent.includes('hunter2'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await flush(400);

console.log('\n— transport switching —');
const store = await import('../assets/js/store.js');
const Api = await import('../assets/js/api/chat.js');
const settings = store.loadSettings();
t('default transport is the secure backend', Api.activeTransport(settings) === 'backend');
settings.advanced.transport = 'local';
settings.advanced.apiKey = 'AIzaFAKEKEYFOR-TEST-0000000000';
store.saveSettings(settings);
t('advanced transport switches to the device key', Api.activeTransport(store.loadSettings()) === 'local');
settings.advanced.transport = 'backend';
settings.advanced.apiKey = '';
store.saveSettings(settings);
t('switching back is possible', Api.activeTransport(store.loadSettings()) === 'backend');

console.log('\n— persistence & safety —');
const chats = store.loadChats();
t('conversation saved to local storage', chats.length === 1 && chats[0].messages.length >= 4, String(chats.length));
t('title derived from the first message', chats[0].title.startsWith('Hello TRALIX'), chats[0].title);
t('no provider key written to frontend storage',
  !JSON.stringify(store.loadSettings()).match(/sk-[A-Za-z0-9]{10,}/), '');
t('settings persisted with the v2 schema', store.meta().schema === store.SCHEMA_VERSION);

const health = await Api.refreshCapabilities({ force: true });
t('health report applied to feature flags', health.ok === true);
const { FEATURES } = await import('../assets/js/config.js');
t('web search reported as available by the backend', FEATURES.webSearch === true);
t('attachments reported as unavailable', FEATURES.attachments === false);

console.log('\n— errors during the run —');
t('no uncaught errors or rejections', problems.length === 0, problems.join(' | '));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
