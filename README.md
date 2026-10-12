# JARVIS AI

**A personal intelligence interface, designed for mobile.** JARVIS keeps the existing chat, history, memory, projects, settings, and secure backend while adding a cinematic assistant stage, an animated energy core, and an explicit local demo for trying the app before a model is connected.

The demo is deliberately not presented as AI: its fixed sample replies are tagged **LOCAL DEMO · NOT AI**. A real response requires a verified backend or the separately opted-in device-only provider transport.

## At a glance

| Works without an AI API | Needs a live model/provider |
| --- | --- |
| Immersive and conversation views; animated core and state indicators | Open-ended, model-generated answers |
| Local demo conversations, saved chat history, search, projects, and memory | Model-based analysis, coding, drafting, and research |
| Browser speech output where `SpeechSynthesis` is available | Backend-backed web search, only when enabled on that deployment |
| Speech input only when the browser exposes recognition; otherwise typing and iPhone keyboard dictation | Any live-data lookup or tool that is not explicitly enabled |
| PWA app shell and previously cached static assets | Attachments and system-screen/app control are not provided |

JARVIS does **not** fake control of iOS, Safari, or other apps. Conversations, settings, and memories are stored in this browser. Do not put provider secrets in frontend code or in a public `backend.json` file.

## Preview locally

Node 18+ is required. From the repository root:

```bash
npm run serve
# Open http://localhost:8787
```

No `OPENAI_API_KEY` is needed to preview the interface. With no saved device key and no verified backend, automatic mode selects the local demo; sending a message will not call the chat API. To check the backend path without using a real credential, run the test suite instead.

For an iPhone XS Max-sized browser preview, use a **414 × 896 CSS-pixel** viewport in your desktop browser's responsive/device mode, then test both portrait and landscape. To view it on a physical iPhone over the same Wi-Fi, set `HOST=0.0.0.0 PORT=8787` before starting the server and open `http://<computer-LAN-IP>:8787` in Safari. That HTTP LAN preview is for layout only: iOS speech recognition and service-worker/PWA installation require a secure context. For those, use an HTTPS deployment/tunnel, open the URL in iPhone Safari, then choose **Share → Add to Home Screen**. No physical iPhone test is claimed by this repository change.

## Deploy the frontend and API to Render

The app is configured as a **single Render Web Service**: the Node server serves the static JARVIS PWA and `/api` from the same HTTPS origin. The repository's `render.yaml` is the Render Blueprint; it builds with `npm run check`, starts with `npm run serve`, and checks `/api/health`. `backend.json` intentionally keeps an empty `url`, so the frontend uses its same-origin API.

1. Push this configuration to the GitHub branch you want Render to deploy, then in Render choose **New → Blueprint** and connect the repository/branch. Review the configured service and plan before creating it. The blueprint names the service `jarvis-ai` and specifies Render's `free` plan. Free services may spin down when idle, so the first request after a quiet period can take longer; check Render's current free-tier limits before applying.
2. Open the HTTPS URL Render assigns. The UI and API should both be on that origin. With no provider key, the health endpoint reports the backend as unconfigured; this is expected, and the local demo still works.
3. For live model responses, add `OPENAI_API_KEY` as a **secret environment variable in the Render dashboard**, then redeploy. This is optional; the key is not in `render.yaml`, `backend.json`, or browser code. Never commit it.
4. If Render assigns a hostname other than `https://jarvis-ai.onrender.com`, or you add a custom domain, set `TRALIX_ALLOWED_ORIGINS` in the service environment to the exact app origin. The frontend/API calls themselves remain same-origin.

If you already have a Render API service, update that service instead of creating a second one: set its build command to `npm run check`, start command to `npm run serve` (equivalent to `node server/node.js --static`), and health check path to `/api/health`. This preserves the existing API while adding the UI and avoids running duplicate services. `render.json` also reflects the combined start mode for the existing Render setup.

Before switching from GitHub Pages or another host, export your JARVIS data in **Settings → Data**, then import that backup on the Render origin. Browsers keep local data separately for each origin, so chat history, settings, and memories do not automatically transfer. The device-only provider key is not included in the export.

To install the deployed PWA on iPhone XS Max, open its HTTPS Render URL in Safari, tap **Share → Add to Home Screen**, then launch JARVIS from the Home Screen. Reopen once after deployment to install the updated app shell. The local Arena preview is not a Render deployment; an actual Render URL is available only after the repository is connected and deployed there.

## Modes and voice

- **Immersive** is the assistant home with a lightweight CSS energy core. **Conversation** shows the familiar chat thread. The core reflects idle, listening, thinking, generating, speaking, and error states; hidden tabs pause its animation, and reduced-motion preferences are respected.
- **Auto** uses local samples until the secure backend is verified, unless you have explicitly configured the device-only provider path. **Demo** always uses local samples. **Live** never silently falls back to a canned reply; if setup is missing, JARVIS says so. Each demo response and the runtime control identify the selected path.
- Output uses the browser's built-in `SpeechSynthesis` API and installed voices when present. Input support is detected at runtime. Microphone access is initiated only after tapping the mic; unsupported browsers, denied permission, silence, and recognition errors have clear fallbacks. On iPhone, keyboard dictation remains an option.
- Use the stop controls to cancel generation or speech. Existing chat history, retries, clear-chat confirmation/undo, and local data export/import are preserved.

## Connect a real model (optional)

The recommended path keeps the provider key on the server. The existing backend serves the static app and `/api` from one origin:

```bash
OPENAI_API_KEY='your-key' npm run serve
```

The key is read by the server process; never paste it into frontend source or `backend.json`. Configure a separately hosted backend URL in the app's **Connect** sheet, or set the public pointer in `backend.json`:

```json
{ "url": "https://your-backend.example.com" }
```

For a low-cost first live test, select **JARVIS Fast** (the current backend default maps it to `gpt-5-mini`) and set a small spend limit with your provider. Check current provider pricing and model availability before enabling requests. Usage may incur charges. The backend's `OPENAI_API_KEY` is required only on the server.

The existing optional **This device only — my own provider key** path is retained in Advanced settings for users who explicitly choose it. It calls the provider directly from the browser and stores the user's own key on that device; it is less protective than the recommended backend. JARVIS adds no paid speech service or voice dependency.

### Existing backend notes

- `server/node.js --static` serves the app and API on the same origin; `server/worker.js` is the Cloudflare Worker implementation.
- The backend uses the OpenAI Responses API and reads `OPENAI_API_KEY` server-side. Chat streaming and model availability are verified from backend health responses.
- `TRALIX_MODEL_FAST`, `TRALIX_MODEL_SMART`, `TRALIX_MODEL_CODE`, and `TRALIX_MODEL_RESEARCH` can override tier mappings. `TRALIX_ENABLE_WEB_SEARCH=true` advertises the optional backend search tool.
- See [`server/README.md`](server/README.md) and [`server/.env.example`](server/.env.example) for deployment and environment details. Internal `tralix-*` tier IDs remain for backend/storage compatibility; user-facing labels are JARVIS-branded.

## iOS/PWA design notes

The interface uses the existing visual-viewport sizing and in-layout composer, respects safe-area insets, supports portrait and landscape, and keeps the chat pane as the scroll container. Controls are touch-friendly; sheets and drawers manage scroll locking and focus; reduced-motion styles disable decorative animation. The CSS core avoids a continuous WebGL render loop to stay lightweight on older phones.

PWA metadata and app icons are preserved and JARVIS-branded. The service worker caches the static app shell only; API calls and `backend.json` are deliberately never cached. On a deployment, reload once to install the updated service worker and icons.

## Validation

```bash
npm run check       # syntax, JSON, asset references, service-worker shell, security scan, DOM contract
npm test            # deterministic logic and voice helpers
npm run test:backend
npm run test:dom    # UI interactions, modes, demo/live paths, history, mobile scroll contract
npm run verify      # all checks above
```

The DOM suite uses jsdom, not a physical iPhone browser. Device-only behavior (especially Safari speech recognition, Home Screen installation, safe-area rendering, and the virtual keyboard) still needs manual iPhone verification.

## Project map

```text
index.html                     JARVIS PWA shell and immersive/conversation UI
assets/app.css                 visual system, animated core, iOS/mobile/accessibility rules
assets/js/app.js               app boot, backend health, and voice/runtime wiring
assets/js/demo.js              deterministic, abortable local samples (explicitly not AI)
assets/js/voice.js             runtime speech feature detection and browser voice APIs
assets/js/ui/assistant.js      view mode, capability readouts, and demo/live controls
assets/js/ui/chat.js           chat, streaming, cancellation, retries, history
assets/js/api/                 existing secure backend and opt-in local transports
server/                        existing Node and Cloudflare backend
render.yaml                    Render Blueprint for the same-origin app + API service
icons/                         SVG mark and PWA/iOS raster icons
manifest.webmanifest           JARVIS install metadata (root-hosted PWA)
sw.js                          offline static app shell; API traffic is excluded
tests/                         logic, backend, and jsdom interaction suites
tools/check.mjs                static validation and secret scan
```

## License

UNLICENSED — private project.
