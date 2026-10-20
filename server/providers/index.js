/* ==========================================================================
   server/providers/index.js — the provider catalogue.

   Every provider is a small module with the same three entry points
   (probe / streamChat / chat). Adding a provider means adding one module and
   one entry here — nothing in the router, tasks or routes changes.

   Honesty rules baked into this file:
     • `freeTier` describes whether the vendor publishes a *free* API tier.
       It is a hint for ordering, never a guarantee — only `probe()` proves
       that a key works, and only the vendor knows the remaining quota.
     • `capabilities` are what this adapter actually implements. A capability
       we cannot verify is listed as `false`, not as `true` optimistically.
     • Model ids below are defaults, not promises. They are checked against
       the provider's live model list after a probe and reported as
       verified / unverified rather than silently swapped.
   ========================================================================== */

import { createCompatibleAdapter, bearer } from './compatible.js';
import * as openai from './openai.js';
import * as gemini from './gemini.js';
import * as anthropic from './anthropic.js';

/* --------------------------- compatible providers ------------------------- */

const groq = createCompatibleAdapter({
  id: 'groq',
  label: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  authHeaders: bearer,
  models: {
    fast: 'openai/gpt-oss-20b',
    smart: 'openai/gpt-oss-120b',
    code: 'qwen/qwen3.8-27b',
    research: 'openai/gpt-oss-120b',
  },
  supportsEffort: () => false,
});

const openrouter = createCompatibleAdapter({
  id: 'openrouter',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  authHeaders: (key) => ({
    Authorization: `Bearer ${String(key || '').trim()}`,
    'HTTP-Referer': 'https://github.com/tralix-scokt/Ai',
    'X-Title': 'JARVIS STUDIO',
  }),
  models: {
    // Resolved from the live catalogue: OpenRouter tags free models with :free
    // and reports pricing, so we prefer discovery over hard-coded ids.
    fast: '',
    smart: '',
    code: '',
    research: '',
  },
  supportsEffort: () => false,
});

const ollama = createCompatibleAdapter({
  id: 'ollama',
  label: 'Ollama (local)',
  baseUrl: 'http://127.0.0.1:11434/v1',
  authHeaders: () => ({}),
  models: {
    fast: 'qwen2.5-coder:7b',
    smart: 'llama3.1:8b',
    code: 'qwen2.5-coder:7b',
    research: 'llama3.1:8b',
  },
  supportsEffort: () => false,
});

const mistral = createCompatibleAdapter({
  id: 'mistral',
  label: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  authHeaders: bearer,
  models: {
    fast: 'mistral-small-latest',
    smart: 'mistral-medium-latest',
    code: 'codestral-latest',
    research: 'mistral-large-latest',
  },
  supportsEffort: () => false,
});

/* ------------------------------ the catalogue ----------------------------- */

/**
 * @typedef {object} ProviderCatalogEntry
 * @property {string} id
 * @property {string} label
 * @property {boolean} freeTier          vendor publishes a free API tier
 * @property {'free'|'paid'|'local'} kind
 * @property {string} envKey             environment variable holding the key
 * @property {string} envBaseKey         environment variable overriding the URL
 * @property {string} docsUrl
 * @property {string} note               one-line, shown in Settings
 * @property {object} capabilities
 * @property {object} models             default model per tier
 * @property {boolean} requiresKey       false for local providers
 * @property {number} priority           lower wins (user-overridable)
 */
export const CATALOG = [
  {
    ...gemini,
    id: 'gemini',
    envKey: 'GEMINI_API_KEY',
    envBaseKey: 'GEMINI_BASE_URL',
    freeTier: true,
    kind: 'free',
    requiresKey: true,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    note: 'Generous free tier with per-minute limits. Great default for Free-first routing.',
    capabilities: { chat: true, streaming: true, json: true, vision: true, tools: true, code: true },
    priority: 10,
  },
  {
    ...groq,
    id: 'groq',
    envKey: 'GROQ_API_KEY',
    envBaseKey: 'GROQ_BASE_URL',
    freeTier: true,
    kind: 'free',
    requiresKey: true,
    docsUrl: 'https://console.groq.com/docs/rate-limits',
    note: 'Very fast free tier. Model availability changes often — the probe verifies it.',
    capabilities: { chat: true, streaming: true, json: true, vision: false, tools: true, code: true },
    priority: 20,
  },
  {
    ...openrouter,
    id: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    envBaseKey: 'OPENROUTER_BASE_URL',
    freeTier: true,
    kind: 'free',
    requiresKey: true,
    docsUrl: 'https://openrouter.ai/docs/models',
    note: 'Aggregator. Free models are tagged ":free"; free list is discovered from the live catalogue.',
    capabilities: { chat: true, streaming: true, json: true, vision: false, tools: false, code: true },
    priority: 30,
    discover: async ({ key, baseUrl, signal }) => discoverOpenRouterModels({ key, baseUrl, signal }),
  },
  {
    ...ollama,
    id: 'ollama',
    envKey: '',
    envBaseKey: 'OLLAMA_BASE_URL',
    freeTier: true,
    kind: 'local',
    requiresKey: false,
    docsUrl: 'https://ollama.com/docs',
    note: 'Free and offline. Requires Ollama running on the same host as the backend.',
    capabilities: { chat: true, streaming: true, json: true, vision: false, tools: false, code: true },
    priority: 40,
  },
  {
    ...openai,
    id: 'openai',
    envKey: 'OPENAI_API_KEY',
    envBaseKey: 'OPENAI_BASE_URL',
    freeTier: false,
    kind: 'paid',
    requiresKey: true,
    docsUrl: 'https://platform.openai.com/docs/models',
    note: 'Paid only. Used when you authorise paid usage or set it as the preferred provider.',
    capabilities: { chat: true, streaming: true, json: true, vision: true, tools: true, code: true },
    priority: 50,
  },
  {
    ...anthropic,
    id: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    envBaseKey: 'ANTHROPIC_BASE_URL',
    freeTier: false,
    kind: 'paid',
    requiresKey: true,
    docsUrl: 'https://docs.anthropic.com/en/docs/models',
    note: 'Paid only. Strong at review and long-context reasoning.',
    capabilities: { chat: true, streaming: true, json: true, vision: true, tools: false, code: true },
    priority: 60,
  },
  {
    ...mistral,
    id: 'mistral',
    envKey: 'MISTRAL_API_KEY',
    envBaseKey: 'MISTRAL_BASE_URL',
    freeTier: true,
    kind: 'paid',                    // free "experimental" tier, not guaranteed
    requiresKey: true,
    docsUrl: 'https://docs.mistral.ai/deployment/laplateforme/limits',
    note: 'Codestral and Mistral models. A limited free "experimental" tier exists on some accounts.',
    capabilities: { chat: true, streaming: true, json: true, vision: false, tools: true, code: true },
    priority: 70,
  },
];

export const PROVIDER_IDS = CATALOG.map(p => p.id);
export const byId = (id) => CATALOG.find(p => p.id === id) || null;

/** The tier names the UI and the router speak. */
export const TIERS = ['fast', 'smart', 'code', 'research'];

export const TIER_LABELS = {
  fast: 'Fast',
  smart: 'Smart',
  code: 'Code',
  research: 'Research',
};

/**
 * OpenRouter publishes prices in its catalogue, so free models can be found
 * rather than guessed. Returns up-to-date ids or an empty object on failure —
 * the router marks models unverified when discovery fails.
 */
export async function discoverOpenRouterModels({ key, baseUrl, signal, timeoutMs = 8000 } = {}) {
  const base = String(baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = () => controller.abort('cancelled');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${String(key || '').trim()}` },
      signal: controller.signal,
    });
    if (!res.ok) return {};
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.data) ? data.data : [];

    const isFree = (m) => {
      const p = m?.pricing || {};
      const num = (v) => (v === undefined || v === null ? Number.NaN : Number(v));
      return [num(p.prompt), num(p.completion), num(p.request)].every(v => Number.isNaN(v) || v === 0);
    };
    const free = list.filter(isFree)
      .map(m => ({
        id: String(m.id),
        context: Number(m.context_length || m.top_provider?.context_length || 0) || 0,
      }))
      .sort((a, b) => b.context - a.context);

    if (!free.length) return {};
    const pick = (needle) => free.find(m => needle.test(m.id))?.id || '';
    return {
      code: pick(/coder|code|dev(stral)?|qwen/i) || free[0].id,
      smart: pick(/instruct|chat|qwen|deepseek|gemma|llama/i) || free[0].id,
      fast: pick(/lite|small|mini|8b|7b|flash/i) || free[0].id,
      research: pick(/r1|reason|deepseek|qwen|large|70b/i) || free[0].id,
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
