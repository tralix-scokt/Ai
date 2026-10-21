/* ==========================================================================
   server/providers/anthropic.js — Anthropic (Claude) adapter.

   Paid provider. It is included so a deployment with a Claude key can route
   review/planning work there, but Free-first routing will never select it
   unless paid usage is explicitly authorised.
   ========================================================================== */

import { CODES, safeUpstreamMessage, redact } from '../lib/http.js';

export const id = 'anthropic';
export const label = 'Anthropic';
export const protocol = 'anthropic-messages';
export const freeTier = false;

export const models = {
  fast: 'claude-haiku-4-5',
  smart: 'claude-sonnet-4-5',
  code: 'claude-sonnet-4-5',
  research: 'claude-opus-4-1',
};

export const defaultBaseUrl = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
const normaliseBase = (url) => String(url || defaultBaseUrl).replace(/\/+$/, '');

const headers = (key) => ({
  'x-api-key': String(key || '').trim(),
  'anthropic-version': VERSION,
});

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
    // Anthropic has no token-free endpoint that is guaranteed on every plan;
    // /v1/models is the documented listing endpoint and is free to call.
    const res = await fetch(`${normaliseBase(baseUrl)}/models?limit=100`, {
      headers: { ...headers(key), Accept: 'application/json' },
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
      status: 'ok', verified: true, models: list, latencyMs,
      message: list.length ? `Anthropic responded with ${list.length} models.` : 'Anthropic accepted the key.',
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      status: aborted ? 'upstream_timeout' : 'unreachable',
      verified: false, models: [], latencyMs: Date.now() - started,
      message: aborted ? 'Anthropic did not respond in time.' : 'The JARVIS backend cannot reach Anthropic from its network.',
      detail: redact(String(err?.message || err)),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function toMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const text = String(m.content ?? m.text ?? '').trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

export async function streamChat({
  key, baseUrl, model, messages, instructions,
  maxTokens = 4096, signal, timeoutMs = 120_000, onDelta, temperature = 0.4,
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
    res = await fetch(`${normaliseBase(baseUrl)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers(key) },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        ...(instructions ? { system: instructions } : {}),
        messages: toMessages(messages),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: CODES.aborted });
    const e = new Error('Anthropic could not be reached.');
    e.code = CODES.network;
    e.detail = redact(String(err?.message || err));
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || !res.body) {
    const payload = await res.json().catch(() => ({}));
    const vendor = String(payload?.error?.type || payload?.error?.message || '');
    const err = new Error(safeUpstreamMessage(res.status, vendor));
    err.code = res.status === 429
      ? (/credit|balance|billing/i.test(vendor) ? CODES.quota_exceeded : CODES.rate_limit)
      : res.status === 401 || res.status === 403 ? CODES.unauthorized
        : res.status === 404 ? CODES.invalid_config
          : res.status >= 500 ? CODES.provider_unavailable : CODES.bad_request;
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

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const line = frame.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let event;
        try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (event.type === 'message_start') {
          if (event.message?.model) usedModel = event.message.model;
          if (event.message?.usage) {
            usage = { inputTokens: event.message.usage.input_tokens ?? null, outputTokens: 0, totalTokens: null };
          }
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const piece = event.delta.text || '';
          full += piece;
          onDelta?.(piece, full);
        } else if (event.type === 'message_delta') {
          const u = event.usage || {};
          usage = {
            inputTokens: usage?.inputTokens ?? u.input_tokens ?? null,
            outputTokens: u.output_tokens ?? null,
            totalTokens: (usage?.inputTokens ?? 0) + (u.output_tokens ?? 0) || null,
          };
        } else if (event.type === 'error') {
          const err = new Error('Anthropic returned an error mid-answer.');
          err.code = CODES.provider_unavailable;
          err.detail = redact(String(event.error?.message || ''));
          throw err;
        } else if (event.type === 'message_stop') {
          return { text: full, model: usedModel, usage, provider: id, status: 'completed' };
        }
      }
    }
    return { text: full, model: usedModel, usage, provider: id, status: full ? 'incomplete' : 'empty' };
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export async function chat(opts) {
  const { key, baseUrl, model, messages, instructions, maxTokens = 4096, signal, timeoutMs = 120_000, temperature = 0.3 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = () => controller.abort('client-aborted');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(`${normaliseBase(baseUrl)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(key) },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature, stream: false,
        ...(instructions ? { system: instructions } : {}),
        messages: toMessages(messages),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const vendor = String(payload?.error?.type || '');
      const err = new Error(safeUpstreamMessage(res.status, vendor));
      err.code = res.status === 429
        ? (/credit|balance|billing/i.test(vendor) ? CODES.quota_exceeded : CODES.rate_limit)
        : res.status === 401 || res.status === 403 ? CODES.unauthorized
          : res.status === 404 ? CODES.invalid_config
            : res.status >= 500 ? CODES.provider_unavailable : CODES.bad_request;
      err.status = res.status;
      err.detail = redact(JSON.stringify(payload));
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('');
    return {
      text: String(text || '').trim(),
      model: data.model || model,
      usage: data.usage ? {
        inputTokens: data.usage.input_tokens ?? null,
        outputTokens: data.usage.output_tokens ?? null,
        totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      } : null,
      provider: id,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
