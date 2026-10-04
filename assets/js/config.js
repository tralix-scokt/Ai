/* ==========================================================================
   config.js — single place for product identity and runtime configuration.

   TRALIX AI is provider-agnostic: the UI never talks to an AI vendor directly.
   It talks to the TRALIX backend (`/api/chat`), which holds the vendor key
   server-side. See server/README.md for deployment.
   ========================================================================== */

export const APP = {
  name: 'TRALIX AI',
  shortName: 'TRALIX',
  tagline: 'Intelligent AI Assistant',
  version: '2.0.0',
  supportEmail: '',                       // optional, shown in error states
};

/** LocalStorage key override for the backend base URL (Advanced settings). */
export const API_BASE_KEY = 'tralix.backend.v1';

/**
 * Committed, non-secret deployment pointer. GitHub Pages cannot host the
 * backend, so the deployed frontend needs to know where it lives. This file is
 * public by design: it contains a URL, never a key.
 *
 * Resolution order (first non-empty wins):
 *   1. the device override saved in Advanced settings / the connect sheet
 *   2. window.TRALIX_API_BASE (set by an embedding page)
 *   3. ?api=https://… in the URL (handy for testing a new deployment)
 *   4. ./backend.json  { "url": "https://…" }
 *   5. same origin — correct when server/node.js serves the app and API together
 */
export const BACKEND_CONFIG_PATH = './backend.json';

let remoteBase = '';          // filled in by loadBackendConfig()
let queryBase = '';
let configLoaded = false;

export function apiBase() {
  const injected = (typeof window !== 'undefined' && window.TRALIX_API_BASE) || '';
  let stored = '';
  try { stored = localStorage.getItem(API_BASE_KEY) || ''; } catch { stored = ''; }
  return normaliseBase(stored || injected || queryBase || remoteBase || '');
}

/** Where the base URL currently in use came from — shown in Diagnostics. */
export function apiBaseSource() {
  let stored = '';
  try { stored = localStorage.getItem(API_BASE_KEY) || ''; } catch { /* private mode */ }
  if (stored) return 'device override';
  if (typeof window !== 'undefined' && window.TRALIX_API_BASE) return 'window.TRALIX_API_BASE';
  if (queryBase) return '?api= parameter';
  if (remoteBase) return 'backend.json';
  return 'same origin';
}

export const backendConfigLoaded = () => configLoaded;

/**
 * Read ?api= and ./backend.json once, before the first health check.
 * Never throws: a missing or malformed file just means "same origin".
 */
export async function loadBackendConfig() {
  if (typeof window === 'undefined') return '';
  try {
    const params = new URLSearchParams(window.location?.search || '');
    const fromQuery = params.get('api') || params.get('backend') || '';
    if (fromQuery) queryBase = normaliseBase(fromQuery);
  } catch { /* no URL support */ }

  if (queryBase) { configLoaded = true; return apiBase(); }

  try {
    const res = await fetch(BACKEND_CONFIG_PATH, { cache: 'no-store', credentials: 'omit' });
    if (res.ok) {
      const data = await res.json();
      const url = normaliseBase(data?.url || data?.apiBase || '');
      // Only accept an absolute http(s) URL or an explicit relative base.
      if (url && (/^https?:\/\//i.test(url) || url.startsWith('/'))) remoteBase = url;
    }
  } catch { /* no config file — same origin */ }

  configLoaded = true;
  return apiBase();
}

export function setApiBase(url) {
  let stored = String(url || '').trim();
  try {
    if (stored) localStorage.setItem(API_BASE_KEY, stored);
    else localStorage.removeItem(API_BASE_KEY);
  } catch { /* private mode — runtime override only */ }
}

/** Trim slashes/spaces so endpoint building is predictable. */
export function normaliseBase(url = '') {
  return String(url).trim().replace(/\s+/g, '').replace(/\/+$/, '');
}

/** Absolute URL for a backend endpoint, e.g. endpoint('/chat'). */
export function apiUrl(path = '') {
  const base = apiBase();
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}/api${suffix}`;
}

/** Feature flags. Anything false is advertised honestly in the UI. */
export const FEATURES = {
  backendProxy: true,        // TRALIX backend (OpenAI) — the default path
  localByoKey: true,         // advanced: user's own provider key, device-only
  attachments: false,        // file uploads need the backend file pipeline
  webSearch: false,          // enabled per-deployment when the backend has it
  codeExecution: false,
  projects: true,
  memory: true,
  voice: true,
  export: true,
};

/** Tunables (kept out of components). */
export const LIMITS = {
  maxMessagesPerChat: 400,
  maxChats: 80,
  maxMemory: 300,
  historyTurns: 24,          // messages of context sent to the model
  maxInputChars: 16000,
  maxAttachmentBytes: 12 * 1024 * 1024,
  requestTimeoutMs: 120000,
  healthTimeoutMs: 6000,
};

export const STORAGE_PREFIX = 'tralix';
