/* ==========================================================================
   app.js — TRALIX AI boot and wiring.

   This file only assembles modules: state, persistence, transport, voice and
   the UI pieces live in their own files. Nothing here talks to a provider
   directly — that is api/chat.js's job.
   ========================================================================== */

import { $, copyText, haptic } from './util.js';
import { APP } from './config.js';
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
  refreshHealth: async ({ force = true } = {}) => {
    const health = await Api.refreshCapabilities({ force });
    state.health = health;
    updateConnText();
    modelPicker.render();
    return health;
  },
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
 * Connection details are separate from the activity indicator: the ring shows
 * what TRALIX is doing right now, `connText` shows whether a backend is there.
 */
function updateConnText() {
  const transport = Api.activeTransport(state.settings);
  const node = $('#connText');
  const ring = $('#statusSidebar');

  if (transport === 'local') {
    node.textContent = 'Device-only key';
    if (ring) ring.dataset.conn = 'ok';
    return;
  }
  if (!state.health) {
    node.textContent = 'Checking backend…';
    if (ring) ring.dataset.conn = 'unknown';
    return;
  }
  if (state.health.ok) {
    node.textContent = 'TRALIX backend · online';
    if (ring) ring.dataset.conn = 'ok';
  } else {
    node.textContent = state.health.message || 'Backend offline';
    if (ring) ring.dataset.conn = 'bad';
  }
}

/* ============================== connection =============================== */
async function openConnect() {
  const statusEl = $('#connectStatus');
  $('#connectBase').value = apiBase();
  statusEl.className = 'status-line';
  statusEl.textContent = 'Checking…';
  openSheet('connectSheet');

  const health = await Api.refreshCapabilities({ force: true });
  state.health = health;
  updateConnText();
  statusEl.textContent = health.ok
    ? `Connected · ${health.provider || 'backend'}${health.model ? ` · ${health.model}` : ''}`
    : (health.message || 'No response from the backend');
  statusEl.className = `status-line ${health.ok ? 'ok' : 'bad'}`;

  $('#connectExplanation').textContent = health.ok
    ? 'TRALIX is talking to its backend. Messages are sent to the API for a reply and are not stored on the server.'
    : 'This app needs the TRALIX backend to be reachable. The backend holds the OpenAI key — it is never present in this frontend. Deploy server/ and paste its URL below.';
}

$('#btnConnectSave')?.addEventListener('click', async () => {
  const { setApiBase, normaliseBase } = await import('./config.js');
  setApiBase(normaliseBase($('#connectBase').value));
  Api.refreshCapabilities({ force: true }).then((health) => {
    state.health = health;
    updateConnText();
    const statusEl = $('#connectStatus');
    statusEl.textContent = health.ok ? 'Connected.' : (health.message || 'Still unreachable');
    statusEl.className = `status-line ${health.ok ? 'ok' : 'bad'}`;
    toast(health.ok ? 'TRALIX connected' : 'Still unreachable', { tone: health.ok ? 'success' : 'error' });
  });
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

  // background tasks that must not block first paint
  setTimeout(async () => {
    const health = await Api.refreshCapabilities();
    state.health = health;
    updateConnText();
    modelPicker.render();
    settingsUi.refreshDebug?.();
    Api.syncModelMapping().then(() => settingsUi.refresh?.());
  }, 350);

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
