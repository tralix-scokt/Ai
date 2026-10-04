/* ==========================================================================
   app.js — TRALIX AI boot and wiring.

   This file only assembles modules: state, persistence, transport, voice and
   the UI pieces live in their own files. Nothing here talks to a provider
   directly — that is api/chat.js's job.
   ========================================================================== */

import { $, copyText, haptic } from './util.js';
import { APP, apiBase, apiBaseSource, loadBackendConfig } from './config.js';
import * as Store from './store.js';
import * as Api from './api/chat.js';
import * as Voice from './voice.js';
import { bindVisualViewport, forceReleaseScrollLock, scrollToEnd, isNearBottom } from './scrolling.js';
import { TOOLS } from './tools.js';
import { modelLabel } from './models.js';

import { initSheets, openSheet, closeSheet } from './ui/sheets.js';
import { initToast, toast } from './ui/feedback.js';
import { initStatus, setStatus, setError } from './ui/status.js';
import { createSidebar } from './ui/sidebar.js';
import { createSearch } from './ui/search.js';
import { createMemoryManager } from './ui/memory.js';
import { createProjects } from './ui/projects.js';
import { createModelPicker } from './ui/models.js';
import { createSettings } from './ui/settings.js';
import { createComposer } from './ui/composer.js';
import { createChatController } from './ui/chat.js';

/* ================================= state ================================= */
const state = {
  settings: Store.loadSettings(),
  chat: null,
  health: null,
  healthAt: 0,
};

const el = {
  app: $('#app'),
  boot: $('#boot'),
  chatScroll: $('#chatScroll'),
};

/* ================================ theming ================================= */
function applyTheme() {
  const pref = state.settings.theme;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (meta.getAttribute('media')) continue;
    meta.setAttribute('content', theme === 'dark' ? '#0a0b0f' : '#ffffff');
  }
}

function applyDensity() {
  document.documentElement.dataset.density = state.settings.density || 'comfortable';
}

function applyLanguage() {
  const lang = state.settings.language;
  document.documentElement.lang = !lang || lang === 'system' ? 'en' : lang;
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings.theme === 'system') applyTheme();
});

const saveSettings = (settings) => Store.saveSettings(settings);

function persistChat() {
  if (!state.chat) return;
  state.chat.updatedAt = Date.now();
  Store.upsertChat(state.chat);
}

/* ================================= voice ================================== */
const listener = new Voice.Listener({
  onResult: (text) => {
    setStatus('listening');
    $('#voiceLabel').textContent = text ? text : 'Listening…';
  },
  onError: (message) => {
    toast(message, { tone: 'error', ms: 4200 });
    setVoiceBar(null);
    setStatus('idle');
  },
  onStart: () => {
    setVoiceBar({ state: 'listening', label: 'Listening…', hint: 'tap the mic again to stop' });
  },
  onEnd: (finalText) => {
    setVoiceBar(null);
    setStatus('idle');
    composer.setRecording(false);
    if (finalText && finalText.trim().length > 1) {
      composer.setValue(finalText.trim(), { focus: false });
      composer.el.form.requestSubmit();
    } else {
      toast('Did not catch that — try again', { ms: 2000 });
    }
  },
});

let listening = false;

function toggleListening() {
  if (!Voice.sttSupported) {
    toast('Voice input needs Safari on iPhone or Chrome on Android.', { ms: 3600, tone: 'error' });
    return;
  }
  if (listening) {
    listener.stop();
    listening = false;
    composer.setRecording(false);
    setVoiceBar(null);
    return;
  }
  Voice.stopSpeaking();
  chat.stopSpeaking();
  listening = true;
  composer.setRecording(true);
  haptic(12);
  listener.start();
}

function setVoiceBar(info) {
  const bar = $('#voiceState');
  if (!info) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#statusVoice').dataset.state = info.state || 'listening';
  $('#voiceLabel').textContent = info.label || 'Listening…';
  $('#voiceHint').textContent = info.hint || '';
}

/* ============================== components =============================== */
const memoryManagerSettings = createMemoryManager($('#memManagerSettings'), {
  onChange: () => { memoryManagerSheet.refresh(); sidebar.refreshCounts(); },
});
const memoryManagerSheet = createMemoryManager($('#memManagerSheet'), {
  onChange: () => { memoryManagerSettings.refresh(); sidebar.refreshCounts(); },
});

const modelPicker = createModelPicker({
  getSettings: () => state.settings,
  getHealth: () => state.health,
  onSelect: () => {
    saveSettings(state.settings);
    updateModelChip();
    chat.render();
  },
});

const settingsUi = createSettings({
  getSettings: () => state.settings,
  saveSettings,
  onTheme: applyTheme,
  onDensity: applyDensity,
  onHaptics: () => {},
  onModelChanged: () => { updateModelChip(); chat.render(); settingsUi.refresh(); },
  onVoiceChanged: () => {},
  onMemoryChanged: () => { sidebar.refreshCounts(); },
  onChatsChanged: () => { sidebar.render(); sidebar.refreshCounts(); },
  onDataReplaced: () => {
    state.settings = Store.loadSettings();
    applyTheme(); applyDensity(); applyLanguage();
    state.chat = Store.loadChats()[0] || Store.newChat();
    chat.render(); sidebar.render(); sidebar.refreshCounts();
    memoryManagerSettings.refresh(); memoryManagerSheet.refresh();
    settingsUi.refresh();
  },
  getHealth: () => state.health,
  refreshHealth: async ({ force = true, probe = false } = {}) => {
    const health = await refreshHealth({ force, probe });
    modelPicker.render();
    return health;
  },
  getBackendInfo: () => ({ base: apiBase(), source: apiBaseSource() }),
  openConnect: () => openConnect(),
  memoryManager: memoryManagerSettings,
  modelPicker,
});

const sidebar = createSidebar({
  getSettings: () => state.settings,
  saveSettings,
  getChat: () => state.chat,
  onOpenChat: (id) => chat.openChat(id),
  onNewChat: () => chat.newChat(),
  onOpenSearch: () => search.open(),
  onOpenProjects: () => { projects.render(); openSheet('projectsSheet'); },
  onOpenMemory: () => { memoryManagerSheet.refresh(); openSheet('memorySheet'); },
  onOpenSettings: () => settingsUi.open('general'),
  onOpenConnect: () => openConnect(),
  onChatsChanged: () => { sidebar.render(); sidebar.refreshCounts(); },
  onOpenModel: () => modelPicker.open(),
  getModelLabel: () => modelLabel(state.settings.model),
});

const search = createSearch({ onOpenChat: (id) => chat.openChat(id) });

const projects = createProjects({
  onOpenChat: (id) => { chat.openChat(id); closeSheet('projectsSheet'); },
  onChanged: () => { sidebar.render(); sidebar.refreshCounts(); },
});

const composer = createComposer({
  onSubmit: (text) => chat.send(text),
  onStop: () => chat.stopStreaming(),
  onMic: () => toggleListening(),
  onAttach: () => openAttachments(),
});

const chat = createChatController({
  getSettings: () => state.settings,
  getChat: () => state.chat,
  setChat: (value) => { state.chat = value; },
  persist: persistChat,
  onChatsChanged: () => { sidebar.render(); },
  composer,
  onOpenSettings: (tab) => settingsUi.open(tab),
  onOpenConnect: () => openConnect(),
  onMemoryChanged: () => { sidebar.refreshCounts(); memoryManagerSettings.refresh(); },
  getHealth: () => state.health,
  onSpeakingChange: () => {},
  // A completed round-trip is the strongest possible proof of a working
  // connection, so it updates the reported state immediately.
  onRequestSucceeded: () => {
    if (!state.health?.ok) refreshHealth({ force: true });
    else state.healthAt = Date.now();
  },
});

/* ============================== chrome bits ============================== */
$('#btnModel')?.addEventListener('click', () => modelPicker.open());
$('#btnNavModel')?.addEventListener('click', () => modelPicker.open());

function updateModelChip() {
  const label = modelLabel(state.settings.model);
  const chip = $('#chipLabel');
  if (chip) chip.textContent = label;
  const nav = $('#navModelLabel');
  if (nav) nav.textContent = label;
}

/**
 * Connection state is separate from the activity indicator: the ring shows what
 * TRALIX is doing right now, `connText` says whether a backend is actually able
 * to answer. Six honest states — never a vague "offline" when the truth is
 * "the server has no key".
 */
export const CONNECTION_TEXT = {
  checking: 'Checking backend…',
  ready: 'TRALIX backend · connected',
  busy: 'TRALIX backend · rate limited',
  unconfigured: 'Backend has no API key',
  unauthorized: 'Backend key rejected',
  unreachable: 'Backend unreachable',
  upstream: 'AI service unreachable',
  local: 'Device-only key',
};

/** Reduce a health report to one of the connection states above. */
export function connectionState(health) {
  if (!health) return 'checking';
  if (health.reachable === false) return 'unreachable';
  if (health.ok) return health.status === 'rate_limit' ? 'busy' : 'ready';
  switch (health.status) {
    case 'unconfigured': return 'unconfigured';
    case 'unauthorized': return 'unauthorized';
    case 'rate_limit': return 'busy';
    case 'upstream_error':
    case 'upstream_timeout':
    case 'unreachable': return 'upstream';
    default: return 'unreachable';
  }
}

const CONN_TONE = {
  checking: 'unknown',
  ready: 'ok',
  busy: 'ok',
  unconfigured: 'bad',
  unauthorized: 'bad',
  unreachable: 'bad',
  upstream: 'bad',
  local: 'ok',
};

function updateConnText() {
  const transport = Api.activeTransport(state.settings);
  const node = $('#connText');
  const ring = $('#statusSidebar');
  if (!node) return;

  if (transport === 'local') {
    node.textContent = CONNECTION_TEXT.local;
    if (ring) ring.dataset.conn = CONN_TONE.local;
    return;
  }

  const key = connectionState(state.health);
  node.textContent = CONNECTION_TEXT[key] || CONNECTION_TEXT.unreachable;
  if (ring) ring.dataset.conn = CONN_TONE[key] || 'unknown';
  node.dataset.state = key;
}

/**
 * One refresh path for every trigger: boot, the connect sheet, the online
 * event, the tab regaining focus, a failed send, and a slow poll. Health is
 * cheap (it is cached server-side for 45s), so polling costs almost nothing.
 */
let healthInFlight = null;
async function refreshHealth({ force = false, probe = false } = {}) {
  if (healthInFlight) return healthInFlight;
  healthInFlight = (async () => {
    try {
      const health = await Api.refreshCapabilities({ force: force || probe, probe });
      state.health = health;
      state.healthAt = Date.now();
      updateConnText();
      return health;
    } finally {
      healthInFlight = null;
    }
  })();
  return healthInFlight;
}

/** Backend availability detection while the app is open. */
const HEALTH_POLL_MS = 60000;
let healthTimer = null;
function startHealthWatch() {
  const tick = () => { if (!document.hidden) refreshHealth(); };
  clearInterval(healthTimer);
  healthTimer = setInterval(tick, HEALTH_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    // Coming back to a stale tab is exactly when a re-check is worth it.
    if (!document.hidden && Date.now() - state.healthAt > 20000) refreshHealth();
  });
}

/* ============================== connection =============================== */
function describeHealth(health) {
  const key = connectionState(health);
  const where = apiBase() || 'this origin';
  switch (key) {
    case 'ready':
      return {
        ok: true,
        line: `Connected · ${health.provider || 'openai'}${health.model ? ` · ${health.model}` : ''}${health.latencyMs ? ` · ${health.latencyMs}ms` : ''}`,
        explain: `TRALIX verified the connection to the AI service at ${where}. Messages are sent to the backend for a reply and are not stored on the server.`,
      };
    case 'busy':
      return { ok: true, line: 'Rate limited, but the backend is configured', explain: health.message || 'The AI service is throttling this key. TRALIX will retry shortly.' };
    case 'unconfigured':
      return { ok: false, line: 'Backend reachable · no API key set', explain: 'The TRALIX backend answered but has no OPENAI_API_KEY. Set it as a server secret (server/README.md) — the key never belongs in this frontend.' };
    case 'unauthorized':
      return { ok: false, line: 'Backend reachable · the key was rejected', explain: 'The AI service rejected the server key. Check OPENAI_API_KEY on the backend.' };
    case 'upstream':
      return { ok: false, line: 'Backend reachable · AI service unreachable', explain: 'The TRALIX backend is up but cannot reach the AI service from its network. Check OPENAI_BASE_URL or the provider status.' };
    default:
      return { ok: false, line: 'No response from the backend', explain: 'This app needs the TRALIX backend to be reachable. The backend holds the OpenAI key — it is never present in this frontend. Deploy server/ and paste its URL below.' };
  }
}

async function openConnect() {
  const statusEl = $('#connectStatus');
  const sourceEl = $('#connectSource');
  $('#connectBase').value = apiBase();
  if (sourceEl) {
    sourceEl.textContent = apiBase()
      ? `In use: ${apiBase()} (from ${apiBaseSource()}).`
      : `In use: this origin (${apiBaseSource()}). Set a URL to use a backend deployed elsewhere.`;
  }
  statusEl.className = 'status-line';
  statusEl.textContent = 'Checking…';
  openSheet('connectSheet');

  const health = await refreshHealth({ force: true, probe: true });
  const view = describeHealth(health);
  statusEl.textContent = view.line;
  statusEl.className = `status-line ${view.ok ? 'ok' : 'bad'}`;
  $('#connectExplanation').textContent = view.explain;
  modelPicker.render();
}

$('#btnConnectSave')?.addEventListener('click', async () => {
  const { setApiBase, normaliseBase } = await import('./config.js');
  setApiBase(normaliseBase($('#connectBase').value));
  Api.clearHealthCache?.();
  const health = await refreshHealth({ force: true, probe: true });
  const view = describeHealth(health);
  const statusEl = $('#connectStatus');
  statusEl.textContent = view.line;
  statusEl.className = `status-line ${view.ok ? 'ok' : 'bad'}`;
  $('#connectExplanation').textContent = view.explain;
  modelPicker.render();
  toast(view.ok ? 'TRALIX connected' : view.line, { tone: view.ok ? 'success' : 'error' });
});

$('#btnConnectDoctor')?.addEventListener('click', () => { closeSheet('connectSheet'); settingsUi.openDoctor(); });

/* ------------------------------ attachments ------------------------------ */
function openAttachments() {
  const list = $('#attachList');
  const fileTools = TOOLS.filter(t => ['file_analysis', 'image_understanding'].includes(t.id));
  list.innerHTML = fileTools.map(tool => `
    <li><strong>${tool.label}</strong> — ${tool.available ? 'enabled' : 'not enabled yet (needs the upload pipeline)'}</li>`).join('')
    + '<li><strong>PDF · TXT · DOCX · images · code files</strong> — planned formats</li>';
  openSheet('attachSheet');
}

/* ============================== shortcuts ================================ */
document.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (!meta) return;

  const key = event.key.toLowerCase();
  if (key === 'k') {
    event.preventDefault();
    search.open();
  } else if (key === 'o' && event.shiftKey) {
    event.preventDefault();
    chat.newChat();
  } else if (key === '/') {
    event.preventDefault();
    composer.focus();
  }
});

/* ============================ code + copy ================================ */
document.addEventListener('click', async (event) => {
  const copyBtn = event.target.closest?.('[data-copy-target]');
  if (!copyBtn) return;
  const target = document.getElementById(copyBtn.dataset.copyTarget);
  if (!target) return;
  const ok = await copyText(target.textContent || '');
  copyBtn.classList.toggle('done', ok);
  const label = copyBtn.querySelector('span');
  if (label) {
    const original = label.textContent;
    label.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => { label.textContent = original; copyBtn.classList.remove('done'); }, 1600);
  }
  haptic(4);
});

/* ============================== starters ================================= */
const STARTER_PROMPTS = {
  ask: '',
  build: 'Help me build: ',
  analyze: 'Analyze this for me: ',
  research: 'Research this topic and give me a structured summary: ',
  plan: 'Help me plan: ',
};

for (const button of document.querySelectorAll('#starterGrid .starter')) {
  button.addEventListener('click', () => {
    const prompt = STARTER_PROMPTS[button.dataset.starter] ?? '';
    composer.setValue(prompt);
    if (!prompt) toast('Ask TRALIX anything', { ms: 1600 });
  });
}

/* ============================== lifecycle ================================ */
window.addEventListener('offline', () => {
  setError('You are offline');
  toast('You are offline — TRALIX will not be able to reply', { tone: 'error' });
});

window.addEventListener('online', () => {
  setStatus('idle');
  refreshHealth({ force: true });          // the backend may be back with us
  toast('Back online', { tone: 'success' });
});

window.addEventListener('pagehide', () => {
  Voice.stopSpeaking();
  forceReleaseScrollLock();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    Voice.stopSpeaking();
    forceReleaseScrollLock();
  }
});

window.addEventListener('unhandledrejection', (event) => {
  console.warn('[tralix] unhandled rejection', event.reason);
});

/* A send that failed for connection reasons should re-measure the connection,
   so the status line and the Retry affordance agree with reality. */
window.addEventListener('tralix:connection-suspect', () => refreshHealth({ force: true }));

/* ================================= init ================================== */
async function init() {
  Store.migrateLegacy();

  initStatus();
  initToast();
  initSheets();

  applyTheme();
  applyDensity();
  applyLanguage();

  const chats = Store.loadChats();
  state.chat = chats[0] || Store.newChat();

  updateModelChip();
  updateConnText();
  sidebar.render();
  sidebar.refreshCounts();
  memoryManagerSettings.refresh();
  memoryManagerSheet.refresh();
  settingsUi.init?.();
  settingsUi.refresh?.();
  chat.render();

  composer.sync();
  composer.resize();

  // iOS hands over voices only after a gesture in some versions
  Voice.loadVoices().then(() => settingsUi.refresh?.());

  bindVisualViewport({
    app: el.app,
    chat: el.chatScroll,
    visualViewport: window.visualViewport,
    scrollToBottom: (instant) => chat.scrollToBottom(instant),
    onResize: () => { if (isNearBottom(el.chatScroll, 60)) scrollToEnd(el.chatScroll, true); },
  });

  document.addEventListener('pointerdown', () => Voice.warmupSpeech(), { once: true });

  // A welcome tap dismisses the keyboard; a scroll keeps it.
  el.chatScroll.addEventListener('click', () => {
    if (document.activeElement === composer.el) composer.blur();
  });

  // Background tasks that must not block first paint. The backend pointer is
  // resolved first (a committed backend.json or ?api=), because every other
  // call depends on knowing where the backend is.
  setTimeout(async () => {
    await loadBackendConfig();
    updateConnText();
    const health = await refreshHealth({ force: true });
    modelPicker.render();
    settingsUi.refreshDebug?.();
    if (health.ok) Api.syncModelMapping().then(() => settingsUi.refresh?.());
    startHealthWatch();
  }, 250);

  // reveal
  el.boot?.remove();
  el.app.hidden = false;

  const query = window.location?.search || '';
  if (query.includes('new=1')) chat.newChat();
  else if (query.includes('search=1')) search.open();
  else if (!state.chat.messages.length && window.matchMedia('(min-width: 900px)').matches) {
    composer.focus();
  }
}

/* ================================== PWA =================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((registration) => {
      registration.update().catch(() => {});
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            $('#updateBar').hidden = false;
          }
        });
      });
    }).catch(() => {});
  });

  $('#btnReload')?.addEventListener('click', () => {
    navigator.serviceWorker.getRegistration().then(r => r?.update());
    location.reload();
  });
}

init().catch((err) => {
  console.error('[tralix] boot failed', err);
  const boot = document.getElementById('boot');
  if (boot) boot.textContent = 'TRALIX AI could not start. Reload the page.';
});
