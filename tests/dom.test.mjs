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
window.scrollTo = () => {};
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

/* ------------------------------ backend.json ------------------------------ */
// The harness answers ./backend.json so the deployed-frontend path is testable.
let backendJson = { url: '' };

/* --------------------------------- fetch ---------------------------------- */
let fetchMode = 'down';
let streamedText = '';
const requests = [];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  requests.push({ url: target, body: init.body ? JSON.parse(init.body) : null });

  if (target.includes('backend.json')) {
    if (!backendJson) return { ok: false, status: 404, async json() { return {}; } };
    return jsonResponse(backendJson);
  }

  if (fetchMode === 'down') throw new TypeError('Failed to fetch');

  if (target.includes('/api/health')) {
    if (fetchMode === 'unconfigured') {
      // The backend answers, but it has no key: reachable ≠ ready.
      return jsonResponse({
        ok: false, status: 'unconfigured', reachable: true, configured: false, verified: false,
        provider: 'openai', model: 'gpt-5', tools: [],
        features: { webSearch: false, attachments: false },
        error: 'invalid_config',
        message: 'TRALIX backend is reachable but OPENAI_API_KEY is not set.',
      });
    }
    return jsonResponse({
      ok: true, status: 'ok', reachable: true, configured: true, verified: true,
      provider: 'openai', model: 'gpt-5',
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
t('identity is JARVIS AI', $('.brand-text strong').textContent.trim() === 'JARVIS AI');
t('subtitle identifies the personal intelligence system', $('.brand-text small').textContent.includes('PERSONAL INTELLIGENCE'));
t('welcome greeting is present', $('#welcomeQuestion').textContent.includes('Systems online. How can I assist you?'));
t('four quick-start tasks are available', $$('#starterGrid .starter').length === 4, String($$('#starterGrid .starter').length));
t('the app opens in immersive mode', $('#app').dataset.mode === 'immersive');
t('local demo mode is clearly shown before a backend is verified',
  $('#app').dataset.runtime === 'demo' && $('#runtimeLabel').textContent === 'DEMO' && !$('#demoFootnote').hidden);
t('browser voice fallback is stated honestly',
  /keyboard dictation fallback/i.test($('#micStatusLabel').textContent));
t('no provider branding in the product chrome', (() => {
  const chrome = ['.brand-text', '#welcome', '#topbar', '#composerWrap']
    .map(sel => $(sel)?.textContent || '').join(' ');
  return !/gemini|gpt|openai|claude/i.test(chrome);
})(), '');
t('provider names appear only in Advanced settings (developer surface)', (() => {
  const prior = $('#welcome').textContent;
  const advanced = $('[data-section="advanced"]').textContent;
  return !/gemini/i.test(prior) && /Gemini/i.test(advanced);
})(), '');
t('composer placeholder', $('#composer-input').placeholder === 'Message JARVIS…');
t('composer starts disabled', $('#btnSend').disabled === true);

console.log('\n— local demo conversation —');
$('#composer-input').value = 'Hello JARVIS';
$('#composer-input').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await flush(900);
const demoNode = $('.msg-bot.msg-demo');
t('Demo Mode answers from its local sample set', Boolean(demoNode), demoNode?.textContent);
t('every demo answer says it was not AI-generated',
  demoNode?.textContent.includes('not generated by an AI model')
    && demoNode?.querySelector('.msg-demo-tag')?.textContent.includes('NOT AI'), demoNode?.textContent);
t('demo mode does not call the chat backend', chatRequests().length === 0, `${chatRequests().length} requests`);
t('the user message is kept in the conversation', $('.msg-user')?.textContent.includes('Hello JARVIS'));
t('per-message timestamps are rendered', Boolean($('.msg-user .msg-time') && $('.msg-bot .msg-time')));
t('sending opens conversation mode', $('#app').dataset.mode === 'conversation' && !$('#messages').hidden);
t('conversation can return to the immersive core', (() => {
  $('#btnViewMode').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const ok = $('#app').dataset.mode === 'immersive' && $('#messages').hidden && !$('#sessionPreview').hidden;
  $('#btnViewMode').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return ok;
})());
t('status returns to idle after the local sample', $('#statusSidebar').dataset.state === 'idle', $('#statusSidebar').dataset.state);

console.log('\n— explicit live backend error and retry —');
// Switching from Demo to Live opens connection setup and never disguises an API failure.
$('#runtimeBadge').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(100);
t('choosing live mode opens backend setup when unverified', !$('#connectSheet').hidden);
t('runtime state explicitly shows the selected live path', $('#app').dataset.runtime === 'live');
$('#connectSheet .icon-btn[data-close]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(400);
$('#composer-input').value = 'Hello JARVIS live path';
$('#composer-input').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await flush(80);
const errorNode = $('.msg-bot.msg-error');
t('live backend failure renders an understandable error state', Boolean(errorNode));
t('error text is human, not a stack trace',
  Boolean(errorNode) && !/TypeError|undefined|at \w+/.test(errorNode.textContent), errorNode?.textContent);
t('the failed user message is kept', $$('.msg-user').some(node => node.textContent.includes('Hello JARVIS live path')));
const errActions = () => [...($('.msg-bot.msg-error')?.querySelectorAll('.msg-actions .act') || [])].map(b => b.textContent.trim());
t('a Retry action is offered on the failed turn', errActions().some(l => l === 'Retry'), errActions().join(','));
t('a Connection shortcut is offered for a connection failure', errActions().some(l => l === 'Connection'), errActions().join(','));
t('the failed turn still offers Copy', errActions().some(l => l === 'Copy'), errActions().join(','));
t('status indicator shows an error', $('#statusSidebar').dataset.state === 'error', $('#statusSidebar').dataset.state);
t('the connection row reports the real backend problem',
  /unreachable|rejected|setup required|not configured/i.test($('#connText').textContent), $('#connText').textContent);

// Bring the backend test double up, tap Retry, and verify the same turn is sent once.
fetchMode = 'up';
const retryBtn = [...$$('.msg-bot.msg-error .msg-actions .act')].find(b => b.textContent.trim() === 'Retry');
retryBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(180);
t('Retry re-sends the same live turn', lastChatRequest()?.body?.messages?.at(-1)?.content === 'Hello JARVIS live path',
  JSON.stringify(lastChatRequest()?.body?.messages?.at(-1)));
t('Retry clears the error state', !$('.msg-bot.msg-error'));
t('Retry streams a real backend reply into the same conversation', Boolean($('.msg-bot:not(.msg-error):not(.msg-demo)')?.textContent.trim()));
t('Retry does not duplicate the failed user message',
  $$('.msg-user').filter(node => node.textContent.includes('Hello JARVIS live path')).length === 1);
t('connection status recovers after a successful backend reply',
  /connected/i.test($('#connText').textContent), $('#connText').textContent);

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
t('system instructions sent with the request', (lastChatRequest()?.body?.instructions || '').includes('JARVIS AI'));
t('composer cleared after a successful send', $('#composer-input').value === '');
t('response actions available', [...$$('.msg-actions .act')].map(b => b.textContent).join(' ').includes('Copy'));
t('more menu offers follow-ups', [...$$('.more-menu button')].some(b => b.textContent === 'Shorter'));
t('status returned to idle', $('#statusSidebar').dataset.state === 'idle', $('#statusSidebar').dataset.state);

console.log('\n— stop generation —');
const errorsBeforeStop = $$('.msg-bot.msg-error').length;
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
  $$('.msg-bot.msg-error').length === errorsBeforeStop,
  `${errorsBeforeStop} → ${$$('.msg-bot.msg-error').length}`);
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

/*
 * The exact mobile regression this project had to fix: after a drawer or sheet
 * closes, the page must be scrollable again. If body overflow stays 'hidden',
 * an iPhone user is stuck on a frozen conversation.
 */
t('body scrolling is restored after the drawer closes',
  document.body.style.overflow === '' || document.body.style.overflow === 'visible',
  JSON.stringify(document.body.style.overflow));
t('overscroll containment is released too',
  !document.body.style.overscrollBehavior || document.body.style.overscrollBehavior === '',
  JSON.stringify(document.body.style.overscrollBehavior));
/*
 * jsdom does not apply external stylesheets, so the scroll contract is checked
 * against the CSS text itself — which is where the real regression lived.
 */
const css = readFileSync(new URL('../assets/app.css', import.meta.url), 'utf8');
const ruleFor = (selector) => {
  const match = css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[2] : '';
};
const appRule = ruleFor('.app');
const chatRule = ruleFor('.chat');

t('the app frame never scrolls (children do)', /overflow:\s*hidden/.test(appRule), appRule.trim().slice(0, 60));
t('the app frame is sized to the visual viewport',
  /--vvh/.test(appRule) && /100dvh/.test(appRule), appRule.trim().slice(0, 90));
t('the conversation pane is the scroll container',
  /overflow-y:\s*auto/.test(chatRule), chatRule.trim().slice(0, 60));
t('the conversation pane gets momentum scrolling on iOS',
  /-webkit-overflow-scrolling:\s*touch/.test(chatRule), chatRule.trim().slice(0, 90));
t('no stylesheet rule locks the document body',
  !/^\s*body\s*\{[^}]*overflow:\s*hidden/m.test(css),
  'body { overflow: hidden } found in app.css');

// Open and close a sheet as well: the same guarantee must hold for both layers.
$('#btnSettings').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(60);
t('a sheet locks scrolling while it is open', document.body.style.overflow === 'hidden',
  JSON.stringify(document.body.style.overflow));
$('#settingsSheet .icon-btn[data-close]').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(400);
t('body scrolling is restored after a sheet closes', document.body.style.overflow === '',
  JSON.stringify(document.body.style.overflow));

// Nesting: two overlays open, one closes — the page stays locked until the last.
$('#btnSettings').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(60);
$('#btnMemory').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(80);
t('two overlays can be open at once', !$('#memorySheet').hidden && !$('#settingsSheet').hidden);
const nestedCount = await lockCount();
t('the lock is reference counted across overlays', nestedCount === 2, String(nestedCount));
t('the document style is applied once, not per overlay',
  document.body.style.overflow === 'hidden', JSON.stringify(document.body.style.overflow));

$('#memorySheet .icon-btn[data-close]').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(320);
t('the lock survives the first of two closes', (await lockCount()) > 0, String(await lockCount()));
t('the page is still locked while one overlay remains', document.body.style.overflow === 'hidden',
  JSON.stringify(document.body.style.overflow));

$('#settingsSheet .icon-btn[data-close]').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(400);
t('the page is scrollable again after the last overlay closes',
  (await lockCount()) === 0 && document.body.style.overflow === '',
  `count=${await lockCount()} overflow=${JSON.stringify(document.body.style.overflow)}`);
t('the conversation pane rule is unchanged after all of that',
  /overflow-y:\s*auto/.test(ruleFor('.chat')));

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
t('title derived from the first message', chats[0].title.startsWith('Hello JARVIS'), chats[0].title);
t('no provider key written to frontend storage',
  !JSON.stringify(store.loadSettings()).match(/sk-[A-Za-z0-9]{10,}/), '');
t('settings persisted with the v2 schema', store.meta().schema === store.SCHEMA_VERSION);

const health = await Api.refreshCapabilities({ force: true });
t('health report applied to feature flags', health.ok === true);
const { FEATURES } = await import('../assets/js/config.js');
t('web search reported as available by the backend', FEATURES.webSearch === true);
t('attachments reported as unavailable', FEATURES.attachments === false);

console.log('\n— automatic backend detection —');
{
  const healthCallsBefore = requests.filter(r => r.url.includes('/api/health')).length;

  // 1. the app checks the backend on its own at boot (no user action)
  t('the app probes /api/health by itself at boot', healthCallsBefore >= 1, `${healthCallsBefore} calls`);

  // 2. coming back online triggers a re-check
  window.dispatchEvent(new window.Event('online'));
  await flush(60);
  t('the "online" event re-checks the backend',
    requests.filter(r => r.url.includes('/api/health')).length > healthCallsBefore);

  // 3. a failed request marks the connection suspect and re-measures it
  const beforeSuspect = requests.filter(r => r.url.includes('/api/health')).length;
  window.dispatchEvent(new window.CustomEvent('tralix:connection-suspect', { detail: { code: 'network' } }));
  await flush(60);
  t('a failed request triggers a fresh connection check',
    requests.filter(r => r.url.includes('/api/health')).length > beforeSuspect);

  // 4. the reported status reflects the health payload (up → connected, not "coming soon")
  t('the status row reports a verified connection',
    /connected/i.test($('#connText').textContent), $('#connText').textContent);
  t('the status row never claims "coming soon" for chat',
    !/coming soon/i.test($('#connText').textContent), $('#connText').textContent);
  t('connected state tints the indicator as healthy', $('#statusSidebar').dataset.conn === 'ok',
    $('#statusSidebar').dataset.conn);

  // 5. a reachable-but-unkeyed backend is reported honestly, not as "connected"
  fetchMode = 'unconfigured';
  window.dispatchEvent(new window.CustomEvent('tralix:connection-suspect', { detail: {} }));
  await flush(80);
  t('an unkeyed backend is not called "connected"',
    !/connected/i.test($('#connText').textContent), $('#connText').textContent);
  t('an unkeyed backend is named precisely',
    /setup required/i.test($('#connText').textContent), $('#connText').textContent);
  t('an unkeyed backend tints the indicator as bad', $('#statusSidebar').dataset.conn === 'bad',
    $('#statusSidebar').dataset.conn);

  // 6. chat is not blocked by any "coming soon" gate while disconnected
  t('the composer stays usable while the backend is unconfigured', $('#btnSend').disabled !== undefined);
  t('the composer is not hidden behind an availability gate', !$('#composerWrap').hidden);
  t('the send path is not gated by a feature flag', $('#composer-input').disabled !== true);

  fetchMode = 'up';
  window.dispatchEvent(new window.CustomEvent('tralix:connection-suspect', { detail: {} }));
  await flush(80);
  t('the connection recovers when the backend comes back',
    /connected/i.test($('#connText').textContent), $('#connText').textContent);
}

console.log('\n— backend URL resolution (Render same-origin and split deployments) —');
{
  // A fresh module instance per scenario, because the base URL is cached.
  const loadConfig = async (tag) => {
    const mod = await import(`../assets/js/config.js?case=${tag}`);
    return mod;
  };

  const restoreSearch = window.location.search;

  // 1. same origin when nothing is configured
  backendJson = { url: '' };
  window.history.replaceState({}, '', '/Ai/');
  let cfg = await loadConfig('same-origin');
  await cfg.loadBackendConfig();
  t('with no config the base is same-origin', cfg.apiBase() === '', JSON.stringify(cfg.apiBase()));
  t('and the source is reported as same origin', cfg.apiBaseSource() === 'same origin', cfg.apiBaseSource());
  t('endpoint URLs stay relative', cfg.apiUrl('/chat') === '/api/chat', cfg.apiUrl('/chat'));

  // 2. backend.json points at a separately deployed backend
  backendJson = { url: 'https://tralix-backend.example.workers.dev' };
  cfg = await loadConfig('backend-json');
  await cfg.loadBackendConfig();
  t('backend.json supplies the deployed backend URL',
    cfg.apiBase() === 'https://tralix-backend.example.workers.dev', cfg.apiBase());
  t('the source is attributed to backend.json', cfg.apiBaseSource() === 'backend.json', cfg.apiBaseSource());
  t('endpoints are built against it',
    cfg.apiUrl('/chat') === 'https://tralix-backend.example.workers.dev/api/chat', cfg.apiUrl('/chat'));
  t('a trailing slash in the config is normalised',
    cfg.normaliseBase('https://x.dev///') === 'https://x.dev');

  // 3. ?api= beats backend.json (useful for testing a new deployment)
  window.history.replaceState({}, '', '/Ai/?api=https%3A%2F%2Fstaging.example.dev');
  cfg = await loadConfig('query');
  await cfg.loadBackendConfig();
  t('?api= overrides backend.json', cfg.apiBase() === 'https://staging.example.dev', cfg.apiBase());
  t('the source is attributed to the query string', cfg.apiBaseSource() === '?api= parameter', cfg.apiBaseSource());

  // 4. an explicit device override wins over everything
  window.localStorage.setItem('tralix.backend.v1', 'https://self-hosted.example.dev');
  cfg = await loadConfig('device');
  await cfg.loadBackendConfig();
  t('a saved device override wins', cfg.apiBase() === 'https://self-hosted.example.dev', cfg.apiBase());
  t('the source is reported as a device override', cfg.apiBaseSource() === 'device override', cfg.apiBaseSource());
  window.localStorage.removeItem('tralix.backend.v1');

  // 5. a malformed or key-bearing config file is rejected safely
  window.history.replaceState({}, '', '/Ai/');
  backendJson = { url: 'not a url', key: 'sk-should-never-be-here' };
  cfg = await loadConfig('malformed');
  await cfg.loadBackendConfig();
  t('a relative/garbage URL is not accepted as a base', cfg.apiBase() === '', JSON.stringify(cfg.apiBase()));

  backendJson = { url: '' };
  window.history.replaceState({}, '', restoreSearch || '/Ai/');
}

console.log('\n— clear-history confirmation and undo —');
$('#btnSettings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(60);
$('#settingsSheet .tab[data-tab=\"data\"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const chatsBeforeClear = store.loadChats();
$('#btnClearChats').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(60);
t('clearing conversations asks for confirmation',
  !$('#confirmSheet').hidden && $('#confirmTitle').textContent === 'Clear all conversations?');
t('confirmation explains the scope of deletion',
  $('#confirmBody').textContent.includes('Every conversation on this device will be deleted'));
$('#confirmNo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(360);
t('cancel leaves conversation history untouched', store.loadChats().length === chatsBeforeClear.length);
$('#btnClearChats').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(60);
$('#confirmYes').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(80);
t('confirmed clear deletes local conversations', store.loadChats().length === 0);
$('#toastAction').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(60);
t('clear-history undo restores the saved conversations', store.loadChats().length === chatsBeforeClear.length);
$('#settingsSheet [data-close=\"settingsSheet\"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(360);

console.log('\n— core animation, accessibility and PWA states —');
const statusModule = await import('../assets/js/ui/status.js');
t('energy core has an accessible idle label',
  $('#aiCore').getAttribute('role') === 'img' && /idle/i.test($('#aiCore').getAttribute('aria-label')));
for (const state of statusModule.STATES) {
  statusModule.setStatus(state);
  t(`${state} activity state reaches the core and status indicator`,
    $('#aiCore').dataset.state === state && $('#statusSidebar').dataset.state === state,
    `${$('#aiCore').dataset.state}/${$('#statusSidebar').dataset.state}`);
}
statusModule.setStatus('idle');
t('CSS provides distinct listening/thinking/speaking/error core treatments',
  ['listening', 'thinking', 'speaking', 'error'].every(state => css.includes(`#aiCore[data-state=\"${state}\"]`)));
t('reduced-motion disables decorative core animation',
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.core-orbit[^}]*animation:\s*none/.test(css));
t('background tabs suspend continuous core motion', /html\.page-suspended[^}]*animation-play-state:\s*paused/.test(css));
t('XS Max-sized layouts include narrow and short-screen rules',
  /@media \(max-width: 390px\)/.test(css) && /@media \(max-height: 740px\) and \(max-width: 899px\)/.test(css));
t('viewport permits pinch zoom for accessibility', !/maximum-scale=1|user-scalable=no/.test(html));
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
t('PWA manifest is JARVIS-branded', manifest.short_name === 'JARVIS');
t('PWA identity is rooted for the Render-hosted app', manifest.id === '/');
t('all manifest icon assets exist', manifest.icons.every(icon =>
  readFileSync(path.join(root, icon.src.replace(/^\.\//, ''))).length > 0));

console.log('\n— errors during the run —');
t('no uncaught errors or rejections', problems.length === 0, problems.join(' | '));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
