/* ==========================================================================
   app.js — Jarvis
   UI, chat flow, streaming, voice, memory, PWA wiring.
   ========================================================================== */

import {
  $, $$, escapeHtml, relTime, dayBucket, greeting, nextFrame,
  copyText, toast, confirmDialog, autosize, uid, haptic,
} from './util.js';

import { renderMarkdown, stripMarkdown } from './markdown.js';

import * as Store from './store.js';
import * as AI from './providers.js';
import * as Voice from './voice.js';

/* ================================ state ================================== */
const state = {
  settings: Store.loadSettings(),
  chat: null,
  streaming: false,
  abort: null,
  speakingId: null,
  listening: false,
};

/* ============================== shortcuts ================================ */
const el = {
  // chrome
  drawer:      $('#drawer'),
  scrim:       $('#scrim'),
  chatScroll:  $('#chatScroll'),
  welcome:     $('#welcome'),
  messages:    $('#messages'),
  scrollAnchor:$('#scrollAnchor'),
  jumpBtn:     $('#jumpBtn'),

  // composer
  composer:    $('#composer'),
  input:       $('#input'),
  btnSend:     $('#btnSend'),
  btnStop:     $('#btnStop'),
  btnMic:      $('#btnMic'),
  btnClear:    $('#btnClear'),
  listenBar:   $('#listenBar'),
  listenText:  $('#listenText'),

  // header
  chipLabel:   $('#chipLabel'),
  chipDot:     $('#chipDot'),
  brandSub:    $('#brandSub'),
  chatList:    $('#chatList'),
  chatSearch:  $('#chatSearch'),
  memCount:    $('#memCount'),
  userName:    '',
};

/* =============================== theming ================================= */
function applyTheme() {
  const pref = state.settings.theme;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  document.documentElement.dataset.theme = theme;
  $('#themeSub').textContent = pref === 'system' ? 'Automatic' : (theme === 'dark' ? 'Dark' : 'Light');
  $('#themeIcon').textContent = theme === 'dark' ? '🌙' : '☀️';

  const meta = document.querySelector('meta[name="theme-color"]:not([media])')
    || document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d0e10' : '#ffffff');
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings.theme === 'system') applyTheme();
});

/* ================================ chats ================================== */
function persist() {
  if (!state.chat) return;
  state.chat.updatedAt = Date.now();
  Store.upsertChat(state.chat);
  renderChatList();
  updateBrandSub();
}

function startNewChat() {
  state.chat = Store.newChat();
  renderMessages();
  el.input.value = '';
  autosize(el.input);
  syncComposer();
  el.input.focus({ preventScroll: true });
  renderChatList();
  updateBrandSub();
  scrollToBottom(true);
}

function openChat(id) {
  const chat = Store.getChat(id);
  if (!chat) return;
  state.chat = chat;
  renderMessages();
  renderChatList();
  updateBrandSub();
  scrollToBottom(true);
}

function updateBrandSub() {
  const n = state.chat?.messages?.length || 0;
  el.brandSub.textContent = !n ? 'Personal assistant'
    : `${Math.ceil(n / 2)} exchange${n > 2 ? 's' : ''}`;
}

function renderChatList(filter = '') {
  const chats = Store.loadChats();
  const q = filter.trim().toLowerCase();
  const list = q ? chats.filter(c => c.title.toLowerCase().includes(q)) : chats;

  el.chatList.innerHTML = '';

  if (!list.length) {
    el.chatList.innerHTML = `<div class="chat-empty">${
      q ? 'No chats match that.' : 'No chats yet. Start talking.'}</div>`;
    return;
  }

  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.id === state.chat?.id ? ' active' : '');
    row.innerHTML =
      `<svg viewBox="0 0 24 24" aria-hidden="true" style="width:17px;height:17px;flex:0 0 auto;opacity:.6">` +
      `<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.5-4.6A8.4 8.4 0 0 1 3.6 11.5a8.4 8.4 0 0 1 8.4-8.4h.5a8.4 8.4 0 0 1 8.5 8.4z"/></svg>` +
      `<span class="ci-title">${escapeHtml(c.title)}</span>` +
      `<button class="ci-del" aria-label="Delete chat">` +
      `<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;

    row.querySelector('.ci-title').addEventListener('click', () => {
      openChat(c.id);
      closeDrawer();
    });

    row.querySelector('.ci-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog('Delete this chat?', `"${c.title}" will be removed for good.`, 'Delete');
      if (!ok) return;
      Store.deleteChat(c.id);
      if (c.id === state.chat?.id) startNewChat(); else renderChatList();
      toast('Chat deleted');
    });

    el.chatList.appendChild(row);
  }
}

/* ============================== rendering ================================ */
function messageNode(msg) {
  const wrap = document.createElement('div');
  wrap.dataset.id = msg.id;

  if (msg.role === 'user') {
    wrap.className = 'msg user';
    wrap.innerHTML = `<div class="bubble">${escapeHtml(msg.text)}</div>`;
    return wrap;
  }

  wrap.className = 'msg bot' + (msg.error ? ' error' : '');
  wrap.innerHTML =
    `<div class="row">` +
      `<div class="avatar${msg.pending ? ' thinking' : ''}"></div>` +
      `<div class="content">${msg.pending ? typingDots() : ''}</div>` +
    `</div>` +
    `<div class="msg-actions"></div>`;

  if (!msg.pending) {
    wrap.querySelector('.content').innerHTML = renderMarkdown(msg.text);
    buildActions(wrap, msg);
  }
  return wrap;
}

const typingDots = () => '<div class="typing"><i></i><i></i><i></i></div>';

function buildActions(node, msg) {
  const bar = node.querySelector('.msg-actions');
  if (!bar) return;
  bar.innerHTML = '';

  const mk = (label, svgPath, onClick, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = `<svg viewBox="0 0 24 24">${svgPath}</svg>${label}`;
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  };

  mk('Copy',
    `<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>`,
    async (e) => {
      const ok = await copyText(stripMarkdown(msg.text));
      toast(ok ? 'Copied' : 'Copy failed');
      haptic();
    });

  if (Voice.ttsSupported) {
    mk('Listen',
      `<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>`,
      () => {
        if (state.speakingId === msg.id) {
          Voice.stopSpeaking();
          state.speakingId = null;
          renderMessages();
          return;
        }
        state.speakingId = msg.id;
        Voice.speak(stripMarkdown(msg.text), {
          voiceURI: state.settings.voiceURI,
          rate: Number(state.settings.voiceRate) || 1,
          onEnd: () => { if (state.speakingId === msg.id) { state.speakingId = null; renderMessages(); } },
        });
        renderMessages();
      },
      state.speakingId === msg.id ? 'on' : '');

    if (state.speakingId === msg.id) {
      const b = bar.querySelector('.on');
      if (b) b.innerHTML = `<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>Stop`;
    }
  }

  const isLast = state.chat?.messages?.[state.chat.messages.length - 1]?.id === msg.id;
  if (isLast && !state.streaming) {
    mk('Retry',
      `<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>`,
      () => regenerate(msg.id));
  }
}

function renderMessages() {
  const msgs = state.chat?.messages || [];
  el.welcome.hidden = msgs.length > 0;
  el.messages.innerHTML = '';
  el.messages.style.display = msgs.length ? '' : 'none';

  let lastDay = null;
  for (const m of msgs) {
    const bucket = dayBucket(m.ts);
    if (bucket !== lastDay) {
      lastDay = bucket;
      const d = document.createElement('div');
      d.className = 'day-divider';
      d.textContent = bucket;
      el.messages.appendChild(d);
    }
    el.messages.appendChild(messageNode(m));
  }

  if (!msgs.length) {
    const h = new Date().getHours();
    const first = !state.settings.onboarded && !state.settings.apiKey;
    $('#welcomeTitle').textContent = greeting();
    $('#welcomeSub').textContent = first
      ? 'I am Jarvis. Add your free Gemini key and let us begin.'
      : 'What are we working on today?';
    $('#welcomeHint').hidden = !first;
  }
  updateMemCount();
  syncComposer();
}

function updateMemCount() {
  const n = Store.loadMemory().length;
  el.memCount.textContent = n === 1 ? '1 thing remembered' : `${n} things remembered`;
}

/* ------------------------------ scroll utils ----------------------------- */
function nearBottom(slack = 120) {
  const c = el.chatScroll;
  return c.scrollHeight - c.scrollTop - c.clientHeight < slack;
}

function scrollToBottom(instant = false) {
  const c = el.chatScroll;
  c.classList.toggle('no-anim', instant);
  c.scrollTop = c.scrollHeight;
  if (instant) requestAnimationFrame(() => c.classList.remove('no-anim'));
  el.jumpBtn.hidden = true;
}

el.chatScroll.addEventListener('scroll', () => {
  el.jumpBtn.hidden = nearBottom();
}, { passive: true });

el.jumpBtn.addEventListener('click', () => scrollToBottom());

/* ============================== composer ================================= */
function syncComposer() {
  const has = el.input.value.trim().length > 0;
  el.btnSend.disabled = !has || state.streaming;
  el.btnSend.hidden = state.streaming;
  el.btnStop.hidden = !state.streaming;
  el.btnMic.hidden = state.streaming;
  el.btnClear.hidden = !has || state.streaming;
}

el.input.addEventListener('input', () => { autosize(el.input); syncComposer(); });

el.input.addEventListener('keydown', (e) => {
  // Desktop convenience; on iPhone the enter key inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 700px)').matches) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});

el.btnClear.addEventListener('click', () => {
  el.input.value = '';
  autosize(el.input);
  syncComposer();
  el.input.focus({ preventScroll: true });
});

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(el.input.value);
});

/* ============================== sending ================================== */
async function sendMessage(rawText, { silent = false } = {}) {
  const text = String(rawText || '').trim();
  if (!text || state.streaming) return;

  if (!state.settings.apiKey) {
    openSettings();
    setKeyStatus('Add your Gemini API key to start chatting.', 'bad');
    toast('Add your API key first');
    return;
  }

  haptic();

  // lock the chat into the list on first send
  if (!state.chat.messages.length) {
    state.chat.title = Store.titleFrom(text);
  }

  state.chat.messages.push({ id: uid(), role: 'user', text, ts: Date.now() });
  el.input.value = '';
  autosize(el.input);
  persist();
  renderMessages();
  scrollToBottom();

  // remember facts the user asked us to keep
  if (state.settings.memAuto) captureMemories(text);

  await streamReply();
}

async function streamReply() {
  const chat = state.chat;
  const history = chat.messages
    .filter(m => !m.error && (m.role === 'user' || m.role === 'assistant'))
    .slice(-24)
    .map(m => ({ role: m.role, text: m.text }));

  const systemPrompt = AI.buildSystemPrompt({
    persona: state.settings.persona,
    personaPreset: state.settings.personaPreset,
    userName: el.userName,
    memory: Store.memoryToPrompt(),
  });

  const botMsg = { id: uid(), role: 'assistant', text: '', ts: Date.now(), pending: true };
  chat.messages.push(botMsg);

  state.streaming = true;
  syncComposer();
  renderMessages();
  scrollToBottom();

  const node = el.messages.querySelector(`[data-id="${botMsg.id}"]`);
  const contentEl = node?.querySelector('.content');
  const avatarEl = node?.querySelector('.avatar');

  // stream into the DOM on animation frames so iOS stays smooth
  let full = '';
  let dirty = false;
  let raf = null;

  const paint = () => {
    raf = null;
    if (!dirty || !contentEl) return;
    dirty = false;
    contentEl.innerHTML = renderMarkdown(full) + '<span class="caret"></span>';
    if (nearBottom()) el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  };

  const onDelta = (_delta, whole) => {
    full = whole;
    dirty = true;
    if (!raf) raf = requestAnimationFrame(paint);
  };

  const controller = new AbortController();
  state.abort = controller;

  let error = null;
  try {
    await AI.streamChat({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      messages: history,
      systemPrompt,
      signal: controller.signal,
      onDelta,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      error = null;                       // user stopped on purpose
    } else {
      error = err;
    }
  }

  if (raf) cancelAnimationFrame(raf);
  state.streaming = false;
  state.abort = null;

  botMsg.pending = false;
  avatarEl?.classList.remove('thinking');

  if (error) {
    const message = error.message || 'Something went wrong.';
    if (full.trim()) {
      // partial reply arrived — keep what we got, flag it at the end
      botMsg.text = full.trim() + `\n\n> ⚠️ ${message}`;
    } else {
      // nothing streamed: keep the turn balanced so Retry still works
      botMsg.text = message;
    }
    botMsg.error = true;
    persist();
    renderMessages();
    scrollToBottom();
    toast(message, 3600);
    return;
  }

  botMsg.text = full.trim() || '_No reply came back. Try again._';
  persist();
  renderMessages();

  // auto-speak
  if (state.settings.ttsEnabled && state.settings.ttsAuto) {
    const spoken = stripMarkdown(botMsg.text);
    if (spoken) {
      state.speakingId = botMsg.id;
      Voice.speak(spoken, {
        voiceURI: state.settings.voiceURI,
        rate: Number(state.settings.voiceRate) || 1,
        onEnd: () => {
          if (state.speakingId === botMsg.id) { state.speakingId = null; renderMessages(); }
        },
      });
      renderMessages();
    }
  }
}

function stopStreaming() {
  try { state.abort?.abort(); } catch {}
  state.streaming = false;
  syncComposer();
  toast('Stopped');
}

el.btnStop.addEventListener('click', stopStreaming);

/* ----------------------------- regenerate -------------------------------- */
async function regenerate(botId) {
  if (state.streaming) return;
  const msgs = state.chat.messages;
  const i = msgs.findIndex(m => m.id === botId);
  if (i === -1) return;
  msgs.splice(i, 1);                       // drop the reply, keep the prompt
  persist();
  renderMessages();
  await streamReply();
}

/* =============================== memory ================================== */
function captureMemories(text) {
  const found = AI.extractMemoryCandidates(text);
  const added = found.map(f => Store.addMemory(f, 'auto')).filter(Boolean);
  if (added.length) {
    updateMemCount();
    toast(`Remembered: ${added.map(a => a.text).join(' · ')}`, 2600);
  }
}

/* ================================ voice ================================== */
const listener = new Voice.Listener({
  onResult: (text) => {
    el.listenText.textContent = text || 'Listening…';
  },
  onError: (msg) => {
    toast(msg, 4000);
    setListeningUI(false);
  },
  onStart: () => { setListeningUI(true); },
  onEnd: (finalText) => {
    setListeningUI(false);
    if (finalText && finalText.trim().length > 1) {
      el.input.value = finalText.trim();
      autosize(el.input);
      syncComposer();
      sendMessage(el.input.value);
    } else if (state.listening) {
      toast('Didn’t catch that — try again', 1800);
    }
    state.listening = false;
  },
});

function setListeningUI(on) {
  el.btnMic.classList.toggle('rec', on);
  el.composer.classList.toggle('rec', on);
  el.listenBar.hidden = !on;
  if (on) el.listenText.textContent = 'Listening…';
}

function startListening() {
  if (state.streaming) return;
  if (!Voice.sttSupported) {
    toast('Voice input needs Safari on iPhone or Chrome on Android.', 3600);
    return;
  }
  Voice.stopSpeaking();
  state.speakingId = null;
  state.listening = true;
  haptic(12);
  listener.start();
}

function stopListening() {
  if (!state.listening) return;
  listener.stop();
}

/* push-to-talk: hold the mic; release to send */
let pressTimer = null;
let holding = false;

el.btnMic.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  holding = true;
  pressTimer = setTimeout(() => {
    if (holding) startListening();
  }, 60);
});

const release = (e) => {
  if (!holding) return;
  holding = false;
  clearTimeout(pressTimer);
  if (state.listening) stopListening();
};

el.btnMic.addEventListener('pointerup', release);
el.btnMic.addEventListener('pointercancel', release);
// no pointerleave: a slightly imprecise thumb should not cut the recording off
window.addEventListener('blur', release);
el.btnMic.addEventListener('contextmenu', (e) => e.preventDefault());

/* ============================== sheets =================================== */
function openSheet(id) {
  const back = document.getElementById(id);
  back.hidden = false;
  requestAnimationFrame(() => back.classList.add('on'));
}

function closeSheet(id) {
  const back = document.getElementById(id);
  back.classList.remove('on');
  setTimeout(() => { back.hidden = true; }, 300);
}

for (const id of ['modelSheet', 'settingsSheet', 'memorySheet']) {
  const back = document.getElementById(id);
  back?.addEventListener('click', (e) => { if (e.target === back) closeSheet(id); });
}

/* ------------------------------- drawer ---------------------------------- */
function openDrawer() {
  renderChatList(el.chatSearch.value);
  el.drawer.classList.add('open');
  el.drawer.setAttribute('aria-hidden', 'false');
  el.scrim.hidden = false;
  requestAnimationFrame(() => el.scrim.classList.add('on'));
}

function closeDrawer() {
  el.drawer.classList.remove('open');
  el.drawer.setAttribute('aria-hidden', 'true');
  el.scrim.classList.remove('on');
  setTimeout(() => { el.scrim.hidden = true; }, 300);
}

$('#btnMenu').addEventListener('click', openDrawer);
$('#btnCloseDrawer').addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);
el.chatSearch.addEventListener('input', (e) => renderChatList(e.target.value));

$('#btnNewChat').addEventListener('click', startNewChat);
$('#btnNewChat2').addEventListener('click', () => { startNewChat(); closeDrawer(); });

$('#btnTheme').addEventListener('click', () => {
  const order = ['dark', 'light', 'system'];
  const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
  state.settings.theme = next;
  Store.saveSettings(state.settings);
  applyTheme();
  toast(next === 'system' ? 'Theme: Automatic' : `Theme: ${next === 'dark' ? 'Dark' : 'Light'}`);
});

/* ------------------------------- models ---------------------------------- */
function renderModels() {
  const box = $('#modelList');
  box.innerHTML = '';

  const known = AI.getAvailableModels();

  for (const m of AI.MODELS) {
    const usable = AI.isModelAvailable(m.id);
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = !usable;
    b.className = 'model-opt' + (m.id === state.settings.model ? ' sel' : '');
    if (!usable) b.style.opacity = '.45';

    b.innerHTML =
      `<div class="mo-body">` +
        `<span class="mo-name">${escapeHtml(m.name)}` +
          (m.badge ? ` · <span style="color:var(--accent-a);font-size:12px">${escapeHtml(m.badge)}</span>` : '') +
        `</span>` +
        `<span class="mo-desc">${escapeHtml(
          usable ? m.desc : 'Not available on your API key'
        )}</span>` +
      `</div><span class="mo-check">✓</span>`;

    if (usable) {
      b.addEventListener('click', () => {
        state.settings.model = m.id;
        Store.saveSettings(state.settings);
        updateModelChip();
        renderModels();
        closeSheet('modelSheet');
        toast(m.name);
      });
    }
    box.appendChild(b);
  }

  if (!known) {
    const note = document.createElement('p');
    note.className = 'set-p';
    note.style.padding = '2px 4px';
    note.textContent = state.settings.apiKey
      ? 'Add or test your key to see exactly which models you can use.'
      : 'Add your API key first to unlock these.';
    box.appendChild(note);
  }
}

function updateModelChip() {
  const m = AI.modelById(state.settings.model);
  el.chipLabel.textContent = m.name.replace('Gemini 2.5 ', '2.5 ');
  el.chipDot.classList.toggle('off', !state.settings.apiKey);
}

$('#btnModel').addEventListener('click', () => { renderModels(); openSheet('modelSheet'); });

/* ------------------------------ settings --------------------------------- */
function openSettings() {
  const s = state.settings;
  $('#apiKeyInput').value = s.apiKey || '';
  $('#personaInput').value = s.persona || '';
  $('#ttsToggle').checked = Boolean(s.ttsEnabled);
  $('#ttsAutoToggle').checked = Boolean(s.ttsAuto);
  $('#memAutoToggle').checked = Boolean(s.memAuto);
  $('#voiceRate').value = s.voiceRate || 1;
  $('#voiceRateVal').textContent = `${Number(s.voiceRate || 1).toFixed(1)}×`;
  renderPersonaChips();
  renderVoicePicker();
  renderMemoryManager();
  openSheet('settingsSheet');
}

$('#btnSettings').addEventListener('click', () => { closeDrawer(); setTimeout(openSettings, 180); });
$('#btnCloseSettings').addEventListener('click', () => closeSheet('settingsSheet'));
$('#welcomeSettingsBtn').addEventListener('click', openSettings);

function setKeyStatus(msg, cls = '') {
  const s = $('#keyStatus');
  s.textContent = msg;
  s.className = 'status-line ' + cls;
}

$('#btnSaveKey').addEventListener('click', () => {
  const key = $('#apiKeyInput').value.trim();
  if (!key) { setKeyStatus('Paste a key first.', 'bad'); return; }
  if (!/^AIza[\w-]{20,}$/.test(key)) {
    setKeyStatus('That does not look like a Gemini key (they start with "AIza").', 'bad');
  }
  state.settings.apiKey = key;
  Store.saveSettings(state.settings);
  updateModelChip();
  $('#welcomeHint').hidden = true;
  setKeyStatus('Saved. Testing…');
  testKey(true);
});

$('#btnTestKey').addEventListener('click', () => testKey(false));

async function testKey(silent) {
  const key = $('#apiKeyInput').value.trim() || state.settings.apiKey;
  if (!key) { setKeyStatus('No key to test.', 'bad'); return; }
  setKeyStatus('Checking with Google…');

  try {
    const models = await AI.verifyKey(key);

    // The saved model may not exist on this key (Google retires models often).
    // Quietly move to the best one that actually works instead of failing later.
    const chosen = AI.bestAvailableModel(state.settings.model);
    const switched = chosen !== state.settings.model;
    if (switched) {
      state.settings.model = chosen;
      Store.saveSettings(state.settings);
      updateModelChip();
    }

    const label = AI.modelById(chosen).name;
    setKeyStatus(
      switched
        ? `Key works. Switched to ${label} (${models.length} models available).`
        : `Working. ${models.length} models available to you.`,
      'ok'
    );
    toast(switched ? `Jarvis is awake — using ${label}` : 'Jarvis is awake');
    renderModels();

    if (!state.settings.onboarded) {
      state.settings.onboarded = true;
      Store.saveSettings(state.settings);
      renderMessages();
    }
  } catch (err) {
    setKeyStatus(err.message, 'bad');
    if (!silent) toast(err.message, 3400);
  }
}

$('#btnEye').addEventListener('click', () => {
  const i = $('#apiKeyInput');
  i.type = i.type === 'password' ? 'text' : 'password';
});

$('#btnGetKey').addEventListener('click', () => {
  window.open('https://aistudio.google.com/apikey', '_blank', 'noopener');
});

/* ---------------------------- persona controls --------------------------- */
const PERSONA_TEXT = {
  warm:    'Be warm, encouraging and human. Keep replies tight and use my name sometimes.',
  concise: 'Be extremely concise. Answer in as few words as the question allows, with no preamble.',
  butler:  'Speak like a refined British butler — precise, calm, quietly witty. Address me as "sir".',
  coach:   'Be an energetic coach: direct, motivating, action-oriented. End with one clear next step.',
};

function renderPersonaChips() {
  $$('#personaPresets .chip').forEach(c => {
    const on = state.settings.personaPreset === c.dataset.persona;
    c.classList.toggle('on', on);
  });
}

$$('#personaPresets .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const key = chip.dataset.persona;
    const already = state.settings.personaPreset === key;
    state.settings.personaPreset = already ? '' : key;
    state.settings.persona = already ? '' : PERSONA_TEXT[key];
    $('#personaInput').value = state.settings.persona;
    Store.saveSettings(state.settings);
    renderPersonaChips();
    toast(already ? 'Personality cleared' : 'Personality set');
  });
});

$('#personaInput').addEventListener('change', (e) => {
  state.settings.persona = e.target.value.trim();
  if (state.settings.persona) state.settings.personaPreset = '';
  Store.saveSettings(state.settings);
  renderPersonaChips();
});

/* ------------------------------ voice prefs ------------------------------ */
$('#ttsToggle').addEventListener('change', (e) => {
  state.settings.ttsEnabled = e.target.checked;
  Store.saveSettings(state.settings);
  if (!e.target.checked) Voice.stopSpeaking();
});

$('#ttsAutoToggle').addEventListener('change', (e) => {
  state.settings.ttsAuto = e.target.checked;
  Store.saveSettings(state.settings);
  if (e.target.checked) {
    state.settings.ttsEnabled = true;
    $('#ttsToggle').checked = true;
    Store.saveSettings(state.settings);
    Voice.speak('Voice output is on.', {
      voiceURI: state.settings.voiceURI,
      rate: Number(state.settings.voiceRate) || 1,
    });
  }
});

$('#memAutoToggle').addEventListener('change', (e) => {
  state.settings.memAuto = e.target.checked;
  Store.saveSettings(state.settings);
});

$('#voiceRate').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('#voiceRateVal').textContent = `${v.toFixed(1)}×`;
});

$('#voiceRate').addEventListener('change', (e) => {
  state.settings.voiceRate = Number(e.target.value);
  Store.saveSettings(state.settings);
  Voice.speak('This is my speaking speed.', {
    voiceURI: state.settings.voiceURI,
    rate: Number(state.settings.voiceRate) || 1,
  });
});

$('#btnTestVoice').addEventListener('click', () => {
  const s = state.settings;
  const text = s.personaPreset === 'butler'
    ? 'Good evening, sir. All systems are at your disposal.'
    : `Hello${el.userName ? ', ' + el.userName : ''}. I am Jarvis. I am ready when you are.`;
  if (!('speechSynthesis' in window)) { toast('This browser cannot speak.'); return; }
  Voice.speak(text, {
    voiceURI: s.voiceURI,
    rate: Number(s.voiceRate) || 1,
    onEnd: () => {},
  });
});

function renderVoicePicker() {
  const sel = $('#voicePick');
  const voices = Voice.voiceList();
  sel.innerHTML = '';

  if (!voices.length) {
    sel.innerHTML = '<option>Loading voices…</option>';
    Voice.loadVoices().then(() => renderVoicePicker());
    return;
  }

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Automatic (best available)';
  sel.appendChild(auto);

  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name} — ${v.lang}${v.localService ? '' : ' (cloud)'}`;
    sel.appendChild(o);
  }
  sel.value = state.settings.voiceURI || '';
}

$('#voicePick').addEventListener('change', (e) => {
  state.settings.voiceURI = e.target.value;
  Store.saveSettings(state.settings);
  const v = Voice.voiceList().find(x => x.voiceURI === e.target.value);
  Voice.speak(`This is ${v ? v.name : 'the automatic voice'}.`, {
    voiceURI: state.settings.voiceURI,
    rate: Number(state.settings.voiceRate) || 1,
  });
});

/* ------------------------------- memory UI ------------------------------- */
function renderMemoryManager() {
  const list = Store.loadMemory();
  const box = $('#memList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="mem-empty">Nothing yet. Say “remember that…” in a chat.</div>';
  }
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'mem-item';
    row.innerHTML = `<span></span><button aria-label="Forget">✕</button>`;
    row.querySelector('span').textContent = m.text;
    row.querySelector('button').addEventListener('click', () => {
      Store.removeMemory(m.id);
      renderMemoryManager();
      renderMemoryBig();
      updateMemCount();
      toast('Forgotten');
    });
    box.appendChild(row);
  }
}

function renderMemoryBig() {
  const list = Store.loadMemory();
  const box = $('#memListBig');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="mem-empty">Nothing remembered yet.</div>';
    return;
  }
  for (const m of list) {
    const row = document.createElement('div');
    row.className = 'mem-item';
    row.innerHTML = `<span></span><button aria-label="Forget">✕</button>`;
    row.querySelector('span').textContent = m.text;
    row.querySelector('button').addEventListener('click', () => {
      Store.removeMemory(m.id);
      renderMemoryBig();
      renderMemoryManager();
      updateMemCount();
    });
    box.appendChild(row);
  }
}

$('#btnMemAdd').addEventListener('click', () => {
  const v = $('#memInput').value.trim();
  if (!v) return;
  Store.addMemory(v, 'manual');
  $('#memInput').value = '';
  renderMemoryManager();
  renderMemoryBig();
  updateMemCount();
  toast('Saved to memory');
});

$('#memInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btnMemAdd').click(); }
});

$('#btnMemClear').addEventListener('click', async () => {
  const ok = await confirmDialog('Clear all memories?', 'Jarvis will forget everything it learned about you.', 'Clear all');
  if (!ok) return;
  Store.clearMemory();
  renderMemoryManager();
  renderMemoryBig();
  updateMemCount();
  toast('Memory cleared');
});

$('#btnMemory').addEventListener('click', () => {
  closeDrawer();
  setTimeout(() => { renderMemoryBig(); openSheet('memorySheet'); }, 180);
});
$('#btnCloseMemory').addEventListener('click', () => closeSheet('memorySheet'));
$('#btnMemoryAdd').addEventListener('click', () => { closeSheet('memorySheet'); setTimeout(openSettings, 200); });

/* --------------------------------- data ---------------------------------- */
$('#btnExport').addEventListener('click', () => {
  try {
    const data = Store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jarvis-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Backup downloaded');
  } catch (err) {
    toast('Export failed: ' + err.message, 3000);
  }
});

$('#btnImport').addEventListener('click', () => $('#importFile').click());

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await Store.importAll(data);
    state.settings = Store.loadSettings();
    applyTheme();
    updateModelChip();
    const chats = Store.loadChats();
    state.chat = chats[0] || Store.newChat();
    renderMessages();
    renderChatList();
    renderMemoryManager();
    updateMemCount();
    closeSheet('settingsSheet');
    toast('Backup restored');
  } catch (err) {
    toast('Could not read that file', 3000);
  }
  e.target.value = '';
});

$('#btnWipe').addEventListener('click', async () => {
  const ok = await confirmDialog(
    'Erase everything?',
    'All chats and memories will be deleted from this device. Your API key is kept.',
    'Erase'
  );
  if (!ok) return;
  Store.wipeAll({ keepKey: true });
  state.settings = Store.loadSettings();
  state.chat = Store.newChat();
  applyTheme();
  updateModelChip();
  renderMessages();
  renderChatList();
  renderMemoryManager();
  updateMemCount();
  closeSheet('settingsSheet');
  toast('Everything erased');
});

/* ============================ welcome prompts ============================= */
$$('#suggestGrid .suggest').forEach(btn => {
  btn.addEventListener('click', () => {
    el.input.value = btn.dataset.prompt || '';
    autosize(el.input);
    syncComposer();
    el.input.focus({ preventScroll: true });
    // put the caret at the end so they just keep typing
    el.input.setSelectionRange(el.input.value.length, el.input.value.length);
  });
});

/* ============================== clipboard ================================ */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('[data-copy]');
  if (!btn) return;
  const ok = await copyText(btn.dataset.copy || '');
  toast(ok ? 'Code copied' : 'Copy failed');
});

/* ================================ init =================================== */
function init() {
  applyTheme();
  updateModelChip();

  const chats = Store.loadChats();
  state.chat = chats[0] || Store.newChat();

  renderMessages();
  renderChatList();
  renderMemoryManager();
  updateMemCount();
  updateBrandSub();

  // iOS: voices only load after a user gesture in some versions
  const unlockVoices = () => {
    Voice.loadVoices().then(() => {
      const v = Voice.pickDefaultVoice();
      if (v && !state.settings.voiceURI) {
        // remember the automatic pick so the picker shows reality
        renderVoicePicker();
      }
    });
    document.removeEventListener('pointerdown', unlockVoices);
  };
  document.addEventListener('pointerdown', unlockVoices, { once: true });
  Voice.loadVoices();

  /* iOS keyboard handling.
     Safari does not shrink the layout viewport when the keyboard opens, so a
     fixed, full-height app ends up hidden behind it. Pinning the app to the
     visual viewport is the only reliable fix on iPhone. */
  const appEl = $('#app');
  if (window.visualViewport) {
    const vv = window.visualViewport;
    let lastH = vv.height;

    const fit = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', `${kb}px`);

      appEl.style.height = `${vv.height}px`;
      appEl.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';

      const keyboardJustOpened = kb > 120 && lastH - vv.height > 120;
      lastH = vv.height;

      if (keyboardJustOpened || document.activeElement === el.input) {
        requestAnimationFrame(() => scrollToBottom(true));
      }
    };

    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }

  // unlock speech on the first touch anywhere (required by iOS)
  document.addEventListener('pointerdown', () => Voice.warmupSpeech(), { once: true });

  // tapping the chat dismisses the keyboard
  el.chatScroll.addEventListener('touchstart', () => {
    if (document.activeElement === el.input) el.input.blur();
  }, { passive: true });

  // block pull-to-refresh inside the app
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  window.addEventListener('beforeunload', () => { Voice.stopSpeaking(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { Voice.stopSpeaking(); state.speakingId = null; }
  });

  // greet once
  if (!state.chat.messages.length && state.settings.apiKey) {
    setTimeout(() => el.input.focus({ preventScroll: true }), 400);
  }
}

init();

/* ============================== PWA ====================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
      // Home Screen PWAs can stay open for long stretches; check the worker on
      // every load rather than waiting for the browser's background interval.
      reg.update().catch(() => {});

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
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
