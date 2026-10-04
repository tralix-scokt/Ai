# TRALIX AI — connection report

Status of the frontend ↔ TRALIX backend ↔ OpenAI path after this round of work.

> **The AI is not connected yet.** This environment has no `OPENAI_API_KEY` and no
> Cloudflare credentials, so no request has ever reached `api.openai.com` from
> here. Everything up to that boundary is implemented and verified; the two
> steps in *"What is still needed"* below are the only things standing between
> this build and a live assistant. Nothing else is simulated or faked.

---

## 1. The exact backend URL the frontend is configured to use

**Right now: same origin (`""`).**

`backend.json` ships with an empty `url`, so `apiBase()` returns `''` and every
call goes to `/api/…` on whatever origin serves the app. That is correct for
local self-hosting:

```
OPENAI_API_KEY=… node server/node.js --static   →  http://localhost:8787  →  /api/chat ✅
```

It is **not** sufficient for GitHub Pages, because `tralix-scokt.github.io`
cannot run the backend. On Pages the app will therefore resolve to same-origin,
get a 404 from `/api/health`, and honestly report *"Backend unreachable"* until
the deployed worker URL is filled in:

```json
// backend.json  (public pointer — a URL, never a key)
{ "url": "https://tralix-backend.<your-subdomain>.workers.dev" }
```

| Resolution order | Source | Set by |
| --- | --- | --- |
| 1 | device override | Connect sheet / Settings → Advanced (**Save & test**) |
| 2 | `window.TRALIX_API_BASE` | an embedding page |
| 3 | `?api=https://…` | a URL, handy for testing a new deployment |
| 4 | `backend.json` | committed in the repo root |
| 5 | same origin | `node server/node.js --static` |

Diagnostics (Settings → Diagnostics → *Backend URL source*) always reports which
one is in use, along with the verified status.

## 2. Environment variables that still need configuring

| Variable | Where | Value needed | Required? |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | server secret only | a real key from platform.openai.com | **yes — nothing works without it** |
| `backend.json` → `url` | repo root (public) | the deployed backend URL | **yes, for GitHub Pages** |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | Workers Scripts: Edit | yes, for the workflow |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | Cloudflare account ID | yes, for the workflow |
| `TRALIX_ALLOWED_ORIGINS` | worker var / Actions variable | `https://tralix-scokt.github.io` (the default in `wrangler.toml` and the workflow) | recommended |
| `TRALIX_MODEL_FAST` / `_SMART` / `_CODE` / `_RESEARCH` | worker var | optional overrides | no |
| `TRALIX_ENABLE_WEB_SEARCH` | worker var | `true` only if you want the upstream search tool | no |
| `OPENAI_BASE_URL` | server env | a gateway/proxy, or a local test double | no |

No key exists in the frontend, in `backend.json`, in the repository, in the
service worker, or in any log line — `tools/check.mjs` fails the build if one appears.

## 3. What is implemented

**Backend** (`server/worker.js`, shared by the Worker and the Node adapter)

| Endpoint | Behaviour |
| --- | --- |
| `GET /api/health[?probe=1]` | Verifies the key against the upstream model list (8s timeout, 45s cache). Reports `ok`, `status`, `reachable`, `configured`, `verified`, per-tier availability, `checkedAt`, `latencyMs`. |
| `GET /api/models` | Source of truth: tier → model, reasoning effort, label, and whether that model exists upstream. |
| `POST /api/chat` | Streams `model → delta… → usage → done` as SSE; aborts the upstream request when the client goes away. |

`ok: true` means *the backend proved it can answer right now* — a verified
upstream round-trip, not an assumption. Failure vocabulary: `unconfigured`,
`unauthorized`, `rate_limit`, `upstream_error`, `upstream_timeout`, `unreachable`.

**Frontend**

* Automatic detection: at boot, every 60s while the tab is visible, on `online`,
  when the tab regains focus, and after any failed request.
* The sidebar row, Connect sheet, model picker and Diagnostics all read one
  connection state machine, so the status can never disagree with reality.
* Failed turns offer **Retry** (re-sends the same turn, no duplicated user
  message) and a **Connection** shortcut. A cut-short answer keeps its text.
* Chat is never gated behind a "coming soon" state: when a backend is verified,
  messages stream straight into the existing interface with Stop, Copy,
  Regenerate, Follow-ups, markdown, tables and code blocks intact.

## 4. Verification performed

| Requirement | How it was verified | Result |
| --- | --- | --- |
| `npm run verify` | check · logic · backend · dom | **422 assertions, 0 failures** |
| `GET /api/health` | live HTTP, keyless server and doubled upstream | `unconfigured` / `verified: true` |
| `GET /api/models` | live HTTP | 4 tiers, availability resolved |
| `POST /api/chat` | live HTTP | `model → delta → usage → done` |
| SSE streaming | live HTTP + 93 backend assertions; deltas reassemble to the exact answer | ✅ |
| **An actual OpenAI response** | **impossible here — no key exists in this environment** | **not verified** |
| Stop generation | live HTTP: client abort → `aborted upstream requests: 0 → 1` | ✅ |
| Tier → model mapping | upstream log: `tralix-smart → gpt-5 (effort low)`, `tralix-research → gpt-5 (effort high)` | ✅ |
| Error mapping | 401/403 → `unauthorized`, 429 → `rate_limit`, 500 → `provider_unavailable`, bad model → `invalid_config`; no vendor body, no key material | ✅ |
| CORS | allow-list echoes the Pages origin, refuses others | ✅ |
| Key hygiene | server logs clean, client payloads clean, static scan clean | ✅ |
| iPhone/mobile chat scroll | CSS contract asserted from the shipped rules (`.app` fixed to `--vvh`/`100dvh` and never scrolls, `.chat` is the scroll container with momentum scrolling, no `body{overflow:hidden}` anywhere) | ✅ by rule; not on a physical device |
| Mobile drawer releases its scroll lock | body scrolling restored after a sheet closes, after a drawer closes, and only after the last of two nested overlays; `scrollTo` guarded | ✅ |
| Retry after a failure | jsdom: the button exists, re-sends the same turn, streams a reply, does not duplicate the user bubble, and the status recovers to "connected" | ✅ |

### Why "an actual OpenAI response" is not verified

`tests/fake-openai.mjs` is a local double that speaks the **real** Responses API
wire format (`response.created`, `response.output_text.delta`,
`response.completed` with `usage`), plus the failure modes (401, 403, 429, 500,
missing model, empty answer, mid-stream disconnect). It proves the TRALIX side of
the pipe is correct — request shape, tier mapping, reasoning effort, streaming,
abort, error mapping, redaction.

It cannot prove that `api.openai.com` accepts your key, because it never touches
it. That claim is deliberately withheld.

## 5. What is still needed (2 steps)

**Step 1 — deploy the backend with the key**

Repository → Settings → Secrets and variables → Actions → *Secrets*:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → *Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers overview → Account ID |
| `OPENAI_API_KEY` | your key (never committed; pushed to the worker as an encrypted secret) |

Then run **Actions → Deploy TRALIX backend → Run workflow**. It prints the
worker URL and a health link. Prefer your own host?

```bash
export OPENAI_API_KEY=sk-…
./tools/deploy-backend.sh          # or: --node for the self-host command
```

**Step 2 — point the frontend at it**

```bash
# backend.json
{ "url": "https://tralix-backend.<your-subdomain>.workers.dev" }
```

Commit and push. On the next load the app probes that URL; when the answer is
`"ok": true, "verified": true`, the sidebar reads **“TRALIX backend · connected”**
and chat streams for real. To try it on one device first, paste the URL into the
Connect sheet and tap **Save & test** — that performs the same upstream probe.

Verify from the command line at any time:

```bash
curl -s "https://tralix-backend.<your-subdomain>.workers.dev/api/health?probe=1"
# {"ok":true,"status":"ok","verified":true,…}   ← this is the line that proves it
```

## 6. Local previews running in this workspace

| Port | What it is |
| --- | --- |
| `8787` | **Honest state**: the real backend with no key. The UI reports *"Backend has no API key"* and failed sends offer Retry — exactly what a deployed-but-unkeyed backend looks like. |
| `8789` | **Plumbing demo**: the same backend pointed at the local Responses-API double. Chat streams, Stop stops, Retry retries — with a stub upstream, **not OpenAI**. |

Neither port is connected to OpenAI. Port 8789 exists to demonstrate that the
transport works; its replies are generated by `tests/fake-openai.mjs`.
