/* ==========================================================================
   api/v2.js — the JARVIS STUDIO API client.

   One small module for every /api/v2 endpoint. Rules:
     • every failure becomes a TralixError, so the UI has one error vocabulary;
     • nothing here invents data — if the server did not report it, the value
       stays null and the UI says "not reported";
     • streaming aborts the request as soon as the caller stops, which also
       cancels the upstream provider call on the server.
   ========================================================================== */

import { apiUrl } from '../config.js';
import { TralixError, ERROR_CODES, codeFromStatus } from '../errors.js';
import { request, readSse } from './client.js';

const endpoint = (path = '') => apiUrl(`/v2${path.startsWith('/') ? path : `/${path}`}`);

/* --------------------------------- helpers -------------------------------- */

async function get(path, { timeoutMs = 15000, signal } = {}) {
  let res;
  try {
    res = await request(endpoint(path), { method: 'GET', timeoutMs, signal });
  } catch (err) {
    throw err instanceof TralixError ? err : new TralixError(ERROR_CODES.network, { detail: String(err) });
  }
  if (!res.ok) throw await toError(res);
  return res.json().catch(() => ({}));
}

async function send(method, path, body, { timeoutMs = 30000, signal } = {}) {
  let res;
  try {
    res = await request(endpoint(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
      signal,
    });
  } catch (err) {
    throw err instanceof TralixError ? err : new TralixError(ERROR_CODES.network, { detail: String(err) });
  }
  if (!res.ok) throw await toError(res);
  return res.status === 204 ? {} : res.json().catch(() => ({}));
}

async function toError(res) {
  let payload = null;
  try { payload = await res.clone().json(); } catch { /* non-JSON error body */ }
  const code = payload?.error?.code || codeFromStatus(res.status);
  const error = new TralixError(code, {
    status: res.status,
    message: payload?.error?.message || undefined,
    detail: typeof payload?.error === 'string' ? payload.error : '',
  });
  // Extra routing information the UI needs to explain *what* to do next.
  error.blocked = payload?.error?.blocked || null;
  error.requiresPaidPermission = Boolean(payload?.error?.requiresPaidPermission);
  error.attempts = payload?.error?.attempts || null;
  return error;
}

/* ------------------------------- overview ---------------------------------- */

export const health = ({ signal } = {}) => get('/health', { signal, timeoutMs: 12000 });
export const envReport = ({ signal } = {}) => get('/env', { signal });

/* ------------------------------- providers --------------------------------- */

export const providers = ({ force = false, signal } = {}) =>
  get(`/providers${force ? '?force=1' : ''}`, { signal, timeoutMs: 20000 });

export const testProvider = (id, { key = '', baseUrl = '', save = false } = {}, { signal } = {}) =>
  send('POST', '/providers/test', { id, key, baseUrl, save }, { signal, timeoutMs: 25000 });

export const saveProviderKey = (id, key, baseUrl = '', { signal } = {}) =>
  send('POST', '/providers/key', { id, key, baseUrl }, { signal, timeoutMs: 25000 });

export const removeProviderKey = (id, { signal } = {}) =>
  send('DELETE', `/providers/key?id=${encodeURIComponent(id)}`, undefined, { signal });

export const saveProviderConfig = (providersPatch, { signal } = {}) =>
  send('PATCH', '/providers/config', { providers: providersPatch }, { signal });

export const routing = ({ tier = '', task = '', signal } = {}) => {
  const params = new URLSearchParams();
  if (tier) params.set('tier', tier);
  if (task) params.set('task', task);
  const query = params.toString();
  return get(`/routing${query ? `?${query}` : ''}`, { signal, timeoutMs: 20000 });
};

export const saveRouting = (patch, { signal } = {}) => send('PATCH', '/routing', { routing: patch }, { signal });

/* --------------------------------- chat ------------------------------------ */

/**
 * Stream a routed completion.
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {string} [opts.instructions]
 * @param {'chat'|'plan'|'edit'|'review'|'research'} [opts.task]
 * @param {string} [opts.tier]
 * @param {AbortSignal} [opts.signal]
 * @param {(delta:string, full:string)=>void} [opts.onDelta]
 * @param {(info:{provider:string, providerLabel:string, model:string, paid:boolean})=>void} [opts.onModel]
 */
export async function chat({
  messages = [],
  instructions = '',
  task = 'chat',
  tier = '',
  require = [],
  preferred = '',
  allowPaid = false,
  maxTokens = 4096,
  signal,
  onDelta,
  onModel,
  timeoutMs = 120000,
} = {}) {
  const res = await request(endpoint('/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages, instructions, task, tier, require, preferred, allowPaid, maxTokens }),
    timeoutMs,
    signal,
  });

  if (!res.ok) throw await toError(res);

  let full = '';
  let info = null;

  for await (const frame of readSse(res)) {
    if (frame?.type === 'delta') {
      full += frame.text || '';
      onDelta?.(frame.text || '', full);
    } else if (frame?.type === 'model') {
      info = frame;
      onModel?.(frame);
    } else if (frame?.type === 'error') {
      const error = new TralixError(frame.code || ERROR_CODES.unknown, {
        message: frame.message,
        retryable: frame.code !== ERROR_CODES.bad_request,
      });
      error.blocked = frame.blocked || null;
      error.requiresPaidPermission = Boolean(frame.requiresPaidPermission);
      error.attempts = frame.attempts || null;
      throw error;
    } else if (frame?.type === 'done') {
      info = info || frame;
      return { text: full, provider: frame.provider, providerLabel: frame.providerLabel, model: frame.model, paid: Boolean(frame.paid), attempts: frame.attempts || [] };
    }
  }

  return { text: full, provider: info?.provider || '', providerLabel: info?.providerLabel || '', model: info?.model || '', paid: Boolean(info?.paid), attempts: [] };
}

/** Non-streaming completion — used for quick actions and summaries. */
export async function chatBuffered(opts = {}) {
  return send('POST', '/chat/buffered', {
    messages: opts.messages || [],
    instructions: opts.instructions || '',
    task: opts.task || 'chat',
    tier: opts.tier || '',
    maxTokens: opts.maxTokens || 1024,
  }, { signal: opts.signal, timeoutMs: opts.timeoutMs || 60000 });
}

/* -------------------------------- GitHub ----------------------------------- */

export const githubStatus = ({ signal } = {}) => get('/github/status', { signal, timeoutMs: 15000 });
export const repos = ({ signal } = {}) => get('/github/repos', { signal, timeoutMs: 20000 });
export const branches = (repo, { signal } = {}) =>
  get(`/github/branches?repo=${encodeURIComponent(repo)}`, { signal, timeoutMs: 20000 });
export const tree = (repo, branch = '', { signal } = {}) =>
  get(`/github/tree?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`, { signal, timeoutMs: 20000 });
export const file = (repo, branch, path, { signal } = {}) =>
  get(`/github/file?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`, { signal, timeoutMs: 20000 });
export const selectRepo = (repo, branch = '', { signal } = {}) =>
  send('POST', '/github/select', { repo, branch }, { signal });
export const saveGithubToken = (token, { signal } = {}) =>
  send('POST', '/github/key', { token }, { signal, timeoutMs: 20000 });
export const removeGithubToken = ({ signal } = {}) =>
  send('DELETE', '/github/key', undefined, { signal });
export const oauthStartUrl = ({ signal } = {}) =>
  get('/github/oauth/start?redirect=0', { signal, timeoutMs: 10000 });

/* --------------------------------- tasks ----------------------------------- */

export const tasks = ({ signal } = {}) => get('/tasks', { signal });
export const task = (id, { signal } = {}) => get(`/tasks/${encodeURIComponent(id)}`, { signal });
export const createTask = (payload, { signal } = {}) => send('POST', '/tasks', payload, { signal });
export const advanceTask = (id, { signal } = {}) => send('POST', `/tasks/${id}/advance`, {}, { signal, timeoutMs: 180000 });
export const approveTask = (id, message = '', { signal } = {}) =>
  send('POST', `/tasks/${id}/approve`, { message }, { signal, timeoutMs: 60000 });
export const openPullRequest = (id, title = '', body = '', { signal } = {}) =>
  send('POST', `/tasks/${id}/pr`, { title, body }, { signal, timeoutMs: 60000 });
export const cancelTask = (id, { signal } = {}) => send('POST', `/tasks/${id}/cancel`, {}, { signal });
export const deleteTask = (id, { signal } = {}) => send('DELETE', `/tasks/${id}`, undefined, { signal });

/* -------------------------------- sandbox ---------------------------------- */

export const sandboxStatus = ({ force = false, signal } = {}) =>
  get(`/sandbox/status${force ? '?force=1' : ''}`, { signal, timeoutMs: 15000 });
export const runCommand = (payload, { signal } = {}) =>
  send('POST', '/sandbox/run', payload, { signal, timeoutMs: 600000 });

/* --------------------------------- voice ----------------------------------- */

export const voiceStatus = ({ signal } = {}) => get('/voice/status', { signal, timeoutMs: 10000 });
export const saveVoiceKey = (key, referenceId = '', { signal } = {}) =>
  send('POST', '/voice/key', { key, referenceId }, { signal, timeoutMs: 15000 });

/**
 * Speak text through the server-side provider.
 * @returns {Promise<{url:string, revoke:()=>void}>} an object URL for the audio
 */
export async function speak(text, { format = 'mp3', speed = 1, signal } = {}) {
  const res = await request(endpoint('/voice/speak'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, format, speed }),
    timeoutMs: 45000,
    signal,
  });
  if (!res.ok) throw await toError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url), bytes: blob.size };
}

/* -------------------------------- settings --------------------------------- */

export const settings = ({ signal } = {}) => get('/settings', { signal });
export const saveSettings = (patch, { signal } = {}) => send('PATCH', '/settings', patch, { signal, timeoutMs: 20000 });
