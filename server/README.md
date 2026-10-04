# TRALIX backend

The secure half of TRALIX AI. It exists for one reason: **the OpenAI key must
never reach the browser.** The frontend only ever calls these endpoints.

```
User → TRALIX frontend → POST /api/chat → TRALIX backend → OpenAI Responses API
                                                             ↓
User ← TRALIX frontend ← SSE stream of text deltas ←──────────┘
```

No scraping, no automation of chatgpt.com — this is the official API.

## Endpoints

| Method | Path          | Purpose |
|--------|---------------|---------|
| POST   | `/api/chat`   | Streams a reply. Body: `{ model, instructions, messages, stream, tools? }`. Response: SSE frames `{type:'delta'|'done'|'usage'|'error'}`. |
| GET    | `/api/health` | `{ ok, configured, provider, model, tools, features }` — the UI uses this to show honest capability states. |
| GET    | `/api/models` | Tier → provider model mapping (shown only in Advanced/debug). |
| OPTIONS| any           | CORS preflight. |

## What the backend enforces (so a client cannot weaken it)

- Server-side TRALIX identity and honesty rules are prepended to every request.
- Request size, message count and per-message length are capped.
- Per-IP rate limiting (30 requests/minute per isolate — swap in Durable Objects
  or KV for a global limit).
- CORS allowlist via `TRALIX_ALLOWED_ORIGINS`.
- The key is read from the environment, never logged, never returned.

## Deploy — Cloudflare Workers (shortest path)

```bash
npm i -g wrangler          # or: npx wrangler …
wrangler secret put OPENAI_API_KEY
wrangler deploy server/worker.js --name tralix-backend
```

Then in TRALIX: **Settings → Advanced → Backend URL** → paste
`https://tralix-backend.<your-subdomain>.workers.dev` → **Save URL**, then
**Test connection**.

## Deploy — any Node 18+ host (VPS, Render, Railway, Fly)

```bash
OPENAI_API_KEY=sk-... node server/node.js            # API only
OPENAI_API_KEY=sk-... node server/node.js --static   # API + the web app
```

`--static` serves the repository root as well, so `http://localhost:8787` runs
the whole product on one origin (no CORS involved).

## Deploy — Vercel / Netlify functions

Same contract; port `worker.js`'s `fetch(request, env)` into a function handler
and map the routes below `/api/*`. Nothing else needs to change — the frontend
only depends on the three endpoints above.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | yes | OpenAI key. Server-side only. |
| `TRALIX_MODEL_FAST` / `_SMART` / `_CODE` / `_RESEARCH` | no | Override the tier → model mapping. |
| `TRALIX_ALLOWED_ORIGINS` | no | Comma-separated origin allowlist. Default `*`. |
| `TRALIX_ENABLE_WEB_SEARCH` | no | `true` enables the OpenAI web search tool, which flips the UI's "Web search" capability to *Available*. |
| `OPENAI_BASE_URL` | no | Gateway/proxy override. |
| `PORT` | no | Node adapter port (default 8787). |

See `.env.example`.

## Local development

```bash
OPENAI_API_KEY=sk-... node server/node.js --static
```

Without a key the backend still starts and `/api/health` reports
`configured: false` — the UI then explains that the backend is reachable but not
configured, instead of pretending to work.

## Tests

```bash
node tests/logic.test.mjs     # frontend logic
npm run check                 # syntax + asset integrity + secret scan
```
