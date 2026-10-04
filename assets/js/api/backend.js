/* ==========================================================================
   api/backend.js — the TRALIX backend client.

   The frontend never talks to an AI vendor directly and never holds a provider
   key. It speaks to our own API:

       POST /api/chat    → SSE stream of {type:'delta'|'done'|'error'}
       GET  /api/health  → capability + configuration report
       GET  /api/models  → TRALIX tier → provider model mapping

   Deployable on Cloudflare Workers, Vercel, Netlify or Node — see server/.
   ========================================================================== */

import { apiUrl, APP, FEATURES, LIMITS } from '../config.js';
import { TralixError, ERROR_CODES, codeFromStatus } from '../errors.js';
import { request, getJson, errorFromResponse, readSse } from './client.js';

/** Is a TRALIX backend reachable? Cached briefly to keep the UI snappy. */
let healthCache = { at: 0, value: null };

export async function health({ force = false, timeoutMs = LIMITS.healthTimeoutMs } = {}) {
  const now = Date.now();
  if (!force && healthCache.value && now - healthCache.at < 45000) return healthCache.value;

  try {
    const res = await request(apiUrl('/health'), { method: 'GET', timeoutMs });
    if (!res.ok) throw await errorFromResponse(res);
    const data = await res.json();
    const value = { ok: true, ...data };
    healthCache = { at: now, value };
    return value;
  } catch (err) {
    const error = err instanceof TralixError ? err : new TralixError(ERROR_CODES.network, { detail: String(err) });
    const value = { ok: false, error: error.code, detail: error.detail, message: error.message };
    healthCache = { at: now, value };
    return value;
  }
}

export const clearHealthCache = () => { healthCache = { at: 0, value: null }; };

/** Model mapping (tier → provider model). Safe to fail: the local fallback applies. */
export async function models() {
  try {
    return await getJson('/models', { timeoutMs: LIMITS.healthTimeoutMs });
  } catch {
    return null;
  }
}

/**
 * Stream a completion from the TRALIX backend.
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {string} opts.instructions      system prompt (built client-side, enforced server-side too)
 * @param {string} opts.model             TRALIX tier id
 * @param {AbortSignal} [opts.signal]
 * @param {(delta:string, full:string)=>void} [opts.onDelta]
 * @param {boolean} [opts.webSearch]      request the search tool when the backend has it
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{text:string, model:string, usage:object|null, searchUsed:boolean}>}
 */
export async function streamChat({
  messages,
  instructions,
  model,
  signal,
  onDelta,
  webSearch = false,
  timeoutMs = LIMITS.requestTimeoutMs,
}) {
  const payload = {
    model,
    instructions,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: true,
    ...(webSearch ? { tools: ['web_search'] } : {}),
    client: { name: APP.name, version: APP.version },
  };

  let res;
  try {
    res = await request(apiUrl('/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      timeoutMs,
      signal,
    });
  } catch (err) {
    throw err instanceof TralixError ? err : new TralixError(ERROR_CODES.network, { detail: String(err) });
  }

  if (!res.ok) throw await errorFromResponse(res);

  let full = '';
  let modelUsed = model;
  let usage = null;
  let searchUsed = false;
  let sawAny = false;

  const emit = (delta) => {
    if (!delta) return;
    sawAny = true;
    full += delta;
    onDelta?.(delta, full);
  };

  for await (const event of readSse(res, { onRawText: emit })) {
    if (!event || typeof event !== 'object') continue;

    switch (event.type) {
      case 'delta':
      case 'response.output_text.delta':
        emit(event.text ?? event.delta ?? '');
        break;

      case 'model':
        if (event.model) modelUsed = event.model;
        break;

      case 'search':
        searchUsed = true;
        break;

      case 'usage':
        usage = event.usage || null;
        break;

      case 'done':
      case 'response.completed':
        if (event.text) emit(event.text);
        if (event.model) modelUsed = event.model;
        if (event.usage) usage = event.usage;
        break;

      case 'error': {
        const code = Object.values(ERROR_CODES).includes(event.code)
          ? event.code
          : codeFromStatus(Number(event.status) || 500, event.code || '');
        throw new TralixError(code, {
          status: Number(event.status) || 0,
          detail: event.message || event.detail || 'backend error',
          message: event.userMessage,
        });
      }

      default:
        break;
    }
  }

  if (!sawAny) {
    throw new TralixError(ERROR_CODES.unknown, { message: 'The model returned nothing. Try rephrasing.', detail: 'empty stream' });
  }

  return { text: full, model: modelUsed, usage, searchUsed };
}

/**
 * Non-streaming backend call — used by the Advanced "test connection" action.
 */
export async function ping(timeoutMs = 8000) {
  const res = await request(apiUrl('/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'tralix-fast',
      instructions: 'Reply with the single word: ready',
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      client: { name: APP.name, version: APP.version },
    }),
    timeoutMs,
  });
  if (!res.ok) throw await errorFromResponse(res);
  const data = await res.json().catch(() => ({}));
  return { text: String(data.text || data.output_text || '').trim(), model: data.model || '' };
}

/** Apply a health report to runtime feature flags (honest UI). */
export function applyHealthToFeatures(report) {
  if (!report || !report.ok) return;
  if (Array.isArray(report.tools)) {
    FEATURES.webSearch = report.tools.includes('web_search');
    FEATURES.codeExecution = report.tools.includes('code_execution');
    FEATURES.attachments = Boolean(report.features?.attachments);
  } else if (report.features) {
    if (typeof report.features.webSearch === 'boolean') FEATURES.webSearch = report.features.webSearch;
    if (typeof report.features.attachments === 'boolean') FEATURES.attachments = report.features.attachments;
  }
}
