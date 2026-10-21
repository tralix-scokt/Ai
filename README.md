# JARVIS STUDIO

**An AI coding workspace** — free-first multi-model routing, GitHub tasks that stop
for human review, checks that run in an isolated sandbox, and a voice-enabled
assistant. Buildless static PWA on the front, a dependency-free Node/Cloudflare
backend on the back.

```
Browser ── static PWA (GitHub Pages safe) ──┐
                                            │  /api/v2/*
                                   JARVIS backend (Node or Worker)
                                            │
        ┌───────────────┬───────────────────┼─────────────────┬──────────────┐
   free-tier models  paid models      GitHub API        Fish Audio       sandbox
   Gemini · Groq     OpenAI · Anthropic  (repos,        (text-to-speech) (allowlisted
   OpenRouter        Mistral            branches,                        commands,
   Ollama (local)                       commits, PRs)                    no network)
```

**Renamed from TRALIX AI.** The product chrome, copy, title and manifest now say
JARVIS STUDIO. Storage keys (`tralix.*.v2`), tier ids (`tralix-smart`) and every
environment variable (`TRALIX_*`) keep their old names, so an existing install
keeps its data. The original assistant — chat, memory, projects, voice, PWA — is
still there, unchanged in behaviour.

---

## Quick start

```bash
# 1. the whole product, locally (backend serves the app too)
npm run serve                       # → http://localhost:8787
```

The interface works without any key: every provider card says *No key*, GitHub says
*Not connected*, and the setup checklist tells you what is missing. Nothing on
screen is invented — if the backend cannot be reached, the Home area says
**Unreachable** and offers a retry.

Add a key when you have one (Settings → AI Models, or on the server):

```bash
GEMINI_API_KEY=your-key npm run serve
```

Then press **Test connection** on the provider card: the server makes a real
request to the vendor and reports what came back. A key that was only typed is
never called *connected*.

---

## The workspace

| Area | What it does | Needs |
|---|---|---|
| **Home** | Live system status (free models, paid usage, GitHub, sandbox, voice), a setup checklist, recent tasks and recent conversations | the backend |
| **Projects** | Connect GitHub, browse only the repositories the credential can see, pick a branch, read files, see per-repo task history | `GITHUB_TOKEN` |
| **JARVIS Assistant** | Conversation with streaming replies, plus the **Coding task** toggle that turns a message into a repo task with a plan, diffs and review | a provider key |
| **AI Models** | Provider cards with real verified state, key hints, cooldowns, enable/priority, the routing policy and the usage the vendor reported | — |
| **Settings** | GitHub permissions, task autonomy, sandbox report, voice, security notes and an environment-variable report | — |

Desktop: a rail on the left, the conversation or diff in the middle, the task panel
on the right. Mobile: the same five areas in a bottom bar. Areas stay mounted when
hidden, so a stream keeps running while you read a diff.

---

## Free-first routing

Chat and coding tasks go through `/api/v2/chat`, which picks a provider per
request:

1. **Free first.** Free-tier providers (Gemini, Groq, OpenRouter, Ollama) are
   ranked before paid ones; ties break on the priority you set.
2. **Failover, not failure.** A provider that is rate limited, cooling down or
   unreachable is skipped and the next eligible one is tried, with the context
   preserved. The response reports which provider answered and what was skipped.
3. **Paid usage is off by default.** A paid provider is only used after you
   explicitly allow fallback **and** set a monthly ceiling in USD. With neither,
   JARVIS stops with *No free model is available* rather than spending money.
4. **Nothing is fabricated.** Usage is shown only when the provider reports it;
   otherwise the table says *not reported*. Quotas, credits and costs are never
   estimated in the UI.
5. **One key is enough.** The app works with a single provider configured.

Every provider can be disabled individually and given a priority.

---

## GitHub workflow

A coding task moves through explicit states — **queued → analyzing → planning →
editing → testing → repairing → awaiting review → completed** (or
`awaiting_plan_review`, `failed`, `cancelled`) — and the panel shows the state,
the plan, the per-file diff, the captured stdout/stderr/exit codes of the checks
that ran, and a second-model review when one exists.

Safety rules, enforced in code and covered by tests:

- work happens on an isolated branch (`jarvis/…` by default) — never on the default branch;
- **nothing is committed until you press Commit**, and a pull request is only *prepared*, never merged;
- destructive or externally visible actions ask first;
- a task that cannot even plan creates no branch and reports why.

Authentication is PAT-first: a server-side `GITHUB_TOKEN` (a fine-grained token
limited to the repositories you choose, with *Contents: Read and write*,
*Metadata: Read-only*, *Pull requests: Read and write*). GitHub App credentials
and per-user OAuth are implemented as fallbacks. Tokens live on the server in a
`0600` file and are returned to the browser only as a four-character hint.

---

## Safe execution

Checks and tests never run on the app server's behalf with your secrets in reach:

- a separate process with CPU/memory/time limits (`prlimit`/`unshare` when present, Docker when configured),
- a restricted working directory that is cleaned up afterwards,
- **network off by default**,
- a command allowlist (`node`, `npm`, `pnpm`, `yarn`, `npx`, `python3`, `pytest`, `go`, `cargo`, `php`, `ruby`, `make`, `git`),
- captured stdout, stderr, exit code and test results.

Settings → *Execution* reports exactly which isolation this host provides. On a
plain Node host without Docker it says **Process sandbox only** and tells you to
set `JARVIS_SANDBOX_DRIVER=docker` on a host with Docker for real container
isolation. It never claims more than the host delivers.

---

## Voice

- **Text-to-speech** is proxied through the backend (Fish Audio), so the key never
  reaches the browser. Not configured → spoken replies are simply off and the UI
  says so.
- **Speech recognition** is the browser's own Web Speech API. It is independent of
  TTS, needs no key, and the audio never leaves the device.
- The central orb animates for *idle · listening · thinking · speaking · error* and
  respects `prefers-reduced-motion`. Voice is never a prerequisite for coding.

---

## Environment variables

Server-side only — none of these belong in the frontend. See `server/.env.example`
for the annotated file.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | recommended | Google Gemini — free tier, first choice in Free-first routing |
| `GROQ_API_KEY` | optional | Groq — free tier, very fast |
| `OPENROUTER_API_KEY` | optional | OpenRouter — free models tagged `:free` |
| `OPENAI_API_KEY` | optional | OpenAI (paid). Also powers the legacy `/api/chat` endpoint |
| `ANTHROPIC_API_KEY` | optional | Anthropic Claude (paid) |
| `MISTRAL_API_KEY` | optional | Mistral (paid) |
| `OLLAMA_BASE_URL` | optional | A local Ollama instance (free, no key) |
| `<PROVIDER>_BASE_URL` | optional | Gateway/proxy override per provider: `GEMINI_BASE_URL`, `GROQ_BASE_URL`, `OPENROUTER_BASE_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `MISTRAL_BASE_URL` |
| `GITHUB_TOKEN` | for repo work | Fine-grained PAT, server-side |
| `GITHUB_APP_ID` · `GITHUB_APP_PRIVATE_KEY` · `GITHUB_APP_INSTALLATION_ID` | optional | GitHub App fallback |
| `GITHUB_OAUTH_CLIENT_ID` · `GITHUB_OAUTH_CLIENT_SECRET` · `GITHUB_OAUTH_REDIRECT_URI` | optional | Per-user sign-in |
| `FISH_AUDIO_API_KEY` | for spoken replies | Text-to-speech (the microphone does not need it) |
| `FISH_AUDIO_MODEL` · `FISH_AUDIO_REFERENCE_ID` · `FISH_AUDIO_BASE_URL` | optional | Voice model, voice id, proxy override |
| `JARVIS_WRITE_TOKEN` | recommended in production | Shared secret required for every mutating API call |
| `JARVIS_DATA_DIR` | optional | Where settings, keys and task history are stored |
| `JARVIS_PAID_FALLBACK` · `JARVIS_MONTHLY_LIMIT_USD` | optional | The starting routing policy: paid fallback off and a ceiling of `0` unless you set them (the same two fields are editable in Settings → AI Models) |
| `JARVIS_SANDBOX_DRIVER` · `JARVIS_SANDBOX_NETWORK` | optional | `process` or `docker`, and whether the sandbox may reach the network (`off` by default) |
| `JARVIS_ALLOWED_ORIGINS` | optional | The same CORS allowlist under the new name; `TRALIX_ALLOWED_ORIGINS` still works |
| `TRALIX_MODEL_FAST` · `_SMART` · `_CODE` · `_RESEARCH` | optional | Override the tier → model mapping |
| `TRALIX_ENABLE_WEB_SEARCH` | optional | Enables the OpenAI web-search tool and flips the capability in the UI |
| `PORT` | optional | Node adapter port (default 8787) |

Sandbox **time and memory limits** (`JARVIS_SANDBOX_TIMEOUT_MS`, `JARVIS_SANDBOX_MEMORY_MB`)
are runtime *settings*, not environment variables: change them in Settings → Execution, or
through `PATCH /api/v2/settings`.

---

## What genuinely works, and what needs something from you

| Feature | State |
|---|---|
| Interface, navigation, PWA offline shell, themes | **Works out of the box** |
| Chat with streaming replies | **Works** with any one provider key |
| Free-first routing, failover, per-provider enable/priority | **Works** with one or more keys |
| Paid fallback with a monthly ceiling | **Works** once you authorise it and set a limit |
| Provider connection testing | **Works** — a real request, not a guess |
| GitHub: list repos, branches, read files | **Works** with `GITHUB_TOKEN` and outbound access to `api.github.com` |
| Coding tasks: plan → edit → diff → checks → review | **Works** with a provider key **and** GitHub |
| Commit / pull-request preparation | **Works** — always behind an explicit button, never merged |
| Sandbox checks | **Works** as a process sandbox; **container isolation needs Docker** on the host |
| Spoken replies | **Works** with `FISH_AUDIO_API_KEY`; the device voice is the fallback |
| Microphone input | **Works** where the browser supports Web Speech |
| Supabase | **Not used.** Auth and persistence live in the backend's own store; there is no multi-user account system, so a database would add surface without adding capability |

Deployment limits worth knowing: GitHub Pages can host the frontend only (it
cannot run server code or hold a secret), so the backend must be deployed
separately; the serverless Worker runtime has no filesystem or process spawning,
so task history resets on redeploy and the sandbox is unavailable there. Run
`node server/node.js` (VPS, Render, Railway, Fly, your laptop) for the full
feature set.

---

## Running and deploying

```bash
npm run serve          # backend + frontend at http://localhost:8787
npm run backend        # backend only
npm run verify         # static checks + every test suite
```

**Frontend** — already static: push to `main`, GitHub Pages serves the app shell
(`.nojekyll` is present and all paths are relative). Hard-refresh once after
deploying so the new service worker replaces the cached shell.

**Backend** — deploy separately:

```bash
# Cloudflare Workers via GitHub Actions: add CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID and your provider keys as repo secrets, then run the
# "Deploy backend" workflow — it prints the worker URL.
./tools/deploy-backend.sh          # …or from your machine
```

### Render (one service, app + API)

`render.json` is a ready-made Blueprint. New → Blueprint → point it at this repo
and it creates a Node web service that serves **both** the interface and the API:

```
Build:   npm install --omit=dev --no-audit --no-fund
Start:   node server/node.js --static          # --static serves the frontend too
Health:  /api/health                            # not ?probe=1 — that spends a vendor call
Disk:    /var/data  (1 GB)  with  JARVIS_DATA_DIR=/var/data
Node:    20
```

Manual setup works the same way — a **Web Service**, runtime **Node**, no build
step beyond the install above. Then set the environment variables from the table
in `render.json`; the two that matter most on a public host are
`JARVIS_WRITE_TOKEN` (without it, anyone who finds the URL can change settings
and start tasks) and, if the frontend lives on GitHub Pages rather than on this
service, `TRALIX_ALLOWED_ORIGINS=https://<you>.github.io`.

Three things Render changes, honestly:

- **The filesystem is ephemeral.** Attach the disk above, or settings, keys and
  task history reset on every restart and redeploy.
- **No Docker inside the runtime.** `JARVIS_SANDBOX_DRIVER=docker` cannot work
  there; the sandbox runs as a limited process and may also lack `prlimit` /
  `unshare`. Settings → Execution reports exactly which of those this host has.
- **Free and starter instances sleep.** The first request after an idle period is
  slow; health checks keep a paid instance warm.

If you serve the frontend from GitHub Pages instead, drop `--static` from the
start command, keep the CORS variable, and put the service URL in `backend.json`.

### Vercel (serverless)

`vercel.json` and `api/[...path].js` are ready: import the repo, keep every
default (Vercel detects no framework, which is correct — the app is static and
the API is one function), and set the environment variables in
**Settings → Environment Variables**.

```
Build:   (none — the app is already static)
Install: npm install --omit=dev --no-audit --no-fund
API:     api/[...path].js   → node server/worker.js   (the same fetch handler)
Limits:  maxDuration 300 s (Hobby maximum), 1024 MB
```

`api/[...path].js` is an adapter and nothing more: it turns Vercel's Node
request/response into the `Request`/`Response` pair `server/worker.js` already
speaks, and streams the answer back chunk by chunk so chat and task events still
arrive as they happen. No provider, key or route knowledge lives in it.

Four things Vercel changes, honestly:

- **There is no filesystem.** It is read-only apart from `/tmp` (500 MB, per
  instance). `server/store.js` detects that and falls back to memory, which the
  UI reports: Home shows *Connected (memory store)* and Settings says
  *memory store — resets on redeploy*. Settings, task history and keys saved
  through the interface are per-instance and lost on redeploy. **Put every key
  in an environment variable instead** — then nothing you care about depends on
  storage at all.
- **The sandbox runs inside the function itself.** 2 GB and 1 vCPU on Hobby, and
  the whole invocation is killed at `maxDuration`. There is no container, so
  treat permitted checks as best-effort; Settings → Execution reports exactly
  what the host has (`git` and `node` are present, `docker` is not).
- **No background work.** One function serves the whole API: no workers, no
  queues, no long-lived processes.
- **Smaller platform caps.** Request and response bodies are 4.5 MB (large diffs
  and file reads can hit that), and runtime logs are kept for 1 hour on Hobby.

`maxDuration` is set to 300 s, the Hobby maximum, only so a long check is not cut
short; a chat answer is typically a few seconds. Lower it if you would rather
fail fast.

On Vercel the interface and the API share an origin, so leave `backend.json`
empty — it only matters when the frontend is hosted somewhere else.

**Connecting them** — put the backend URL in `backend.json` (a public pointer,
never a key) and push:

```json
{ "url": "https://your-backend.example.workers.dev" }
```

The frontend resolves its API base from, in order: a device override saved in the
app, `window.TRALIX_API_BASE`, `?api=https://…`, `backend.json`, then same origin.
Diagnostics always reports which one is in use.

---

## Testing

```bash
npm run check        # syntax, JSON, asset refs, SW shell, secret scan, DOM contract
npm test             # 121 logic tests (markdown, memory, migration, tools, scroll…)
npm run test:server  # 289 server tests: backend, routing, runner, tasks, voice, diff
npm run test:dom     # 131 integration checks (jsdom): boots the real app
npm run test:studio  # 51 workspace checks (jsdom): areas, honest states, task rules
npm run verify       # all of the above
```

`npm run test:dom` and `npm run test:studio` need `npm install --no-save jsdom`
and skip with a message when it is absent. `npm run check` fails the build on a
key-like string in a browser-shipped file, a `chatgpt.com` reference, a direct
frontend call to a provider API, or an element id used in JS but missing from
`index.html`.

---

## Project structure

```
index.html                     app shell: rail, five areas, composer, task panel, overlays
assets/app.css                 original design system (tokens, dark/light, mobile-first)
assets/studio.css              JARVIS STUDIO: workspace, orb, panels, diffs, responsive
assets/js/
  app.js                       boot + wiring (including the workspace layer)
  config.js  errors.js  store.js  models.js  personality.js  markdown.js
  highlight.js  tools.js  voice.js  scrolling.js
  api/client.js                fetch, timeouts, SSE parsing
  api/backend.js               legacy backend client (/api/chat, /api/health)
  api/local.js                 optional device-only provider transport
  api/chat.js                  transport selection: routed → legacy → device key
  api/v2.js                    every /api/v2 endpoint
  ui/nav.js  ui/orb.js         area navigation + the orb state machine
  views/home.js  projects.js  models.js  settings.js  tasks.js
  ui/…                         sheets, feedback, status, messages, composer, chat,
                               sidebar, search, memory, projects, models, settings
api/[...path].js               Vercel adapter: Node req/res → the fetch handler
server/
  worker.js                    Cloudflare Worker entry; legacy /api/* + /api/v2/*
  node.js                      Node 18+ adapter (optionally serves the frontend)
  routes.js                    /api/v2 route table
  router.js                    free-first selection, failover, cost guard
  providers/*.js               one adapter per vendor
  github.js  tasks.js  runner.js  diff.js  tts.js  store.js  lib/http.js
  wrangler.toml  .env.example  README.md
tests/                         logic, server, voice, jsdom and studio suites + doubles
tools/check.mjs                static validation / secret scan
sw.js  manifest.webmanifest    offline shell, PWA metadata
vercel.json  .vercelignore     Vercel deployment (static app + one API function)
render.json  railway.json      Render / Railway deployment
backend.json                   public pointer to a backend hosted elsewhere
docs/                          upgrade and studio reports
```

---

## Privacy and security

- Conversations, memories and UI settings live in **this browser**. Only the
  messages needed for a reply are sent to the backend, which forwards them to the
  chosen provider and stores nothing.
- Provider keys, the GitHub token and the Fish Audio key are **server-side**, in a
  `0600` file, never in the browser, never in Git, never in logs. Reads return a
  four-character hint.
- Key-shaped strings are redacted from every server log line and error payload.
- Set `JARVIS_WRITE_TOKEN` on any deployment reachable from the internet: every
  mutating call then requires it.
- Sensitive content (card numbers, passwords, keys, IDs) is refused by the memory
  system even when you ask it to remember.
- Exports never contain a key.

## Licence

UNLICENSED — private project.
