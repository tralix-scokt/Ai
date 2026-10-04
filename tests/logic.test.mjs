/* ==========================================================================
   logic.test.mjs — run with:  node tests/logic.test.mjs   (or npm test)

   Covers the pure logic that the UI depends on: markdown + highlighting safety,
   the TRALIX personality and memory extraction, the model tier system, storage
   and its migration from the previous Jarvis build, the tool layer, and the
   mobile scroll/viewport contract.

   No dependencies, no test framework.
   ========================================================================== */

/* --------------------------- browser stubs -------------------------------- */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.window = globalThis.window || { visualViewport: null };
if (!globalThis.navigator?.onLine) {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, language: 'en-GB' },
      configurable: true,
    });
  } catch { /* newer Node exposes a read-only navigator — the real one is fine */ }
}

const { renderMarkdown, stripMarkdown, toCopyText } = await import('../assets/js/markdown.js');
const { highlight, normaliseLang } = await import('../assets/js/highlight.js');
const { isNearBottom, bindVisualViewport, acquireScrollLock, releaseScrollLock, scrollLockCount, forceReleaseScrollLock } = await import('../assets/js/scrolling.js');
const { MODELS, modelById, normaliseModelId, applyServerMapping, resolvedSummary } = await import('../assets/js/models.js');
const { buildSystemPrompt, extractMemoryCandidates, isRememberRequest, PERSONALITIES } = await import('../assets/js/personality.js');
const { TOOLS, evaluateExpression, needsLiveInfo, applyServerTools, availableTools } = await import('../assets/js/tools.js');
const { evaluateExpression: _eval } = await import('../assets/js/tools.js');
const { chunkText, estimatedSpeechSeconds } = await import('../assets/js/voice.js');
const Store = await import('../assets/js/store.js');
const { activeTransport, buildMessages, transportLabel } = await import('../assets/js/api/chat.js');
const { TralixError, toTralixError, codeFromStatus, ERROR_CODES, errorLabel } = await import('../assets/js/errors.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
};

/* ================================ markdown ================================ */
console.log('\n— markdown —');
const md1 = renderMarkdown('**bold** and *italic* and `code`');
t('bold / italic / inline code',
  md1.includes('<strong>bold</strong>') && md1.includes('<em>italic</em>') && md1.includes('<code>code</code>'), md1);
t('inline code is not italicised',
  renderMarkdown('`a_b_c`').includes('<code>a_b_c</code>'), '');

const md2 = renderMarkdown('```js\nconst x = 1 < 2;\n```');
t('fenced code block: escaped, labelled, copyable',
  md2.includes('&lt;') && md2.includes('class="code-block"') && md2.includes('data-copy-target="tralix-code-0"')
  && md2.includes('<span class="code-lang">js</span>') && !md2.includes('<script'), md2.slice(0, 200));
t('code body is syntax highlighted',
  md2.includes('tok-key') && md2.includes('tok-num'), '');
t('code content is never rendered as markup',
  renderMarkdown('```\n**not bold**\n```').includes('**not bold**'), '');

const md3 = renderMarkdown('# Title\n\n- one\n- two\n\n1. first\n2. second');
t('headings and lists',
  md3.includes('<h2>Title</h2>') && (md3.match(/<li>/g) || []).length === 4
  && md3.includes('<ol class="md-ol">'), md3);

t('task list items become checkboxes',
  renderMarkdown('- [x] done\n- [ ] todo').includes('type="checkbox"'), '');
t('markdown table wrapped for horizontal scroll',
  renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |').includes('<div class="table-wrap"><table>'), '');
t('blockquote', renderMarkdown('> quoted').includes('<blockquote>'), '');
t('horizontal rule', renderMarkdown('---').includes('<hr>'), '');

t('safe links get target=_blank',
  renderMarkdown('[click](https://ok.com)').includes('target="_blank"'), '');
t('javascript: urls are neutralised',
  !renderMarkdown('[evil](javascript:alert(1))').includes('javascript:alert'), '');
t('raw HTML from the model is escaped',
  !renderMarkdown('<script>alert(1)</script>').includes('<script>')
  && renderMarkdown('<img src=x onerror=alert(1)>').includes('&lt;img'), '');
t('iframe / object injection escaped',
  !renderMarkdown('<iframe src="x"></iframe>').includes('<iframe>'), '');
t('stripMarkdown removes emphasis for speech',
  stripMarkdown('**Hi** there').includes('Hi there'), '');
t('toCopyText keeps code but drops decoration',
  toCopyText('```js\nconst a = 1;\n```').includes('const a = 1;'), '');

console.log('\n— syntax highlighting —');
t('js keywords highlighted', highlight('const x = 1', 'js').includes('tok-key'), '');
t('python comments highlighted', highlight('# note\npass', 'python').includes('tok-com'), '');
t('unknown languages fall back safely', highlight('some text', 'klingon').length > 0, '');
t('html escape survives highlighting', (() => {
  const out = highlight('<b>x</b>', 'html');
  return out.includes('&lt;') && !out.includes('<b>') && out.includes('tok-tag');
})(), '');
t('highlighting never emits executable markup', (() => {
  const out = highlight('<script>alert(1)</script>', 'html');
  return !out.includes('<script>');
})(), '');
t('language aliases resolve', normaliseLang('typescript') === 'ts' && normaliseLang('bash') === 'sh', '');

/* ================================ identity =============================== */
console.log('\n— personality —');
const prompt = buildSystemPrompt({ personality: 'tralix', responseStyle: 'balanced', memory: '- [personal]\n- name is Tralix', userName: 'Tralix' });
t('TRALIX is the primary identity', prompt.includes('TRALIX AI'), '');
t('no Gemini/vendor identity in the prompt', !/gemini/i.test(prompt), '');
t('memory is injected when enabled', prompt.includes('[personal]') && prompt.includes('name is Tralix'), '');
t('user name injected', prompt.includes('Tralix'), '');
t('current date injected', /Current date:/.test(prompt), '');
t('filler enthusiasm is explicitly banned', /never open with filler/i.test(prompt), '');
t('no unresolved placeholders', !prompt.includes('{user'), '');
t('memory omitted when disabled',
  !buildSystemPrompt({ memory: 'secret', memoryEnabled: false }).includes('secret'), '');
t('JARVIS mode is an optional add-on',
  buildSystemPrompt({ personality: 'jarvis' }).includes('Mode: JARVIS')
  && buildSystemPrompt({ personality: 'jarvis' }).includes('TRALIX AI'), '');
t('custom persona replaces the default voice',
  buildSystemPrompt({ personality: 'custom', persona: 'Be terse.' }).startsWith('Be terse.'), '');
t('response style is applied',
  buildSystemPrompt({ responseStyle: 'concise' }).includes('Response style: concise'), '');
t('web-search awareness only when available',
  buildSystemPrompt({ hasWebSearch: true }).includes('web search tool is available')
  && !buildSystemPrompt({ hasWebSearch: false }).includes('web search tool is available'), '');
t('three personalities offered', PERSONALITIES.length === 3, '');

console.log('\n— memory extraction —');
t('"remember that my name is X"',
  /Tralix/i.test(extractMemoryCandidates('Remember that my name is Tralix').join(' ')), '');
t('name + location in one line', (() => {
  const r = extractMemoryCandidates('My name is Sarah and I live in Lagos').join(' ');
  return /Sarah/i.test(r) && /Lagos/i.test(r);
})(), '');
t('"call me X"', /Mike/i.test(extractMemoryCandidates('Call me Mike').join(' ')), '');
t('"I work as X"', /product designer/i.test(extractMemoryCandidates('I work as a product designer').join(' ')), '');
t('no false positives on a plain question',
  extractMemoryCandidates('What is the weather today?').length === 0, '');
t('remember requests are detected', isRememberRequest('Please remember that I use VS Code'), '');
t('ordinary messages are not treated as remember requests',
  !isRememberRequest('What is the fastest sorting algorithm?'), '');

/* ================================= models ================================ */
console.log('\n— model tier system —');
t('four TRALIX tiers', MODELS.length === 4 && MODELS.every(m => m.id.startsWith('tralix-')), '');
t('no vendor names in user-facing labels',
  MODELS.every(m => !/gemini|gpt|claude/i.test(m.label)), MODELS.map(m => m.label).join(', '));
t('legacy vendor model ids map onto tiers',
  normaliseModelId('gemini-2.5-pro') === 'tralix-research'
  && normaliseModelId('gpt-4o-mini') === 'tralix-fast'
  && normaliseModelId('claude-code') === 'tralix-code', '');
t('unknown ids fall back to the default', normaliseModelId('nonsense') === 'tralix-smart', '');
t('tier lookup never returns undefined', modelById('nope').id === 'tralix-smart', '');

applyServerMapping({ 'tralix-smart': { provider: 'openai', model: 'gpt-5.2' } });
t('server mapping is applied', resolvedSummary('tralix-smart').includes('gpt-5.2'), resolvedSummary('tralix-smart'));
t('unmapped tiers keep the documented fallback',
  resolvedSummary('tralix-fast').includes('fallback'), resolvedSummary('tralix-fast'));

/* ================================= store ================================= */
console.log('\n— storage & migration —');
t('legacy keys are read-only fallbacks, not the target',
  Store.legacyKeys.chats === 'jarvis.chats.v1' && Store.storageKeys.chats === 'tralix.chats.v2', '');

localStorage.setItem('jarvis.chats.v1', JSON.stringify([{ id: 'c1', title: 'Old chat', messages: [{ id: 'm1', role: 'user', text: 'hello', ts: 1 }] }]));
localStorage.setItem('jarvis.memory.v1', JSON.stringify([{ id: 'm1', text: 'my name is Tralix', ts: 2, source: 'auto' }]));
localStorage.setItem('jarvis.settings.v1', JSON.stringify({ apiKey: 'AIzaTEST', model: 'gemini-2.5-pro', theme: 'light', ttsAuto: true, voiceRate: 1.1, memAuto: true }));

const migration = Store.migrateLegacy();
t('migration reports what it moved', migration.migrated === true && migration.from === 'jarvis.v1', JSON.stringify(migration));
t('legacy conversations preserved',
  Store.loadChats()[0]?.title === 'Old chat' && Store.loadChats()[0]?.messages[0]?.text === 'hello', '');
t('legacy memories preserved and categorised',
  Store.loadMemory()[0]?.text === 'my name is Tralix' && Store.loadMemory()[0]?.category === 'personal', '');
t('legacy settings migrated into the new shape',
  Store.loadSettings().theme === 'light' && Store.loadSettings().voice.auto === true, JSON.stringify(Store.loadSettings().voice));
t('legacy vendor model mapped to a tier',
  Store.loadSettings().model === 'tralix-research', Store.loadSettings().model);
t('legacy device key moved to advanced/local transport',
  Store.loadSettings().advanced.apiKey === 'AIzaTEST' && Store.loadSettings().advanced.transport === 'local', '');
t('legacy keys are left untouched (rollback stays possible)',
  localStorage.getItem('jarvis.chats.v1') !== null && localStorage.getItem('jarvis.memory.v1') !== null, '');
t('second migration is a no-op', Store.migrateLegacy().migrated === false, '');

console.log('\n— memory safety —');
const safeAdd = Store.addMemory('Prefers dark mode and short answers');
t('memories are categorised', safeAdd?.category === 'preferences', safeAdd?.category);
t('duplicate memories are rejected',
  Store.addMemory('Prefers dark mode and short answers') === null, '');
t('sensitive content is refused', Store.addMemory('my card number is 4111 1111 1111 1111')?.refused === true, '');
t('api keys are refused', Store.addMemory(`my api key is ${'s' + 'k'}-abcdefghijklmnopqrstuvwx`)?.refused === true, '');
t('passwords are refused', Store.addMemory('the password is hunter2!')?.refused === true, '');
t('instructions are categorised', Store.addMemory('always answer in metric units')?.category === 'instructions', '');
Store.updateMemory(Store.loadMemory()[0].id, { text: 'Prefers dark mode' });
t('memories can be edited', Store.loadMemory().some(m => m.text === 'Prefers dark mode' && m.editedAt), '');
t('invalid edits are rejected', Store.updateMemory(Store.loadMemory()[0].id, { text: '   ' }) === null, '');
t('memory prompt groups by category', Store.memoryToPrompt().includes('[preferences]'), '');

console.log('\n— chats & search —');
const chatA = Store.newChat();
chatA.title = 'CODM loadout maths';
chatA.messages.push({ id: 'x1', role: 'user', text: 'best smg for close range in CODM', ts: Date.now() });
chatA.updatedAt = Date.now();
Store.upsertChat(chatA);
const chatB = Store.newChat();
chatB.title = 'Website review';
chatB.messages.push({ id: 'x2', role: 'user', text: 'the anime website hero section feels heavy', ts: Date.now() });
Store.upsertChat(chatB);

t('search finds by title', Store.searchChats('website').some(c => c.id === chatB.id), '');
t('search finds by message content', Store.searchChats('close range').some(c => c.id === chatA.id), '');
t('search returns snippets', (Store.searchSnippets.get(chatA.id) || '').includes('close range'), '');
t('search misses do not error', Store.searchChats('zzzznothing').length === 0, '');
t('titles are derived from the first message',
  Store.titleFrom('help me plan a trip to lagos').startsWith('Help me plan'), '');
t('pinning survives a save', (() => {
  Store.upsertChat({ ...chatA, pinned: true });
  return Store.getChat(chatA.id).pinned === true;
})(), '');

console.log('\n— export / import / wipe —');
const backup = Store.exportAll();
t('export never contains the provider key', backup.settings.advanced.apiKey === '', '');
t('export includes chats, memory and projects',
  Array.isArray(backup.chats) && Array.isArray(backup.memory) && Array.isArray(backup.projects), '');
const before = Store.loadChats().length;
Store.wipeAll({ keepAdvanced: true });
t('wipe clears conversations', Store.loadChats().length === 0, '');
t('wipe keeps the device key', Store.loadSettings().advanced.apiKey === 'AIzaTEST', '');
Store.importAll(backup);
t('import restores conversations', Store.loadChats().length === before, `${Store.loadChats().length} vs ${before}`);
t('import does not overwrite the device key', Store.loadSettings().advanced.apiKey === 'AIzaTEST', '');
t('import accepts a legacy Jarvis backup',
  Store.importAll({ app: 'jarvis', settings: { theme: 'dark' }, chats: [], memory: [] }) === true, '');

/* ================================= tools ================================= */
console.log('\n— tool layer —');
t('calculator evaluates correctly', evaluateExpression('2 + 3 * (4 - 1)') === 11, '');
t('calculator handles powers', evaluateExpression('2^10') === 1024, '');
t('calculator rejects code', (() => { try { _eval('process.exit(1)'); return false; } catch { return true; } })(), '');
t('current-information questions are detected',
  needsLiveInfo('what is the latest AI news today') && needsLiveInfo('current bitcoin price'), '');
t('ordinary questions are not flagged as live-data',
  !needsLiveInfo('explain closures in javascript'), '');
t('unavailable tools state why', TOOLS.filter(x => !x.available).every(x => x.unavailableReason), '');
t('no tool claims availability it does not have',
  TOOLS.some(x => x.id === 'calendar' && x.available === false), '');
applyServerTools(['web_search']);
t('backend can enable a server tool', availableTools().some(x => x.id === 'web_search'), '');
applyServerTools([]);
t('turning tools off is honoured', !availableTools().some(x => x.id === 'web_search'), '');

/* ============================== transport ================================ */
console.log('\n— transport —');
const backendSettings = { advanced: { transport: 'backend', apiKey: '' } };
const localSettings = { advanced: { transport: 'local', apiKey: 'sk-test' } };
t('backend is the default path', activeTransport(backendSettings) === 'backend', '');
t('local transport requires a key', activeTransport({ advanced: { transport: 'local', apiKey: '' } }) === 'backend', '');
t('local transport is used when configured', activeTransport(localSettings) === 'local', '');
t('transport label is user-facing', transportLabel(backendSettings) === 'TRALIX backend', transportLabel(backendSettings));
t('history trims hidden system turns correctly', (() => {
  const chat = { messages: [
    { role: 'assistant', text: 'stale reply' },
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi' },
    { role: 'user', text: 'more', hidden: true },
  ] };
  const built = buildMessages(chat);
  return built.length === 3 && built[0].role === 'user';
})(), '');
t('empty messages are dropped', buildMessages({ messages: [{ role: 'user', text: '   ' }] }).length === 0, '');

console.log('\n— errors —');
t('network failures map to a friendly code',
  toTralixError(new TypeError('Failed to fetch')).code === ERROR_CODES.network, '');
t('aborts are recognised', toTralixError(Object.assign(new Error('x'), { name: 'AbortError' })).code === ERROR_CODES.aborted, '');
t('429 maps to rate limiting', codeFromStatus(429) === ERROR_CODES.rate_limit, '');
t('401 maps to authorisation', codeFromStatus(401) === ERROR_CODES.unauthorized, '');
t('5xx maps to provider unavailable', codeFromStatus(503) === ERROR_CODES.provider_unavailable, '');
t('retryable flags are sensible',
  new TralixError(ERROR_CODES.rate_limit).retryable === true
  && new TralixError(ERROR_CODES.unauthorized).retryable === false, '');
t('labels are human readable', errorLabel(ERROR_CODES.invalid_config) === 'Not configured', '');
t('errors never leak a stack trace to the UI',
  !new TralixError(ERROR_CODES.unknown).message.includes('at '), '');

console.log('\n— voice text handling —');
t('short text stays a single utterance', chunkText('Hello there.').length === 1, '');
t('long text is chunked for iOS', (() => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} with a few extra words.`).join(' ');
  const chunks = chunkText(long);
  return chunks.length > 1 && chunks.every(c => c.length <= 260);
})(), '');
t('speech duration is estimated', estimatedSpeechSeconds('one two three four five six', 1) >= 1, '');

/* ============================== scrolling ================================ */
console.log('\n— chat scrolling —');
const scroller = { scrollHeight: 900, scrollTop: 600, clientHeight: 300 };
t('detects a chat already at the bottom', isNearBottom(scroller), '');
scroller.scrollTop = 400;
t('does not treat an older position as the bottom', !isNearBottom(scroller), '');
scroller.scrollTop = 600;

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
const appStyle = {
  style: {
    height: '',
    transform: '',
    props: {},
    setProperty(name, value) { this.props[name] = value; },
  },
};
const scheduledFrames = [];
const bottomScrolls = [];
const unbind = bindVisualViewport({
  app: appStyle,
  chat: scroller,
  visualViewport,
  scrollToBottom: (instant) => bottomScrolls.push(instant),
  scheduleFrame: (cb) => scheduledFrames.push(cb),
});
t('fits the app to the visual viewport', appStyle.style.height === '800px' && appStyle.style.props['--vvh'] === '800px', appStyle.style.height);
t('initial fit does not scroll unnecessarily', scheduledFrames.length === 0, '');
visualViewport.height = 520;
visualViewport.emit('resize');
t('keyboard opening resizes the app (100dvh-safe)', appStyle.style.height === '520px', appStyle.style.height);
t('a bottom-following reader is kept in place', scheduledFrames.length === 1, '');
scheduledFrames.shift()();
t('correction after resize is instant', bottomScrolls[0] === true, '');

scroller.scrollTop = 100;
visualViewport.height = 800;
visualViewport.emit('resize');
t('a reader scrolled up is never yanked down', scheduledFrames.length === 0, '');
visualViewport.offsetTop = 18;
visualViewport.emit('scroll');
t('tracks a shifted visual viewport', appStyle.style.transform === 'translateY(18px)', appStyle.style.transform);
unbind();
t('listeners are removed on cleanup',
  visualViewport.listenerCount('resize') === 0 && visualViewport.listenerCount('scroll') === 0, '');

console.log('\n— scroll lock —');
t('lock is off to begin with', scrollLockCount() === 0, '');
acquireScrollLock();
acquireScrollLock();
t('nested overlays share one lock', scrollLockCount() === 2, String(scrollLockCount()));
releaseScrollLock();
t('the lock survives the first close', scrollLockCount() === 1, String(scrollLockCount()));
releaseScrollLock();
t('the lock is released with the last close', scrollLockCount() === 0, '');
acquireScrollLock();
forceReleaseScrollLock();
t('the safety valve always frees the page', scrollLockCount() === 0, '');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
