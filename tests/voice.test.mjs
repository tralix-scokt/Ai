/* ==========================================================================
   voice.test.mjs — spoken replies (Fish Audio) and the separation of
   speech-to-text from text-to-speech.

   Real code paths: server/tts.js and the /api/v2/voice/* routes, driven
   against a local double of the Fish Audio API (tests/fake-fish.mjs). No
   account, no network call and no real key is involved.

   The rules this suite exists to defend:
     • the key lives on the server and is never returned to the client;
     • an unconfigured voice is reported as unconfigured, never as working;
     • only a real request can prove a voice works;
     • text-to-speech and speech recognition are independent.
   ========================================================================== */

import handler from '../server/worker.js';
import * as Store from '../server/store.js';
import { startFakeFish } from './fake-fish.mjs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? `— ${extra}` : ''); }
};
const group = (title) => console.log(`\n— ${title} —`);

const SECRET = 'fa-TESTKEY-not-a-real-credential-0001';
const dataDir = `/tmp/jarvis-voice-${Date.now()}`;

const fish = await startFakeFish({ status: 200 });
await Store.init({ dir: dataDir });

const env = {
  TRALIX_ALLOWED_ORIGINS: '*',
  JARVIS_DATA_DIR: dataDir,
  JARVIS_WRITE_TOKEN: '',
  FISH_AUDIO_BASE_URL: `http://127.0.0.1:${fish.port}/v1/tts`,
};

const call = (path, { method = 'GET', body } = {}) =>
  handler.fetch(new Request(`https://backend.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

const readBody = async (res) => {
  const type = res.headers.get('content-type') || '';
  if (type.includes('json')) return res.json().catch(() => ({}));
  return res.text();
};

/* ============================ 1. not configured =========================== */
group('an unconfigured voice says so, and only says what it knows');

{
  const res = await call('/api/v2/voice/status');
  const data = await res.json();

  t('the endpoint answers', res.status === 200, String(res.status));
  t('it is reported as not configured', data.configured === false);
  t('the provider is named', data.provider === 'fish-audio', data.provider);
  t('no key hint is invented', data.keyHint === '', JSON.stringify(data.keyHint));
  t('the note tells the user exactly what to set', /FISH_AUDIO_API_KEY/.test(data.note || ''), data.note);
  t('the note says the microphone is independent', /Speech recognition/.test(data.note || ''));
  t('the character limit is reported', data.maxChars === 1200, String(data.maxChars));

  const speak = await call('/api/v2/voice/speak', { method: 'POST', body: { text: 'Hello' } });
  const speakBody = await readBody(speak);
  t('speaking without a key fails honestly', speak.status === 503, String(speak.status));
  t('and says text-to-speech is not configured', /not configured/i.test(speakBody?.error?.message || ''),
    speakBody?.error?.message);
  t('no audio was requested from the vendor', fish.requests.length === 0);
}

/* ============================== 2. env key ================================ */
group('a key from the environment is used, and stays on the server');

{
  const keyed = { ...env, FISH_AUDIO_API_KEY: SECRET, FISH_AUDIO_MODEL: 's2.1-pro-free' };
  const callKeyed = (path, opts = {}) =>
    handler.fetch(new Request(`https://backend.test${path}`, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }), keyed);

  const status = await (await callKeyed('/api/v2/voice/status')).json();
  t('the key is reported as configured', status.configured === true);
  t('its source is the environment', status.keySource === 'environment', status.keySource);
  t('only a hint is returned', status.keyHint && !status.keyHint.includes(SECRET.slice(4, 20)),
    status.keyHint);
  t('the configured model is reported', status.model === 's2.1-pro-free', status.model);

  fish.reset();
  const res = await callKeyed('/api/v2/voice/speak', { method: 'POST', body: { text: 'Good evening, sir.' } });
  t('speech is synthesised', res.status === 200, String(res.status));
  t('the audio type is preserved', (res.headers.get('content-type') || '').includes('audio/mpeg'),
    res.headers.get('content-type'));
  const bytes = Buffer.from(await res.arrayBuffer());
  t('the audio bytes are passed through untouched', bytes.byteLength > 0, String(bytes.byteLength));

  const upstream = fish.requests.at(-1);
  t('the vendor request carried the key', upstream?.authorization === `Bearer ${SECRET}`);
  t('the vendor request carried the model header', upstream?.model === 's2.1-pro-free', upstream?.model);
  t('the text was forwarded', upstream?.body?.text === 'Good evening, sir.', upstream?.body?.text);
  t('the format was requested', upstream?.body?.format === 'mp3', upstream?.body?.format);
  t('prosody is sent, not invented', typeof upstream?.body?.prosody?.speed === 'number');
  t('audio is never cached', /no-store/.test(res.headers.get('cache-control') || ''));

  const long = 'a'.repeat(1201);
  const tooLong = await callKeyed('/api/v2/voice/speak', { method: 'POST', body: { text: long } });
  const tooLongBody = await readBody(tooLong);
  t('over-long text is refused', tooLong.status === 413, String(tooLong.status));
  t('and the limit is quoted', /1200/.test(tooLongBody?.error?.message || ''));

  const empty = await callKeyed('/api/v2/voice/speak', { method: 'POST', body: { text: '   ' } });
  t('empty text is refused', empty.status === 400, String(empty.status));
}

/* ========================= 3. a rejected credential ======================= */
group('a rejected vendor key is reported, not swallowed');

{
  fish.status = 401;
  const keyed = { ...env, FISH_AUDIO_API_KEY: SECRET };
  const res = await handler.fetch(new Request('https://backend.test/api/v2/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Testing.' }),
  }), keyed);
  const body = await readBody(res);

  t('the failure is surfaced', res.status !== 200, String(res.status));
  t('the message names the real cause', /rejected the API key/i.test(body?.error?.message || ''),
    body?.error?.message);
  t('the key is never echoed back', !JSON.stringify(body).includes(SECRET));
  fish.status = 200;
}

/* ===================== 4. a key added from the client ===================== */
group('a key saved from the UI is stored server-side and never returned');

{
  const res = await call('/api/v2/voice/key', { method: 'POST', body: { key: SECRET, referenceId: 'voice-abc' } });
  const data = await res.json();

  t('the key is accepted', res.status === 200 && data.saved === true, String(res.status));
  t('only a hint comes back', Boolean(data.hint) && !data.hint.includes(SECRET.slice(4, 20)), data.hint);
  t('status now reports it as configured', data.status?.configured === true);
  t('and says it came from the server store', data.status?.keySource === 'server store', data.status?.keySource);
  t('the voice id was saved too', data.status?.voiceId === 'voice-abc', data.status?.voiceId);

  const status = await (await call('/api/v2/voice/status')).json();
  t('a later status read still hides the key', status.configured === true && !JSON.stringify(status).includes(SECRET));
  t('the environment still wins when both are set',
    (await (await handler.fetch(new Request('https://backend.test/api/v2/voice/status'),
      { ...env, FISH_AUDIO_API_KEY: SECRET })).json()).keySource === 'environment');
}

/* ================= 5. the vendor is unreachable (our fault) =============== */
group('an unreachable vendor is our failure to report, not the model\'s');

{
  const port = fish.port;
  await fish.close();
  const keyed = { ...env, FISH_AUDIO_API_KEY: SECRET, FISH_AUDIO_BASE_URL: `http://127.0.0.1:${port}/v1/tts` };
  const res = await handler.fetch(new Request('https://backend.test/api/v2/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Are you there?' }),
  }), keyed);
  const body = await readBody(res);

  t('the request fails', res.status !== 200, String(res.status));
  t('the message says the backend could not reach Fish Audio',
    /could not reach Fish Audio/i.test(body?.error?.message || ''), body?.error?.message);
  t('no key leaked while failing', !JSON.stringify(body).includes(SECRET));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
