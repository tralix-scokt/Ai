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
import * as Store from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const SERVE_STATIC = process.argv.includes('--static');

/**
 * Load ./server/.env (or ./.env) without a dependency. Real environment
 * variables always win, so a hosting platform's dashboard remains the source
 * of truth. `.env` is git-ignored and must never be committed.
 */
function loadDotEnv() {
  for (const candidate of [path.join(here, '.env'), path.join(root, '.env')]) {
    let text = '';
    try { text = fs.readFileSync(candidate, 'utf8'); } catch { continue; }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Z][A-Z0-9_]*$/i.test(key) || process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      process.env[key] = value;
    }
    console.log(`  loaded ${path.relative(root, candidate)}`);
    break;
  }
}
loadDotEnv();

// Create the data directory before the first request so the startup banner can
// report the real storage mode.
await Store.init({ env: { JARVIS_DATA_DIR: process.env.JARVIS_DATA_DIR } }).catch(() => 'memory');

const env = {
  /* ---- legacy single-provider tier mapping (still supported) ---- */
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
  TRALIX_ALLOWED_ORIGINS: process.env.TRALIX_ALLOWED_ORIGINS
    || process.env.JARVIS_ALLOWED_ORIGINS || '*',
  TRALIX_ENABLE_WEB_SEARCH: process.env.TRALIX_ENABLE_WEB_SEARCH || 'false',
  TRALIX_MODEL_FAST: process.env.TRALIX_MODEL_FAST || '',
  TRALIX_MODEL_SMART: process.env.TRALIX_MODEL_SMART || '',
  TRALIX_MODEL_CODE: process.env.TRALIX_MODEL_CODE || '',
  TRALIX_MODEL_RESEARCH: process.env.TRALIX_MODEL_RESEARCH || '',

  /* ---- JARVIS STUDIO: provider routing ---- */
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL || '',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_BASE_URL: process.env.GROQ_BASE_URL || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
  MISTRAL_BASE_URL: process.env.MISTRAL_BASE_URL || '',
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || '',

  /* ---- JARVIS STUDIO: GitHub ---- */
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  GITHUB_APP_ID: process.env.GITHUB_APP_ID || '',
  GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY || '',
  GITHUB_INSTALLATION_ID: process.env.GITHUB_INSTALLATION_ID || '',
  GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID || '',
  GITHUB_OAUTH_CLIENT_SECRET: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
  GITHUB_OAUTH_REDIRECT_URI: process.env.GITHUB_OAUTH_REDIRECT_URI || '',

  /* ---- JARVIS STUDIO: voice ---- */
  FISH_AUDIO_API_KEY: process.env.FISH_AUDIO_API_KEY || '',
  FISH_AUDIO_MODEL: process.env.FISH_AUDIO_MODEL || '',
  FISH_AUDIO_REFERENCE_ID: process.env.FISH_AUDIO_REFERENCE_ID || '',

  /* ---- JARVIS STUDIO: cost, security, storage, sandbox ---- */
  JARVIS_PAID_FALLBACK: process.env.JARVIS_PAID_FALLBACK || 'false',
  JARVIS_MONTHLY_LIMIT_USD: process.env.JARVIS_MONTHLY_LIMIT_USD || '',
  JARVIS_WRITE_TOKEN: process.env.JARVIS_WRITE_TOKEN || '',
  JARVIS_DATA_DIR: process.env.JARVIS_DATA_DIR || '',
  JARVIS_SANDBOX_DRIVER: process.env.JARVIS_SANDBOX_DRIVER || '',
  JARVIS_SANDBOX_NETWORK: process.env.JARVIS_SANDBOX_NETWORK || '',
};

// The sandbox runner reads these from process.env, so make sure the values the
// server was started with are present even when only `env` was populated.
for (const key of ['JARVIS_SANDBOX_DRIVER', 'JARVIS_SANDBOX_NETWORK', 'JARVIS_DATA_DIR']) {
  if (!process.env[key] && env[key]) process.env[key] = env[key];
}

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
  const has = (value) => (value ? 'yes' : 'no');
  console.log(`JARVIS STUDIO backend listening on http://${HOST}:${PORT}`);
  console.log(`  data directory      : ${path.resolve(process.cwd(), process.env.JARVIS_DATA_DIR || './data')} (${Store.storageMode()})`);
  console.log(`  legacy OpenAI tier  : ${has(env.OPENAI_API_KEY)}`);
  console.log(`  free-tier providers : ${['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY']
    .filter(k => env[k]).map(k => k.replace('_API_KEY', '')).join(', ') || 'none configured'}`);
  console.log(`  paid fallback       : ${env.JARVIS_PAID_FALLBACK === 'true' ? 'AUTHORISED' : 'off (free-first)'}`);
  console.log(`  GitHub              : ${has(env.GITHUB_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY))}`);
  console.log(`  Fish Audio voice    : ${has(env.FISH_AUDIO_API_KEY)}`);
  console.log(`  write token         : ${has(env.JARVIS_WRITE_TOKEN)}`);
  if (SERVE_STATIC) console.log(`  serving the app from ${root}`);
});
