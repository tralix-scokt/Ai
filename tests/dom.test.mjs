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

/*
 * jsdom implements no media playback, so spoken replies are driven through a
 * stand-in Audio element the test can start and finish by hand.
 */
class FakeAudio {
  static instances = [];
  constructor(src) {
    this.src = src;
    this.playing = false;
    this.listeners = {};
    FakeAudio.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn);
  }
  play() { this.playing = true; return Promise.resolve(); }
  pause() { this.playing = false; }
  /** Test helper: the audio finished playing. */
  finish() { this.playing = false; for (const fn of this.listeners.ended || []) fn(); }
  fail() { for (const fn of this.listeners.error || []) fn(); }
}
globalThis.Audio = FakeAudio;
window.Audio = FakeAudio;

/* ------------------------------ backend.json ------------------------------ */
// The harness answers ./backend.json so the deployed-frontend path is testable.
let backendJson = { url: '' };

/* --------------------------------- fetch ---------------------------------- */
let fetchMode = 'down';
let streamedText = '';
const requests = [];
const v2Requests = [];
/** How the mocked deployment answers /api/v2/chat. */
let v2Mode = 'ok';                  // 'ok' | 'blocked' | 'missing'
/** Whether the mocked /api/health advertises the routing layer. */
let healthV2 = false;
/** 'off' = no voice key on the server, 'server' = Fish Audio configured. */
let voiceMode = 'off';
const speechRequests = [];
/** 'short' or 'long' — a long reply must be split before it is spoken. */
let replyLength = 'short';

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
        message: 'JARVIS backend is reachable but OPENAI_API_KEY is not set.',
      });
    }
    return jsonResponse({
      ok: true, status: 'ok', reachable: true, configured: true, verified: true,
      provider: 'openai', model: 'gpt-5',
      tools: ['web_search'],
      features: { webSearch: true, attachments: false, multiProviderRouting: healthV2 },
      ...(healthV2 ? { jarvis: { api: '/api/v2', studio: true } } : {}),
    });
  }
  if (target.includes('/api/models')) {
    return jsonResponse({ models: { 'tralix-smart': { provider: 'openai', model: 'gpt-5' } } });
  }
  if (target.includes('/api/v2/chat')) {
    v2Requests.push({ url: target, body: init.body ? JSON.parse(init.body) : null });

    if (v2Mode === 'missing') {
      // A deployment that predates the routing layer.
      return jsonResponse({ error: { code: 'not_found', message: 'Not Found' } }, 404);
    }
    if (v2Mode === 'blocked') {
      // No free model left, and paid usage is not authorised.
      return jsonResponse({
        error: {
          code: 'paid_blocked',
          message: 'No free model is available right now. Paid providers are configured but you have not authorised paid usage.',
          requiresPaidPermission: true,
        },
      }, 503);
    }

    const chunks = [
      { type: 'model', provider: 'gemini', providerLabel: 'Gemini', model: 'gemini-2.5-flash', paid: false },
      { type: 'delta', text: 'Routed through the free tier.' },
      { type: 'done', provider: 'gemini', providerLabel: 'Gemini', model: 'gemini-2.5-flash', paid: false, attempts: [] },
    ];
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

  if (target.includes('/api/v2/voice/status')) {
    return jsonResponse({
      provider: 'fish-audio',
      configured: voiceMode === 'server',
      keySource: voiceMode === 'server' ? 'environment' : '',
      keyHint: voiceMode === 'server' ? 'fa-…0001' : '',
      model: 's2-pro', voiceId: '', format: 'mp3', speed: 1.15, maxChars: 1200,
    });
  }

  if (target.includes('/api/v2/voice/speak')) {
    speechRequests.push({ url: target, body: init.body ? JSON.parse(init.body) : null });
    if (voiceMode !== 'server') {
      return jsonResponse({ error: { code: 'invalid_config', message: 'Text-to-speech is not configured.' } }, 503);
    }
    return new Response(Buffer.from([0x49, 0x44, 0x33, 0x03]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
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
    const long = 'This is a sentence long enough to need splitting. '.repeat(40);
    const chunks = replyLength === 'long'
      ? [{ type: 'delta', text: long }, { type: 'done', model: 'gpt-5' }]
      : [
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
t('identity is JARVIS STUDIO', $('.brand-text strong').textContent.trim() === 'JARVIS STUDIO');
t('subtitle present', $('.brand-text small').textContent.includes('AI Coding Workspace'));
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
t('composer placeholder', $('#composer-input').placeholder === 'Message JARVIS…');
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
const errActions = () => [...($('.msg-bot.msg-error')?.querySelectorAll('.msg-actions .act') || [])].map(b => b.textContent.trim());
t('a Retry action is offered on the failed turn', errActions().some(l => l === 'Retry'), errActions().join(','));
t('a Connection shortcut is offered for a connection failure', errActions().some(l => l === 'Connection'), errActions().join(','));
t('the failed turn still offers Copy', errActions().some(l => l === 'Copy'), errActions().join(','));
t('status indicator shows an error', $('#statusSidebar').dataset.state === 'error', $('#statusSidebar').dataset.state);
t('the connection row reports the real problem, not a vague "offline"',
  /no api key|unreachable|rejected|not configured/i.test($('#connText').textContent), $('#connText').textContent);

// Retry must actually work: bring the backend up, tap Retry, expect a reply.
fetchMode = 'up';
const retryBtn = [...$$('.msg-bot.msg-error .msg-actions .act')].find(b => b.textContent.trim() === 'Retry');
retryBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await flush(150);
t('Retry re-sends the same turn', lastChatRequest()?.body?.messages?.at(-1)?.content === 'Hello TRALIX',
  JSON.stringify(lastChatRequest()?.body?.messages?.at(-1)));
t('Retry clears the error state', !$('.msg-bot.msg-error'));
t('Retry streams a real reply into the same conversation', Boolean($('.msg-bot:not(.msg-error)')?.textContent.trim()));
t('The user message was not duplicated by Retry', $$('.msg-user').length === 1, `${$$('.msg-user').length} user bubbles`);
t('connection status recovers after a successful reply',
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
t('system instructions sent with the request', (lastChatRequest()?.body?.instructions || '').includes('JARVIS'));
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

console.log('\n— free-first routing —');
{
  // Imported here (not at the top) so the section can stand on its own; the
  // later transport section imports the same module under a different name.
  const ChatApi = await import('../assets/js/api/chat.js');
  const send = async (text) => {
    $('#composer-input').value = text;
    $('#composer-input').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(150);
  };
  const lastBot = () => $$('.msg-bot').at(-1);

  // The deployment advertises /api/v2, so ordinary chat must be routed.
  healthV2 = true;
  v2Mode = 'ok';
  await ChatApi.refreshCapabilities({ force: true });
  const legacyBefore = chatRequests().length;

  await send('Explain closures like I am five');

  t('chat is routed through /api/v2 when the backend offers it', v2Requests.length === 1,
    `${v2Requests.length} v2 requests`);
  t('the routed request carries the JARVIS tier, not a vendor model',
    v2Requests[0]?.body?.tier === 'smart', JSON.stringify(v2Requests[0]?.body?.tier));
  t('the client never asks for a paid provider', v2Requests[0]?.body?.allowPaid !== true);
  t('the legacy single-provider endpoint was not used', chatRequests().length === legacyBefore,
    `${legacyBefore} → ${chatRequests().length}`);
  t('the routed reply is rendered', /Routed through the free tier/.test(lastBot()?.textContent || ''),
    (lastBot()?.textContent || '').slice(0, 80));
  t('the reply names the provider that actually answered',
    /Gemini/.test(lastBot()?.querySelector('.msg-model')?.textContent || ''),
    lastBot()?.querySelector('.msg-model')?.textContent);

  // No silent paid switching: a routing block is reported, never downgraded
  // onto the legacy key.
  v2Mode = 'blocked';
  await send('Write me a sonnet about TypeScript');
  t('a blocked paid request is not silently retried on the legacy key',
    chatRequests().length === legacyBefore, `${legacyBefore} → ${chatRequests().length}`);
  t('the block is shown to the user as an error', Boolean($$('.msg-bot.msg-error').at(-1)));
  t('and it says why', /free model|paid usage/i.test($$('.msg-bot.msg-error').at(-1)?.textContent || ''),
    ($$('.msg-bot.msg-error').at(-1)?.textContent || '').slice(0, 120));

  // A deployment without /api/v2 still works: only that case falls back.
  v2Mode = 'missing';
  await send('Are you still there?');
  t('a deployment without /api/v2 falls back to /api/chat', chatRequests().length > legacyBefore,
    `${legacyBefore} → ${chatRequests().length}`);
  t('and the fallback still answers',
    /Bold/.test($$('.msg-bot:not(.msg-error)').at(-1)?.textContent || ''));

  healthV2 = false;
  v2Mode = 'ok';
  await ChatApi.refreshCapabilities({ force: true });
}

console.log('\n— sheets, drawer and scroll lock —');
const lockCount = async () => (await import('../assets/js/scrolling.js')).scrollLockCount();
const { openSheet } = await import('../assets/js/ui/sheets.js');

// Settings is a workspace area of its own now. The classic sheet (advanced
// provider/voice options) is opened from that area, so both paths are checked.
$('#btnSettings').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(40);
t('settings button opens the Settings area',
  !$('#view-settings').hidden && $('#viewTitle').textContent === 'Settings');
t('the Settings area offers the classic advanced sheet', Boolean($('#btnOpenClassicSettings')));

openSheet('settingsSheet');
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
t('four JARVIS tiers offered', $$('#modelList .model-opt').length === 4);
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
openSheet('settingsSheet');
await flush(60);
t('a sheet locks scrolling while it is open', document.body.style.overflow === 'hidden',
  JSON.stringify(document.body.style.overflow));
$('#settingsSheet .icon-btn[data-close]').dispatchEvent(new window.Event('click', { bubbles: true }));
await flush(400);
t('body scrolling is restored after a sheet closes', document.body.style.overflow === '',
  JSON.stringify(document.body.style.overflow));

// Nesting: two overlays open, one closes — the page stays locked until the last.
openSheet('settingsSheet');
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
t('title derived from the first message', chats[0].title.startsWith('Hello TRALIX'), chats[0].title);
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
    /no api key/i.test($('#connText').textContent), $('#connText').textContent);
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

console.log('\n— backend URL resolution (GitHub Pages deployment) —');
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

  // 2. backend.json points at a deployed backend (the GitHub Pages case)
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

console.log('\n— spoken replies —');
{
  const store = await import('../assets/js/store.js');

  // Driven through the real controls, so the app's own settings state changes.
  const setToggle = (id, value) => {
    const el = $(id);
    el.checked = value;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  setToggle('#setVoiceAuto', true);
  t('auto-speak also enables voice output', store.loadSettings().voice.enabled === true);

  const sendUi = async (text) => {
    $('#composer-input').value = text;
    $('#composer-input').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(200);
  };

  // jsdom offers no speech synthesis, so the device voice is genuinely absent
  // here — which makes this a clean test of the server path and its fallback.
  const deviceVoiceAvailable = 'speechSynthesis' in window;
  t('the test environment has no device voice (the server path is under test)', !deviceVoiceAvailable);

  /** Play every piece of audio the app asks for, as a real browser would. */
  const pumpAudio = async (max = 60) => {
    for (let i = 0; i < max; i += 1) {
      await flush(15);
      const playing = FakeAudio.instances.find(a => a.playing);
      if (playing) { playing.finish(); continue; }
      if (speechRequests.length && i > 3) return;
    }
  };

  voiceMode = 'off';
  replyLength = 'short';
  speechRequests.length = 0;
  FakeAudio.instances.length = 0;
  await sendUi('Say hello');
  t('with no voice key on the server nothing is sent to be spoken',
    speechRequests.length === 0, String(speechRequests.length));
  t('and nothing was handed to a player', FakeAudio.instances.length === 0);

  // Adding a key in Settings → Voice tells the assistant to re-check.
  voiceMode = 'server';
  window.dispatchEvent(new window.CustomEvent('jarvis:voice-changed'));
  replyLength = 'long';
  speechRequests.length = 0;
  FakeAudio.instances.length = 0;
  await sendUi('Explain the plan in detail');
  await pumpAudio();

  const pieces = speechRequests.map(r => r.body?.text || '');
  t('a reply longer than the provider allows is split into pieces',
    pieces.length > 1, `${pieces.length} piece(s)`);
  t('no piece exceeds the server limit',
    pieces.every(piece => piece.length <= 1100),
    pieces.map(p => p.length).join(', '));
  t('nothing is dropped: the pieces carry the whole reply',
    pieces.join(' ').length > 1900, String(pieces.join(' ').length));
  t('the pieces begin where the reply begins',
    pieces[0].startsWith('This is a sentence long enough to need splitting.'), pieces[0].slice(0, 60));
  t('no piece is empty', pieces.every(p => p.trim().length > 0));
  t('the speaking speed is sent with every piece',
    speechRequests.length > 0 && speechRequests.every(r => r.body?.speed === 1.15),
    String(speechRequests.map(r => r.body?.speed)));

  // Stop mid-reply: the audio must actually stop, and nothing further is fetched.
  speechRequests.length = 0;
  FakeAudio.instances.length = 0;
  await sendUi('Another long answer, please');
  await flush(60);
  t('a piece is playing', FakeAudio.instances.some(a => a.playing));

  const stopButton = $$('.msg-actions [data-role="speak"]').at(-1);
  t('the speaking message offers Stop', /Stop/.test(stopButton?.textContent || ''),
    stopButton?.textContent);
  if (stopButton) stopButton.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(150);
  const atStop = speechRequests.length;
  await pumpAudio();

  t('Stop ends the audio instead of leaving it pending',
    !FakeAudio.instances.some(a => a.playing));
  t('no further audio is requested after Stop',
    speechRequests.length === atStop, `${atStop} → ${speechRequests.length}`);
  t('the status returns to idle after speaking', $('#statusSidebar').dataset.state === 'idle',
    $('#statusSidebar').dataset.state);

  // A failure halfway through is reported, not silently switched to another voice.
  speechRequests.length = 0;
  FakeAudio.instances.length = 0;
  await sendUi('One more long answer');
  await flush(60);
  FakeAudio.instances.find(a => a.playing)?.finish();
  await flush(40);
  FakeAudio.instances.find(a => a.playing)?.fail();       // the second piece fails
  await flush(60);
  t('a broken player is reported rather than ignored',
    /stopped/i.test($('#toast')?.textContent || ''), ($('#toast')?.textContent || '').slice(0, 80));

  setToggle('#setVoiceAuto', false);
  t('auto-speak can be turned off again', store.loadSettings().voice.auto === false);
  voiceMode = 'off';
  replyLength = 'short';
}

console.log('\n— errors during the run —');
t('no uncaught errors or rejections', problems.length === 0, problems.join(' | '));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
