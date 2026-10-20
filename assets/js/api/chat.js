/* ==========================================================================
   api/chat.js — transport selection and request assembly.

   Chooses between:
     routed  (default when the backend serves /api/v2)
                       : free-first routing across every configured provider.
     legacy  backend   : /api/chat → OpenAI. Used only by deployments that do
                         not serve /api/v2 yet.
     local   (advanced): user's own key, device-only storage.

   Nothing in the UI needs to know which one is in play — except Advanced
   settings and the debug panel, which read it from here.
   ========================================================================== */

import { FEATURES, LIMITS } from '../config.js';
import { ERROR_CODES, TralixError } from '../errors.js';
import { normaliseModelId, resolveLocal } from '../models.js';
import { buildSystemPrompt } from '../personality.js';
import * as Backend from './backend.js';
import * as Local from './local.js';
import * as V2 from './v2.js';

/**
 * Which transport will be used for the next request.
 * @param {object} settings
 * @returns {'backend'|'local'}
 */
export function activeTransport(settings) {
  const adv = settings?.advanced || {};
  if (adv.transport === 'local' && adv.apiKey) return 'local';
  return 'backend';
}

/**
 * Does this deployment route across providers? The legacy health report says so
 * (`jarvis.api` / `features.multiProviderRouting`), which the app already
 * fetched at boot — so no extra round trip is needed here.
 */
export function routingAvailable() {
  const report = Backend.cachedHealth?.();
  return Boolean(report?.jarvis?.api || report?.features?.multiProviderRouting);
}

export function transportLabel(settings) {
  return activeTransport(settings) === 'local'
    ? `Local · ${Local.providerById(settings.advanced.localProvider).label}`
    : 'JARVIS backend';
}

/** Build the message array sent to the model (trimmed history, roles normalised). */
export function buildMessages(chat, { turns = LIMITS.historyTurns } = {}) {
  const msgs = (chat?.messages || [])
    .filter(m => !m.error && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
    .slice(-turns);

  const out = [];
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${m.text}`;
    else out.push({ role, content: String(m.text).slice(0, LIMITS.maxInputChars) });
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

/** Assemble the system prompt for a request. */
export function buildInstructions({ settings, memoryText = '', hasWebSearch = false }) {
  return buildSystemPrompt({
    personality: settings.personality,
    persona: settings.persona,
    responseStyle: settings.responseStyle,
    memory: memoryText,
    memoryEnabled: settings.memory?.enabled !== false,
    hasWebSearch,
  });
}

/**
 * Send one turn.
 * @param {object} opts
 * @param {object} opts.settings
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {string} opts.instructions
 * @param {AbortSignal} [opts.signal]
 * @param {(delta:string, full:string)=>void} [opts.onDelta]
 * @param {(info:{provider:string, providerLabel:string, model:string, paid:boolean})=>void} [opts.onModel]
 * @returns {Promise<{text:string, model:string, usage:object|null, searchUsed:boolean}>}
 */
export async function send({ settings, messages, instructions, signal, onDelta, onModel }) {
  if (!messages?.length) {
    throw new TralixError(ERROR_CODES.bad_request, { message: 'There is nothing to send.', retryable: false });
  }

  const tier = normaliseModelId(settings.model);
  const transport = activeTransport(settings);
  const wantSearch = FEATURES.webSearch;

  if (transport === 'local') {
    const resolved = resolveLocal(tier, settings.advanced.localProvider);
    return Local.streamLocal({
      provider: settings.advanced.localProvider,
      apiKey: settings.advanced.apiKey,
      model: resolved.model,
      reasoning: resolved.reasoning,
      messages,
      instructions,
      signal,
      onDelta,
    });
  }

  if (routingAvailable()) {
    try {
      const routed = await V2.chat({
        messages,
        instructions,
        task: 'chat',
        // The tier the user picked ("tralix-smart") is a JARVIS tier; the
        // router speaks the same names without the brand prefix.
        tier: String(tier || '').replace(/^tralix-/, ''),
        signal,
        onDelta,
        onModel,
      });
      return {
        text: routed.text,
        model: routed.model,
        provider: routed.provider,
        providerLabel: routed.providerLabel,
        paid: Boolean(routed.paid),
        usage: null,
        searchUsed: false,
        status: 'completed',
      };
    } catch (err) {
      /*
       * Only one reason is allowed to fall back: the deployment does not serve
       * /api/v2 at all. Every routing outcome — "no eligible model", "paid
       * usage not authorised", quota — is reported, never downgraded silently
       * onto the legacy paid key.
       */
      const missingV2 = err?.status === 404 || err?.code === ERROR_CODES.not_found;
      if (!missingV2) throw err;
    }
  }

  return Backend.streamChat({
    model: tier,
    messages,
    instructions,
    signal,
    onDelta,
    webSearch: wantSearch,
  });
}

/** Backend capabilities, mapped into the feature flags the UI reads. */
export async function refreshCapabilities({ force = false } = {}) {
  const report = await Backend.health({ force });
  Backend.applyHealthToFeatures(report);
  return report;
}

export const lastHealth = () => Backend.health();

/** Load and apply the server's tier → model mapping. */
export async function syncModelMapping() {
  const data = await Backend.models();
  if (data?.models) {
    const { applyServerMapping } = await import('../models.js');
    applyServerMapping(data.models);
    return data.models;
  }
  return null;
}

export async function testConnection() {
  return Backend.ping();
}

export async function testLocalKey(provider, apiKey) {
  const { applyServerTools } = await import('../tools.js');
  applyServerTools([]);           // local mode has no server tools
  return Local.probe(provider, apiKey);
}
