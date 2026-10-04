/* ==========================================================================
   providers.js — the AI brain
   Primary: Google Gemini (free tier, key from aistudio.google.com/apikey)
   Also supports OpenAI and Anthropic if the user adds those keys later.
   Runs entirely in the browser: the key never touches a server of ours.
   ========================================================================== */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/* ------------------------------ model catalog ----------------------------
   Curated defaults. The real list is reconciled against whatever the user's
   key can actually reach (see probeModels) so Google renaming a model never
   breaks the app — unavailable options are shown as such instead.
   -------------------------------------------------------------------------- */
export const MODELS = [
  { id: 'gemini-3.8-flash',      name: 'Gemini 3.8 Flash',    desc: 'Fast and smart. Best all-rounder.', provider: 'gemini', badge: 'Recommended' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', desc: 'Fastest replies. Great for quick asks.', provider: 'gemini' },
  { id: 'gemini-3.7-flash',      name: 'Gemini 3.7 Flash',    desc: 'Previous generation. Reliable.', provider: 'gemini' },
  { id: 'gemini-2.5-pro',        name: 'Gemini 2.5 Pro',      desc: 'Deepest reasoning. Needs older key access.', provider: 'gemini' },
];

export const modelById = (id) => MODELS.find(m => m.id === id) || MODELS[0];

/** Models this key can actually use — filled in by probeModels(). */
let availableModelIds = null;
export const setAvailableModels = (ids) => { availableModelIds = Array.isArray(ids) ? ids : null; };
export const getAvailableModels = () => availableModelIds;
export const isModelAvailable = (id) => !availableModelIds || availableModelIds.includes(id);

/** Pick the best model the user's key can actually reach. */
export function bestAvailableModel(preferred) {
  if (!availableModelIds) return preferred;
  if (availableModelIds.includes(preferred)) return preferred;
  const firstWorking = MODELS.find(m => availableModelIds.includes(m.id));
  if (firstWorking) return firstWorking.id;
  // key exposes something we have not curated — use it directly
  const anyGemini = availableModelIds.find(id => /^gemini-.*flash/.test(id));
  return anyGemini || preferred;
}

/* -------------------------------- errors --------------------------------- */
export class AIError extends Error {
  constructor(message, { status = 0, kind = 'unknown', retryable = false } = {}) {
    super(message);
    this.name = 'AIError';
    this.status = status;
    this.kind = kind;
    this.retryable = retryable;
  }
}

function friendlyError(status, payload) {
  const raw = payload?.error?.message || payload?.message || '';
  const reason = payload?.error?.status || payload?.error?.details?.[0]?.reason || '';

  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(raw + reason)) {
    return new AIError('That API key looks wrong. Check it in Settings — it should start with "AIza".',
      { status, kind: 'auth' });
  }
  if (status === 400 && /safety|blocked/i.test(raw)) {
    return new AIError('That request was blocked by safety filters. Try rewording it.',
      { status, kind: 'blocked' });
  }
  if (status === 403) {
    return new AIError('The key was rejected. Make sure the Gemini API is enabled for it.',
      { status, kind: 'auth' });
  }
  if (status === 404) {
    return new AIError('That model is not available on your key. Pick a different one.',
      { status, kind: 'model' });
  }
  if (status === 429) {
    return new AIError('Rate limit hit — you are sending faster than the free tier allows. Wait a few seconds.',
      { status, kind: 'rate', retryable: true });
  }
  if (status >= 500) {
    return new AIError('Google had a hiccup. Try again in a moment.',
      { status, kind: 'server', retryable: true });
  }
  if (!navigator.onLine) {
    return new AIError('You appear to be offline. Reconnect and try again.', { kind: 'offline', retryable: true });
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
    return new AIError('Network blocked the request. Check your connection, then try again.',
      { status, kind: 'network', retryable: true });
  }
  return new AIError(raw || `Something went wrong (HTTP ${status}).`, { status, kind: 'unknown' });
}

/* ------------------------------- preflight ------------------------------- */
/**
 * Cheap key check — hits the models list endpoint.
 * Also records which models this key can reach so the picker stays honest.
 * @returns {Promise<string[]>} usable model ids
 */
export async function probeModels(apiKey) {
  if (!apiKey || !apiKey.trim()) throw new AIError('No API key saved yet.', { kind: 'auth' });

  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey.trim() },
    });
  } catch (e) {
    throw friendlyError(0, { message: String(e) });
  }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw friendlyError(res.status, payload);
  }

  const data = await res.json().catch(() => ({}));
  const names = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace('models/', ''))
    .filter(Boolean);

  setAvailableModels(names);
  return names;
}

/** Kept as an alias — the app calls either name. */
export const verifyKey = probeModels;

/* ------------------------------ prompt building -------------------------- */
export const DEFAULT_PERSONA = `You are Jarvis, a personal AI assistant — the kind of assistant the user can rely on daily.

Voice and manner:
- Warm, clear and confident. Talk like a sharp, friendly person, never like a corporate tool.
- Be concise by default. Lead with the answer, then add only the detail that earns its place.
- Never open with filler like "Great question!" or "Certainly!". Just help.
- Plain, natural language. No corporate jargon, no unnecessary bullet lists for simple answers.
- If something is uncertain, say so plainly instead of inventing detail.

How you work:
- You remember what you've been told about the user. Use those facts naturally — never announce that you are reading them from a memory list.
- Ask a short clarifying question only when the request is genuinely ambiguous; otherwise make a sensible assumption and state it in one line.
- When the user asks you to remember something, confirm briefly, then it is saved.
- Format for a phone screen: short paragraphs, occasional bold for emphasis, lists only when they genuinely help.
- You can use markdown, including code blocks when code is involved.`;

const PERSONA_PRESETS = {
  warm:    'Be warm, encouraging and human. Use my name occasionally. Keep replies tight.',
  concise: 'Be extremely concise. Answer in as few words as the question allows. No preamble at all.',
  butler:  'Speak like a refined British butler: precise, calm, unfailingly polite, with dry wit and impeccable diction. Address me as "sir" unless told otherwise.',
  coach:   'Be an energetic coach: direct, motivating, action-oriented. End with one clear next step.',
};

export function buildSystemPrompt({ persona = '', personaPreset = '', userName = '', memory = '' } = {}) {
  let base = persona.trim() || DEFAULT_PERSONA;
  if (!persona.trim() && personaPreset && PERSONA_PRESETS[personaPreset]) {
    base += `\n\nAdditional style instruction: ${PERSONA_PRESETS[personaPreset]}`;
  }
  if (userName) base += `\n\nThe user's name is ${userName}. Use it naturally, not constantly.`;
  if (memory) {
    base += `\n\nThings you know about the user (from your memory, treat as true and current):\n${memory}`;
  }
  base += `\n\nCurrent date: ${new Date().toDateString()}.`;
  return base;
}

/* --------------------------- memory extraction --------------------------- */
/** Pull "remember that X" style instructions out of a user message. */
export function extractMemoryCandidates(text = '') {
  const found = [];
  const patterns = [
    /\bremember (?:that )?(?:my |i |i'm |im )?([^.!?\n]{3,140})/gi,
    /\b(?:please )?(?:note|keep in mind) (?:that )?([^.!?\n]{3,140})/gi,
    /\bmy name is ([A-Za-z][\w'-]{1,30})/gi,
    /\bcall me ([A-Za-z][\w'-]{1,30})/gi,
    /\bi(?:'m| am) (?:a|an|the) ([^.!?\n]{3,80})/gi,
    /\bi live in ([^.!?\n]{2,60})/gi,
    /\bi work (?:as|at) ([^.!?\n]{2,80})/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = (m[0] || '').trim();
      if (raw.length > 6 && raw.length < 200) found.push(raw);
    }
  }
  // dedupe, keep order
  return [...new Set(found.map(s => s.replace(/\s+/g, ' ').replace(/^[-–]\s*/, '').trim()))].slice(0, 4);
}

/* ============================== GEMINI ==================================== */
function toGeminiContents(messages, systemPrompt) {
  const contents = [];

  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const text = String(m.text || '').trim();
    if (!text) continue;
    // Gemini wants alternating turns — merge consecutive same-role messages
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n\n' + text;
    else contents.push({ role, parts: [{ text }] });
  }

  // must start with a user turn
  while (contents.length && contents[0].role === 'model') contents.shift();
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });

  const body = { contents };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
  return body;
}

function geminiChunkText(chunk) {
  const cand = chunk?.candidates?.[0];
  if (!cand) return { text: '', done: false, blocked: chunk?.promptFeedback?.blockReason || null };

  const parts = cand?.content?.parts || [];
  // thought summaries arrive as parts flagged thought:true — never show those
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');

  return {
    text,
    done: Boolean(cand.finishReason),
    finish: cand.finishReason || null,
  };
}

/**
 * Reasoning controls differ by generation, and sending the wrong one is a 400:
 *   Gemini 3.x  → thinkingConfig.thinkingLevel  ('low' | 'medium' | 'high')
 *   Gemini 2.5  → thinkingConfig.thinkingBudget (integer)
 * We keep chat snappy — this is a voice assistant, not a maths olympiad.
 */
function thinkingConfigFor(model = '') {
  if (/^gemini-3/.test(model)) return { thinkingLevel: 'low' };
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  return null;                                   // unknown family: send nothing
}

/**
 * Stream a Gemini reply.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role:string,text:string}>} opts.messages
 * @param {string} opts.systemPrompt
 * @param {AbortSignal} opts.signal
 * @param {(delta:string, full:string)=>void} opts.onDelta
 * @returns {Promise<string>} full text
 */
export async function streamGemini({ apiKey, model, messages, systemPrompt, signal, onDelta, temperature = 0.85 }) {
  const request = (withThinking) => {
    const payload = toGeminiContents(messages, systemPrompt);
    payload.generationConfig = { temperature, maxOutputTokens: 8192, topP: 0.95 };
    const tc = withThinking ? thinkingConfigFor(model) : null;
    if (tc) payload.generationConfig.thinkingConfig = tc;
    return payload;
  };

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const headers = {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey.trim(),
  };

  const call = (withThinking) => fetch(url, {
    method: 'POST', headers, body: JSON.stringify(request(withThinking)), signal,
  });

  let res;
  try {
    res = await call(true);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw friendlyError(0, { message: String(e) });
  }

  // If this model rejects our reasoning settings, retry once without them.
  if (res.status === 400) {
    const probe = await res.clone().json().catch(() => ({}));
    const text = JSON.stringify(probe);
    if (/thinking/i.test(text)) {
      try {
        res = await call(false);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw friendlyError(0, { message: String(e) });
      }
    } else {
      throw friendlyError(400, probe);
    }
  }

  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({}));
    throw friendlyError(res.status, errPayload);
  }

  // Some browsers/proxies return non-streaming JSON — handle both.
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('event-stream')) {
    const data = await res.json().catch(() => ({}));
    const full = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const blocked = data?.promptFeedback?.blockReason;
    if (!full && blocked) throw new AIError(`Blocked by safety filters (${blocked}).`, { kind: 'blocked' });
    if (full) onDelta?.(full, full);
    return full;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let sawAny = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json || json === '[DONE]') continue;

        let chunk;
        try { chunk = JSON.parse(json); } catch { continue; }

        if (chunk?.error) throw friendlyError(chunk.error.code || 500, chunk);

        const { text, blocked } = geminiChunkText(chunk);
        if (blocked && !text) throw new AIError(`Blocked by safety filters (${blocked}).`, { kind: 'blocked' });

        if (text) {
          sawAny = true;
          full += text;
          onDelta?.(text, full);
        }
      }
    }
  }

  if (!sawAny) throw new AIError('The model returned nothing. Try rephrasing.', { kind: 'empty' });
  return full;
}

/* ==================== optional: OpenAI / Anthropic ======================= */
/* Present so the app is not locked to one vendor — used only if a key exists. */

async function streamOpenAI({ apiKey, model, messages, systemPrompt, signal, onDelta }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map(m => ({ role: m.role, content: m.text }))],
    }),
    signal,
  });
  if (!res.ok) throw friendlyError(res.status, await res.json().catch(() => ({})));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      try {
        const delta = JSON.parse(json)?.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onDelta?.(delta, full); }
      } catch {}
    }
  }
  return full;
}

async function streamAnthropic({ apiKey, model, messages, systemPrompt, signal, onDelta }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model, max_tokens: 8192, stream: true, system: systemPrompt,
      messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })),
    }),
    signal,
  });
  if (!res.ok) throw friendlyError(res.status, await res.json().catch(() => ({})));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.type === 'content_block_delta' && evt.delta?.text) {
          full += evt.delta.text;
          onDelta?.(evt.delta.text, full);
        }
      } catch {}
    }
  }
  return full;
}

/** Single entry point used by the app. */
export async function streamChat(opts) {
  const provider = modelById(opts.model).provider || 'gemini';
  if (provider === 'openai')    return streamOpenAI(opts);
  if (provider === 'anthropic') return streamAnthropic(opts);
  return streamGemini(opts);
}
