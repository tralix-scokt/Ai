/* ==========================================================================
   server/providers/compatible.js — OpenAI "Chat Completions" compatible base.

   Several providers expose the same wire format (Groq, OpenRouter, Ollama,
   and OpenAI itself). One adapter, parameterised per provider, keeps the
   routing layer small and makes adding the next compatible service a
   five-line catalogue entry instead of a new file.

   Contract implemented by every provider module in this directory:

     probe({ key, baseUrl, signal, timeoutMs })
        → { status, verified, models[], latencyMs, message, httpStatus }
     streamChat({ key, baseUrl, model, messages, instructions, effort,
                  maxTokens, signal, timeoutMs, onDelta })
        → { text, model, usage }
     chat(...)  → same, buffered (no streaming)
   ========================================================================== */

import { CODES, safeUpstreamMessage, readSseFrames, redact } from '../lib/http.js';

/** Turn our normalised messages into the Chat Completions shape. */
export function toChatMessages(messages, instructions) {
  const out = [];
  if (instructions) out.push({ role: 'system', content: instructions });
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content ?? m.text ?? '');
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  return out;
}

function vendorCode(body) {
  return String(body?.error?.code || body?.error?.type || body?.error?.message || '');
}

/** Normalise usage reported by compatible providers (tokens only — no prices). */
function normaliseUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
  };
}

/**
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.label
 * @param {string} spec.baseUrl
 * @param {(key:string)=>Record<string,string>} spec.authHeaders
 * @param {object} spec.models       { fast, smart, code, research }
 * @param {(model:string)=>object}  [spec.extraBody]
 */
export function createCompatibleAdapter(spec) {
  const {
    id, label, baseUrl, authHeaders, models,
    extraBody = () => ({}),
    supportsEffort = () => false,
    modelsPath = '/models',
  } = spec;

  const normaliseBase = (url) => String(url || baseUrl).replace(/\/+$/, '');

  async function probe({ key, baseUrl: override, signal, timeoutMs = 8000 } = {}) {
    const base = normaliseBase(override);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('probe-timeout'), timeoutMs);
    const onAbort = () => controller.abort('cancelled');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetch(`${base}${modelsPath}`, {
        headers: { Accept: 'application/json', ...authHeaders(key) },
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
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      const ids = list.map(m => (typeof m === 'string' ? m : m?.id || m?.name || m?.model)).filter(Boolean).map(String);
      return {
        status: 'ok',
        verified: true,
        models: ids,
        latencyMs,
        message: `${label} responded with ${ids.length} model${ids.length === 1 ? '' : 's'}.`,
      };
    } catch (err) {
      const aborted = controller.signal.aborted;
      return {
        status: aborted ? 'upstream_timeout' : 'unreachable',
        verified: false,
        models: [],
        latencyMs: Date.now() - started,
        message: aborted
          ? `${label} did not respond within ${timeoutMs}ms.`
          : `The JARVIS backend cannot reach ${label} from its network.`,
        detail: redact(String(err?.message || err)),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function streamChat({
    key, baseUrl: override, model, messages, instructions,
    effort = '', maxTokens = 4096, signal, timeoutMs = 120_000, onDelta,
    temperature = 0.4,
  }) {
    const base = normaliseBase(override);
    const body = {
      model,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      messages: toChatMessages(messages, instructions),
      ...extraBody(model),
    };
    if (effort && supportsEffort(model)) {
      body.reasoning_effort = effort;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const onAbort = () => controller.abort('client-aborted');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(key) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: CODES.aborted });
      const e = new Error(`${label} could not be reached.`);
      e.code = CODES.network;
      e.detail = redact(String(err?.message || err));
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok || !res.body) {
      const payload = await res.json().catch(() => ({}));
      const err = new Error(safeUpstreamMessage(res.status, vendorCode(payload)));
      err.code = res.status === 429
        ? (/quota|insufficient|credit|billing/i.test(vendorCode(payload)) ? CODES.quota_exceeded : CODES.rate_limit)
        : res.status === 401 || res.status === 403 ? CODES.unauthorized
          : res.status >= 500 ? CODES.provider_unavailable
            : CODES.bad_request;
      err.status = res.status;
      err.detail = redact(JSON.stringify(payload));
      throw err;
    }

    let full = '';
    let usage = null;
    let usedModel = model;

    for await (const frame of readSseFrames(res)) {
      if (frame?.model) usedModel = frame.model;
      if (frame?.usage) usage = normaliseUsage(frame.usage);
      const delta = frame?.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta?.(delta, full);
      }
      const finish = frame?.choices?.[0]?.finish_reason;
      if (finish === 'stop' || finish === 'length') break;
    }

    return { text: full, model: usedModel, usage, provider: id };
  }

  async function chat(opts) {
    const result = await streamChat({ ...opts, onDelta: null });
    return result;
  }

  return { id, label, protocol: 'openai-compatible', models, probe, streamChat, chat };
}

/** Bearer auth — the header shape used by OpenAI, Groq, OpenRouter. */
export const bearer = (key) => ({ Authorization: `Bearer ${String(key || '').trim()}` });
