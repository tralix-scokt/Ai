# Deploying JARVIS STUDIO to Vercel

A short, mechanical checklist. No key or token belongs in this file, in the
repository, or in the browser — only in the Vercel project's environment
variables, which are encrypted at rest and handed to the server-side function
alone.

## 1. Create the project

Import `tralix-scokt/Ai` and keep every default. The repository already carries
`vercel.json` and `api/[...path].js`, so:

| Setting | Value |
| --- | --- |
| Framework preset | Other / none (there is nothing to build) |
| Build command | none |
| Install command | `npm install --omit=dev --no-audit --no-fund` |
| Output directory | project root |
| Production branch | `main` — or the branch you want live |

`api/[...path].js` is the only server-side code Vercel adds. It adapts Vercel's
Node request/response to the `fetch(request, env)` handler in `server/worker.js`
and streams responses back chunk by chunk, so SSE still streams.

## 2. Environment variables

Settings → Environment Variables → add each for Production, Preview and
Development. **Sensitive** type for anything secret; Vercel will not show the
value again after you save it.

| Name | Required for | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | a free model that actually answers | free tier, recommended |
| `GROQ_API_KEY` | another free model | optional; one free provider is enough |
| `OPENROUTER_API_KEY` | more free models (`:free`) | optional |
| `OPENAI_API_KEY` | the paid route and the legacy `/api/chat` | stored and *verifiable*, but never used unless you authorise paid fallback |
| `ANTHROPIC_API_KEY` | Claude | optional, paid, same rule |
| `FISH_AUDIO_API_KEY` | spoken replies | the microphone is independent and needs no key |
| `GITHUB_TOKEN` | Projects, code tasks, branches, pull requests | fine-grained PAT: Contents RW, Metadata R, Pull requests RW, scoped to the repos you use |
| `JARVIS_WRITE_TOKEN` | locking the API | see the warning below |
| `JARVIS_PAID_FALLBACK` | cost protection | `false` — never silently switch to a paid model |
| `JARVIS_MONTHLY_LIMIT_USD` | cost protection | `0` until you decide otherwise |
| `JARVIS_SANDBOX_DRIVER` | permitted checks | `process` (no container runtime on Vercel) |
| `JARVIS_SANDBOX_NETWORK` | permitted checks | `off` |
| `TRALIX_ALLOWED_ORIGINS` | CORS | only if the frontend is hosted somewhere else; on Vercel it is the same origin |

Leave `JARVIS_DATA_DIR` and `PORT` unset.

### About `JARVIS_WRITE_TOKEN`

Setting it locks every mutating endpoint (saving settings, keys, starting
tasks). The interface cannot send that header yet, so **leaving it unset is the
only configuration in which saving settings from the app works today** — and it
means anyone who finds the deployment URL could change those settings. They
still cannot read your keys: the API returns a short hint, never a value.

To have both, the app needs a token field that sends `x-jarvis-token`; until
then this is a deliberate, documented trade-off.

## 3. Deploy

Push to the production branch, or run from a checkout:

```bash
npx vercel --prod
```

## 4. Verify with real requests

Do not trust a green build; each of these makes an actual call.

1. `https://<your-app>.vercel.app/api/health` → reachable. Skip `?probe=1`, it
   spends a vendor call.
2. Settings → **AI Models → Test connection** for each provider. The UI never
   says "connected" just because a key was typed.
3. Settings → **GitHub** → the status is verified with a real call.
4. Settings → **Execution** → reports what the sandbox genuinely has here.
5. Settings → **Voice → Test voice** → a real text-to-speech request.
6. Send one message and read the model label: it names the provider that
   actually answered.

Hard-refresh once after the first deploy so the new service worker replaces the
cached shell.

## 5. What Vercel cannot give you

- **No filesystem.** The store falls back to memory: settings, task history and
  keys saved through the interface are per-instance and reset on redeploy. Keys
  set as environment variables are immune — that is why they are recommended.
- **No container.** Permitted checks run inside the function: 1 vCPU, 2 GB on
  Hobby, killed at `maxDuration`, no Docker. Best-effort, reported as such.
- **No background work.** One function serves the whole API.
- **4.5 MB** request/response bodies; runtime logs kept 1 hour on Hobby.

Supabase (or any hosted Postgres) is the fix for the first item; Vercel Sandbox
would be the fix for the second. Neither is required to use the app.
