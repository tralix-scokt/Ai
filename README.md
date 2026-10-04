# Jarvis

A personal AI assistant that runs in your browser and lives on your iPhone's Home Screen.
ChatGPT-style interface, Gemini brain, memory, and push-to-talk voice.

**No PC needed. No App Store. No server. No subscription.**

---

## What it is

A single web app that talks directly to Google's Gemini API from your phone.
Your API key is stored only in your phone's browser storage — it is never sent to any
server of ours, because there isn't one. The whole app is static files.

---

## Setup (about 3 minutes, all on your iPhone)

### 1. Get a free Gemini API key

1. Open **Safari** and go to **https://aistudio.google.com/apikey**
2. Sign in with your Google account
3. Tap **Create API key**
4. Tap the key to copy it

It's free. No credit card. The free tier covers normal personal use — see limits below.

### 2. Open Jarvis and paste the key

1. Open your Jarvis link
2. Tap the **☰** menu (top-left) → **Settings**
3. Paste the key into *Your Gemini API key*
4. Tap **Save key** — you should see **"Key saved and working"**

If it says the key is wrong, re-copy it. Gemini keys are long and start with `AIza`.

### 3. Put it on your Home Screen

1. In Safari, tap the **Share** button (the square with an arrow)
2. Scroll down → **Add to Home Screen**
3. Tap **Add**

You now have a Jarvis icon. Opening it runs fullscreen with no browser bars — it feels
like a native app.

---

## Using it

| I want to… | Do this |
|---|---|
| Type a message | Tap the box, type, tap the arrow |
| **Talk to it** | **Press and hold** the mic button, speak, let go — it sends |
| Start a new chat | **+** in the top bar |
| Find an old chat | **☰** menu → search |
| Switch AI model | Tap the model name at the top |
| Hear a reply read aloud | Tap **🔊 Listen** under the answer |
| Make it always speak | Settings → Voice → *Auto-speak every reply* |
| Change its personality | Settings → Personality (there's a "Classic Jarvis butler" mode) |
| See what it remembers | **☰** menu → **Memory** |

### Making it remember things

Just say it naturally — Jarvis picks it up automatically:

- *"Remember that my name is Tralix"*
- *"My name is Tralix and I live in Warri"*
- *"Call me Chief"*
- *"Remember I'm building an AI assistant"*

Those get saved to Memory and are included in every future chat. You can review, add,
or delete any of them from the Memory screen. Turn automatic saving off in
Settings → Voice → *Learn facts about me*.

---

## Give it a personality

Settings → **Personality** has four one-tap presets:

- **Warm & friendly** — encouraging and human
- **Short & sharp** — ruthless brevity
- **Classic Jarvis butler** — refined British butler, calls you "sir"
- **Coach & cheerleader** — motivating, always ends with a next step

Or write your own in the text box. Anything you put there replaces the default.

---

## What works, and what iPhone won't allow

**Works great:**
- Chat with streaming replies, markdown, code blocks with copy buttons
- Hold-to-talk voice input
- Spoken replies with a choice of voices and speed
- Memory that persists between sessions
- Install to Home Screen, works offline for the app shell
- Dark / light / automatic themes
- Export and import a backup of everything

**iPhone limits — these are Apple's rules, not bugs:**

- **Voice input needs the screen on and Jarvis open.** iOS suspends microphone access
  for backgrounded web apps. There is no "Hey Jarvis" always-listening mode in a web
  app — that requires a native app built on a Mac.
- **Timers and alarms are in-conversation only.** A web app cannot add to the iPhone
  Clock or Reminders app. You can ask Jarvis to track things and it will remember them.
- **Screen lock stops everything**, including speech.

If you later want always-listening and Siri integration, the path is an Apple Shortcut
that calls this same API — ask and I'll set that up.

---

## Free tier limits

The Gemini free tier is genuinely free but rate-limited. Roughly:

- **Gemini 3.8 Flash** — the default, fast and capable
- **Gemini 3.5 Flash Lite** — fastest, highest daily allowance
- Limits are per *project*, and reset at midnight Pacific time

If you hit a limit, Jarvis tells you plainly and you can retry in a moment, or switch
to Flash Lite from the model menu for a higher daily allowance.

---

## Troubleshooting

**"That API key looks wrong"**
Re-copy the key from aistudio.google.com/apikey. Watch for a trailing space.

**Mic button does nothing / "Microphone access is blocked"**
The page must be on **https://** (not http). Then check
iPhone Settings → Safari → Microphone. Also make sure you're in Safari, not an in-app
browser like Instagram or Facebook.

**Voice types the wrong thing**
Speech recognition improves with a stable connection. Hold the button, speak clearly,
and release when done — it keeps listening while your thumb is down.

**"Rate limit hit"**
You're sending faster than the free tier allows. Wait a few seconds, or switch to
Flash Lite in the model menu.

**Replies are cut off**
Long answers can hit the output limit. Say "continue" and it will pick up.

**Nothing loads after an update**
Close the app fully (swipe up from the bottom, swipe the card away) and reopen.

---

## Your data

Everything — chats, memories, settings — lives in your phone's browser storage for this
site. Nothing syncs anywhere.

- **Export backup** in Settings saves a `.json` file to your Files app
- Your **API key is never included** in an export
- Clearing Safari data, or deleting the app, **erases everything** — export first
- **Erase everything** wipes chats and memories but keeps your key

---

## For developers

Static site, zero build step, no dependencies.

```
index.html                 app shell + markup
manifest.webmanifest       PWA install metadata
sw.js                      service worker (offline app shell)
assets/app.css             design system (CSS custom properties, iOS safe areas)
assets/js/util.js          helpers, toast, confirm, clipboard
assets/js/store.js         all localStorage persistence
assets/js/markdown.js      dependency-free markdown renderer (XSS-safe)
assets/js/providers.js     Gemini client + streaming + prompt building
assets/js/voice.js         Speech Recognition & Synthesis for iOS
assets/js/app.js           UI state, chat flow, wiring
icons/                     generated app icons
```

Run locally:

```bash
python3 -m http.server 3000
```

Run the logic tests:

```bash
node tests/logic.test.mjs
```

A few deliberate choices worth knowing:

- **No framework.** The whole app is smaller than most frameworks' bundles, which
  matters on a phone connection.
- **Markdown is escaped before formatting**, never after — the renderer pulls code
  blocks out first, escapes the rest, then applies formatting.
- **The model list self-heals.** On save, the app asks Google which models your key can
  actually reach and moves you to a working one, because model IDs get retired often.
- **Reasoning config is generation-aware.** Gemini 3.x wants `thinkingLevel`; 2.5 wants
  `thinkingBudget`. Sending both is a hard error, so it is chosen per model — and the
  request retries once without it if a model rejects it.
