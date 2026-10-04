#!/usr/bin/env node
/* ==========================================================================
   server/node.js — TRALIX backend for Node 18+ (VPS, Render, Railway, Fly…).

   Reuses the exact same handler as the Cloudflare Worker (server/worker.js) so
   both deployments behave identically. Optionally serves the static frontend
   too, which is the easiest way to run TRALIX locally:

     OPENAI_API_KEY=sk-... node server/node.js --static
     →  http://localhost:8787

   Environment:
     OPENAI_API_KEY           required for /api/chat
     PORT                     default 8787
     TRALIX_ALLOWED_ORIGINS   comma-separated allowlist, default "*"
     TRALIX_MODEL_*           override the tier → model mapping
     OPENAI_BASE_URL          optional gateway/proxy
   ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const SERVE_STATIC = process.argv.includes('--static');

const env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
  TRALIX_ALLOWED_ORIGINS: process.env.TRALIX_ALLOWED_ORIGINS || '*',
  TRALIX_ENABLE_WEB_SEARCH: process.env.TRALIX_ENABLE_WEB_SEARCH || 'false',
  TRALIX_MODEL_FAST: process.env.TRALIX_MODEL_FAST || '',
  TRALIX_MODEL_SMART: process.env.TRALIX_MODEL_SMART || '',
  TRALIX_MODEL_CODE: process.env.TRALIX_MODEL_CODE || '',
  TRALIX_MODEL_RESEARCH: process.env.TRALIX_MODEL_RESEARCH || '',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.join(root, pathname);
  if (!filePath.startsWith(root)) { res.writeHead(403).end('Forbidden'); return; }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // unknown path → app shell (SPA-ish behaviour for the PWA)
      if (!path.extname(pathname)) {
        fs.createReadStream(path.join(root, 'index.html'))
          .on('error', () => { res.writeHead(404).end('Not found'); })
          .pipe(res.writeHead(200, { 'Content-Type': MIME['.html'] }));
        return;
      }
      res.writeHead(404).end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=300' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!url.pathname.startsWith('/api/')) {
    if (SERVE_STATIC) { serveStatic(req, res); return; }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'bad_request', message: 'Not an API route. Start with --static to serve the app.' } }));
    return;
  }

  // Convert the Node request into a web Request for the shared handler.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });

  try {
    const response = await handler.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) { res.end(); return; }

    const reader = response.body.getReader();
    res.on('close', () => reader.cancel().catch(() => {}));
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[tralix] request failed', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unknown', message: 'Unexpected backend error.' } }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`TRALIX backend listening on http://${HOST}:${PORT}`);
  console.log(`  key configured: ${env.OPENAI_API_KEY ? 'yes' : 'NO — set OPENAI_API_KEY'}`);
  if (SERVE_STATIC) console.log(`  serving the app from ${root}`);
});
