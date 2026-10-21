/* ==========================================================================
   vercel.test.mjs — the Vercel adapter (api/[...path].js).

   The adapter is the only new code in a Vercel deployment: the backend is the
   same fetch(request, env) handler that runs on Workers and under Node. So
   what has to be proven here is the translation, not the API:

     • a Node req/res pair becomes the Request/Response the backend expects;
     • request bodies and JSON survive the trip, and oversized ones are refused;
     • streamed responses (SSE chat, task events) arrive as chunks, not as one
       buffered blob — otherwise streaming silently becomes "wait for it all";
     • the platform's env vars reach the handler (that is where keys live);
     • a client that hangs up aborts the handler's signal, which is what makes
       the Stop button cancel the upstream call instead of only hiding the text.

   No network and no platform are involved: the handler is injected.
   ========================================================================== */

import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { handle, toWebRequest, writeResponse } from '../api/[...path].js';
import * as Store from '../server/store.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? `— ${extra}` : ''); }
};
const group = (title) => console.log(`\n— ${title} —`);

const dataDir = `/tmp/jarvis-vercel-${Date.now()}`;
await Store.init({ dir: dataDir });

const env = {
  TRALIX_ALLOWED_ORIGINS: '*',
  JARVIS_DATA_DIR: dataDir,
  JARVIS_WRITE_TOKEN: '',
};

/* ------------------------- doubles for req and res ------------------------ */

function makeReq({ method = 'GET', url = '/api/v2/voice/status', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: 'jarvis.vercel.app', 'x-forwarded-proto': 'https', ...headers };
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.chunks = [];
  res.ends = 0;
  res.setHeader = (key, value) => { res.headers[String(key).toLowerCase()] = value; };
  res.getHeader = (key) => res.headers[String(key).toLowerCase()];
  res.removeHeader = (key) => { delete res.headers[String(key).toLowerCase()]; };
  res.write = (chunk) => { res.chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk) => {
    if (chunk) res.chunks.push(Buffer.from(chunk));
    res.ends += 1;
    res.emit('close');
    return res;
  };
  Object.defineProperty(res, 'headersSent', { get: () => res.ends > 0 || res.chunks.length > 0 });
  res.writableEnded = false;
  return res;
}

const text = (res) => Buffer.concat(res.chunks).toString('utf8');
const json = (res) => { try { return JSON.parse(text(res)); } catch { return null; } };

/* ------------------------------ the real handler -------------------------- */

group('the adapter serves the real backend');
{
  const res = makeRes();
  await handle(makeReq(), res, { env });
  const body = json(res);
  t('a GET becomes a 200 JSON answer', res.statusCode === 200, String(res.statusCode));
  t('the backend answered, not the adapter', body?.provider === 'fish-audio', text(res).slice(0, 80));
  t('an unconfigured voice is still reported as unconfigured', body?.configured === false);
  t('the response ends exactly once', res.ends === 1, String(res.ends));
}

group('routing and errors');
{
  const res = makeRes();
  await handle(makeReq({ url: '/api/does-not-exist' }), res, { env });
  t('an unknown route is a 404 from the backend, not a crash',
    res.statusCode === 404, String(res.statusCode));
  t('the error carries a code the UI understands', json(res)?.error?.code === 'bad_request');
}
{
  const res = makeRes();
  await handle(makeReq({ method: 'OPTIONS', url: '/api/v2/health' }), res, { env });
  t('a CORS preflight is answered',
    res.statusCode === 204 || res.statusCode === 200, String(res.statusCode));
  t('the CORS header is passed through',
    Boolean(res.headers['access-control-allow-origin']), String(res.headers['access-control-allow-origin']));
}

group('request bodies');
{
  const res = makeRes();
  await handle(makeReq({
    method: 'POST',
    url: '/api/v2/voice/speak',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello there', speed: 1.15 }),
  }), res, { env });
  const body = json(res);
  // No key is configured, so the honest answer is 503 — which also proves the
  // JSON body was parsed by the backend and not lost in the adapter.
  t('a JSON body reaches the handler', res.statusCode === 503, String(res.statusCode));
  t('the refusal is the provider code, not an adapter error',
    body?.error?.code === 'invalid_config', JSON.stringify(body?.error));
}
{
  const res = makeRes();
  await handle(makeReq({
    method: 'POST',
    url: '/api/v2/voice/speak',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(4.6 * 1024 * 1024) }),
  }), res, { env });
  t('a body larger than the platform allows is refused before buffering',
    res.statusCode === 413, String(res.statusCode));
  t('the refusal explains itself', /4\.5 MB/.test(text(res)), text(res).slice(0, 80));
}

group('streaming');
{
  const chunks = ['data: {"type":"delta"}\n\n', 'data: {"type":"delta"}\n\n', 'data: {"type":"done"}\n\n'];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const res = makeRes();
  await writeResponse(res, new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Content-Length': '999' },
  }));
  t('every chunk is written, in order', text(res) === chunks.join(''), JSON.stringify(text(res)));
  t('the stream is written as separate chunks, not one blob',
    res.chunks.length === chunks.length, `${res.chunks.length} write(s)`);
  t('the response is ended exactly once', res.ends === 1, String(res.ends));
  t('a length header the platform owns is not copied back',
    res.headers['content-length'] === undefined, String(res.headers['content-length']));
  t('the content type survives', res.headers['content-type'] === 'text/event-stream');
}
{
  // A body that arrives slowly must still be written as it arrives.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('first\n'));
      await gate;
      controller.enqueue(new TextEncoder().encode('second\n'));
      controller.close();
    },
  });
  const res = makeRes();
  const writing = writeResponse(res, new Response(stream, { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 20));
  t('the first chunk is flushed before the last one exists',
    text(res) === 'first\n', JSON.stringify(text(res)));
  release();
  await writing;
  t('the rest arrives after it', text(res) === 'first\nsecond\n', JSON.stringify(text(res)));
}

group('environment and cancellation');
{
  // Env vars are where every key lives on Vercel: prove they reach the handler.
  const seen = {};
  await handle(makeReq({ url: '/api/v2/voice/status' }), makeRes(), {
    env: { ...env, FISH_AUDIO_API_KEY: 'fa-TESTKEY-not-a-real-credential-0001' },
    onRequest: async (request, environment) => {
      seen.env = environment;
      seen.url = request.url;
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  t('the platform environment is handed to the handler',
    seen.env?.FISH_AUDIO_API_KEY === 'fa-TESTKEY-not-a-real-credential-0001');
  t('the URL is rebuilt from the forwarded host and proto',
    seen.url === 'https://jarvis.vercel.app/api/v2/voice/status', String(seen.url));
}
{
  let captured = null;
  let settled = false;
  const req = makeReq({ url: '/api/v2/chat' });
  const res = makeRes();
  const running = handle(req, res, {
    env,
    onRequest: async (request) => {
      captured = request;
      await new Promise(resolve => setTimeout(resolve, 200));
      settled = true;
      return new Response('{}');
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  t('the handler received a request', Boolean(captured));
  t('the request is not aborted while the client is still there', captured.signal.aborted === false);
  req.emit('aborted');                     // the browser hung up (Stop, or a closed tab)
  await new Promise(resolve => setTimeout(resolve, 10));
  t('a client that hangs up aborts the handler\'s signal', captured.signal.aborted === true);
  await running;
  t('the handler is allowed to finish after the abort', settled === true);
}
{
  // toWebRequest on its own: headers, method and the body it is given.
  const request = toWebRequest(
    makeReq({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' } }),
    { body: Buffer.from('{"a":1}') },
  );
  t('the method is kept', request.method === 'POST');
  t('custom headers are forwarded', request.headers.get('x-trace') === 'abc');
  t('the buffered body is forwarded', await request.text() === '{"a":1}');
  t('a GET has no body', toWebRequest(makeReq({ method: 'GET' })).body === null);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
