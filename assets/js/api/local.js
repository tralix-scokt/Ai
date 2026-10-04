/* ==========================================================================
   api/local.js — advanced, optional direct-to-provider transport.

   This preserves the previous build's capability: if a user supplies their own
   key in Advanced settings, the browser calls the provider directly and the key
   stays in this device's storage. It is OFF by default; TRALIX ships using the
   secure backend (see api/backend.js).

   It exists so nothing that worked before is lost — not as the recommended
   path. Provider model names live here and nowhere else in the UI.
   ========================================================================== */

import { TralixError, ERROR_CODES, codeFromStatus, toTralixError } from '../errors.js';
import { readSse } from './client.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_BASE = 'https://api.openai.com/v1';

export const LOCAL_PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini', keyHint: 'AIza…', docs: 'https://aistudio.google.com/apikey' },
  { id: 'openai', label: 'OpenAI', keyHint: 'sk-…', docs: 'https://platform.openai.com/api-keys' },
];

export const providerById = (id) => LOCAL_PROVIDERS.find(p => p.id === id) || LOCAL_PROVIDERS[0];

/** A cheap validity check used before saving a device key. */
export function looksLikeKey(provider, key = '') {
  const k = String(key).trim();
  if (!k) return false;
  return provider === 'gemini' ? /^AIza[\w-]{20,}$/.test(k) : /^sk-[\w-]{16,}$/.test(k);
}

function friendly(status, payload) {
  const detail = payload?.error?.message || payload?.message || `HTTP ${status}`;
  const code = codeFromStatus(status, payload?.error?.status || payload?.error?.code || '');
  return new TralixError(code, { status, detail });
}

/* -------------------------------- Gemini --------------------------------- */
function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const text = String(m.content ?? m.text ?? '').trim();
    if (!text) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n\n' + text;
    else contents.push({ role, parts: [{ text }] });
  }
  while (contents.length && contents[0].role === 'model') contents.shift();
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  return contents;
}

/** List the models a Gemini key can actually reach. */
export async function probeGemini(apiKey, { signal } = {}) {
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': String(apiKey).trim() },
      signal,
    });
  } catch (err) {
    throw toTralixError(err);
  }
  if (!res.ok) throw friendly(res.status, await res.json().catch(() => ({})));
  const data = await res.json().catch(() => ({}));
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace('models/', ''))
    .filter(Boolean);
}

/* ------------------------------- OpenAI ---------------------------------- */
/**
 * Verify an OpenAI key with the cheapest possible call.
 * Uses the models endpoint so no tokens are spent.
 */
export async function probeOpenAI(apiKey, { signal } = {}) {
  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${String(apiKey).trim()}` },
      signal,
    });
  } catch (err) {
    throw toTralixError(err);
  }
  if (!res.ok) throw friendly(res.status, await res.json().catch(() => ({})));
  const data = await res.json().catch(() => ({}));
  return (data.data || []).map(m => m.id).filter(Boolean);
}

export function probe(provider, apiKey, opts = {}) {
  return provider === 'openai' ? probeOpenAI(apiKey, opts) : probeGemini(apiKey, opts);
}

/* ------------------------------ streaming -------------------------------- */
async function streamGemini({ apiKey, model, messages, instructions, signal, onDelta }) {
  const body = { contents: toGeminiContents(messages), generationConfig: { temperature: 0.8, maxOutputTokens: 8192, topP: 0.95 } };
  if (instructions) body.systemInstruction = { parts: [{ text: instructions }] };

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(apiKey).trim() },
    body: JSON.stringify(body),
    signal,
  }).catch(err => { throw toTralixError(err); });

  if (!res.ok) throw friendly(res.status, await res.json().catch(() => ({})));

  let full = '';
  const emit = (t) => { if (t) { full += t; onDelta?.(t, full); } };

  for await (const chunk of readSse(res)) {
    if (chunk?.error) throw friendly(chunk.error.code || 500, chunk);
    const parts = chunk?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) if (!p.thought) emit(p.text || '');
  }
  if (!full) throw new TralixError(ERROR_CODES.unknown, { message: 'The model returned nothing. Try rephrasing.' });
  return { text: full, model, usage: null, searchUsed: false };
}

async function streamOpenAI({ apiKey, model, messages, instructions, signal, onDelta, reasoning }) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(apiKey).trim()}` },
    body: JSON.stringify({
      model,
      stream: true,
      ...(reasoning?.effort && !/^gpt-(4|3)/.test(model) ? { reasoning_effort: reasoning.effort } : {}),
      messages: [
        ...(instructions ? [{ role: 'system', content: instructions }] : []),
        ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      ],
    }),
    signal,
  }).catch(err => { throw toTralixError(err); });

  if (!res.ok) throw friendly(res.status, await res.json().catch(() => ({})));

  let full = '';
  const emit = (t) => { if (t) { full += t; onDelta?.(t, full); } };

  for await (const chunk of readSse(res)) {
    emit(chunk?.choices?.[0]?.delta?.content || '');
  }
  if (!full) throw new TralixError(ERROR_CODES.unknown, { message: 'The model returned nothing. Try rephrasing.' });
  return { text: full, model, usage: null, searchUsed: false };
}

/**
 * Stream through the user's own provider key.
 * @param {object} opts
 * @param {'gemini'|'openai'} opts.provider
 * @param {string} opts.apiKey    device-stored key
 * @param {string} opts.model     concrete provider model id (resolved by models.js)
 */
export async function streamLocal(opts) {
  const { provider, apiKey, model } = opts;
  if (!apiKey) {
    throw new TralixError(ERROR_CODES.invalid_config, {
      message: 'No provider key is saved on this device. Add one in Settings → Advanced.',
    });
  }
  return provider === 'openai'
    ? streamOpenAI({ ...opts, model })
    : streamGemini({ ...opts, model });
}
