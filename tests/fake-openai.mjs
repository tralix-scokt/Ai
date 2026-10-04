#!/usr/bin/env node
/* ==========================================================================
   fake-openai.mjs — a local stand-in for api.openai.com used by the tests.

   *** TEST HARNESS. NOT PART OF THE PRODUCT. ***
   It exists so the TRALIX backend's Responses-API plumbing can be exercised
   without a real key: request shaping, SSE frames, usage reporting, error
   mapping and — most importantly — that "Stop" actually aborts the upstream
   request instead of leaving it running.

   It speaks the real wire format:

     GET  /v1/models     → { object:'list', data:[{id:'gpt-5'}, …] }
     POST /v1/responses  → text/event-stream of
                           response.created, response.output_text.delta,
                           response.output_text.done, response.completed

   Behaviour is chosen by trigger words inside the request input so a single
   server can serve every scenario:
     TRIGGER_401 · TRIGGER_403 · TRIGGER_429 · TRIGGER_500 · TRIGGER_SLOW
     TRIGGER_EMPTY · TRIGGER_CUT (drops the connection mid-stream)
     TRIGGER_BADMODEL (404 model_not_found)

   Run standalone:   node tests/fake-openai.mjs [port]
   Inspect state:    GET /__state
   ========================================================================== */

import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.FAKE_OPENAI_PORT || 0);

const state = {
  requests: [],        // { method, path, model, auth, stream, trigger, at }
  aborted: 0,          // requests the client cancelled mid-flight
  completions: 0,      // requests that reached the end of the stream
  modelsCalls: 0,
  unauthorizedCalls: 0,
};

const MODELS = [
  { id: 'gpt-5' },
  { id: 'gpt-5-mini' },
  { id: 'gpt-5-codex' },
  { id: 'gpt-5-nano' },
];

const sse = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

/** The reply text the double streams back. Deterministic, so tests can assert. */
function replyFor(request) {
  const input = JSON.stringify(request.input ?? '');
  const lastUser = (request.input || []).filter(i => i.role === 'user').at(-1);
  const prompt = (lastUser?.content || []).map(c => c.text || '').join(' ').trim();

  if (input.includes('TRIGGER_ECHO_MODEL')) {
    return [`model=${request.model}`, ` effort=${request.reasoning?.effort ?? 'none'}`,
      ` instructions=${(request.instructions || '').includes('TRALIX AI') ? 'present' : 'MISSING'}`].join(' ');
  }
  if (!prompt) return 'No prompt was supplied.';
  return `TRALIX test reply to: ${prompt.slice(0, 120)}`;
}

function chunksOf(text) {
  // Split into several deltas so the client's incremental rendering is exercised.
  const words = text.split(' ');
  const out = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(' ') + (i + 3 < words.length ? ' ' : ''));
  return out.length ? out : [text];
}

async function handleResponses(req, res, body) {
  const request = JSON.parse(body || '{}');
  const blob = JSON.stringify(request);
  const trigger = (blob.match(/TRIGGER_[A-Z0-9_]+/) || [null])[0];

  state.requests.push({
    method: req.method,
    path: '/v1/responses',
    model: request.model || null,
    auth: (req.headers.authorization || '').startsWith('Bearer ') ? 'bearer' : 'none',
    stream: request.stream !== false,
    trigger,
    hasInstructions: typeof request.instructions === 'string' && request.instructions.length > 0,
    reasoning: request.reasoning || null,
    at: Date.now(),
  });

  // ---- failure scenarios, delivered the way OpenAI delivers them ----------
  if (trigger === 'TRIGGER_401') {
    state.unauthorizedCalls += 1;
    return json(res, 401, {
      error: { message: 'Incorrect API key provided: sk-***REDACTED***.', type: 'invalid_request_error', code: 'invalid_api_key' },
    });
  }
  if (trigger === 'TRIGGER_403') {
    state.unauthorizedCalls += 1;
    return json(res, 403, { error: { message: 'You do not have access to this model.', type: 'invalid_request_error', code: 'permission_denied' } });
  }
  if (trigger === 'TRIGGER_429') {
    return json(res, 429, { error: { message: 'Rate limit reached for gpt-5.', type: 'requests', code: 'rate_limit_exceeded' } });
  }
  if (trigger === 'TRIGGER_500') {
    return json(res, 500, { error: { message: 'The server had an error while processing your request.', type: 'server_error', code: 'server_error' } });
  }
  if (trigger === 'TRIGGER_BADMODEL') {
    return json(res, 404, { error: { message: `The model '${request.model}' does not exist`, type: 'invalid_request_error', code: 'model_not_found' } });
  }

  // ---- normal streaming response -----------------------------------------
  const delay = trigger === 'TRIGGER_SLOW' ? 220 : 4;
  const text = trigger === 'TRIGGER_EMPTY' ? '' : replyFor(request);
  const id = `resp_${Math.random().toString(36).slice(2, 12)}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });

  let finished = false;
  const onClose = () => {
    if (!finished) state.aborted += 1;
  };
  res.on('close', onClose);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  sse(res, 'response.created', { type: 'response.created', response: { id, model: request.model, status: 'in_progress' } });
  sse(res, 'response.in_progress', { type: 'response.in_progress', response: { id, status: 'in_progress' } });

  let index = 0;
  for (const chunk of chunksOf(text)) {
    await sleep(delay);
    if (res.destroyed) return;
    if (trigger === 'TRIGGER_CUT' && index === 2) {
      finished = true;
      res.destroy();               // hard drop, like a proxy dying mid-stream
      return;
    }
    sse(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: `msg_${id}`,
      output_index: 0,
      content_index: 0,
      delta: chunk,
    });
    index += 1;
  }

  if (res.destroyed) return;
  sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: `msg_${id}`, text });
  sse(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id,
      model: request.model,
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: {
        input_tokens: 42 + (text.length % 7),
        output_tokens: 17 + text.length % 11,
        total_tokens: 59 + text.length % 13,
      },
    },
  });

  finished = true;
  state.completions += 1;
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/__state') return json(res, 200, state);
  if (url.pathname === '/__reset') {
    state.requests = []; state.aborted = 0; state.completions = 0;
    state.modelsCalls = 0; state.unauthorizedCalls = 0;
    return json(res, 200, { reset: true });
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    state.modelsCalls += 1;
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return json(res, 401, { error: { message: 'Missing bearer token.', type: 'invalid_request_error', code: 'invalid_api_key' } });
    }
    return json(res, 200, { object: 'list', data: MODELS });
  }

  if (url.pathname === '/v1/responses' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      return await handleResponses(req, res, body);
    } catch (err) {
      if (!res.headersSent) return json(res, 500, { error: { message: String(err?.message || err) } });
      res.destroy();
      return undefined;
    }
  }

  return json(res, 404, { error: { message: `Unknown path ${url.pathname}`, code: 'not_found' } });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`fake OpenAI upstream listening on http://127.0.0.1:${port}`);
    console.log(`  base URL for the TRALIX backend: http://127.0.0.1:${port}/v1`);
  });
}

export function startFakeOpenAI(port = 0) {
  return new Promise((resolve) => {
    const srv = http.createServer(server.listeners('request')[0]);
    srv.listen(port, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port, state }));
  });
}

export { state };
