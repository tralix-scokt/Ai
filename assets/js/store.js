/* ==========================================================================
   store.js — all persistence lives on the device (localStorage)
   Nothing here ever leaves the phone.
   ========================================================================== */

import { uid } from './util.js';

const K = {
  chats:    'jarvis.chats.v1',
  settings: 'jarvis.settings.v1',
  memory:   'jarvis.memory.v1',
};

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-2.5-flash',
  theme: 'dark',            // 'dark' | 'light' | 'system'
  persona: '',              // custom personality text
  personaPreset: '',
  ttsEnabled: true,         // voice available at all
  ttsAuto: false,           // speak every reply automatically
  voiceURI: '',
  voiceRate: 1,
  memAuto: true,            // auto-save "remember that ..."
  haptics: true,
  onboarded: false,
};

/* ------------------------------- low level ------------------------------- */
function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (err) {
    console.warn('[store] write failed', err);
    return false;
  }
}

/* -------------------------------- settings ------------------------------- */
export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(K.settings, {}) };
}

export function saveSettings(settings) {
  return write(K.settings, settings);
}

/* --------------------------------- memory -------------------------------- */
/** Memory items: { id, text, ts, source } */
export function loadMemory() {
  const list = read(K.memory, []);
  return Array.isArray(list) ? list : [];
}

export function saveMemory(list) {
  return write(K.memory, list);
}

export function addMemory(text, source = 'user') {
  const clean = String(text).trim().replace(/\s+/g, ' ');
  if (!clean || clean.length < 2) return null;

  const list = loadMemory();
  // de-dupe near-identical facts
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (list.some(m => norm(m.text) === norm(clean))) return null;

  const item = { id: uid(), text: clean, ts: Date.now(), source };
  list.unshift(item);
  saveMemory(list.slice(0, 300));
  return item;
}

export function removeMemory(id) {
  const list = loadMemory().filter(m => m.id !== id);
  saveMemory(list);
  return list;
}

export function clearMemory() { saveMemory([]); }

export function memoryToPrompt(limit = 40) {
  const list = loadMemory().slice(0, limit);
  if (!list.length) return '';
  return list.map(m => `- ${m.text}`).join('\n');
}

/* --------------------------------- chats --------------------------------- */
/** Chat: { id, title, createdAt, updatedAt, messages:[{id,role,text,ts,error?}] } */
export function loadChats() {
  const list = read(K.chats, []);
  return Array.isArray(list) ? list : [];
}

export function saveChats(list) {
  // keep storage bounded — newest 60 chats
  return write(K.chats, list.slice(0, 60));
}

export function getChat(id) {
  return loadChats().find(c => c.id === id) || null;
}

export function upsertChat(chat) {
  const list = loadChats();
  const i = list.findIndex(c => c.id === chat.id);
  if (i === -1) list.unshift(chat);
  else list[i] = chat;
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  saveChats(list);
  return list;
}

export function deleteChat(id) {
  const list = loadChats().filter(c => c.id !== id);
  saveChats(list);
  return list;
}

export function deleteAllChats() { saveChats([]); }

export function newChat() {
  return {
    id: uid(),
    title: 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}

/** Build a chat title from the first user message. */
export function titleFrom(text = '') {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  const cut = t.length > 42 ? t.slice(0, 42).replace(/\s\S*$/, '') + '…' : t;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/* ------------------------------ backup / wipe ---------------------------- */
export function exportAll() {
  return {
    app: 'jarvis',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { ...loadSettings(), apiKey: '' },   // never export the key
    memory: loadMemory(),
    chats: loadChats(),
  };
}

export function importAll(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a Jarvis backup');
  const current = loadSettings();
  if (data.settings) write(K.settings, { ...current, ...data.settings, apiKey: current.apiKey });
  if (Array.isArray(data.memory)) saveMemory(data.memory);
  if (Array.isArray(data.chats))  saveChats(data.chats);
  return true;
}

export function wipeAll({ keepKey = true } = {}) {
  const key = keepKey ? loadSettings().apiKey : '';
  localStorage.removeItem(K.chats);
  localStorage.removeItem(K.memory);
  localStorage.removeItem(K.settings);
  if (keepKey && key) saveSettings({ ...DEFAULT_SETTINGS, apiKey: key });
}
