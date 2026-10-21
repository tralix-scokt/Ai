/* ==========================================================================
   api/[...path].js — JARVIS STUDIO on Vercel.

   The backend (server/worker.js) is a `fetch(request, env)` handler: the very
   same code that runs on Cloudflare Workers and under `node server/node.js`.
   This file is only an adapter. It turns Vercel's Node `req`/`res` pair into
   the Request/Response pair the backend already speaks, and streams the answer
   back chunk by chunk so server-sent events (chat, task events) still stream.

   Nothing here knows about providers, keys or routes — that stays in server/.

   Honest limits of this deployment (see README → Vercel):
     • the filesystem is read-only except /tmp, so the store falls back to
       memory: settings, task history and stored keys do not survive a
       redeploy, and are not shared between instances. Use env vars for keys.
     • the sandbox runs inside the function itself (1 vCPU, 2 GB on Hobby) and
       is bounded by maxDuration below.
   ========================================================================== */

import handler from '../server/worker.js';

/**
 * Hobby allows 300 s (the default and the maximum); Pro can go to 800.
 * Raising this is only useful for long checks — chat answers are far shorter.
 */
export const config = { maxDuration: 300, memory: 1024 };

/** Vercel caps a request body at 4.5 MB; refuse more rather than buffer it. */
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

/** Hop-by-hop and length headers must not be forwarded into the Request. */
const SKIP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'expect']);

/** Headers the platform manages for us; copying them back breaks the response. */
const SKIP_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection']);

/**
 * Build the Web `Request` the backend expects.
 * `signal` is the caller's AbortController: when the browser hangs up, Vercel
 * closes the request, we abort, and the backend cancels the upstream call with
 * it — which is what makes the Stop button stop the model, not just the UI.
 */
export function toWebRequest(req, { body, signal } = {}) {
  const forwardedHost = req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost';
  const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const forwardedProto = req.headers?.['x-forwarded-proto'] || 'https';
  const proto = String(Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto).split(',')[0].trim();
  const url = new URL(req.url || '/', `${proto || 'https'}://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (value === undefined || SKIP_HEADERS.has(String(key).toLowerCase())) continue;
    if (Array.isArray(value)) value.forEach(item => headers.append(key, String(item)));
    else headers.set(key, String(value));
  }

  const method = String(req.method || 'GET').toUpperCase();
  const mayHaveBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    ...(mayHaveBody && body ? { body } : {}),
    ...(signal ? { signal } : {}),
  });
}

/** Buffer the request body, refusing anything larger than the platform allows. */
async function readBody(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return { body: undefined };

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { tooLarge: true };
    chunks.push(chunk);
  }
  return { body: chunks.length ? Buffer.concat(chunks) : undefined };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/** Copy a Web `Response` onto the Node response, streaming the body. */
export async function writeResponse(res, response) {
  res.statusCode = response.status;

  // set-cookie can legitimately appear more than once; forEach would merge them.
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie() : [];
  response.headers.forEach((value, key) => {
    if (SKIP_RESPONSE_HEADERS.has(key) || key === 'set-cookie') return;
    res.setHeader(key, value);
  });
  if (setCookies.length) res.setHeader('Set-Cookie', setCookies);

  if (!response.body) { res.end(); return; }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);                       // Uint8Array — Node writes it as-is
    }
  } finally {
    try { reader.releaseLock?.(); } catch { /* already released */ }
    res.end();
  }
}

/**
 * The whole adapter. `onRequest` and `env` are injectable so the test suite can
 * exercise it without a platform (see tests/vercel.test.mjs).
 */
export async function handle(req, res, { env = process.env, onRequest = (request, environment) => handler.fetch(request, environment) } = {}) {
  const controller = new AbortController();
  // A client that goes away must take the upstream call with it.
  req.on?.('aborted', () => controller.abort('client aborted'));
  res.on?.('close', () => controller.abort('client closed'));

  let response;
  try {
    const { body, tooLarge } = await readBody(req);
    if (tooLarge) {
      sendJson(res, 413, { error: { code: 'too_long', message: 'Request body is larger than 4.5 MB.' } });
      return;
    }
    response = await onRequest(toWebRequest(req, { body, signal: controller.signal }), env);
  } catch (err) {
    console.error('[jarvis] vercel adapter failed:', err?.message || String(err));
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 500, { error: { code: 'unknown', message: 'Unexpected backend error.' } });
    } else {
      res.end();
    }
    return;
  }

  try {
    await writeResponse(res, response);
  } catch (err) {
    console.error('[jarvis] vercel adapter could not finish the response:', err?.message || String(err));
    if (!res.writableEnded) res.end();
  }
}

export default function api(req, res) {
  return handle(req, res);
}
