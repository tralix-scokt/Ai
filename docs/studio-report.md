# JARVIS STUDIO — build report

How the existing TRALIX AI project was inspected, extended and redesigned into
JARVIS STUDIO, what genuinely works, what needs keys or infrastructure, and the
limits that remain.

*Report written after the workspace interface, the routing layer, the GitHub
workflow, the execution sandbox, the voice layer and the verification suites were
complete. `docs/upgrade-report.md` covers the earlier TRALIX 2.0 build and is kept
as history.*

---

## 1. What was found

A working, mature product — not a demo:

- **Frontend**: a buildless static PWA. Vanilla ES modules, no bundler, no
  framework. `index.html` plus `assets/app.css` (1,352 lines of design tokens and
  a mobile-first layout contract where the document never scrolls and the
  conversation column does) and ~30 JS modules under `assets/js/`.
- **Backend**: `server/worker.js` (Cloudflare Worker) and `server/node.js` (Node
  18+ adapter) sharing one handler — `POST /api/chat` (SSE), `GET /api/health`
  with a *verified* upstream probe, `GET /api/models`. Dependency-free, with
  redaction, a CORS allowlist, a body cap and rate limits.
- **Quality gates**: `npm run check` (a static "build": syntax, JSON, asset
  references, the service-worker shell list, a secret scan and a DOM contract
  that fails when JS queries an element id that is not in `index.html`), a 121-test
  logic suite, a backend suite driven against a fake OpenAI server, and a jsdom
  integration suite that boots the real app.
- **Features**: streaming chat, memory with categories, projects, search, voice in
  and out, themes, export/import, an offline shell, honest error states.

Nothing was deleted or replaced. The decision was to keep the stack — buildless
static PWA, dependency-free Node/Cloudflare backend — and add a layer on top.

## 2. What changed

**New backend (Phase 1–3)**

| File | Role |
|---|---|
| `server/routes.js` | the `/api/v2` route table |
| `server/router.js` | free-first selection, failover with cooldowns, cost guard |
| `server/providers/*.js` | one adapter per vendor (Gemini, Groq, OpenRouter, OpenAI, Anthropic, Mistral, Ollama) |
| `server/github.js` | PAT-first repository access: repos, branches, trees, files, commits, PR preparation |
| `server/tasks.js` | the task state machine: analyze → plan → edit → test → repair → review |
| `server/runner.js` | the execution sandbox: limits, allowlist, network off, capture |
| `server/diff.js` | unified diffs and hunk grouping for the UI |
| `server/tts.js` | Fish Audio text-to-speech proxy |
| `server/store.js`, `server/lib/http.js` | server-side settings/secrets (0600) and shared HTTP helpers |
| `server/worker.js`, `server/node.js` | dispatch `/api/v2`, honest feature reporting, startup banner |

The legacy endpoints keep working unchanged, so an old frontend against a new
backend — or a new frontend against an old backend — still functions.

**Redesigned interface (Phase 2)**

| File | Role |
|---|---|
| `index.html` | five areas in one shell, rail nav, mobile bottom bar, task launcher, task panel, orb |
| `assets/studio.css` | the JARVIS design system: black/navy, electric blue + cyan, restrained glass, the orb, diff and task panels, responsive at 899px and 1200px |
| `assets/js/ui/nav.js` | one source of truth for the active area (⌘/Ctrl+1…5 too) |
| `assets/js/ui/orb.js` | one orb state machine: idle · listening · thinking · speaking · error · offline |
| `assets/js/views/home.js` `projects.js` `models.js` `settings.js` `tasks.js` | the five areas |
| `assets/js/api/v2.js`, `assets/js/diff.js` | typed v2 client and diff renderer |
| `assets/js/errors.js` | routing error codes (`no_eligible_model`, `paid_blocked`, `quota_exceeded`, …) |
| `assets/js/app.js` | wiring: areas, orb, task launcher → task panel, the assistant |

**Routing and voice (Phase 4–5)**: ordinary chat now goes through the router as
soon as the backend advertises `/api/v2`; the reply names the provider that
actually answered; spoken replies use the server voice when configured and the
device voice otherwise.

**Rename**: product chrome, copy, title and manifest are JARVIS STUDIO. Storage
keys (`tralix.*.v2`), tier ids (`tralix-smart`) and every `TRALIX_*` environment
variable keep their old names.

## 3. The interface

Deep black/navy surfaces, electric-blue and cyan accents, restrained
glassmorphism, and one animated centrepiece — the orb — whose state always
matches what the assistant is doing. Five areas, one visible at a time, all kept
mounted so a stream survives a detour to a diff:

- **Home** — six live status cards, a setup checklist, recent tasks, recent chats.
- **Projects** — GitHub connection, repository filter, branch picker, file tree,
  file viewer with syntax highlighting, per-repo task history.
- **JARVIS Assistant** — the original conversation, plus a **Coding task** toggle
  that turns the same message into a repository task.
- **AI Models** — provider cards with verified state, key hints, cooldowns,
  enable/priority, the routing policy and the usage the vendor reported.
- **Settings** — GitHub permissions, task autonomy, sandbox report, voice,
  security notes and an environment-variable report.

Every state was designed: loading, empty, offline, unreachable and failure. When
the backend is down, Home says **Unreachable** with a retry and stops claiming
readiness; when no key exists, a provider card says *No key* and offers to test
one; when no repository is selected, the task launcher says so and refuses to
start a task.

## 4. What genuinely works

Proven by tests, not by assertion:

- **Free-first routing** — free providers before paid ones, ranked by your
  priority, with failover across providers that are rate limited, cooling down or
  unreachable, preserving the conversation. The response reports the provider that
  answered and what was skipped.
- **Cost protection** — paid fallback is off until you allow it *and* set a
  monthly ceiling; the server refuses a policy that allows paid use without one.
  A blocked request is reported to the user, never downgraded onto a paid key.
- **Real connection tests** — the vendor is actually called; a typed key is never
  called *connected*.
- **GitHub** — only repositories the credential can see; per-task branch; diffs
  before acceptance; checks in an isolated sandbox; commit and pull-request
  preparation behind explicit buttons. Nothing is pushed to the default branch and
  nothing is ever merged.
- **Sandbox** — time/CPU/memory limits, a restricted temporary directory that is
  cleaned up, network off by default, a command allowlist, captured
  stdout/stderr/exit codes.
- **Voice** — server-side Fish Audio with the device voice as fallback; browser
  speech recognition, independent of TTS.
- **Honesty** — usage is shown only when a provider reports it; quotas, credits and
  costs are never estimated in the UI.

## 5. What needs keys, auth or infrastructure

| To use | You need |
|---|---|
| Chat, coding tasks | **One** provider key — Gemini, Groq or OpenRouter have free tiers |
| Paid models | The key, plus an explicit opt-in and a monthly ceiling |
| Repository work | `GITHUB_TOKEN` (fine-grained, Contents R/W, Metadata R, Pull requests R/W) and outbound access to `api.github.com` |
| Spoken replies | `FISH_AUDIO_API_KEY` |
| Microphone input | A browser with Web Speech (nothing to configure) |
| Container isolation | Docker on the host: `JARVIS_SANDBOX_DRIVER=docker` |
| Task history that survives a redeploy | A Node host with a writable `JARVIS_DATA_DIR` |
| A deployment reachable from the internet | `JARVIS_WRITE_TOKEN` set, and the frontend served from an origin in `TRALIX_ALLOWED_ORIGINS` |

Nothing here is optional-but-undocumented: every variable appears in
`server/.env.example` with placeholders and in `GET /api/v2/env`, which the
Settings area renders as a live checklist.

## 6. Test results

Run in this order, last run all green:

```
npm run check        133/133 checks
npm test             121 passed, 0 failed      (logic)
npm run test:server   93 backend · 54 routing · 31 runner · 57 tasks · 39 voice · 15 diff
npm run test:dom     131 passed, 0 failed      (jsdom: boots the real app)
npm run test:studio   51 passed, 0 failed      (jsdom: the workspace layer)
```

`npm run verify` runs all of them. `test:dom` and `test:studio` require
`npm install --no-save jsdom` and skip with a message if it is missing.

The suites drive real code against doubles: a fake OpenAI server, a fake Gemini
server, a fake GitHub REST API and a fake Fish Audio endpoint. No test contacts a
vendor, and no credential exists in this environment.

## 7. Remaining limits

- **No multi-user accounts.** There is no sign-in; authorisation is a single
  `JARVIS_WRITE_TOKEN`. Supabase was considered and deliberately not added: with
  one operator and server-side storage, a database would add surface without
  adding capability.
- **Serverless is second-class.** On Cloudflare Workers there is no filesystem and
  no process spawning: task history lives in memory and resets on redeploy, and
  the sandbox reports itself unavailable. Run `server/node.js` for the full set.
- **Process sandbox is not a container.** Without Docker, isolation is time and
  memory limits, an allowlist, a temporary directory and network off — strong
  against accidents, not against a determined escape. The Settings area says
  which one you have.
- **Free tiers move.** Model availability and rate limits on free tiers change
  often; the router verifies a provider before ranking it and cools it down when
  it fails, rather than trusting a hard-coded list.
- **No AI provider key exists in this environment**, so every vendor call in the
  tests is a double. The wiring, the routing decisions and the error handling are
  tested; a live vendor response is not.

## 8. Run and deploy

```bash
npm run serve                 # backend + frontend, http://localhost:8787
GEMINI_API_KEY=… GITHUB_TOKEN=… npm run serve
npm run verify                # static checks + every suite
```

**Frontend** — static. Push to `main`; GitHub Pages serves the shell. Hard-refresh
once after deploying so the new service worker replaces the cached shell.
**Backend** — deploy separately (Pages cannot run server code or hold a secret):
the "Deploy backend" GitHub Actions workflow, `./tools/deploy-backend.sh` for
Workers, or any Node 18+ box with `node server/node.js --static`. Point the
frontend at it with `backend.json` (`{ "url": "https://…" }`), `?api=https://…`, or
the Connect sheet for a single device.
