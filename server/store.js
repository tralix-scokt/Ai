/* ==========================================================================
   server/store.js — server-side persistence.

   Node deployments: JSON files under a data directory (default ./data),
   created on demand and git-ignored. Secrets live in a separate file with
   0600 permissions so a stray `cat data/*` does not print an API key.

   Cloudflare Workers (and any runtime without fs): the module transparently
   falls back to an in-memory store. That is an honest degradation — settings
   survive for the life of the isolate and reset on redeploy. Use a Workers KV
   binding or run the Node server if you need durable settings.

   Nothing here is encrypted at rest on purpose: the whole point is that the
   data directory lives on a host you control and is never committed. If you
   need encryption at rest, put the data directory on an encrypted volume.
   ========================================================================== */

import { redact } from './lib/http.js';

let fs = null;
let path = null;
let dataDir = '';
let mode = 'memory';                       // 'file' | 'memory'
const memory = new Map();

/** Call once per process (idempotent). */
export async function init({ dir = '', env = {} } = {}) {
  dataDir = String(dir || env.JARVIS_DATA_DIR || env.TRALIX_DATA_DIR || '').trim()
    || './data';
  if (mode === 'file') return mode;
  try {
    fs = await import('node:fs/promises');
    path = await import('node:path');
    await fs.mkdir(resolve(''), { recursive: true, mode: 0o700 });
    mode = 'file';
  } catch {
    mode = 'memory';
    console.warn('[jarvis] no filesystem available — settings are in-memory only');
  }
  return mode;
}

export const storageMode = () => mode;

function resolve(file) {
  if (!file) return path ? path.resolve(process.cwd(), dataDir) : dataDir;
  return path.resolve(process.cwd(), dataDir, file);
}

async function readFile(name, fallback) {
  if (mode !== 'file') return memory.has(name) ? memory.get(name) : fallback;
  try {
    const raw = await fs.readFile(resolve(name), 'utf8');
    if (mode === 'file' && name === 'secrets.json') { /* no-op, keeps intent visible */ }
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    console.warn(`[jarvis] could not read ${name}:`, redact(String(err?.message || err)));
    return fallback;
  }
}

async function writeFile(name, value, chmod) {
  if (mode !== 'file') { memory.set(name, value); return true; }
  try {
    const target = resolve(name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, JSON.stringify(value, null, 2), { mode: 0o600 });
    if (chmod && fs.chmod) await fs.chmod(target, chmod).catch(() => {});
    return true;
  } catch (err) {
    console.warn(`[jarvis] could not write ${name}:`, redact(String(err?.message || err)));
    return false;
  }
}

/* ------------------------------- settings --------------------------------- */

export const DEFAULT_SETTINGS = {
  version: 3,
  routing: {
    mode: 'free-first',            // 'free-first' | 'free-only' | 'balanced'
    paidFallback: false,           // explicit permission to spend money
    monthlyLimitUsd: 0,            // 0 = no limit configured → paid usage stays off
    preferProvider: '',            // optional favourite, still capability-checked
    allowParallelModels: false,    // e.g. one model plans, another reviews
    reviewWithSecondModel: true,   // only when a second eligible model exists
  },
  providers: {},                   // id → { enabled, priority, baseUrl, paidAllowed }
  github: {
    mode: 'pat',                   // 'pat' | 'app' | 'oauth'
    defaultBranch: '',
    selectedRepo: '',              // "owner/name"
    selectedBranch: '',
    branchPrefix: 'jarvis/',
  },
  tasks: {
    autonomy: 'review-changes',    // 'review-plan' | 'review-changes' | 'full'
    maxRepairAttempts: 2,
    maxFilesPerTask: 12,
    maxFileBytes: 120000,
    runChecks: true,
    commands: [],                  // extra allowlisted commands per project
  },
  sandbox: {
    driver: 'process',             // 'process' | 'docker'
    network: 'off',                // 'off' | 'on'
    timeoutMs: 180000,
    maxOutputBytes: 262144,
    memoryMb: 512,
    dockerImage: 'node:20-slim',
  },
  voice: {
    provider: 'fish-audio',        // 'fish-audio' | 'browser'
    enabled: true,
    autoSpeak: false,
    model: 's2-pro',
    referenceId: '',
    speed: 1,
    format: 'mp3',
  },
  security: {
    // When JARVIS_WRITE_TOKEN is set on the server, mutating endpoints require
    // it. The token itself is only ever read from the environment.
    writeTokenConfigured: false,
  },
};

export async function getSettings() {
  const stored = await readFile('settings.json', null);
  if (!stored || typeof stored !== 'object') return structuredClone(DEFAULT_SETTINGS);
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...stored,
    routing: { ...DEFAULT_SETTINGS.routing, ...(stored.routing || {}) },
    github: { ...DEFAULT_SETTINGS.github, ...(stored.github || {}) },
    tasks: { ...DEFAULT_SETTINGS.tasks, ...(stored.tasks || {}) },
    sandbox: { ...DEFAULT_SETTINGS.sandbox, ...(stored.sandbox || {}) },
    voice: { ...DEFAULT_SETTINGS.voice, ...(stored.voice || {}) },
    security: { ...DEFAULT_SETTINGS.security, ...(stored.security || {}) },
    providers: { ...(stored.providers || {}) },
  };
}

export async function patchSettings(patch = {}) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    routing: { ...current.routing, ...(patch.routing || {}) },
    github: { ...current.github, ...(patch.github || {}) },
    tasks: { ...current.tasks, ...(patch.tasks || {}) },
    sandbox: { ...current.sandbox, ...(patch.sandbox || {}) },
    voice: { ...current.voice, ...(patch.voice || {}) },
  };
  // Never let a client write the security block.
  next.security = current.security;
  await writeFile('settings.json', next);
  return next;
}

/* -------------------------------- secrets --------------------------------- */

/**
 * Secrets (provider keys, GitHub tokens) are stored separately from settings.
 * They are write-only through the API: a read returns a hint, never the value.
 */
export async function getSecrets() {
  return await readFile('secrets.json', {}) || {};
}

export async function getSecret(name) {
  return (await getSecrets())[name] || '';
}

export async function setSecret(name, value) {
  const all = await getSecrets();
  if (value === '' || value === null || value === undefined) delete all[name];
  else all[name] = String(value);
  await writeFile('secrets.json', all, 0o600);
  return Boolean(value);
}

/** `sk-…7f3a` — enough to recognise a key, not enough to use it. */
export function hint(value) {
  const text = String(value || '');
  if (text.length <= 8) return text ? '••••' : '';
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

/* --------------------------------- usage ---------------------------------- */

const periodNow = () => new Date().toISOString().slice(0, 7);      // YYYY-MM

export async function getUsage() {
  const stored = await readFile('usage.json', null);
  const period = periodNow();
  if (!stored || stored.period !== period) {
    return { period, since: new Date().toISOString(), providers: {}, paidRequests: 0, estimatedUsd: 0 };
  }
  return stored;
}

/**
 * Record one completion. Only numbers the provider actually reported are
 * stored — there is no guessing. `usd` is passed by the router only when the
 * provider published a price for the model (OpenRouter does).
 */
export async function recordUsage({ provider, model, kind = 'free', usage = null, usd = null, ok = true }) {
  const ledger = await getUsage();
  const entry = ledger.providers[provider] || {
    requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, models: {},
  };
  entry.requests += 1;
  if (!ok) entry.errors += 1;
  if (usage) {
    entry.inputTokens += Number(usage.inputTokens || 0);
    entry.outputTokens += Number(usage.outputTokens || 0);
  }
  if (typeof usd === 'number' && Number.isFinite(usd)) {
    entry.estimatedUsd = Number((entry.estimatedUsd + usd).toFixed(6));
    ledger.estimatedUsd = Number(((ledger.estimatedUsd || 0) + usd).toFixed(6));
  }
  if (model) entry.models[model] = (entry.models[model] || 0) + 1;
  if (kind === 'paid' && ok) ledger.paidRequests = (ledger.paidRequests || 0) + 1;
  ledger.providers[provider] = entry;
  ledger.updatedAt = new Date().toISOString();
  await writeFile('usage.json', ledger);
  return ledger;
}

/* --------------------------------- tasks ---------------------------------- */

const taskFile = (id) => `tasks/${String(id).replace(/[^a-z0-9_-]/gi, '')}.json`;

export async function saveTask(task) {
  await writeFile(taskFile(task.id), task);
  return task;
}

export async function getTask(id) {
  return await readFile(taskFile(id), null);
}

export async function listTasks({ limit = 50 } = {}) {
  if (mode !== 'file') {
    return [...memory.keys()]
      .filter(k => k.startsWith('tasks/'))
      .map(k => memory.get(k))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);
  }
  try {
    const dir = resolve('tasks');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const files = await fs.readdir(dir);
    const tasks = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const task = await readFile(`tasks/${file}`, null);
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit);
  } catch {
    return [];
  }
}

export async function deleteTask(id) {
  if (mode !== 'file') { memory.delete(taskFile(id)); return true; }
  try { await fs.unlink(resolve(taskFile(id))); return true; } catch { return false; }
}

/* -------------------------------- sessions -------------------------------- */

/** Short-lived OAuth/session records. Ephemeral by design. */
const sessions = new Map();
export const putSession = (id, value, ttlMs = 8 * 3600_000) => {
  sessions.set(id, { ...value, expiresAt: Date.now() + ttlMs });
  for (const [key, entry] of sessions) if (entry.expiresAt < Date.now()) sessions.delete(key);
  return id;
};
export const getSession = (id) => {
  const entry = sessions.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { sessions.delete(id); return null; }
  return entry;
};
export const dropSession = (id) => sessions.delete(id);
