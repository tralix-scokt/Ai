/* ==========================================================================
   api/client.js — low-level fetch helpers.

   One place that knows about timeouts, JSON parsing, SSE frames and how HTTP
   failures become TralixError. No UI, no app state.
   ========================================================================== */

import { apiUrl } from '../config.js';
import { TralixError, ERROR_CODES, codeFromStatus, toTralixError } from '../errors.js';

/**
 * fetch with a timeout that also aborts the response stream.
 * @param {string} url
 * @param {RequestInit & {timeoutMs?:number}} options
 */
export async function request(url, { timeoutMs = 30000, signal, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (signal?.aborted) throw err;                     // caller cancelled deliberately
    if (err?.name === 'AbortError') {
      throw new TralixError(ERROR_CODES.timeout, { detail: `timeout after ${timeoutMs}ms` });
    }
    throw toTralixError(err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/** POST JSON to the TRALIX backend and parse a JSON response. */
export async function postJson(path, body, { timeoutMs = 30000, signal, headers = {} } = {}) {
  const res = await request(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
    timeoutMs,
    signal,
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json().catch(() => ({}));
}

/** GET JSON from the TRALIX backend. */
export async function getJson(path, { timeoutMs = 15000, signal } = {}) {
  const res = await request(apiUrl(path), { method: 'GET', timeoutMs, signal });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json().catch(() => ({}));
}

/** Turn a failed response into a typed error, reading the backend's payload. */
export async function errorFromResponse(res) {
  let payload = null;
  try { payload = await res.clone().json(); } catch {}
  const vendorCode = payload?.error?.code || payload?.code || '';

  // A 404 on /api/chat almost always means the backend is not deployed here
  // (plain GitHub Pages). Say that plainly rather than "not found".
  if (res.status === 404) {
    return new TralixError(ERROR_CODES.invalid_config, {
      status: 404,
      detail: 'backend endpoint not found — is the TRALIX backend deployed?',
    });
  }
  if (res.status === 401 || res.status === 403) {
    return new TralixError(ERROR_CODES.unauthorized, {
      status: res.status,
      detail: payload?.error?.message || payload?.message || 'unauthorised',
    });
  }

  const code = payload?.error?.code && Object.values(ERROR_CODES).includes(payload.error.code)
    ? payload.error.code
    : codeFromStatus(res.status, vendorCode);

  return new TralixError(code, {
    status: res.status,
    detail: payload?.error?.message || payload?.message || `HTTP ${res.status}`,
  });
}

/**
 * Read a Server-Sent-Events stream, yielding parsed JSON events.
 * Also tolerates plain text/event-stream-less responses (some proxies).
 */
export async function* readSse(res, { onRawText } = {}) {
  const ctype = res.headers.get('content-type') || '';
  const isSse = ctype.includes('event-stream') || ctype.includes('text/event-stream');

  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      if (!isSse) {
        // raw text streaming — treat each chunk as a delta
        onRawText?.(buffer);
        buffer = '';
        continue;
      }

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const dataLines = frame.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim());
        if (!dataLines.length) continue;
        const joined = dataLines.join('\n');
        if (joined === '[DONE]') return;
        try {
          yield JSON.parse(joined);
        } catch {
          onRawText?.(joined);
        }
      }
    }
    // flush a trailing frame without the blank-line terminator
    const tail = buffer.trim();
    if (tail) {
      const dataLine = tail.split('\n').find(l => l.startsWith('data:'));
      if (dataLine) {
        const joined = dataLine.slice(5).trim();
        if (joined && joined !== '[DONE]') {
          try { yield JSON.parse(joined); } catch { onRawText?.(joined); }
        }
      } else if (!isSse) {
        onRawText?.(tail);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
