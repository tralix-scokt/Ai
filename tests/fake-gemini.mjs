/* ==========================================================================
   tests/fake-gemini.mjs — a local double for the Gemini generateContent API.

   Enough of the real protocol to prove the adapter: model listing, SSE
   streaming with usage metadata, a 401 and a 429. It never touches Google.
   ========================================================================== */

import http from 'node:http';

function sse(res, chunks, { delayMs = 0 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let index = 0;
  const timer = setInterval(() => {
    if (index >= chunks.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(chunks[index])}\n\n`);
    index += 1;
  }, delayMs || 5);
  res.on('close', () => clearInterval(timer));
}

/**
 * @param {number} port 0 = pick a free port
 * @param {object} options
 * @param {(req:object)=>object} [options.onStream]  inspect the request body
 */
export function startFakeGemini(port = 0, options = {}) {
  const state = {
    modelCalls: 0,
    generateCalls: 0,
    lastBody: null,
    failWith: 0,                       // set to 401 / 429 / 500 to force a failure
    reply: 'Gemini answer from the double.',
    // Optional: (body) => string, so a test can answer planning and editing
    // prompts differently.
    replyFor: null,
  };

  const replyText = (body) => (state.replyFor ? state.replyFor(body, state) : state.reply);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;

      if (url.pathname === '/v1beta/models') {
        state.modelCalls += 1;
        if (state.failWith === 401 || state.failWith === 403) {
          res.writeHead(state.failWith, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'API key not valid' } }));
          return;
        }
        if (state.failWith === 429) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          ],
        }));
        return;
      }

      if (url.pathname.includes(':streamGenerateContent')) {
        state.generateCalls += 1;
        state.lastBody = body;
        if (state.failWith >= 400) {
          res.writeHead(state.failWith, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Rate limited' } }));
          return;
        }
        const text = replyText(body);
        sse(res, [
          { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 } },
        ]);
        return;
      }

      if (url.pathname.includes(':generateContent')) {
        state.generateCalls += 1;
        state.lastBody = body;
        if (state.failWith >= 400) {
          res.writeHead(state.failWith, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Rate limited' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: replyText(body) }] } }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startFakeGemini(Number(process.argv[2] || 8801));
  console.log(`fake gemini listening on http://127.0.0.1:${port}/v1beta`);
}
