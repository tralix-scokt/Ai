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

/** Where the TRALIX backend lives. '' means "same origin, /api/...". */
export function apiBase() {
  const injected = (typeof window !== 'undefined' && window.TRALIX_API_BASE) || '';
  let stored = '';
  try { stored = localStorage.getItem(API_BASE_KEY) || ''; } catch { stored = ''; }
  return normaliseBase(stored || injected || '');
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
