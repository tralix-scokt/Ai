/* ==========================================================================
   server/lib/http.js — shared HTTP helpers for every backend deployment.

   Used by the Cloudflare Worker (server/worker.js) and the Node adapter
   (server/node.js). Dependency-free by design: only Web Standards APIs.

   Contains:
     • CORS handling (allowlist-driven)
     • JSON + error payloads with one error vocabulary
     • redaction (a provider error body can quote our own key back at us)
     • SSE frame encoding
     • body reading with a hard size cap
   ========================================================================== */

export const MAX_BODY_BYTES = 512 * 1024;

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.TRALIX_ALLOWED_ORIGINS || env.JARVIS_ALLOWED_ORIGINS || '*')
    .split(',').map(s => s.trim()).filter(Boolean);
  const permit = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': permit ? (allowed.includes('*') ? '*' : origin) : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function errorPayload(code, message, status = 400, extra = {}) {
  return json({ error: { code, message, ...extra } }, status);
}

/** The single error vocabulary shared by the whole backend. */
export const CODES = {
  offline: 'offline',
  network: 'network',
  timeout: 'timeout',
  rate_limit: 'rate_limit',
  quota_exceeded: 'quota_exceeded',
  unauthorized: 'unauthorized',
  invalid_config: 'invalid_config',
  provider_unavailable: 'provider_unavailable',
  no_eligible_model: 'no_eligible_model',
  paid_blocked: 'paid_blocked',
  bad_request: 'bad_request',
  too_long: 'too_long',
  not_found: 'not_found',
  forbidden: 'forbidden',
  aborted: 'aborted',
  unsupported: 'unsupported',
  unknown: 'unknown',
};

/** HTTP status → our code. Deliberately lossy: never leak a vendor payload. */
export function codeFromStatus(status, vendorCode = '') {
  if (status === 401 || status === 403) return CODES.unauthorized;
  if (status === 404 || status === 400) {
    return /model|not_found/i.test(vendorCode) ? CODES.invalid_config : CODES.bad_request;
  }
  if (status === 413) return CODES.too_long;
  if (status === 408 || status === 504) return CODES.timeout;
  if (status === 429) {
    return /quota|insufficient|credit|billing|balance/i.test(vendorCode)
      ? CODES.quota_exceeded
      : CODES.rate_limit;
  }
  if (status >= 500) return CODES.provider_unavailable;
  return CODES.unknown;
}

/**
 * A user-safe sentence for an upstream failure. The raw body is never
 * forwarded: providers echo headers and key fragments in their errors.
 */
export function safeUpstreamMessage(status, vendorCode = '') {
  if (status === 401 || status === 403) {
    return 'The provider rejected the API key on the JARVIS server. Check the key on the backend.';
  }
  if (status === 429) {
    return /quota|insufficient|credit|billing|balance/i.test(vendorCode)
      ? 'This provider has no quota left on its current plan.'
      : 'This provider is rate limiting the key. JARVIS will try another provider.';
  }
  if (status === 404) return 'The configured model or endpoint was not found on this provider.';
  if (status >= 500) return 'The provider reported an internal error. Try again shortly.';
  return 'The provider rejected the request.';
}

/** Strip anything key-shaped before a detail string reaches a log or a client. */
export function redact(text, max = 300) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***')
    .replace(/AIza[0-9A-Za-z_\-]{8,}/g, 'AIza***')
    .replace(/gsk_[A-Za-z0-9]{8,}/g, 'gsk_***')
    .replace(/sk-ant-[A-Za-z0-9_\-]{8,}/g, 'sk-ant-***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer ***')
    .replace(/(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/g, '$1_***')
    // a private key block is never useful in a log
    .replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, '[private-key-redacted]')
    .slice(0, max);
}

/* --------------------------------- bodies -------------------------------- */

/** Read a JSON body with a hard cap. Returns null when unreadable. */
export async function readJson(request, limit = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) return { error: CODES.too_long };
  try {
    const text = await request.text();
    if (text.length > limit) return { error: CODES.too_long };
    if (!text.trim()) return { value: {} };
    return { value: JSON.parse(text) };
  } catch {
    return { error: CODES.bad_request };
  }
}

/* ---------------------------------- SSE ---------------------------------- */

export function sseResponse(request, env, handler) {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch { closed = true; }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };
      try {
        await handler({ send, finish, request, env });
      } catch (err) {
        send({ type: 'error', code: CODES.unknown, message: 'The request failed unexpectedly.' });
        console.error('[jarvis] stream handler failed', redact(String(err?.stack || err)));
      } finally {
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(request, env),
    },
  });
}

/** Parse an SSE body from an upstream provider, yielding decoded frames. */
export async function* readSseFrames(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
          if (!raw || raw === '[DONE]') return;
          try { yield JSON.parse(raw); } catch { /* ignore keep-alives */ }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/* ------------------------------- rate limit ------------------------------- */

/**
 * Per-isolate request limiter. Cheap and good enough to stop accidental
 * runaway loops from burning a paid key; use KV/Durable Objects for a hard
 * distributed limit.
 */
export function createLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map();
  return function limit(key) {
    const now = Date.now();
    const entry = hits.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count += 1;
    hits.set(key, entry);
    if (hits.size > 5000) hits.clear();
    return { limited: entry.count > max, retryAfter: Math.ceil((entry.reset - now) / 1000) };
  };
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || request.headers.get('X-Real-IP')
    || 'unknown';
}

/** fetch with an abort-based timeout that also cancels the response stream. */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
