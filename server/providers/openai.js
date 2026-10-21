/* ==========================================================================
   server/providers/openai.js — OpenAI adapter (Responses API).

   The provider the project already shipped with. Uses the Responses API for
   chat (streaming + buffered) and GET /v1/models to *prove* a key works
   instead of assuming it.

   Paid provider: OpenAI has no general free API tier. It participates in
   routing only when the deployment explicitly allows paid usage.
   ========================================================================== */

import { CODES, safeUpstreamMessage, redact } from '../lib/http.js';

export const id = 'openai';
export const label = 'OpenAI';
export const protocol = 'openai-responses';
export const freeTier = false;

export const models = {
  fast: 'gpt-5-mini',
  smart: 'gpt-5',
  code: 'gpt-5-codex',
  research: 'gpt-5',
};

const DEFAULT_BASE = 'https://api.openai.com/v1';
export const defaultBaseUrl = DEFAULT_BASE;

const normaliseBase = (url) => String(url || DEFAULT_BASE).replace(/\/+$/, '');

function buildInput(messages) {
  return (messages || []).map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: [{
      type: message.role === 'assistant' ? 'output_text' : 'input_text',
      text: String(message.content ?? message.text ?? ''),
    }],
  }));
}

/** GET /v1/models — authenticates the key without spending tokens. */
export async function probe({ key, baseUrl, signal, timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('probe-timeout'), timeoutMs);
  const onAbort = () => controller.abort('cancelled');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(`${normaliseBase(baseUrl)}/models`, {
      headers: { Authorization: `Bearer ${String(key || '').trim()}` },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;

    if (res.status === 401 || res.status === 403) {
      return { status: 'unauthorized', verified: false, models: [], latencyMs, httpStatus: res.status, message: safeUpstreamMessage(res.status) };
    }
    if (res.status === 429) {
      return { status: 'rate_limit', verified: true, models: [], latencyMs, httpStatus: res.status, message: safeUpstreamMessage(429) };
    }
    if (!res.ok) {
      return { status: 'upstream_error', verified: false, models: [], latencyMs, httpStatus: res.status, message: safeUpstreamMessage(res.status) };
    }

    const data = await res.json().catch(() => null);
    const list = Array.isArray(data?.data) ? data.data.map(m => m?.id).filter(Boolean) : [];
    return {
      status: 'ok',
      verified: true,
      models: list,
      latencyMs,
      message: list.length
        ? `OpenAI responded with ${list.length} models.`
        : 'OpenAI accepted the key (a gateway returned no model list).',
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      status: aborted ? 'upstream_timeout' : 'unreachable',
      verified: false,
      models: [],
      latencyMs: Date.now() - started,
      message: aborted
        ? 'OpenAI did not respond in time.'
        : 'The JARVIS backend cannot reach OpenAI from its network.',
      detail: redact(String(err?.message || err)),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Stream a completion. Emits {text, model, usage} and calls onDelta(text, full)
 * as tokens arrive. Aborting `signal` cancels the upstream request.
 */
export async function streamChat({
  key, baseUrl, model, messages, instructions, effort = '',
  maxTokens = 4096, signal, timeoutMs = 120_000, onDelta, tools = null,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = () => controller.abort('client-aborted');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(`${normaliseBase(baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(key || '').trim()}`,
      },
      body: JSON.stringify({
        model,
        instructions: instructions || undefined,
        input: buildInput(messages),
        stream: true,
        max_output_tokens: maxTokens,
        ...(effort && !/^gpt-4/.test(model) ? { reasoning: { effort } } : {}),
        ...(tools?.length ? { tools } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: CODES.aborted });
    const e = new Error('OpenAI could not be reached.');
    e.code = CODES.network;
    e.detail = redact(String(err?.message || err));
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || !res.body) {
    const payload = await res.json().catch(() => ({}));
    const vendor = String(payload?.error?.code || payload?.error?.type || '');
    const err = new Error(safeUpstreamMessage(res.status, vendor));
    err.code = res.status === 429
      ? (/quota|insufficient|credit|billing/i.test(vendor) ? CODES.quota_exceeded : CODES.rate_limit)
      : res.status === 401 || res.status === 403 ? CODES.unauthorized
        : res.status >= 500 ? CODES.provider_unavailable
          : CODES.bad_request;
    err.status = res.status;
    err.detail = redact(JSON.stringify(payload));
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage = null;
  let usedModel = model;
  let status = 'completed';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let event;
          try { event = JSON.parse(raw); } catch { continue; }

          if (event.type === 'response.created' && event.response?.model) {
            usedModel = event.response.model;
          } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            full += event.delta;
            onDelta?.(event.delta, full);
          } else if (event.type === 'response.completed' && event.response) {
            const u = event.response.usage;
            if (u) usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens };
            status = event.response.status || 'completed';
            return { text: full, model: usedModel, usage, status, provider: id };
          } else if (event.type === 'response.incomplete') {
            status = 'incomplete';
            return { text: full, model: usedModel, usage, status, provider: id };
          } else if (event.type === 'response.failed' || event.type === 'error') {
            const err = new Error('OpenAI stopped before finishing the answer.');
            err.code = CODES.provider_unavailable;
            err.detail = redact(String(event?.response?.error?.message || event?.message || ''));
            throw err;
          }
        }
      }
    }
    return { text: full, model: usedModel, usage, status: full ? 'incomplete' : 'empty', provider: id };
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/** Buffered (non-streaming) completion — used by planning/review sub-tasks. */
export async function chat(opts) {
  const { key, baseUrl, model, messages, instructions, effort = '', maxTokens = 2048, signal, timeoutMs = 120_000, tools = null } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = () => controller.abort('client-aborted');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(`${normaliseBase(baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(key || '').trim()}`,
      },
      body: JSON.stringify({
        model,
        instructions: instructions || undefined,
        input: buildInput(messages),
        stream: false,
        max_output_tokens: maxTokens,
        ...(effort && !/^gpt-4/.test(model) ? { reasoning: { effort } } : {}),
        ...(tools?.length ? { tools } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const vendor = String(payload?.error?.code || '');
      const err = new Error(safeUpstreamMessage(res.status, vendor));
      err.code = res.status === 429
        ? (/quota|insufficient/i.test(vendor) ? CODES.quota_exceeded : CODES.rate_limit)
        : res.status === 401 || res.status === 403 ? CODES.unauthorized
          : res.status >= 500 ? CODES.provider_unavailable
            : CODES.bad_request;
      err.status = res.status;
      err.detail = redact(JSON.stringify(payload));
      throw err;
    }

    const data = await res.json().catch(() => ({}));
    const text = data.output_text
      || (data.output || []).flatMap(item => item.content || []).map(c => c.text || '').join('');
    const u = data.usage;
    return {
      text: String(text || '').trim(),
      model: data.model || model,
      usage: u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.total_tokens } : null,
      provider: id,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
