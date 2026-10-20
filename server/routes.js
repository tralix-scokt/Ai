/* ==========================================================================
   server/routes.js — the JARVIS STUDIO API (v2).

   Everything under /api/v2/ lives here; the original /api/chat|health|models
   endpoints in server/worker.js keep working unchanged for older clients.

   Conventions
     • GET never mutates. POST/PATCH/DELETE may, and require the write token
       when JARVIS_WRITE_TOKEN is set on the server.
     • Provider keys are accepted but never returned: a read gives a hint.
     • Failures use one error vocabulary ({error:{code,message}}) and never
       include an upstream body or a stack trace.
   ========================================================================== */

import {
  json, errorPayload, corsHeaders, CODES, sseResponse, readJson, clientIp, redact,
} from './lib/http.js';
import * as Store from './store.js';
import * as Router from './router.js';
import * as GitHub from './github.js';
import * as Tasks from './tasks.js';
import * as Runner from './runner.js';
import * as Tts from './tts.js';
import { CATALOG, byId } from './providers/index.js';

const CORS_OK = { 'Access-Control-Allow-Credentials': 'true' };

const ok = (data, request, env, status = 200) =>
  json(data, status, { ...corsHeaders(request, env), ...CORS_OK });

const fail = (code, message, status, request, env, extra = {}) =>
  json({ error: { code, message, ...extra } }, status, { ...corsHeaders(request, env), ...CORS_OK });

/* --------------------------------- session -------------------------------- */

function sessionFrom(request) {
  const cookie = String(request.headers.get('Cookie') || '');
  const match = cookie.match(/(?:^|;\s*)jarvis_session=([^;]+)/);
  if (!match) return null;
  return Store.getSession(decodeURIComponent(match[1]));
}

function setSessionCookie(response, sessionId, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  response.headers.append('Set-Cookie',
    `jarvis_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure}`);
  return response;
}

/** Mutating endpoints are protected by JARVIS_WRITE_TOKEN when it is set. */
function authorised(request, env) {
  const required = String(env.JARVIS_WRITE_TOKEN || '');
  if (!required) return true;
  const header = request.headers.get('x-jarvis-token')
    || String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return header === required;
}

const guard = (request, env) => authorised(request, env)
  ? null
  : fail('unauthorized', 'This deployment requires a write token (JARVIS_WRITE_TOKEN).', 401, request, env);

/* --------------------------------- helpers -------------------------------- */

const ENV_REPORT = [
  { name: 'OPENAI_API_KEY', purpose: 'OpenAI chat (paid). Legacy /api/chat uses it too.', secret: true },
  { name: 'GEMINI_API_KEY', purpose: 'Google Gemini — free tier, first choice in Free-first routing.', secret: true },
  { name: 'GROQ_API_KEY', purpose: 'Groq — free tier, very fast.', secret: true },
  { name: 'OPENROUTER_API_KEY', purpose: 'OpenRouter — free models tagged ":free".', secret: true },
  { name: 'ANTHROPIC_API_KEY', purpose: 'Anthropic Claude (paid).', secret: true },
  { name: 'MISTRAL_API_KEY', purpose: 'Mistral (paid, limited free experimental tier).', secret: true },
  { name: 'GITHUB_TOKEN', purpose: 'GitHub personal access token — repository read, branch, commit, PR.', secret: true },
  { name: 'GITHUB_APP_ID', purpose: 'GitHub App id (alternative to a PAT).', secret: false },
  { name: 'GITHUB_APP_PRIVATE_KEY', purpose: 'GitHub App private key (PEM).', secret: true },
  { name: 'GITHUB_INSTALLATION_ID', purpose: 'GitHub App installation id (optional — auto-detected).', secret: false },
  { name: 'GITHUB_OAUTH_CLIENT_ID', purpose: 'OAuth App client id for per-user sign-in.', secret: false },
  { name: 'GITHUB_OAUTH_CLIENT_SECRET', purpose: 'OAuth App client secret.', secret: true },
  { name: 'GITHUB_OAUTH_REDIRECT_URI', purpose: 'OAuth callback override (default: /api/v2/github/oauth/callback).', secret: false },
  { name: 'FISH_AUDIO_API_KEY', purpose: 'Fish Audio text-to-speech.', secret: true },
  { name: 'FISH_AUDIO_MODEL', purpose: 'Fish Audio model (default s2-pro).', secret: false },
  { name: 'FISH_AUDIO_REFERENCE_ID', purpose: 'Fish Audio voice id (optional).', secret: false },
  { name: 'JARVIS_PAID_FALLBACK', purpose: '"true" authorises paid providers as a fallback.', secret: false },
  { name: 'JARVIS_MONTHLY_LIMIT_USD', purpose: 'Monthly spend ceiling for paid providers.', secret: false },
  { name: 'JARVIS_WRITE_TOKEN', purpose: 'Shared secret required for mutating API calls.', secret: true },
  { name: 'JARVIS_DATA_DIR', purpose: 'Where settings, tasks and keys are stored (default ./data).', secret: false },
  { name: 'JARVIS_SANDBOX_DRIVER', purpose: '"process" (default) or "docker".', secret: false },
  { name: 'JARVIS_SANDBOX_NETWORK', purpose: '"off" (default) or "on" for checks that must install deps.', secret: false },
  { name: 'TRALIX_ALLOWED_ORIGINS', purpose: 'CORS allow-list for the API.', secret: false },
];

function envReport(env) {
  return ENV_REPORT.map(entry => ({
    ...entry,
    set: Boolean(String(env[entry.name] || '').trim()),
    value: undefined,
  }));
}

/* ------------------------------ the dispatcher ---------------------------- */

/**
 * @returns {Promise<Response|null>} null when the path is not an /api/v2 route.
 */
export async function handle(request, env, { pathname, search } = {}) {
  const url = pathname ? { pathname, search } : new URL(request.url);
  const path = String(url.pathname || '').replace(/^\/api\/v2/, '').replace(/\/+$/, '') || '/';
  const method = (request.method || 'GET').toUpperCase();
  const session = sessionFrom(request);
  const params = url.search ? new URLSearchParams(String(url.search).replace(/^\?/, '')) : new URLSearchParams();

  const isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
  const needsBody = isWrite && method !== 'DELETE';

  /* ------------------------------- overview ------------------------------ */
  if (path === '/health' && method === 'GET') {
    const [providers, github, sandbox, voice] = await Promise.all([
      Router.listProviders(env),
      GitHub.status(env, { session }).catch(() => ({ configured: false, connected: false, message: 'GitHub status unavailable.' })),
      Runner.sandboxStatus().catch(() => ({ available: false })),
      Tts.status(env).catch(() => ({ configured: false })),
    ]);
    const freeReady = providers.providers.filter(p => p.enabled && p.configured && p.verified && p.kind !== 'paid');
    const paidReady = providers.providers.filter(p => p.enabled && p.configured && p.verified && p.kind === 'paid');
    return ok({
      ok: true,
      storage: Store.storageMode(),
      ready: {
        free: freeReady.length > 0,
        paid: paidReady.length > 0,
        github: Boolean(github.connected),
        sandbox: Boolean(sandbox.available),
        voice: Boolean(voice.configured),
      },
      providers,
      github,
      sandbox,
      voice,
      env: envReport(env),
      checkedAt: new Date().toISOString(),
    }, request, env);
  }

  if (path === '/env' && method === 'GET') {
    return ok({ variables: envReport(env), storage: Store.storageMode() }, request, env);
  }

  /* ------------------------------- settings ------------------------------ */
  if (path === '/settings' && method === 'GET') {
    const settings = await Store.getSettings();
    const secrets = await Store.getSecrets();
    return ok({
      settings,
      secrets: Object.fromEntries(Object.keys(secrets).map(k => [k, Store.hint(secrets[k])])),
      writeTokenRequired: Boolean(String(env.JARVIS_WRITE_TOKEN || '')),
      authenticated: Boolean(!env.JARVIS_WRITE_TOKEN || authorised(request, env)),
    }, request, env);
  }

  if (path === '/settings' && method === 'PATCH') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);
    const updated = await Store.patchSettings(value || {});
    return ok({ settings: updated }, request, env);
  }

  /* ------------------------------- providers ----------------------------- */
  if (path === '/providers' && method === 'GET') {
    const force = params.get('force') === '1' || params.get('probe') === '1';
    return ok(await Router.listProviders(env, { force }), request, env);
  }

  if (path === '/providers/test' && method === 'POST') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);

    const id = String(value?.id || '');
    const meta = byId(id);
    if (!meta) return fail('bad_request', 'Unknown provider.', 404, request, env);

    // A key can be tested before it is saved, and saving is a separate choice.
    const probeEnv = { ...env };
    if (value?.key) probeEnv[meta.envKey] = String(value.key);
    if (value?.baseUrl) probeEnv[meta.envBaseKey] = String(value.baseUrl);

    if (value?.save && value?.key) {
      await Store.setSecret(`provider.${id}`, String(value.key));
    }
    if (value?.save && value?.baseUrl) {
      await Store.patchSettings({ providers: { [id]: { baseUrl: String(value.baseUrl) } } });
    }

    Router.invalidateProbes();
    const state = await Router.probeProvider(probeEnv, id, { force: true });
    return ok(state, request, env, state.verified ? 200 : 502);
  }

  if (path === '/providers/key' && method === 'POST') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);

    const id = String(value?.id || '');
    const meta = byId(id);
    if (!meta || !meta.envKey) return fail('bad_request', 'This provider does not take a stored key.', 400, request, env);

    const key = String(value?.key || '').trim();
    if (!key) return fail('bad_request', 'No key supplied.', 400, request, env);
    if (key.length < 12) return fail('bad_request', 'That key looks incomplete.', 400, request, env);

    await Store.setSecret(`provider.${id}`, key);
    if (value?.baseUrl) await Store.patchSettings({ providers: { [id]: { baseUrl: String(value.baseUrl) } } });
    Router.invalidateProbes();
    const state = await Router.probeProvider(env, id, { force: true });
    return ok({ saved: true, hint: Store.hint(key), state }, request, env, state.verified ? 200 : 502);
  }

  if (path === '/providers/key' && method === 'DELETE') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const id = String(params.get('id') || '');
    const meta = byId(id);
    if (!meta) return fail('bad_request', 'Unknown provider.', 404, request, env);
    await Store.setSecret(`provider.${id}`, '');
    Router.invalidateProbes();
    return ok({ removed: true }, request, env);
  }

  if (path === '/providers/config' && method === 'PATCH') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);

    const settings = await Store.getSettings();
    const providers = { ...(settings.providers || {}) };
    for (const [id, patch] of Object.entries(value?.providers || {})) {
      if (!byId(id)) continue;
      providers[id] = { ...(providers[id] || {}), ...patch };
    }
    const updated = await Store.patchSettings({ providers });
    Router.invalidateProbes();
    return ok({ settings: updated }, request, env);
  }

  /* -------------------------------- routing ------------------------------ */
  if (path === '/routing' && method === 'GET') {
    const settings = await Store.getSettings();
    const policy = await Router.policy(env, settings);
    const usage = await Store.getUsage();
    const { candidates: list, blocked } = await Router.candidates(env, {
      tier: params.get('tier') || 'smart', task: params.get('task') || 'chat',
    });
    return ok({
      policy,
      usage,
      eligible: list.map(c => ({ id: c.id, label: c.label, model: c.model, kind: c.kind, priority: c.priority, paid: c.isPaidUse })),
      blocked: blocked.map(b => ({ id: b.id, label: b.label, reasons: b.reasons })),
      catalog: CATALOG.map(p => ({ id: p.id, label: p.label, kind: p.kind, freeTier: p.freeTier, note: p.note, docsUrl: p.docsUrl, envKey: p.envKey, capabilities: p.capabilities })),
    }, request, env);
  }

  if (path === '/routing' && method === 'PATCH') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);

    const patch = value?.routing || {};
    const allowed = ['mode', 'paidFallback', 'monthlyLimitUsd', 'preferProvider', 'reviewWithSecondModel', 'allowParallelModels'];
    const clean = {};
    for (const key of allowed) if (key in patch) clean[key] = patch[key];

    if (clean.mode && !['free-first', 'free-only', 'balanced'].includes(clean.mode)) {
      return fail('bad_request', 'mode must be free-first, free-only or balanced.', 400, request, env);
    }
    if (clean.paidFallback === true && String(env.JARVIS_PAID_FALLBACK || '').toLowerCase() !== 'true') {
      const stored = await Store.getSettings();
      const limit = Number(clean.monthlyLimitUsd ?? stored.routing?.monthlyLimitUsd ?? 0) || 0;
      if (!(limit > 0)) {
        return fail('bad_request',
          'Set a monthly spending limit before allowing paid providers.', 400, request, env);
      }
    }
    const updated = await Store.patchSettings({ routing: clean });
    return ok({ settings: updated }, request, env);
  }

  /* ---------------------------------- chat ------------------------------- */
  if (path === '/chat' && method === 'POST') {
    const { value, error } = await readJson(request, 256 * 1024);
    if (error) return fail(error, error === CODES.too_long ? 'That request is too large.' : 'Request body must be JSON.', error === CODES.too_long ? 413 : 400, request, env);

    const messages = Array.isArray(value?.messages) ? value.messages : [];
    if (!messages.length) return fail('bad_request', 'messages is required.', 400, request, env);

    const limited = chatLimiter(`${clientIp(request)}:chat`);
    if (limited.limited) {
      return fail('rate_limit', 'Too many requests. Give it a few seconds.', 429, request, env,
        { retryAfter: limited.retryAfter });
    }

    const task = String(value?.task || 'chat');
    const tier = String(value?.tier || '');

    return sseResponse(request, env, async ({ send, finish }) => {
      try {
        const result = await Router.complete(env, {
          messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? m.text ?? '') })),
          instructions: String(value?.instructions || '').slice(0, 12_000),
          tier,
          task,
          require: Array.isArray(value?.require) ? value.require : [],
          allowPaid: Boolean(value?.allowPaid),
          preferred: String(value?.preferred || ''),
          maxTokens: Math.min(8192, Math.max(256, Number(value?.maxTokens) || 4096)),
          signal: request.signal,
          onDelta: (delta) => send({ type: 'delta', text: delta }),
        });

        send({ type: 'model', provider: result.provider, providerLabel: result.providerLabel, model: result.model, paid: Boolean(result.paid) });
        if (result.usage) send({ type: 'usage', usage: result.usage });
        send({
          type: 'done',
          provider: result.provider,
          model: result.model,
          paid: Boolean(result.paid),
          attempts: result.attempts || [],
          latencyMs: result.latencyMs || 0,
        });
      } catch (err) {
        const code = err?.code || CODES.unknown;
        send({
          type: 'error',
          code,
          message: String(err?.message || 'The request failed.'),
          blocked: err?.blocked || undefined,
          requiresPaidPermission: Boolean(err?.requiresPaidPermission),
          attempts: err?.attempts || undefined,
        });
      } finally {
        finish();
      }
    });
  }

  if (path === '/chat/buffered' && method === 'POST') {
    const { value, error } = await readJson(request, 256 * 1024);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);
    try {
      const result = await Router.completeBuffered(env, {
        messages: (value?.messages || []).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
        instructions: String(value?.instructions || '').slice(0, 12_000),
        tier: String(value?.tier || ''),
        task: String(value?.task || 'chat'),
        maxTokens: Math.min(8192, Math.max(128, Number(value?.maxTokens) || 1024)),
      });
      return ok({
        text: result.text,
        provider: result.provider,
        providerLabel: result.providerLabel,
        model: result.model,
        paid: Boolean(result.paid),
        usage: result.usage || null,
        attempts: result.attempts || [],
      }, request, env);
    } catch (err) {
      return fail(err?.code || CODES.unknown, String(err?.message || 'The request failed.'),
        (err?.code === CODES.paid_blocked || err?.code === CODES.no_eligible_model) ? 503 : 502,
        request, env, { blocked: err?.blocked, requiresPaidPermission: Boolean(err?.requiresPaidPermission) });
    }
  }

  /* --------------------------------- GitHub ------------------------------ */
  if (path === '/github/status' && method === 'GET') {
    const settings = await Store.getSettings();
    const state = await GitHub.status(env, { session });
    return ok({ ...state, selectedRepo: settings.github?.selectedRepo || '', selectedBranch: settings.github?.selectedBranch || '' }, request, env);
  }

  if (path === '/github/repos' && method === 'GET') {
    try {
      const repos = await GitHub.listRepos(env, { session });
      return ok({ repos, count: repos.length }, request, env);
    } catch (err) {
      return fail(err?.code || 'unknown', String(err?.message || 'GitHub request failed.'), err?.status || 502, request, env);
    }
  }

  if (path === '/github/branches' && method === 'GET') {
    const repo = String(params.get('repo') || '');
    if (!repo) return fail('bad_request', 'repo is required.', 400, request, env);
    try {
      return ok({ branches: await GitHub.listBranches(env, repo, { session }) }, request, env);
    } catch (err) {
      return fail(err?.code || 'unknown', String(err?.message || 'GitHub request failed.'), err?.status || 502, request, env);
    }
  }

  if (path === '/github/tree' && method === 'GET') {
    const repo = String(params.get('repo') || '');
    const branch = String(params.get('branch') || '');
    if (!repo) return fail('bad_request', 'repo is required.', 400, request, env);
    try {
      const tree = await GitHub.listTree(env, repo, branch, { session });
      return ok({ tree, count: tree.length }, request, env);
    } catch (err) {
      return fail(err?.code || 'unknown', String(err?.message || 'GitHub request failed.'), err?.status || 502, request, env);
    }
  }

  if (path === '/github/file' && method === 'GET') {
    const repo = String(params.get('repo') || '');
    const branch = String(params.get('branch') || '');
    const file = String(params.get('path') || '');
    if (!repo || !file) return fail('bad_request', 'repo and path are required.', 400, request, env);
    try {
      return ok(await GitHub.getFile(env, repo, branch, file, { session }), request, env);
    } catch (err) {
      return fail(err?.code || 'unknown', String(err?.message || 'GitHub request failed.'), err?.status || 502, request, env);
    }
  }

  if (path === '/github/select' && method === 'POST') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);
    const repo = String(value?.repo || '').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail('bad_request', 'repo must look like "owner/name".', 400, request, env);

    const settings = await Store.getSettings();
    await Store.patchSettings({ github: { ...settings.github, selectedRepo: repo, selectedBranch: String(value?.branch || settings.github?.selectedBranch || '') } });
    return ok({ selected: repo }, request, env);
  }

  if (path === '/github/key' && method === 'POST') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);
    const token = String(value?.token || '').trim();
    if (!token) return fail('bad_request', 'No token supplied.', 400, request, env);
    if (!/^(ghp_|github_pat_|gho_|ghs_|ghu_)/.test(token) && token.length < 20) {
      return fail('bad_request', 'That does not look like a GitHub token.', 400, request, env);
    }
    await Store.setSecret('github.pat', token);
    const state = await GitHub.status(env, { session });
    return ok({ saved: true, hint: Store.hint(token), status: state }, request, env, state.connected ? 200 : 502);
  }

  if (path === '/github/key' && method === 'DELETE') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    await Store.setSecret('github.pat', '');
    Store.dropSession(String(params.get('session') || ''));
    return ok({ removed: true }, request, env);
  }

  if (path === '/github/oauth/start' && method === 'GET') {
    const start = GitHub.oauthStart(env, request, { state: String(params.get('state') || '') });
    if (!start) {
      return fail('invalid_config', 'GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.', 503, request, env);
    }
    if (params.get('redirect') === '0') return ok({ url: start.url, redirectUri: start.redirectUri }, request, env);
    return new Response(null, {
      status: 302,
      headers: { Location: start.url, ...corsHeaders(request, env) },
    });
  }

  if (path === '/github/oauth/callback' && method === 'GET') {
    const code = String(params.get('code') || '');
    if (!code) return fail('bad_request', 'GitHub did not return an authorisation code.', 400, request, env);
    try {
      const result = await GitHub.oauthCallback(env, request, { code });
      const response = new Response(
        '<!doctype html><meta charset="utf-8"><title>Signed in</title>'
        + '<script>window.close();window.location.replace("./index.html?github=connected");</script>'
        + '<p style="font:15px system-ui;color:#cfe3ff;background:#080b12;min-height:100vh;margin:0;display:grid;place-items:center">'
        + 'Signed in to GitHub. You can close this tab.</p>',
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
      return setSessionCookie(response, result.sessionId, request);
    } catch (err) {
      console.warn('[jarvis] oauth callback failed:', redact(String(err?.message || err)));
      return fail('unauthorized', String(err?.message || 'The GitHub sign-in failed.'), 502, request, env);
    }
  }

  /* ---------------------------------- tasks ------------------------------ */
  if (path === '/tasks' && method === 'GET') {
    const tasks = await Tasks.list();
    return ok({ tasks: tasks.map(Tasks.summarise) }, request, env);
  }

  if (path === '/tasks' && method === 'POST') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);
    try {
      const task = await Tasks.createTask(env, {
        repo: value?.repo, branch: value?.branch, prompt: value?.prompt, autonomy: value?.autonomy, session,
      });
      // Kick the pipeline off without holding the response open. The client
      // polls GET /api/v2/tasks/:id, which survives a server restart because
      // every state transition is persisted.
      void Tasks.advance(env, task.id, { session }).catch((err) => {
        console.error('[jarvis] task failed', task.id, redact(String(err?.message || err)));
      });
      return ok({ task: Tasks.summarise(task) }, request, env, 202);
    } catch (err) {
      return fail(err?.code || CODES.unknown, String(err?.message || 'The task could not be created.'), 400, request, env);
    }
  }

  const taskMatch = path.match(/^\/tasks\/([\w-]+)(?:\/([\w-]+))?$/);
  if (taskMatch) {
    const [, id, action] = taskMatch;

    if (!action && method === 'GET') {
      const task = await Tasks.get(id);
      if (!task) return fail('not_found', 'Task not found.', 404, request, env);
      return ok({ task }, request, env);
    }

    if (!action && method === 'DELETE') {
      const blocked = guard(request, env);
      if (blocked) return blocked;
      await Tasks.remove(id);
      return ok({ removed: true }, request, env);
    }

    if (isWrite) {
      const blocked = guard(request, env);
      if (blocked) return blocked;
    }

    if (action === 'advance' && method === 'POST') {
      const task = await Tasks.advance(env, id, { session });
      return ok({ task }, request, env);
    }
    if (action === 'approve' && method === 'POST') {
      const { value } = await readJson(request);
      try {
        const task = await Tasks.commit(env, id, { session, message: value?.message || '' });
        return ok({ task }, request, env);
      } catch (err) {
        return fail(err?.code || CODES.unknown, String(err?.message || 'The commit failed.'), 502, request, env);
      }
    }
    if (action === 'pr' && method === 'POST') {
      const { value } = await readJson(request);
      try {
        const task = await Tasks.openPullRequest(env, id, { session, title: value?.title || '', body: value?.body || '' });
        return ok({ task, pr: task.result?.pr }, request, env);
      } catch (err) {
        return fail(err?.code || CODES.unknown, String(err?.message || 'The pull request could not be opened.'), 502, request, env);
      }
    }
    if (action === 'cancel' && method === 'POST') {
      const task = await Tasks.cancel(id);
      return ok({ task }, request, env);
    }
    return fail('not_found', 'Unknown task action.', 404, request, env);
  }

  /* --------------------------------- sandbox ----------------------------- */
  if (path === '/sandbox/status' && method === 'GET') {
    return ok(await Runner.sandboxStatus(), request, env);
  }

  if (path === '/sandbox/run' && method === 'POST') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);
    const settings = await Store.getSettings();
    const result = await Runner.run({
      cwd: '',
      command: value?.command,
      args: value?.args || [],
      timeoutMs: Math.min(600_000, Number(value?.timeoutMs) || settings.sandbox?.timeoutMs || 180_000),
      memoryMb: Number(value?.memoryMb) || settings.sandbox?.memoryMb || 512,
      network: String(value?.network || settings.sandbox?.network || 'off'),
      driver: String(value?.driver || settings.sandbox?.driver || 'process'),
      env: value?.env || {},
    });
    return ok(result, request, env, result.refused ? 400 : 200);
  }

  /* ---------------------------------- voice ------------------------------ */
  if (path === '/voice/status' && method === 'GET') {
    return ok(await Tts.status(env), request, env);
  }

  if (path === '/voice/speak' && method === 'POST') {
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);
    const response = await Tts.synthesize(env, request, value || {}, clientIp(request));
    // Re-attach CORS headers to the audio (or error) response.
    const headers = new Headers(response.headers);
    for (const [key, val] of Object.entries(corsHeaders(request, env))) headers.set(key, val);
    return new Response(response.body, { status: response.status, headers });
  }

  if (path === '/voice/key' && method === 'POST') {
    const blocked = guard(request, env);
    if (blocked) return blocked;
    const { value, error } = await readJson(request);
    if (error) return fail(error, 'Request body must be JSON.', 400, request, env);
    const key = String(value?.key || '').trim();
    if (!key) return fail('bad_request', 'No key supplied.', 400, request, env);
    await Store.setSecret('tts.fishAudioKey', key);
    if (value?.referenceId) await Store.patchSettings({ voice: { referenceId: String(value.referenceId) } });
    return ok({ saved: true, hint: Store.hint(key), status: await Tts.status(env) }, request, env);
  }

  return null;                                          // not a v2 route
}

/* -------------------------------- rate limit ------------------------------- */

import { createLimiter } from './lib/http.js';
const chatLimiter = createLimiter({ windowMs: 60_000, max: 30 });
