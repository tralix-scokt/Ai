/* ==========================================================================
   store.js — persistence (localStorage) with a real migration path.

   v2 (TRALIX) writes to `tralix.*.v2`. The previous Jarvis build wrote
   `jarvis.*.v1`. On first run we import the old data into the new keys and
   leave the legacy keys untouched, so nothing is lost and a rollback to the
   old build still finds its data.
   ========================================================================== */

import { uid } from './util.js';
import { STORAGE_PREFIX, LIMITS } from './config.js';
import { normaliseModelId } from './models.js';

const K = {
  chats:    `${STORAGE_PREFIX}.chats.v2`,
  settings: `${STORAGE_PREFIX}.settings.v2`,
  memory:   `${STORAGE_PREFIX}.memory.v2`,
  projects: `${STORAGE_PREFIX}.projects.v2`,
  meta:     `${STORAGE_PREFIX}.meta.v2`,
};

const LEGACY = {
  chats: 'jarvis.chats.v1',
  settings: 'jarvis.settings.v1',
  memory: 'jarvis.memory.v1',
};

export const SCHEMA_VERSION = 2;

export const DEFAULT_SETTINGS = {
  version: SCHEMA_VERSION,

  /* general */
  theme: 'dark',                 // 'dark' | 'light' | 'system'
  language: 'system',            // BCP-47 tag or 'system'
  density: 'comfortable',        // 'comfortable' | 'compact'
  haptics: true,

  /* ai */
  model: 'tralix-smart',         // TRALIX model id — see models.js
  responseStyle: 'balanced',     // 'concise' | 'balanced' | 'detailed'
  personality: 'tralix',         // 'tralix' | 'jarvis' | 'custom'
  persona: '',                   // custom instructions (only used with 'custom')

  /* voice */
  voice: {
    enabled: true,
    auto: false,
    voiceURI: '',
    rate: 1,
    pitch: 1,
  },

  /* memory */
  memory: {
    enabled: true,
    autoCapture: true,
  },

  /* data / backend */
  historyTurns: LIMITS.historyTurns,

  /* advanced — provider plumbing, hidden behind Advanced settings */
  advanced: {
    transport: 'backend',        // 'backend' (default) | 'local'
    localProvider: 'gemini',     // used only when transport === 'local'
    apiKey: '',                  // device-only key for local transport
    devMode: false,
  },

  onboarded: false,
  sidebarCollapsed: false,
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

const has = (key) => {
  try { return localStorage.getItem(key) !== null; } catch { return false; }
};

/* ------------------------------- migration -------------------------------- */
export function migrateLegacy() {
  const done = read(K.meta, {});
  if (done.migrated) return { migrated: false, reason: 'already-migrated' };

  const legacyChats = read(LEGACY.chats, null);
  const legacySettings = read(LEGACY.settings, null);
  const legacyMemory = read(LEGACY.memory, null);

  if (!legacyChats && !legacySettings && !legacyMemory) {
    write(K.meta, { ...done, schema: SCHEMA_VERSION, migrated: true, migratedAt: Date.now(), nothingToMigrate: true });
    return { migrated: false, reason: 'no-legacy-data' };
  }

  try {
    if (legacySettings && !has(K.settings)) {
      const { settings } = normaliseSettings(legacySettings);
      write(K.settings, settings);
    }
    if (Array.isArray(legacyChats) && !has(K.chats)) {
      write(K.chats, legacyChats.map(normaliseChat).slice(0, LIMITS.maxChats));
    }
    if (Array.isArray(legacyMemory) && !has(K.memory)) {
      write(K.memory, legacyMemory.map(normaliseMemory).slice(0, LIMITS.maxMemory));
    }
  } catch (err) {
    console.warn('[store] migration failed', err);
    return { migrated: false, reason: 'error' };
  }

  write(K.meta, {
    ...done,
    schema: SCHEMA_VERSION,
    migrated: true,
    migratedFrom: 'jarvis.v1',
    migratedAt: Date.now(),
    counts: {
      chats: Array.isArray(legacyChats) ? legacyChats.length : 0,
      memory: Array.isArray(legacyMemory) ? legacyMemory.length : 0,
    },
  });

  // Legacy keys stay exactly as they were — nothing is deleted silently.
  return { migrated: true, from: 'jarvis.v1' };
}

export function meta() { return read(K.meta, {}); }

function setMeta(patch) { write(K.meta, { ...meta(), ...patch }); }

/* -------------------------------- settings ------------------------------- */
function migrateSettingsShape(raw = {}) {
  const s = { ...raw };

  // legacy flat voice keys → nested object (v1 Jarvis)
  if (typeof s.ttsEnabled === 'boolean' || typeof s.voiceRate === 'number') {
    s.voice = {
      enabled: s.ttsEnabled !== false,
      auto: Boolean(s.ttsAuto),
      voiceURI: s.voiceURI || '',
      rate: Number(s.voiceRate) || 1,
      pitch: 1,
    };
  }
  if (typeof s.memAuto === 'boolean') {
    s.memory = { enabled: true, autoCapture: Boolean(s.memAuto) };
  }
  if (s.personaPreset && !s.persona) {
    s.personality = s.personaPreset === 'butler' ? 'jarvis' : 'tralix';
  }
  // legacy Gemini key → advanced local transport (device-only)
  if (s.apiKey) {
    s.advanced = { ...(s.advanced || {}), transport: 'local', localProvider: 'gemini', apiKey: s.apiKey };
  }
  // legacy vendor model ids map onto a TRALIX tier (single source of truth)
  s.model = normaliseModelId(s.model);
  return s;
}

export function normaliseSettings(raw = {}) {
  const migrated = migrateSettingsShape(raw);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...migrated,
    voice: { ...DEFAULT_SETTINGS.voice, ...(migrated.voice || {}) },
    memory: { ...DEFAULT_SETTINGS.memory, ...(migrated.memory || {}) },
    advanced: { ...DEFAULT_SETTINGS.advanced, ...(migrated.advanced || {}) },
    version: SCHEMA_VERSION,
  };
  if (!/^tralix-/.test(settings.model)) settings.model = DEFAULT_SETTINGS.model;
  return { settings, changed: JSON.stringify(settings) !== JSON.stringify(raw) };
}

export function loadSettings() {
  return normaliseSettings(read(K.settings, {})).settings;
}

export function saveSettings(settings) {
  return write(K.settings, { ...settings, version: SCHEMA_VERSION });
}

/* -------------------------------- projects -------------------------------- */
/** Project: { id, name, description, color, createdAt, updatedAt, archived } */
export function loadProjects() {
  const list = read(K.projects, []);
  return Array.isArray(list) ? list : [];
}

export function saveProjects(list) {
  return write(K.projects, (Array.isArray(list) ? list : []).slice(0, 40));
}

export function addProject({ name, description = '', color = '' } = {}) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return null;
  const list = loadProjects();
  const item = {
    id: uid(), name: clean, description: String(description).slice(0, 200),
    color, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
  };
  list.unshift(item);
  saveProjects(list);
  return item;
}

export function updateProject(id, patch = {}) {
  const list = loadProjects();
  const i = list.findIndex(p => p.id === id);
  if (i === -1) return null;
  list[i] = { ...list[i], ...patch, id, updatedAt: Date.now() };
  saveProjects(list);
  return list[i];
}

export function deleteProject(id) {
  saveProjects(loadProjects().filter(p => p.id !== id));
  // detach conversations rather than deleting them
  const chats = loadChats().map(c => (c.projectId === id ? { ...c, projectId: null } : c));
  saveChats(chats);
  return loadProjects();
}

export function projectById(id) {
  return loadProjects().find(p => p.id === id) || null;
}

/* --------------------------------- memory -------------------------------- */
export const MEMORY_CATEGORIES = [
  { id: 'personal', label: 'Personal', hint: 'Name, location, role, family' },
  { id: 'preferences', label: 'Preferences', hint: 'How you like things done' },
  { id: 'projects', label: 'Projects', hint: 'Things you are working on' },
  { id: 'instructions', label: 'Instructions', hint: 'Standing rules for TRALIX' },
  { id: 'other', label: 'Other', hint: 'Everything else' },
];

/** Best-effort category for a memory line (used for legacy items too). */
export function inferCategory(text = '') {
  const t = String(text).toLowerCase();
  if (/\b(i like|i love|i hate|i prefer|prefers|favorite|favourite|dislike)\b/.test(t)) return 'preferences';
  if (/\b(always|never|don'?t|do not|make sure|from now on|when i ask|respond|reply|address me)\b/.test(t)) return 'instructions';
  if (/\b(project|working on|building|repo|repository|codebase|launch)\b/.test(t)) return 'projects';
  if (/\b(my name|i am|i'm|i live|i work|my (wife|husband|son|daughter|dog|cat|birthday)|born)\b/.test(t)) return 'personal';
  return 'other';
}

/** Memory: { id, text, category, ts, editedAt?, source } */
function normaliseMemory(raw = {}) {
  const text = String(raw.text || '').trim().replace(/\s+/g, ' ');
  return {
    id: raw.id || uid(),
    text,
    category: MEMORY_CATEGORIES.some(c => c.id === raw.category) ? raw.category : inferCategory(text),
    ts: Number(raw.ts) || Date.now(),
    editedAt: raw.editedAt || null,
    source: raw.source || 'imported',
  };
}

export function loadMemory() {
  const list = read(K.memory, []);
  return Array.isArray(list) ? list.map(normaliseMemory) : [];
}

export function saveMemory(list) {
  return write(K.memory, (Array.isArray(list) ? list : []).slice(0, LIMITS.maxMemory));
}

/** Refuse to store things that look sensitive, even when asked. */
export function isSensitive(text = '') {
  const t = String(text);
  return [
    /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/,              // card numbers
    /\b(?:cvv|cvc|security code)\b/i,
    /\b(?:password|passphrase|api[ _-]?key|secret|token)\b/i,
    /\b\d{3}-\d{2}-\d{4}\b/,                                 // SSN
    /\bsk-[A-Za-z0-9_-]{16,}\b/,                             // provider keys
    /\bIBAN\b|\bswift code\b/i,
    /\b(?:pin|passport) (?:is|number)\b/i,
  ].some(re => re.test(t));
}

export function addMemory(text, { category, source = 'user' } = {}) {
  const clean = String(text).trim().replace(/\s+/g, ' ').slice(0, 400);
  if (!clean || clean.length < 2) return null;
  if (isSensitive(clean)) return { refused: true };

  const list = loadMemory();
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (list.some(m => norm(m.text) === norm(clean))) return null;

  const item = normaliseMemory({
    text: clean,
    category: category || inferCategory(clean),
    ts: Date.now(),
    source,
  });
  list.unshift(item);
  saveMemory(list);
  return item;
}

export function updateMemory(id, patch = {}) {
  const list = loadMemory();
  const i = list.findIndex(m => m.id === id);
  if (i === -1) return null;
  const text = String(patch.text ?? list[i].text).trim().replace(/\s+/g, ' ').slice(0, 400);
  if (!text) return null;
  list[i] = {
    ...list[i],
    text,
    category: patch.category || list[i].category,
    editedAt: Date.now(),
  };
  saveMemory(list);
  return list[i];
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
  const grouped = new Map();
  for (const m of list) {
    if (!grouped.has(m.category)) grouped.set(m.category, []);
    grouped.get(m.category).push(m.text);
  }
  return [...grouped.entries()]
    .map(([cat, items]) => `[${cat}]\n${items.map(i => `- ${i}`).join('\n')}`)
    .join('\n');
}

/* --------------------------------- chats --------------------------------- */
/** Chat: { id, title, createdAt, updatedAt, projectId, pinned, archived, messages:[] } */
function normaliseChat(raw = {}) {
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter(Boolean).map(m => ({
        id: m.id || uid(),
        role: m.role === 'assistant' ? 'assistant' : 'user',
        text: String(m.text ?? ''),
        ts: Number(m.ts) || Date.now(),
        ...(m.error ? { error: true } : {}),
        ...(m.code ? { code: m.code } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.feedback ? { feedback: m.feedback } : {}),
      })).slice(-LIMITS.maxMessagesPerChat)
    : [];

  return {
    id: raw.id || uid(),
    title: String(raw.title || 'New chat').slice(0, 120) || 'New chat',
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    projectId: raw.projectId || null,
    pinned: Boolean(raw.pinned),
    archived: Boolean(raw.archived),
    messages,
  };
}

export function loadChats() {
  const list = read(K.chats, []);
  return Array.isArray(list) ? list.map(normaliseChat) : [];
}

export function saveChats(list) {
  const sorted = (Array.isArray(list) ? list : [])
    .slice(0, LIMITS.maxChats)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return write(K.chats, sorted);
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

export function newChat({ projectId = null } = {}) {
  return {
    id: uid(),
    title: 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectId,
    pinned: false,
    archived: false,
    messages: [],
  };
}

/** Chat title from the first user message. */
export function titleFrom(text = '') {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  const cut = t.length > 46 ? t.slice(0, 46).replace(/\s\S*$/, '') + '…' : t;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** Snippet for the last query term — rebuilt on each searchChats call. */
export const searchSnippets = new Map();

/** Full-text search across titles and message bodies. */
export function searchChats(query = '', { includeArchived = true } = {}) {
  const q = String(query).trim().toLowerCase();
  const chats = loadChats().filter(c => includeArchived || !c.archived);
  searchSnippets.clear();
  if (!q) return chats;

  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const c of chats) {
    const haystack = `${c.title}\n${c.messages.map(m => m.text).join('\n')}`.toLowerCase();
    let score = 0;
    let matchedAll = true;
    let snippet = '';
    for (const term of terms) {
      if (c.title.toLowerCase().includes(term)) score += 6;
      const idx = haystack.indexOf(term);
      if (idx === -1) { matchedAll = false; break; }
      score += 1;
      if (!snippet) {
        snippet = haystack.slice(Math.max(0, idx - 40), idx + 80).replace(/\s+/g, ' ').trim();
      }
    }
    if (matchedAll) {
      if (snippet) searchSnippets.set(c.id, snippet);
      scored.push({ chat: c, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || b.chat.updatedAt - a.chat.updatedAt);
  return scored.map(s => s.chat);
}

/* ------------------------------ backup / wipe ---------------------------- */
export function exportAll() {
  return {
    app: 'tralix',
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: (() => {
      const s = loadSettings();
      // never export keys
      return { ...s, advanced: { ...s.advanced, apiKey: '' } };
    })(),
    memory: loadMemory(),
    chats: loadChats(),
    projects: loadProjects(),
  };
}

export function importAll(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a TRALIX backup');
  const legacySettings = data.app === 'jarvis' ? { ...data.settings, apiKey: '' } : data.settings;
  const current = loadSettings();

  if (legacySettings) {
    const { settings } = normaliseSettings(legacySettings);
    write(K.settings, {
      ...current,
      ...settings,
      // keys and transport choice are device-local — never overwritten by a file
      advanced: { ...settings.advanced, apiKey: current.advanced.apiKey, transport: current.advanced.transport },
    });
  }
  if (Array.isArray(data.memory)) saveMemory(data.memory.map(normaliseMemory));
  if (Array.isArray(data.chats))  saveChats(data.chats.map(normaliseChat));
  if (Array.isArray(data.projects)) saveProjects(data.projects);

  setMeta({ lastImportAt: Date.now() });
  return true;
}

export function wipeAll({ keepAdvanced = true, keepProjects = false } = {}) {
  const s = loadSettings();
  const keep = keepAdvanced ? s.advanced : DEFAULT_SETTINGS.advanced;
  const projects = keepProjects ? loadProjects() : null;

  try {
    localStorage.removeItem(K.chats);
    localStorage.removeItem(K.memory);
    localStorage.removeItem(K.settings);
  } catch {}

  saveSettings({ ...DEFAULT_SETTINGS, advanced: keep, onboarded: s.onboarded });
  if (projects) saveProjects(projects);
  return true;
}

export const storageKeys = K;
export const legacyKeys = LEGACY;
