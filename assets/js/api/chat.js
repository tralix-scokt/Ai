/* ==========================================================================
   api/chat.js — transport selection and request assembly.

   Chooses between:
     backend (default) : TRALIX backend → OpenAI. Key lives server-side.
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

export function transportLabel(settings) {
  return activeTransport(settings) === 'local'
    ? `Local · ${Local.providerById(settings.advanced.localProvider).label}`
    : 'TRALIX backend';
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
 * @returns {Promise<{text:string, model:string, usage:object|null, searchUsed:boolean}>}
 */
export async function send({ settings, messages, instructions, signal, onDelta }) {
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
