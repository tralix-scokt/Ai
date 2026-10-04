# TRALIX AI

**Intelligent AI Assistant** — a mature, mobile-first AI assistant you can install
on your Home Screen, plus a secure backend that keeps the OpenAI key on the server.

```
User
 ↓
TRALIX AI frontend                    (static PWA — GitHub Pages safe)
 ↓
Secure TRALIX backend / API           (holds the key, enforces the rules)
 ↓
OpenAI API → OpenAI model
 ↓
TRALIX backend → TRALIX AI frontend → User
```

No scraping, no browser automation, no ChatGPT.com behind the scenes: the app talks
to the official **OpenAI Responses API** through our own `/api/chat` endpoint.

---

## What it is now

| This is TRALIX | This is not |
|---|---|
| An independent product identity (TRALIX AI · Intelligent AI Assistant) | A rebranded vendor chat window |
| A mobile-first, iPhone-optimised interface | A desktop app squeezed onto a phone |
| A secure backend + a static frontend | An API key pasted into JavaScript |
| Honest about what it can and cannot do | A demo that pretends features exist |

**JARVIS is a personality mode inside TRALIX**, not the product name.
**Provider model names are an implementation detail** — users choose
*TRALIX Fast / Smart / Code / Research*.

---

## Quick start

### 1. Try the interface (no backend yet)

```bash
npx serve .            # or: python3 -m http.server
```

The UI loads fully. Without a backend, sending a message produces a clear,
professional error state instead of a fake reply.

### 2. Run the whole product locally (recommended)

```bash
OPENAI_API_KEY=sk-... node server/node.js --static
# → http://localhost:8787
```

### 3. Deploy

**Frontend** — already static: push to `main`; GitHub Pages serves the app shell.
(`.nojekyll` is present, all paths are relative, and the manifest keeps `id: "/Ai/"`.)
After deploying, hard-refresh once so the new service worker replaces the old shell.

**Backend** — pick one:

```bash
# Cloudflare Workers (shortest path)
wrangler secret put OPENAI_API_KEY
wrangler deploy server/worker.js --name tralix-backend

# or any Node 18+ host
OPENAI_API_KEY=sk-... node server/node.js
```

Then in the app: **Settings → Advanced → Backend URL** → paste the URL → **Save URL**,
then **Test connection**. Or tap the connection row in the sidebar → **Set up**.

### Environment / secrets

| Variable | Where | Required | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | **server only** | yes | Never in the frontend, never in Git. |
| `TRALIX_MODEL_FAST/_SMART/_CODE/_RESEARCH` | server | no | Override the tier → model mapping. |
| `TRALIX_ALLOWED_ORIGINS` | server | no | Comma-separated CORS allowlist (default `*`). |
| `TRALIX_ENABLE_WEB_SEARCH` | server | no | `true` enables the OpenAI web-search tool and flips the UI capability to *Available*. |
| `OPENAI_BASE_URL` | server | no | Gateway/proxy override. |
| `PORT` | server | no | Node adapter port (default 8787). |

See `server/.env.example` and `server/README.md`.

---

## Model system

Users see tiers; the backend resolves them to provider models.

| Tier | Tagline | Default mapping | Reasoning |
|---|---|---|---|
| `tralix-fast` | Fast responses | `gpt-5-mini` | minimal |
| `tralix-smart` | More capable reasoning | `gpt-5` | low |
| `tralix-code` | Programming-focused | `gpt-5-codex` | medium |
| `tralix-research` | Research-oriented | `gpt-5` | high |

Every default is overridable by environment variable, so model churn never requires
a frontend change. Provider details surface only in **Settings → Advanced**, and in
debug mode the picker shows the resolved model.

---

## What is preserved from the previous build

- All existing conversations, memories and settings — a real migration
  (`jarvis.*.v1` → `tralix.*.v2`) runs on first launch and **leaves the old keys
  untouched**, so nothing is lost and a rollback still finds its data.
- Memory (now categorised: Personal · Preferences · Projects · Instructions · Other,
  with edit/delete and an undo on delete).
- Voice: push-to-talk speech recognition and spoken replies (now with voice choice,
  speed, pitch, auto-speak and sentence-chunked playback for iOS).
- PWA install, standalone display, safe-area handling, offline app shell.
- Export / import backup, clear conversations, erase everything.
- The optional bring-your-own-key provider mode (moved to Advanced, device-only).
- The dark/light theme, the general look of the orb mark, and the deployment shape.

## What is new

- Sidebar information architecture: New chat, Search, Projects, conversation
  history grouped Today / Yesterday / Previous 7 days, Settings, user area.
  Collapsible on desktop, slide-out drawer on mobile.
- Chat: streaming with *TRALIX is thinking…*, Stop generating, and per-response
  actions (Copy · Regenerate · Read aloud · Like · Dislike · More →
  Continue / Shorter / Longer / Explain / Rewrite / Save).
- Markdown rendering with highlighted code blocks, language labels, copy buttons
  and horizontal scrolling; tables, task lists, quotes, links.
- The TRALIX system personality: precise, calm, professional, no filler enthusiasm,
  with an explicit honesty policy about tools and live data.
- Response styles (Concise / Balanced / Detailed) and personality modes
  (TRALIX / JARVIS / Custom).
- Settings split into General · AI · Voice · Memory · Data · Advanced, with a
  diagnostics report and a developer debug panel.
- Projects, chat search across titles *and* message text (with snippets), rename,
  pin, archive with undo, delete with undo.
- A tool layer (`assets/js/tools.js`) that describes real capabilities and refuses
  to fake the ones that are not deployed.
- Professional error states, keyboard shortcuts (⌘K, ⌘⇧O, ⌘/), a TRALIX status
  indicator (idle · listening · thinking · generating · speaking · error) and
  reduced-motion support.

---

## Mobile & scroll contract

The layout is built so a long conversation scrolls with a finger on iPhone:

- the document never scrolls; the message column does,
- no `overflow: hidden` on `html`/`body` in normal use — the lock is reference-counted
  and only while a drawer or modal is genuinely open, then always released
  (including on page hide and via a safety valve),
- no `position: fixed` page locking and no `touch-action: none` on the body,
- the app is fitted to `visualViewport` (`--vvh` + explicit height), so the keyboard
  cannot push the composer off screen,
- `env(safe-area-inset-*)` is respected top and bottom; the composer sits inside the
  layout, not fixed over it, and never blocks scrolling.

---

## Capabilities, honestly

| Capability | State |
|---|---|
| Chat with streaming replies | **Available** (needs the backend configured) |
| Memory, projects, voice, PWA offline shell | **Available** |
| Web search | **Only** if the backend sets `TRALIX_ENABLE_WEB_SEARCH=true`; otherwise TRALIX says it cannot check live data |
| Attachments (PDF/TXT/DOCX/images/code) | **Not deployed** — the button explains this instead of pretending |
| Code execution, calendar, reminders, weather, news | **Not deployed** — listed in the tool layer as unavailable |

`/api/health` is the source of truth: the UI marks a capability available only when
the backend advertises it.

---

## Testing

```bash
npm run check      # syntax, JSON, asset refs, SW shell, secret scan, DOM contract
npm test           # 121 logic tests (markdown, memory, migration, tools, scroll…)
npm run verify     # both

npm install --no-save jsdom
npm run test:dom   # 62 integration checks: boots the real app in jsdom and drives
                   # send/stream/error/sheets/drawer/search/projects/memory/transport
```

`npm run check` also fails the build if a key-like string, a `chatgpt.com`
reference, or a frontend call to a provider API is ever committed.

---

## Project structure

```
index.html                     app shell: sidebar, chat, composer, all overlays
assets/app.css                 design system (tokens, dark/light, mobile-first)
assets/js/
  app.js                       boot + wiring only
  config.js                    identity, feature flags, backend URL resolution
  errors.js                    one error vocabulary → friendly messages
  store.js                     persistence + migration from the Jarvis build
  models.js                    TRALIX tiers ↔ provider models
  personality.js               TRALIX system prompt, styles, memory extraction
  markdown.js  highlight.js    safe rendering and syntax highlighting
  tools.js                     tool layer (availability-honest)
  voice.js                     speech in / speech out (iOS-first)
  scrolling.js                 viewport fitting + scroll-lock manager
  api/client.js                fetch, timeouts, SSE parsing
  api/backend.js               TRALIX backend client (default transport)
  api/local.js                 optional device-only provider transport
  api/chat.js                  transport selection + request assembly
  ui/…                         sheets, feedback, status, messages, composer, chat,
                               sidebar, search, memory, projects, models,
                               settings, doctor
server/
  worker.js                    Cloudflare Worker: /api/chat, /api/health, /api/models
  node.js                      Node 18+ adapter (optionally serves the frontend)
  wrangler.toml  .env.example  deployment config
sw.js                          offline app shell (API traffic is never cached)
manifest.webmanifest           PWA metadata (TRALIX AI)
tests/                         logic tests + jsdom integration test
tools/check.mjs                static validation / secret scan
```

---

## Privacy

- Conversations, memories and settings live in **this browser**. Nothing is uploaded
  to a TRALIX server; only the messages needed for a reply are sent to the backend,
  which forwards them to OpenAI and stores nothing.
- The backend never logs message content, never returns the key, and refuses to run
  without one rather than pretending.
- Sensitive content (card numbers, passwords, API keys, IDs) is refused by the memory
  system even if you ask it to remember them.
- Exports never include a key.

## Licence

UNLICENSED — private project.
