/* ==========================================================================
   server/providers/gemini.js — Google Gemini adapter.

   One of the strongest genuinely free tiers available, which makes it a first
   choice in Free-first routing. Uses the native generateContent protocol:
     GET  /v1beta/models                                     → probe
     POST /v1beta/models/{model}:streamGenerateContent?alt=sse → stream
   ========================================================================== */

import { CODES, safeUpstreamMessage, redact } from '../lib/http.js';

export const id = 'gemini';
export const label = 'Google Gemini';
export const protocol = 'gemini-generate-content';
export const freeTier = true;

export const models = {
  fast: 'gemini-2.5-flash-lite',
  smart: 'gemini-2.5-flash',
  code: 'gemini-2.5-flash',
  research: 'gemini-2.5-pro',
};

export const defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
const normaliseBase = (url) => String(url || defaultBaseUrl).replace(/\/+$/, '');

function toContents(messages) {
  const contents = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const text = String(m.content ?? m.text ?? '').trim();
    if (!text) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n\n' + text;
    else contents.push({ role, parts: [{ text }] });
  }
  while (contents.length && contents[0].role === 'model') contents.shift();
  return contents;
}

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
    const res = await fetch(`${normaliseBase(baseUrl)}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': String(key || '').trim() },
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
    const list = (data?.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);

    return {
      status: 'ok',
      verified: true,
      models: list,
      latencyMs,
      message: list.length
        ? `Gemini responded with ${list.length} usable models.`
        : 'Gemini accepted the key.',
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      status: aborted ? 'upstream_timeout' : 'unreachable',
      verified: false, models: [], latencyMs: Date.now() - started,
      message: aborted ? 'Gemini did not respond in time.' : 'The JARVIS backend cannot reach Gemini from its network.',
      detail: redact(String(err?.message || err)),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export async function streamChat({
  key, baseUrl, model, messages, instructions,
  maxTokens = 8192, signal, timeoutMs = 120_000, onDelta, temperature = 0.5,
}) {
  const body = {
    contents: toContents(messages),
    generationConfig: { temperature, maxOutputTokens: maxTokens, topP: 0.95 },
  };
  if (instructions) body.systemInstruction = { parts: [{ text: instructions }] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = () => controller.abort('client-aborted');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(
      `${normaliseBase(baseUrl)}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(key || '').trim() },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: CODES.aborted });
    const e = new Error('Gemini could not be reached.');
    e.code = CODES.network;
    e.detail = redact(String(err?.message || err));
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok || !res.body) {
    const payload = await res.json().catch(() => ({}));
    const vendor = String(payload?.error?.status || payload?.error?.message || '');
    const err = new Error(safeUpstreamMessage(res.status, vendor));
    err.code = res.status === 429
      ? (/quota|exhausted|billing/i.test(vendor) ? CODES.quota_exceeded : CODES.rate_limit)
      : res.status === 401 || res.status === 403 ? CODES.unauthorized
        : res.status === 404 ? CODES.invalid_config
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
        let chunk;
        try { chunk = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (chunk?.error) {
          const err = new Error('Gemini returned an error mid-answer.');
          err.code = CODES.provider_unavailable;
          err.detail = redact(String(chunk.error.message || ''));
          throw err;
        }
        if (chunk?.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? null,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? null,
            totalTokens: chunk.usageMetadata.totalTokenCount ?? null,
          };
        }
        for (const part of chunk?.candidates?.[0]?.content?.parts || []) {
          if (part.thought) continue;                 // reasoning is not output
          const piece = part.text || '';
          if (!piece) continue;
          full += piece;
          onDelta?.(piece, full);
        }
      }
    }
    return { text: full, model, usage, provider: id, status: full ? 'completed' : 'empty' };
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export async function chat(opts) {
  const { key, baseUrl, model, messages, instructions, maxTokens = 4096, signal, timeoutMs = 120_000, temperature = 0.3 } = opts;
  const body = {
    contents: toContents(messages),
    generationConfig: { temperature, maxOutputTokens: maxTokens, topP: 0.95 },
  };
  if (instructions) body.systemInstruction = { parts: [{ text: instructions }] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = () => controller.abort('client-aborted');
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const res = await fetch(
      `${normaliseBase(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(key || '').trim() },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      const vendor = String(payload?.error?.status || payload?.error?.message || '');
      const err = new Error(safeUpstreamMessage(res.status, vendor));
      err.code = res.status === 429
        ? (/quota|exhausted|billing/i.test(vendor) ? CODES.quota_exceeded : CODES.rate_limit)
        : res.status === 401 || res.status === 403 ? CODES.unauthorized
          : res.status === 404 ? CODES.invalid_config
            : res.status >= 500 ? CODES.provider_unavailable : CODES.bad_request;
      err.status = res.status;
      err.detail = redact(JSON.stringify(payload));
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => (p.thought ? '' : (p.text || ''))).join('');
    return {
      text: String(text || '').trim(),
      model,
      usage: data.usageMetadata ? {
        inputTokens: data.usageMetadata.promptTokenCount ?? null,
        outputTokens: data.usageMetadata.candidatesTokenCount ?? null,
        totalTokens: data.usageMetadata.totalTokenCount ?? null,
      } : null,
      provider: id,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
