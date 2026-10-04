# TRALIX AI — Upgrade Report

Upgrade of the existing repository, in place. Nothing was rebuilt from scratch, no working
functionality was removed, and every feature that is not genuinely implemented is either absent
or labelled **Coming soon**. No API key exists anywhere in the frontend.

---

## 1. What changed

### Brand and identity
- The app is now **TRALIX AI — Intelligent AI Assistant** everywhere: document title, manifest
  (`name`, `short_name`, `description`, `theme_color`, `background_color`), boot screen, sidebar
  brand, welcome screen, status text, error copy and settings.
- **A provider name is never shown as the product identity.** `Gemini`, `ChatGPT` and `JARVIS` no
  longer appear in user-facing chrome; the only place a provider is named is the advanced "bring
  your own key" panel, where it is a technical choice, and the model tier list, which uses TRALIX
  tier names (`TRALIX Fast / Smart / Code / Research`) with the underlying model as small print.
- **JARVIS survives as an optional personality mode** (Settings → Personality), one of
  `balanced`, `concise`, `technical`, `jarvis`. It changes tone, never identity.
- **New logo mark**: a "T" (cyan) inside a violet→blue ring on near-black, generated at
  `icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `favicon-32.png`, plus a dedicated
  `icon-maskable-512.png` (art scaled into the 80% safe zone) and vector source `icons/mark.svg`.
  No humanoid face, no 3D character, no orbital sci-fi furniture. The same mark is inlined as the
  sidebar SVG, so in-app branding and the home-screen icon match.

### Architecture
```
User → TRALIX frontend (static, GitHub-Pages-safe)
        └─ POST /api/chat  (SSE streaming)     → TRALIX backend (server/worker.js | server/node.js)
        └─ GET  /api/health, /api/models      →        └─ OpenAI Responses API
```
- The frontend never talks to a model provider directly in the default configuration. It calls a
  TRALIX-owned endpoint (`api/client.js` + `api/backend.js`); the base URL is resolved from
  `tralix.backend.v1` storage → `window.TRALIX_API_BASE` → same origin.
- `assets/js/providers.js` is now a thin compatibility shim over the real client. It contains no
  provider endpoints; `tools/check.mjs` fails the build if any frontend module other than
  `api/local.js` references a provider host.
- **No scraping, no automation, no hidden browser.** Nothing in the project opens or fetches
  chatgpt.com (a repo-wide scan for `chatgpt.com` / `chat.openai` returns nothing).

### UI/UX
ChatGPT-grade *principles* only — clean, minimal, spacious, strong typographic hierarchy,
unobtrusive controls, mobile-first — with TRALIX-specific structure:
- Dark near-black canvas (`#0a0b0f`), subtle blue/violet accents (`#6e7bff`, `#a06bff`), a small
  amount of cyan (`#4fd8e8`), soft 1px borders, restrained glass on overlays, minimal glow.
- Two-pane desktop shell with a collapsible sidebar: New chat, Search, Projects, Memory, chat
  history grouped by recency with pin/archive, Settings, a live status row and a device/account row.
- Mobile: drawer navigation, a top bar showing the TRALIX mark + name, model selector reachable from
  the sidebar (`Model · TRALIX Smart`) and from a conversation's options menu, 44px tap targets,
  safe-area padding, `100dvh`/visual-viewport handling.
- Welcome screen with four honest starter prompts (ask / build / analyse / research) — each sends a
  real message, none is decorative.
- Message rendering: markdown including tables (wrapped for horizontal scroll on mobile) and code
  blocks with language label, copy button and syntax highlighting across
  js/ts/py/rb/go/rs/java/c/sh/sql/json/yaml/css/markup/diff.
- Composer: auto-growing textarea, Enter/Shift+Enter, mic, attachments (marked *Coming soon*), a
  send button that becomes **Stop** while streaming, and post-answer actions (copy, regenerate,
  follow-ups).
- Settings sheet with tabs (General / Appearance / Voice / Memory / Advanced / About), a
  connection doctor, and an explicit "this is not connected" state instead of pretending.
- Accessibility: full keyboard operation, visible focus rings, ARIA roles/labels on every control
  and live region, `prefers-reduced-motion` and `prefers-contrast` support, WCAG-minded contrast.

### Security
- No API key in HTML, CSS, JS, the manifest, the service worker or any committed file; the only
  key handling in the frontend is the optional BYO-key field, stored locally on the device.
- Server-side key only: `OPENAI_API_KEY` is read from the backend environment (Wrangler secret or
  Node env). It is never echoed to a client; `/api/health` reports `configured: true|false` only.
- Request hardening on the backend: CORS allow-list, 256 KB body cap, 60 messages, 24 000 chars per
  message, 30 requests/minute per client, structured error codes with no stack traces.

### Data, storage and PWA
- Local-first store (`store.js`) under `tralix.{chats,settings,memory,projects,meta}.v2` with a
  one-time, non-destructive migration from the previous `jarvis.*.v1` keys. Chats are never
  silently dropped; export strips the key.
- Service worker bumped to `tralix-v5`, cache-first shell, `/api/` never cached; manifest keeps
  `standalone` display, theme colours, shortcuts and maskable icon.
- Mobile scrolling contract: only the message list scrolls, `body` is never permanently locked, and
  the scroll lock is a reference-counted sheet/drawer lock with a forced-release safety valve.

---

## 2. Preserved functionality

| Preserved | Notes |
| --- | --- |
| Static, buildless deployment | Still plain `index.html` + `assets/`; works on GitHub Pages as before, no bundler, no runtime dependencies. |
| PWA | Manifest, icons, theme colour, standalone mode, safe-area handling and service worker retained (SW version bumped so clients refresh). |
| Local chat history, settings, memory, projects | Same feature set, upgraded schema with backwards migration. |
| Bring-your-own-key mode | Still available in Advanced settings, untouched as an opt-in escape hatch. |
| Voice | Mic input, speech recognition, TTS, read-aloud, rate, voice selection and auto-speak retained and re-skinned into Listening / Thinking / Speaking states. |
| Highlighting, markdown, copy/regenerate/follow-ups | Kept, and the highlighter/markdown engines were strengthened rather than replaced. |
| Existing routes, ids, storage keys | Old deep links and stored data keep working; the legacy key namespace is migrated, not abandoned. |
| Icons and repo layout | Original `icons/` directory retained; the original source art is still in the repo. |

---

## 3. Backend / API added

A clearly separated server layer (`server/`) with one HTTP contract used by both implementations:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chat` | Streams an assistant reply as SSE with frames `{type:'model'\|'delta'\|'usage'\|'done'\|'error'}`. |
| `GET /api/health` | Capabilities + configuration state. Drives the UI's feature flags. |
| `GET /api/models` | The TRALIX tier list and its current resolution. |

- `server/worker.js` — Cloudflare Worker (serverless, secrets via `wrangler secret put`).
- `server/node.js` — dependency-free Node server; `node server/node.js --static` serves the
  frontend and the API from one origin (used for local development and self-hosting).
- Upstream call: **OpenAI Responses API**, streaming, with `response.output_text.delta`
  consumed for deltas and `response.completed` / `response.failed` for termination.
  Reasoning-capable models are called with a modest reasoning effort (nested `reasoning: {effort}`
  on Responses) to keep first-token latency reasonable; non-streaming models are not used for chat.
- `server/.env.example`, `server/wrangler.toml` and `server/README.md` document configuration and
  deployment.

**Live verification (no key present, port 8787):**
```
GET  /api/health → 200 {"ok":false,"configured":false,"provider":"openai","model":"gpt-5",
                        "features":{"webSearch":false,"attachments":false,"codeExecution":false},
                        "rateLimit":{"windowMs":60000,"max":30},"error":"invalid_config"}
GET  /api/models → 200 tralix-fast → gpt-5-mini, tralix-smart → gpt-5,
                        tralix-code → gpt-5-codex, tralix-research → gpt-5
POST /api/chat   → 200 {"error":{"code":"invalid_config","message":"OPENAI_API_KEY is not set…"}}
```

---

## 4. OpenAI model configuration

Model selection lives in `assets/js/models.js` (tiers) and on the backend (actual model ids), so
the frontend never hardcodes a provider model where it matters.

| TRALIX tier | Default upstream | Reasoning effort | Used for |
| --- | --- | --- | --- |
| `tralix-fast` | `gpt-5-mini` | minimal | quick answers, short edits |
| `tralix-smart` *(default)* | `gpt-5` | low | general conversation and reasoning |
| `tralix-code` | `gpt-5-codex` | medium | code generation and review |
| `tralix-research` | `gpt-5` | high | long-form analysis (web search only if enabled) |

- Tier → upstream mapping is overridable with environment variables, so a model can be changed
  without touching or redeploying the frontend.
- `/api/models` reports the live mapping, and `applyServerMapping()` reconciles the UI with whatever
  the backend actually resolved.
- Multi-turn reasoning items are carried with `include: ["reasoning.encrypted_content"]`.
- Non-streaming models are deliberately not used for chat; a stream that fails mid-way surfaces as a
  retryable error rather than a fabricated answer.

---

## 5. Environment variables and secrets

| Variable | Where | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | **Backend secret only** (Wrangler secret / Node env) | Upstream auth. Never sent to the browser. |
| `TRALIX_MODEL_FAST` / `_SMART` / `_CODE` / `_RESEARCH` | Backend | Override the tier → model mapping. |
| `TRALIX_ALLOWED_ORIGINS` | Backend | CORS allow-list for the API. |
| `TRALIX_ENABLE_WEB_SEARCH` | Backend | Enables the upstream search tool when the deployment supports it. |
| `OPENAI_BASE_URL` | Backend | Optional proxy/base override. |
| `PORT`, `HOST` | Backend (`node.js`) | Listen address, default `8787` on `0.0.0.0`. |

Nothing in the frontend build needs a secret, and there is no client-side env file. Local
development: `OPENAI_API_KEY=… node server/node.js --static`. Production (Cloudflare):
`wrangler secret put OPENAI_API_KEY` then
`wrangler deploy server/worker.js --name tralix-backend`.

---

## 6. Features that need a separate backend deployment

The frontend is GitHub-Pages-compatible on its own. These require the `server/` layer to be
deployed, and the UI reflects that honestly (it reads `/api/health` and enables/disables them):

1. **Streaming chat** — the core feature; without a backend the composer states that TRALIX is not
   connected (or the user opts into their own key in Advanced settings).
2. **Web search / live information** — *Coming soon*; gated behind `TRALIX_ENABLE_WEB_SEARCH` and
   reported by `/api/health`. While unavailable, TRALIX says it cannot check live data instead of
   guessing.
3. **File attachments** — *Coming soon*; the bucket is present and inert, and the UI says so. No
   claim of file analysis is made anywhere.
4. **Server-side code execution** — *Coming soon*; flag only, no simulated output.
5. **Any multi-device sync / shared projects** — the Projects area is a complete local UI, and it
   works entirely on-device; syncing would need a backend.

---

## 7. Build, lint, typecheck and test results

The project is intentionally buildless (static ESM, no bundler, no runtime dependencies), so
"production build" is the served artifact itself — verified by loading it from the running server.

| Step | Command | Result |
| --- | --- | --- |
| Static audit / lint-equivalent | `node tools/check.mjs` | **90/90 passed** |
| Unit tests (store, markdown, highlight, models, tools, personality, errors, util) | `node tests/logic.test.mjs` | **121/121 passed** |
| Backend integration (real handler vs a Responses-API double) | `node tests/backend.test.mjs` | **93 passed, 0 failed** |
| Runtime integration tests (jsdom: boot, chat, streaming, stop, retry, connection states, sheets, memory, projects, search, model picker, scroll lock) | `node tests/dom.test.mjs` | **118 passed, 0 failed** |
| Backend smoke test | `curl /api/health`, `/api/models`, `/api/chat`, static assets | **200 / expected payloads** |
| Production artifact | `node server/node.js --static` on `0.0.0.0:8787` | `index.html`, `app.css`, `app.js`, `manifest.webmanifest`, `sw.js`, all icons → **200** |

Aggregate shortcut: `npm run verify` (check + logic + backend + dom). See `docs/connection-report.md` for the live-connection status.
**No known errors.** No failing tests, no console-breaking defects, no dead buttons.

---

## 8. Remaining limitations (honest list)

1. **No real-browser run was possible in this environment.** Playwright/Chromium could not be
   downloaded (the CDN refused the connection), so runtime verification is jsdom-based plus a live
   HTTP smoke test. Layout, CSS and touch behaviour are reasoned about and structurally tested, but
   have not been exercised in Safari/Chrome on a physical device. **Recommendation:** open the
   preview on an iPhone once and confirm the message list scrolls and the drawer lock releases.
2. **No API key is configured here**, so no real model response has been produced end to end. All
   streaming behaviour is verified against a stub; the first live call should be treated as a
   smoke test.
3. **Web search, attachments and code execution are not implemented** — flags only. They are
   labelled *Coming soon* and are never faked.
4. **Voice quality is device-dependent.** Speech recognition and synthesis use the platform APIs;
   availability and voice list vary by browser and OS, and nothing is emulated if they are missing.
5. **Projects, memory and chat history are local to the device.** There is no account, no sync and
   no server-side persistence; clearing site data clears them (the export path is the backup).
6. **Model ids are defaults, not guarantees.** Upstream naming changes over time; the tier mapping
   is env-overridable and `/api/models` reflects reality, but a stale default will surface as a
   backend error rather than being silently swapped.
7. **The icons were regenerated programmatically** from the new mark (no design toolchain in this
   environment). The maskable variant is safe-zone-compliant; if a designer later refines the mark,
   `icons/mark.svg` is the source of truth.
