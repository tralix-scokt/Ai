/* ==========================================================================
   providers.js — compatibility shim (TRALIX 2.0).

   The previous build kept the whole AI stack in this one file. TRALIX now
   separates that work:

     personality.js   the TRALIX voice, styles and memory extraction
     models.js        the TRALIX tier system (fast / smart / code / research)
     api/backend.js   the secure TRALIX backend client (default transport)
     api/local.js     the optional device-only provider transport

   This module stays so older imports keep working, and simply re-exports the
   new pieces. It never talks to a provider itself — that only happens in
   api/local.js (opt-in) or on the server.
   ========================================================================== */

export { MODELS, modelById, normaliseModelId, RESPONSE_STYLES, RESPONSE_ACTIONS } from './models.js';
export {
  buildSystemPrompt,
  extractMemoryCandidates,
  isRememberRequest,
  PERSONA_PRESETS,
  TRALIX_CORE as DEFAULT_PERSONA,
} from './personality.js';
export { TralixError as AIError } from './errors.js';
export { TralixError as AIErrorClass } from './errors.js';

import { normaliseModelId } from './models.js';
import { LOCAL_PROVIDERS, probe as localProbe, streamLocal } from './api/local.js';

/** Legacy provider list, kept for older callers. */
export const LOCAL_PROVIDER_LIST = LOCAL_PROVIDERS;

/**
 * Legacy key check. Local transport only — the default TRALIX transport keeps
 * keys on the server, so there is nothing to verify client-side.
 */
export async function verifyKey(apiKey, provider = 'gemini') {
  return localProbe(provider, apiKey);
}

export const probeModels = verifyKey;

/** Legacy entry point; prefer api/chat.js#send. */
export async function streamChat(opts) {
  return streamLocal({
    provider: opts.provider || 'gemini',
    apiKey: opts.apiKey,
    model: opts.model,
    messages: opts.messages,
    instructions: opts.systemPrompt,
    signal: opts.signal,
    onDelta: opts.onDelta,
  });
}

/** The previous build's "best available model" helper, mapped to TRALIX tiers. */
export function bestAvailableModel(preferred) {
  return normaliseModelId(preferred);
}
