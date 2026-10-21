/* ==========================================================================
   studio.test.mjs — the JARVIS STUDIO workspace layer.

   Boots the real index.html in jsdom against a mocked /api/v2 backend and
   checks the things the workspace promises:

     • five areas, one of them visible at a time, all of them kept alive
     • every number on screen comes from the server, or says it is missing
     • a coding task is never started without a repository, and the launcher
       says which repository it will use
     • paid usage stays blocked until a ceiling is set
     • the orb and the status indicator are driven by one state

   Requires jsdom (dev only):   npm install --no-save jsdom
   Run:                          node tests/studio.test.mjs
   ========================================================================== */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);

async function loadJsdom() {
  for (const attempt of [
    () => import('jsdom'),
    () => req('jsdom'),
    () => req('/tmp/node_modules/jsdom'),
    () => req(path.join(process.env.HOME || '/root', 'node_modules', 'jsdom')),
  ]) {
    try {
      const mod = await attempt();
      if (mod?.JSDOM) return mod;
    } catch { /* try the next location */ }
  }
  return null;
}

const jsdomMod = await loadJsdom();
if (!jsdomMod) {
  console.log('\n⚠️  jsdom is not installed — skipping the studio workspace test.');
  console.log('   npm install --no-save jsdom && node tests/studio.test.mjs\n');
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
const dom = new JSDOM(html, { url: 'https://example.test/Ai/', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;

window.visualViewport = { height: 900, offsetTop: 0, width: 1440, addEventListener() {}, removeEventListener() {} };
window.matchMedia = (query) => {
  const max = /max-width:\s*(\d+)px/.exec(query);
  const min = /min-width:\s*(\d+)px/.exec(query);
  const matches = max ? 1440 <= Number(max[1]) : min ? 1440 >= Number(min[1]) : false;
  return {
    matches, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  };
};

for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'DOMParser']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true });
Object.defineProperty(globalThis, 'matchMedia', { value: window.matchMedia.bind(window), configurable: true });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;

/* -------------------------------- the backend ----------------------------- */
/** What the mocked server answers. Every field here mirrors server/routes.js. */
const server = {
  providers: [
    {
      id: 'gemini', label: 'Google Gemini', kind: 'free', protocol: 'gemini', freeTier: true,
      configured: true, enabled: true, verified: true, status: 'ok', priority: 10,
      keySource: 'env', keyHint: 'GEM…4f2a', modelCount: 4,
      models: { fast: 'gemini-2.5-flash-lite', smart: 'gemini-2.5-flash', code: 'gemini-2.5-flash', research: 'gemini-2.5-pro' },
      modelStatus: { smart: { verified: true } },
      latencyMs: 240, checkedAt: new Date().toISOString(),
      docsUrl: 'https://ai.google.dev/', note: 'Generous free tier.',
      capabilities: ['chat'],
    },
    {
      id: 'groq', label: 'Groq', kind: 'free', protocol: 'openai', freeTier: true,
      configured: false, enabled: true, verified: false, status: 'unconfigured', priority: 20,
      models: {}, modelStatus: {}, message: 'No API key found. Set GROQ_API_KEY on the server.',
      capabilities: ['chat'],
    },
    {
      id: 'openai', label: 'OpenAI', kind: 'paid', protocol: 'responses', freeTier: false,
      configured: true, enabled: true, verified: true, status: 'ok', priority: 60,
      keySource: 'env', keyHint: 'sk-…9c1d', models: { smart: 'gpt-5' }, modelStatus: {},
      paidAllowed: true, capabilities: ['chat'],
    },
  ],
  policy: { mode: 'free-first', paidFallback: false, monthlyLimitUsd: 0, limitSource: 'settings', preferProvider: '', reviewWithSecondModel: true, allowParallelModels: false },
  usage: { period: '2026-10', since: new Date().toISOString(), providers: {}, paidRequests: 0, estimatedUsd: 0 },
  github: { configured: false, connected: false, mode: 'pat', login: '', message: 'No GitHub credential configured. Set GITHUB_TOKEN on the backend.', selectedRepo: '', selectedBranch: '' },
  sandbox: { available: true, driver: 'process', node: true, allowlist: ['node', 'npm'], wrappers: { prlimit: true, unshare: false, docker: false }, notes: [], recommendation: 'Set JARVIS_SANDBOX_DRIVER=docker for true isolation.', configured: { driver: 'process', network: 'off', timeoutMs: 180000, memoryMb: 512 } },
  voice: { provider: 'fish-audio', configured: false, keySource: '', keyHint: '', model: 's2-pro', voiceId: '', format: 'mp3', maxChars: 1200, note: 'Not configured.' },
  tasks: [],
  env: [
    { name: 'GEMINI_API_KEY', purpose: 'Google Gemini — free tier.', secret: true, set: true },
    { name: 'GROQ_API_KEY', purpose: 'Groq — free tier.', secret: true, set: false },
    { name: 'GITHUB_TOKEN', purpose: 'Repository access.', secret: true, set: false },
  ],
  settings: { routing: null, tasks: { autonomy: 'branch', branchPrefix: 'jarvis/', runChecks: true, repair: true }, sandbox: { driver: 'process', network: 'off', timeoutMs: 180000, memoryMb: 512 }, voice: { enabled: false, auto: false, rate: 1 } },
};

const calls = [];
let reachable = true;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = () => json({ error: { code: 'not_found', message: 'Not found' } }, 404);

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  calls.push(target);

  if (!reachable) throw new TypeError('Failed to fetch');
  if (target.includes('backend.json')) return json({ url: '' });

  /* legacy endpoints the app still uses for the connection state */
  if (target.includes('/api/health')) {
    return json({
      ok: true, status: 'ok', reachable: true, configured: true, verified: true,
      provider: 'openai', model: 'gpt-5', tools: [],
      features: { webSearch: false, attachments: false, multiProviderRouting: true },
      jarvis: { api: '/api/v2', studio: true },
    });
  }
  if (target.includes('/api/models')) return json({ models: {} });

  /* /api/v2 */
  if (target.includes('/v2/health')) {
    return json({
      ok: true, storage: 'file',
      ready: { free: true, paid: false, github: false, sandbox: true, voice: false },
      providers: { policy: server.policy, usage: server.usage, providers: server.providers },
      github: server.github, sandbox: server.sandbox, voice: server.voice,
      tasks: { active: 0, last: null },
    });
  }
  if (target.includes('/v2/tasks')) return json({ tasks: server.tasks });
  if (target.includes('/v2/providers')) return json({ policy: server.policy, usage: server.usage, providers: server.providers });
  if (target.includes('/v2/routing')) {
    return json({
      policy: server.policy, usage: server.usage,
      eligible: server.providers.filter(p => p.verified),
      blocked: [{ id: 'openai', label: 'OpenAI', reasons: ['paid usage not authorised'] }],
      catalog: server.providers,
    });
  }
  if (target.includes('/v2/github/status')) return json(server.github);
  if (target.includes('/v2/sandbox/status')) return json(server.sandbox);
  if (target.includes('/v2/voice/status')) return json(server.voice);
  if (target.includes('/v2/env')) return json({ variables: server.env, storage: 'file' });
  if (target.includes('/v2/settings')) return json({ settings: server.settings, storage: 'file', security: { writeTokenRequired: false, redaction: true, secretsInClient: false } });

  return notFound();
};

/* ---------------------------------- boot ---------------------------------- */
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));

console.log('\n— boot —');
await import('../assets/js/app.js');
await flush(400);

const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const text = (sel) => ($(sel)?.textContent || '').replace(/\s+/g, ' ').trim();

t('app is revealed', $('#app') && !$('#app').hidden);
t('the workspace has five areas', $$('#workspace .view').length === 5, String($$('#workspace .view').length));
t('the rail lists the same five areas', $$('#railNav .rail-item').length === 5);
t('the mobile bar lists the same five areas', $$('#tabbar .tab-item').length === 5);

/* ------------------------------ navigation -------------------------------- */
console.log('\n— areas —');
const visibleAreas = () => $$('#workspace .view').filter(v => !v.hidden);
const go = async (view) => {
  $(`[data-view="${view}"]`).dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(80);
};

t('the Assistant is the default area', visibleAreas().length === 1 && !$('#view-assistant').hidden,
  visibleAreas().map(v => v.id).join(','));
t('the title names the area', text('#viewTitle') === 'JARVIS Assistant', text('#viewTitle'));

await go('home');
t('Home replaces the Assistant', !$('#view-home').hidden && $('#view-assistant').hidden);
t('only one area is visible at a time', visibleAreas().length === 1);
t('the switched-away area is kept in the DOM', Boolean($('#view-assistant')));
t('the title follows the area', text('#viewTitle') === 'Overview', text('#viewTitle'));
t('the area is remembered for next time',
  JSON.parse(window.localStorage.getItem('tralix.settings.v2') || '{}').view === 'home');

/* --------------------------------- Home ----------------------------------- */
console.log('\n— Home reads the real state —');
t('the system cards came from /api/v2/health', $$('#statGrid .stat').length >= 5,
  String($$('#statGrid .stat').length));
t('the free-model card counts what is verified', /1 ready/.test(text('#statGrid')), text('#statGrid').slice(0, 120));
t('paid usage is reported as blocked, not authorised', /Blocked by default/.test(text('#statGrid')));
t('GitHub is reported as not connected', /Not connected/.test(text('#statGrid')));
t('the sandbox says which isolation it has', /Process sandbox only/.test(text('#statGrid')));
t('voice is reported as off', /Spoken replies off/.test(text('#statGrid')));
t('the setup checklist is shown', !$('#setupCard').hidden);
t('the checklist asks for what is actually missing', /GitHub/.test(text('#setupList')), text('#setupList').slice(0, 120));
t('and does not ask again for a provider that already works',
  !/Add at least one AI provider key/.test(text('#setupList')));
t('recent tasks has an honest empty state', /No coding tasks yet/.test(text('#recentTasks')));
t('recent conversations has its own empty state', /No conversations yet/.test(text('#recentChats')));

/* -------------------------------- Models ---------------------------------- */
console.log('\n— AI Models —');
await go('models');
t('the provider grid is rendered from the server list', $$('#providerGrid .provider-card').length === 3,
  String($$('#providerGrid .provider-card').length));
t('a verified provider is marked ready', /Ready/.test($('#providerGrid').textContent));
t('an unconfigured provider says so, instead of faking a status',
  /No API key found/.test($('#providerGrid').textContent));
t('the readiness badge counts only verified providers', text('#providersBadge') === '2 of 3 ready', text('#providersBadge'));
t('the key is never shown, only a hint', !/AIza|sk-[A-Za-z0-9]{8}/.test($('#providerGrid').textContent),
  'a full key leaked into the provider grid');
t('the paid provider is blocked until authorised', /paid usage not authorised/.test(text('#blockedList')));
t('usage is reported as empty, not invented', /Nothing used yet/.test(text('#usageTable')));
t('the routing mode is free-first', $('#routingMode')?.value === 'free-first', $('#routingMode')?.value);

/* -------------------------------- Settings -------------------------------- */
console.log('\n— Settings —');
await go('settings');
t('the environment report is rendered', $$('#envList tr, #envList li, #envList .env-row').length > 0 || text('#envList').length > 20,
  text('#envList').slice(0, 80));
t('missing variables are named', /GROQ_API_KEY|GITHUB_TOKEN/.test(text('#envList')));
t('the sandbox report is rendered', /process|docker/i.test(text('#sandboxReport')));
t('the voice report separates speech out from speech in',
  /Spoken replies/.test(text('#voiceReport')) && /Speech recognition/.test(text('#voiceReport')),
  text('#voiceReport').slice(0, 140));
t('the classic advanced sheet is still reachable', Boolean($('#btnOpenClassicSettings')));

/* ------------------------------- Projects --------------------------------- */
console.log('\n— Projects —');
await go('projects');
t('GitHub is reported as not connected', /Not connected/.test(text('#githubBadge')), text('#githubBadge'));
t('the reason is shown, not hidden', /No GitHub credential|GITHUB_TOKEN/.test(text('#githubNote')), text('#githubNote'));
t('the repository list has an honest empty state', /Connect GitHub to see your repositories/.test(text('#repoList')));
t('no repository is selected yet', /No repository selected/.test(text('#selectedRepoChip')));

/* ------------------------------ task launcher ----------------------------- */
console.log('\n— coding tasks —');
await go('assistant');
t('the launcher says no repository is selected', /No repository selected/.test(text('#taskLauncherHint')),
  text('#taskLauncherHint'));

$('#taskMode').checked = true;
$('#taskMode').dispatchEvent(new window.Event('change', { bubbles: true }));
$('#composer-input').value = 'Add input validation to the signup form';
$('#composer-input').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await flush(120);

t('a coding task without a repository is refused, not invented',
  $$('#view-projects').length === 1 && !$('#view-projects').hidden);
t('the composer text is kept for the user', $('#composer-input').value.includes('input validation'));

/* ---------------------------------- orb ----------------------------------- */
console.log('\n— orb and status —');
const { setOrbState } = await import('../assets/js/ui/orb.js');
setOrbState('thinking');
await flush(20);
t('the orb follows one state', $('#orbHome')?.dataset.state === 'thinking', $('#orbHome')?.dataset.state);
t('the assistant orb follows the same state', $('#orbAssistant')?.dataset.state === 'thinking');
t('the orb label is announced', text('#orbStateText').length > 0, text('#orbStateText'));
setOrbState('idle');
await flush(20);
t('returning to idle is possible', $('#orbHome')?.dataset.state === 'idle');

/* ---------------------------- backend unreachable -------------------------- */
console.log('\n— honest failure state —');
reachable = false;
await go('home');
await flush(200);
t('an unreachable backend is reported as unreachable', /Unreachable/i.test(text('#statGrid')),
  text('#statGrid').slice(0, 140));
t('the failure offers a retry', Boolean($('#statGrid [data-retry]')));
t('the greeting stops implying the workspace is ready', /Backend unreachable/i.test(text('#homeGreeting')),
  text('#homeGreeting'));
t('no fake numbers survive the failure', !/ready/i.test(text('#statGrid')));

console.log('\n— errors during the run —');
t('no uncaught errors or rejections', problems.length === 0, problems.join(' | '));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
