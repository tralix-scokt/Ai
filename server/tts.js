/* ==========================================================================
   server/tts.js — spoken responses (Fish Audio).

   Speech synthesis is a *separate* capability from speech recognition:
     • text → speech  : this module, proxied through the backend so the Fish
                        Audio key never reaches the browser.
     • speech → text  : the Web Speech API in the user's browser. It stays in
                        the browser because the audio never needs to leave the
                        device, and no third-party service is involved.

   The endpoint makes a real request. If the key is missing or rejected the
   caller gets an honest error and the UI falls back to text (and, if the
   browser supports it, to the built-in speech synthesis voice).
   ========================================================================== */

import { errorPayload, CODES, createLimiter, redact } from './lib/http.js';
import * as Store from './store.js';

const API = 'https://api.fish.audio/v1/tts';
const MAX_CHARS = 1200;
const limiter = createLimiter({ windowMs: 60_000, max: 20 });

export const FORMATS = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  pcm: 'application/octet-stream',
};

export async function config(env) {
  const settings = await Store.getSettings();
  const secrets = await Store.getSecrets();
  const key = String(env.FISH_AUDIO_API_KEY || secrets['tts.fishAudioKey'] || '');
  return {
    key,
    model: String(env.FISH_AUDIO_MODEL || settings.voice?.model || 's2-pro').trim(),
    referenceId: String(env.FISH_AUDIO_REFERENCE_ID || settings.voice?.referenceId || '').trim(),
    format: FORMATS[String(settings.voice?.format || 'mp3')] ? String(settings.voice?.format) : 'mp3',
    speed: Number(settings.voice?.speed || 1) || 1,
    keySource: env.FISH_AUDIO_API_KEY ? 'environment' : secrets['tts.fishAudioKey'] ? 'server store' : '',
  };
}

/** Report only what we know: configured is a fact, "working" needs a request. */
export async function status(env) {
  const cfg = await config(env);
  return {
    provider: 'fish-audio',
    configured: Boolean(cfg.key),
    keySource: cfg.keySource,
    keyHint: cfg.key ? hintOf(cfg.key) : '',
    model: cfg.model,
    voiceId: cfg.referenceId,
    format: cfg.format,
    maxChars: MAX_CHARS,
    note: cfg.key
      ? 'Configured. Press "Test voice" to make a real request — JARVIS never marks a voice as working without one.'
      : 'Not configured. Set FISH_AUDIO_API_KEY on the backend, or add a key in Settings → Voice. Speech recognition (the microphone) is independent and works without it.',
  };
}

function hintOf(key) {
  const text = String(key || '');
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

/** Synthesise speech. Returns a Response (audio) or an error Response. */
export async function synthesize(env, request, body = {}, clientKey = 'anonymous') {
  const cfg = await config(env);

  if (!cfg.key) {
    return errorPayload(CODES.invalid_config,
      'Text-to-speech is not configured. Add a Fish Audio key on the server (FISH_AUDIO_API_KEY) or in Settings → Voice.',
      503, { feature: 'tts' });
  }

  const limited = limiter(clientKey);
  if (limited.limited) {
    return errorPayload(CODES.rate_limit, 'Too many speech requests. Wait a moment.', 429,
      { retryAfter: limited.retryAfter });
  }

  const text = String(body.text || '').trim();
  if (!text) return errorPayload(CODES.bad_request, 'No text to speak.', 400);
  if (text.length > MAX_CHARS) {
    return errorPayload(CODES.too_long, `Speech is limited to ${MAX_CHARS} characters per request.`, 413);
  }

  const format = FORMATS[String(body.format || cfg.format)] ? String(body.format || cfg.format) : cfg.format;
  const payload = {
    text,
    format,
    mp3_bitrate: 128,
    normalize: true,
    latency: 'normal',
    prosody: {
      speed: clamp(Number(body.speed || cfg.speed) || 1, 0.5, 2),
      volume: 0,
    },
    ...(cfg.referenceId ? { reference_id: cfg.referenceId } : {}),
  };

  let upstream;
  try {
    upstream = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        model: String(body.model || cfg.model),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('[jarvis] fish audio unreachable:', redact(String(err?.message || err)));
    return errorPayload(CODES.network, 'The JARVIS backend could not reach Fish Audio.', 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.warn('[jarvis] fish audio rejected the request:', upstream.status, redact(detail, 200));
    const message = upstream.status === 401 || upstream.status === 403
      ? 'Fish Audio rejected the API key on the JARVIS server.'
      : upstream.status === 429
        ? 'Fish Audio is rate limiting this key (or the plan has run out).'
        : upstream.status >= 500
          ? 'Fish Audio reported an internal error.'
          : 'Fish Audio rejected the speech request.';
    const code = upstream.status === 401 || upstream.status === 403 ? CODES.unauthorized
      : upstream.status === 429 ? CODES.rate_limit
        : upstream.status >= 500 ? CODES.provider_unavailable : CODES.bad_request;
    return errorPayload(code, message, upstream.status === 429 ? 429 : 502, { feature: 'tts' });
  }

  const audio = await upstream.arrayBuffer();
  return new Response(audio, {
    status: 200,
    headers: {
      'Content-Type': FORMATS[format] || 'audio/mpeg',
      'Cache-Control': 'no-store',
      'Content-Length': String(audio.byteLength),
    },
  });
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
