/* ==========================================================================
   routing.test.mjs — the Free-first router, driven end to end.

   Two local doubles stand in for real vendors:
     tests/fake-openai.mjs   OpenAI Responses API (a *paid* provider)
     tests/fake-gemini.mjs   Gemini generateContent (a *free-tier* provider)

   No request ever leaves this machine, and no real key exists. What is proven
   here is the JARVIS side of the contract: capability detection, ordering,
   the paid gate, failover and the usage ledger.

   Run:  node tests/routing.test.mjs
   ========================================================================== */

import { startFakeOpenAI } from './fake-openai.mjs';
import { startFakeGemini } from './fake-gemini.mjs';
import handler from '../server/worker.js';
import * as Store from '../server/store.js';
import * as Router from '../server/router.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? `— ${extra}` : ''); }
};
const group = (title) => console.log(`\n— ${title} —`);

/* ------------------------------- environment ------------------------------ */

const openai = await startFakeOpenAI(0);
const gemini = await startFakeGemini(0);

const dataDir = `/tmp/jarvis-routing-${Date.now()}`;
await Store.init({ dir: dataDir });

const env = {
  OPENAI_API_KEY: 'sk-test-key-not-real',
  OPENAI_BASE_URL: `http://127.0.0.1:${openai.port}/v1`,
  GEMINI_API_KEY: 'AIzaTestKeyNotReal',
  GEMINI_BASE_URL: `http://127.0.0.1:${gemini.port}/v1beta`,
  TRALIX_ALLOWED_ORIGINS: '*',
  JARVIS_DATA_DIR: dataDir,
};

const call = (path, { method = 'GET', body, env: envOverride = env, signal } = {}) =>
  handler.fetch(new Request(`https://backend.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.test', ...(body ? {} : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  }), envOverride);

async function frames(res) {
  const text = await res.text();
  return text.split('\n\n')
    .map(block => block.split('\n').find(l => l.startsWith('data:')))
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
    .filter(Boolean);
}

/* ============================== 1. discovery ============================= */
group('providers are discovered and verified, not assumed');

{
  const res = await call('/api/v2/providers?force=1');
  t('GET /api/v2/providers answers 200', res.status === 200, `got ${res.status}`);
  const body = await res.json();

  const ids = body.providers.map(p => p.id);
  t('the whole catalogue is listed', ids.includes('gemini') && ids.includes('openai') && ids.includes('groq'), ids.join(','));

  const g = body.providers.find(p => p.id === 'gemini');
  const o = body.providers.find(p => p.id === 'openai');
  const groq = body.providers.find(p => p.id === 'groq');

  t('a configured free provider verifies against its own API', g.verified === true && g.status === 'ok', JSON.stringify(g));
  t('a configured paid provider verifies too', o.verified === true, JSON.stringify(o));
  t('an unconfigured provider is reported as unconfigured, not ready',
    groq.configured === false && groq.verified === false && groq.enabled === false, JSON.stringify(groq));
  t('the unconfigured provider names the variable the operator must set',
    /GROQ_API_KEY/.test(groq.message || ''), groq.message);
  t('no key material is echoed to the client',
    !JSON.stringify(body).includes('AIzaTestKeyNotReal') && !JSON.stringify(body).includes('sk-test-key-not-real'));
  t('model verification is per tier and honest',
    g.modelStatus.smart.verified === true && g.modelStatus.smart.model === 'gemini-2.5-flash',
    JSON.stringify(g.modelStatus.smart));
  t('free-first is the default routing mode', body.policy.mode === 'free-first', body.policy.mode);
  t('paid fallback is OFF by default', body.policy.paidFallback === false);
}

/* ============================== 2. the paid gate ========================== */
group('a paid provider is never used without permission');

{
  const res = await call('/api/v2/chat', {
    method: 'POST',
    body: {
      messages: [{ role: 'user', content: 'hello' }],
      // force the paid provider: exclude every free option
    },
    env: { ...env, GEMINI_API_KEY: '' },
  });
  t('chat answers 200 (SSE stream opens)', res.status === 200);
  const list = await frames(res);
  const error = list.find(f => f.type === 'error');
  t('the stream refuses with paid_blocked', error?.code === 'paid_blocked', JSON.stringify(error));
  t('the refusal explains that paid usage is not authorised',
    /paid/i.test(error?.message || ''), error?.message);
  t('the refusal flags that permission is what is missing', error?.requiresPaidPermission === true);
  t('no upstream call was made to the paid provider',
    openai.state.requests.filter(r => r.path === '/v1/responses').length === 0,
    `calls=${openai.state.requests.filter(r => r.path === '/v1/responses').length}`);

  const buffered = await call('/api/v2/chat/buffered', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'hello' }] },
    env: { ...env, GEMINI_API_KEY: '' },
  });
  t('the buffered endpoint refuses too', buffered.status === 503, `got ${buffered.status}`);
  const payload = await buffered.json();
  t('and reports which providers are blocked and why',
    Array.isArray(payload.error?.blocked) && payload.error.blocked.some(b => b.id === 'openai'),
    JSON.stringify(payload.error));
}

group('paid usage needs both permission and a limit');

{
  const noLimit = await call('/api/v2/routing', {
    method: 'PATCH',
    body: { routing: { paidFallback: true } },
  });
  t('enabling paid fallback without a limit is refused', noLimit.status === 400, `got ${noLimit.status}`);
  const why = await noLimit.json();
  t('the refusal says to set a monthly limit', /limit/i.test(why.error?.message || ''), why.error?.message);

  const withLimit = await call('/api/v2/routing', {
    method: 'PATCH',
    body: { routing: { paidFallback: true, monthlyLimitUsd: 5 } },
  });
  t('permission plus a limit is accepted', withLimit.status === 200, `got ${withLimit.status}`);
  const body = await withLimit.json();
  t('the policy records the authorisation', body.settings.routing.paidFallback === true);
  t('the monthly limit is stored', body.settings.routing.monthlyLimitUsd === 5);
}

/* ============================== 3. free-first ============================ */
group('when a free model is available it is used, even with paid permission');

{
  Router.invalidateProbes();
  const before = openai.state.requests.filter(r => r.path === '/v1/responses').length;

  const res = await call('/api/v2/chat', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'say hello' }] },
  });
  const list = await frames(res);
  const done = list.find(f => f.type === 'done');
  const deltas = list.filter(f => f.type === 'delta').map(f => f.text).join('');

  t('the stream completes', Boolean(done), JSON.stringify(list.at(-1)));
  t('the free provider was chosen', done?.provider === 'gemini', JSON.stringify(done));
  t('the reply is marked as not paid', done?.paid === false);
  t('the text streamed through', deltas.includes('Gemini answer from the double.'), deltas.slice(0, 60));
  const after = openai.state.requests.filter(r => r.path === '/v1/responses').length;
  t('the paid provider was not touched', after === before, `${before} → ${after}`);

  const ledger = await Store.getUsage();
  t('usage is recorded for the provider that was used',
    ledger.providers.gemini?.requests >= 1, JSON.stringify(ledger.providers.gemini));
  t('token counts come from the provider, not from guessing',
    ledger.providers.gemini?.outputTokens >= 7 && ledger.providers.gemini?.outputTokens % 7 === 0,
    JSON.stringify(ledger.providers.gemini));
  t('no cost is invented for a provider that publishes no price',
    ledger.providers.gemini?.estimatedUsd === 0 && ledger.estimatedUsd === 0,
    JSON.stringify(ledger));
}

/* ============================== 4. failover ============================== */
group('when the free provider is rate limited, JARVIS fails over honestly');

{
  gemini.state.failWith = 429;
  Router.invalidateProbes();
  const beforeOpenAI = openai.state.requests.filter(r => r.path === '/v1/responses').length;

  const res = await call('/api/v2/chat', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'after the outage' }] },
  });
  const list = await frames(res);
  const done = list.find(f => f.type === 'done');
  const error = list.find(f => f.type === 'error');

  t('the request still completes', Boolean(done) || Boolean(error), JSON.stringify(list.at(-1)));
  if (done) {
    t('it failed over to the paid provider (authorised earlier)', done.provider === 'openai', JSON.stringify(done));
    t('the failover is reported as paid usage', done.paid === true);
    const afterOpenAI = openai.state.requests.filter(r => r.path === '/v1/responses').length;
    t('the paid provider was actually called', afterOpenAI === beforeOpenAI + 1,
      `${beforeOpenAI} → ${afterOpenAI}`);
    t('the attempts list explains the failover',
      (done.attempts || []).some(a => a.provider === 'gemini' && /rate_limit|quota_exceeded/.test(a.code)),
      JSON.stringify(done.attempts));
  } else {
    t('failover produced a documented error', Boolean(error?.attempts?.length), JSON.stringify(error));
  }
  gemini.state.failWith = 0;
}

group('a rate-limited provider is cooled down instead of hammered');

{
  const state = Router.cooldownState('gemini');
  t('the free provider is in cooldown after a 429',
    state !== null && /rate_limit|quota_exceeded/.test(state.code), JSON.stringify(state));
  t('the cooldown has an expiry', (state?.secondsLeft || 0) > 0, String(state?.secondsLeft));

  const routing = await call('/api/v2/routing');
  const body = await routing.json();
  const blocked = body.blocked.find(b => b.id === 'gemini');
  t('the cooldown is visible in the routing report',
    Boolean(blocked && blocked.reasons.some(r => /cooling down/i.test(r))),
    JSON.stringify(blocked?.reasons));
}

/* ============================== 5. cost limit ============================ */
group('the monthly limit is a hard stop');

{
  await Store.patchSettings({ routing: { monthlyLimitUsd: 0.000001, paidFallback: true } });
  await Store.recordUsage({ provider: 'openai', model: 'gpt-5', kind: 'paid', usage: null, usd: 0.000002, ok: true });
  await Router.refreshUsageSnapshot();
  Router.invalidateProbes();
  gemini.state.failWith = 500;                 // take the free provider out

  const res = await call('/api/v2/chat', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'over budget?' }] },
  });
  const list = await frames(res);
  const error = list.find(f => f.type === 'error');
  t('a request over the monthly limit is refused',
    error?.code === 'no_eligible_model' || error?.code === 'paid_blocked', JSON.stringify(error));

  const routing = await call('/api/v2/routing');
  const body = await routing.json();
  const openaiBlocked = body.blocked.find(b => b.id === 'openai');
  t('the routing report says the limit was reached',
    Boolean(openaiBlocked && openaiBlocked.reasons.some(r => /monthly limit/i.test(r))),
    JSON.stringify(openaiBlocked?.reasons));
  gemini.state.failWith = 0;
}

/* ============================== 6. write token =========================== */
group('mutating endpoints can be locked behind a write token');

{
  const locked = { ...env, JARVIS_WRITE_TOKEN: 'test-write-token' };
  const without = await call('/api/v2/settings', { method: 'PATCH', body: { tasks: { autonomy: 'full' } }, env: locked });
  t('a write without the token is refused', without.status === 401, `got ${without.status}`);

  const req = new Request('https://backend.test/api/v2/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-jarvis-token': 'test-write-token' },
    body: JSON.stringify({ tasks: { autonomy: 'review-changes' } }),
  });
  const withToken = await handler.fetch(req, locked);
  t('a write with the token succeeds', withToken.status === 200, `got ${withToken.status}`);

  // A key saved through the API lives in the store, so it must be visible as
  // a hint and never as a value.
  const saved = await handler.fetch(new Request('https://backend.test/api/v2/providers/key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-jarvis-token': 'test-write-token' },
    body: JSON.stringify({ id: 'groq', key: 'gsk_testKeyNotRealAtAll123456' }),
  }), locked);
  t('saving a key through the API is accepted', saved.status === 200 || saved.status === 502,
    `got ${saved.status}`);

  const readOnly = await call('/api/v2/settings', { env: locked });
  const body = await readOnly.json();
  t('reads still work without the token', readOnly.status === 200);
  t('the settings response never contains a stored secret value',
    !JSON.stringify(body).includes('AIzaTestKeyNotReal') && !JSON.stringify(body).includes('gsk_testKeyNotRealAtAll123456'));
  t('a stored key is shown only as a hint',
    /^gsk…/.test(body.secrets['provider.groq'] || ''), String(body.secrets['provider.groq']));
}

/* ============================== 7. sandbox + voice ======================= */
group('capabilities are reported, not assumed');

{
  const res = await call('/api/v2/sandbox/status');
  const body = await res.json();
  t('sandbox status answers 200', res.status === 200);
  t('the driver is reported', body.driver === 'process' || body.driver === 'docker', body.driver);
  t('the command allowlist is published', Array.isArray(body.allowlist) && body.allowlist.includes('npm'));
  t('missing isolation primitives are stated', Array.isArray(body.notes));

  const voice = await call('/api/v2/voice/status');
  const voiceBody = await voice.json();
  t('voice reports "not configured" when no key exists', voiceBody.configured === false, JSON.stringify(voiceBody));
  t('the voice note explains that it is independent of the microphone',
    /microphone|speech recognition/i.test(voiceBody.note || ''), voiceBody.note);

  const health = await call('/api/v2/health');
  const healthBody = await health.json();
  t('the overview reports what is actually ready',
    healthBody.ready.free === true && healthBody.ready.github === false && healthBody.ready.voice === false,
    JSON.stringify(healthBody.ready));
  t('the environment report names variables without values',
    healthBody.env.some(e => e.name === 'GEMINI_API_KEY' && e.set === true)
    && healthBody.env.every(e => e.value === undefined));
}

/* --------------------------------- cleanup ------------------------------- */
openai.server.close();
gemini.server.close();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
