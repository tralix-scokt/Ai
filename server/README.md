# TRALIX backend

The API layer that holds the OpenAI key. The frontend never talks to OpenAI —
it talks to this. One handler, two deployment targets, identical behaviour.

```
TRALIX frontend (GitHub Pages, static)
   │  POST /api/chat   → SSE stream
   │  GET  /api/health → verified connection report
   │  GET  /api/models → TRALIX tier → OpenAI model mapping
   ▼
TRALIX backend  ← OPENAI_API_KEY lives here and nowhere else
   │  POST {OPENAI_BASE_URL}/responses  (Responses API, streamed)
   ▼
OpenAI
```

| File | What it is |
| --- | --- |
| `worker.js` | The whole backend. Cloudflare Workers, Deno, Bun, or Node via the adapter. |
| `node.js` | Node 18+ adapter. `--static` also serves the frontend from one origin. |
| `wrangler.toml` | Worker config: name, compatibility date, non-secret vars. |
| `.env.example` | Every environment variable, with placeholders only. |

---

## 1. Run it locally (5 minutes, no account needed)

```bash
OPENAI_API_KEY=sk-… node server/node.js --static
# → http://localhost:8787   (app + API on the same origin)
```

Check it:

```bash
curl -s "http://localhost:8787/api/health?probe=1" | head -c 400
curl -s  http://localhost:8787/api/models
```

`"ok": true` and `"verified": true` mean the backend reached OpenAI and the key
was accepted. That is a real upstream round-trip, not a guess.

## 2. Deploy it separately (Cloudflare Workers)

The frontend stays on GitHub Pages. Only this API moves.

### Option A — GitHub Actions (recommended, nothing to install)

1. In the repository: **Settings → Secrets and variables → Actions → Secrets**,
   add three secrets:

   | Secret | Where it comes from |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers overview → Account ID |
   | `OPENAI_API_KEY` | platform.openai.com → API keys |

2. Optionally add **Variables** (not secrets): `TRALIX_ALLOWED_ORIGINS`
   (default `https://tralix-scokt.github.io`), `TRALIX_MODEL_SMART`, and so on.

3. Run **Actions → Deploy TRALIX backend → Run workflow**. It prints the worker
   URL and a health link. The key is pushed from the runner to Cloudflare as an
   encrypted secret — it is never written into the repository, and never appears
   in the logs.

### Option B — from your machine

```bash
export OPENAI_API_KEY=sk-…            # never committed, never echoed
./tools/deploy-backend.sh             # wraps wrangler deploy + secret put
```

or by hand:

```bash
cd server
npx wrangler deploy worker.js --name tralix-backend \
  --var TRALIX_ALLOWED_ORIGINS:https://tralix-scokt.github.io
npx wrangler secret put OPENAI_API_KEY
```

### Option C — your own server (Render, Railway, Fly, a VPS)

```bash
OPENAI_API_KEY=… TRALIX_ALLOWED_ORIGINS=https://tralix-scokt.github.io \
  node server/node.js --static
```

## 3. Point the frontend at it

The GitHub Pages frontend is static, so it needs to be told where the API is.
Edit **`backend.json` in the repository root** and commit it:

```json
{ "url": "https://tralix-backend.<your-subdomain>.workers.dev" }
```

This file is public by design — it contains a URL, never a key. The service
worker deliberately never caches it, so a change is picked up on the next load.

Resolution order (first non-empty wins):

1. a device override saved in the app (Connect sheet / Settings → Advanced)
2. `window.TRALIX_API_BASE`
3. `?api=https://…` in the URL
4. `backend.json`
5. same origin — correct when `node server/node.js --static` serves both

Diagnostics (Settings → Diagnostics, or the Connect sheet) always shows which
one is in use.

## 4. Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | **yes** | — | Upstream auth. Server-side only. |
| `TRALIX_ALLOWED_ORIGINS` | recommended | `*` | Comma-separated origin allow-list for CORS. |
| `TRALIX_MODEL_FAST` | no | `gpt-5-mini` | Model behind `tralix-fast`. |
| `TRALIX_MODEL_SMART` | no | `gpt-5` | Model behind `tralix-smart` (default tier). |
| `TRALIX_MODEL_CODE` | no | `gpt-5-codex` | Model behind `tralix-code`. |
| `TRALIX_MODEL_RESEARCH` | no | `gpt-5` | Model behind `tralix-research`. |
| `TRALIX_ENABLE_WEB_SEARCH` | no | `false` | Advertises the upstream web-search tool. |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Gateway/proxy, or a test double. |
| `PORT` / `HOST` | no | `8787` / `0.0.0.0` | Node adapter listen address. |

## 5. API contract

### `POST /api/chat`

```json
{
  "model": "tralix-smart",
  "instructions": "…optional system prompt…",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true,
  "tools": ["web_search"]
}
```

Streams `text/event-stream`:

```
data: {"type":"model","model":"gpt-5"}
data: {"type":"delta","text":"Hello"}
data: {"type":"usage","usage":{"input":42,"output":17,"total":59}}
data: {"type":"done","model":"gpt-5","status":"completed"}
```

`done.status` is `completed`, `incomplete` (the upstream connection dropped
mid-answer — the partial text is kept and the user can retry) or `closed`.

### `GET /api/health[?probe=1]`

```json
{
  "ok": true, "status": "ok", "reachable": true,
  "configured": true, "verified": true,
  "provider": "openai", "model": "gpt-5",
  "models": { "tralix-smart": { "model": "gpt-5", "effort": "low", "available": true } },
  "features": { "webSearch": false, "attachments": false, "codeExecution": false },
  "rateLimit": { "windowMs": 60000, "max": 30 },
  "checkedAt": "2026-10-04T20:39:32.289Z", "latencyMs": 16
}
```

| `status` | Meaning |
| --- | --- |
| `ok` | The key was accepted upstream. Chat works. |
| `unconfigured` | Backend is up, `OPENAI_API_KEY` is missing. |
| `unauthorized` | The upstream rejected the key. |
| `rate_limit` | The key works but is being throttled. |
| `upstream_error` / `upstream_timeout` | The upstream is failing or slow. |
| `unreachable` | The backend itself could not be reached (client-side). |

### `GET /api/models`

Tier → provider model, reasoning effort and whether that model exists in the
upstream model list. This is the source of truth the UI reads.

## 6. Limits and safety

* 256 KB request body, 60 messages, 24 000 characters per message.
* 30 requests per minute per client IP (per isolate on Workers).
* The identity and honesty rules in `SERVER_IDENTITY` are applied **server
  side**, so editing the payload in a browser cannot remove them.
* Upstream error bodies are redacted before they are logged or returned.
  `sk-…` and `Bearer …` patterns can never reach a client or a log line.
* Nothing is stored server-side: no conversations, no prompts, no logs of
  message content. Only request metadata.

## 7. Tests

```bash
npm run test:backend     # drives the real handler against a Responses-API double
npm run fake:openai      # the double, standalone, for manual poking
```

`tests/fake-openai.mjs` is a **test fixture**, not part of the product. It speaks
the real Responses API wire format (`response.created`,
`response.output_text.delta`, `response.completed`) and can simulate 401, 403,
429, 500, a missing model, an empty answer and a connection dropped mid-stream.
It exists so the streaming path, the Stop button and the error mapping can be
proven without spending a real key. Nothing in the shipped app can reach it.
