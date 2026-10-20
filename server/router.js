/* ==========================================================================
   server/router.js — provider-independent, Free-first model routing.

   The core product rule: JARVIS never silently spends money.

     free-first (default)
       1. consider only providers the deployment has authorised for free use
          (vendors that publish a free tier, and local providers),
       2. order them by the user's priority, then by capability fit,
       3. skip any provider that recently failed with a rate limit / quota /
          auth error until its cooldown expires,
       4. if every free option is exhausted, STOP and report
          `no_eligible_model` — the caller decides what to tell the user.

     paid usage is only possible when the deployment explicitly enables
     `routing.paidFallback` (or JARVIS_PAID_FALLBACK=true) and the monthly
     limit has not been reached. That is a hard gate, not a warning.

   Quota honesty: we never invent a balance. If a provider reports usage we
   record the tokens; if it publishes prices (OpenRouter does) we convert them
   to money; otherwise the ledger shows requests and tokens only.
   ========================================================================== */

import { CATALOG, byId, TIERS } from './providers/index.js';
import * as Store from './store.js';
import { CODES } from './lib/http.js';

/* ------------------------------ configuration ----------------------------- */

/** Resolve the runtime config for one provider: env wins over stored keys. */
export async function providerConfig(env, settings, id) {
  const meta = byId(id);
  if (!meta) return null;
  const stored = (settings.providers || {})[id] || {};
  const secrets = await Store.getSecrets();

  const envKey = meta.envKey ? String(env[meta.envKey] || '') : '';
  const envBase = meta.envBaseKey ? String(env[meta.envBaseKey] || '') : '';
  const storedKey = meta.envKey ? String(secrets[`provider.${id}`] || '') : '';

  const key = envKey || storedKey;
  const baseUrl = String(stored.baseUrl || envBase || meta.defaultBaseUrl || '');

  const enabled = stored.enabled === undefined ? Boolean(key) || !meta.requiresKey : Boolean(stored.enabled);
  const priority = Number.isFinite(stored.priority) ? Number(stored.priority) : meta.priority;

  return {
    id,
    key,
    baseUrl,
    enabled: enabled && (meta.requiresKey ? Boolean(key) : true),
    priority,
    paidAllowed: Boolean(stored.paidAllowed),
    keySource: envKey ? 'environment' : storedKey ? 'server store' : '',
    meta,
  };
}

export async function policy(env, settings = null) {
  const s = settings || await Store.getSettings();
  const envPaid = String(env.JARVIS_PAID_FALLBACK || '').toLowerCase() === 'true';
  const envLimit = Number(env.JARVIS_MONTHLY_LIMIT_USD || 0);
  const monthlyLimitUsd = envLimit > 0 ? envLimit : Number(s.routing?.monthlyLimitUsd || 0);
  return {
    mode: s.routing?.mode || 'free-first',
    paidFallback: Boolean(envPaid || s.routing?.paidFallback),
    monthlyLimitUsd,
    limitSource: envLimit > 0 ? 'environment' : 'settings',
    preferProvider: s.routing?.preferProvider || '',
    reviewWithSecondModel: s.routing?.reviewWithSecondModel !== false,
    allowParallelModels: Boolean(s.routing?.allowParallelModels),
  };
}

/* --------------------------------- probing -------------------------------- */

const PROBE_TTL_MS = 45_000;
const probeCache = new Map();
const cooldowns = new Map();               // id → { until, reason, code }
const pricingCache = new Map();            // provider → { modelId: {prompt, completion} }

export function cooldownState(id) {
  const entry = cooldowns.get(id);
  if (!entry) return null;
  if (entry.until <= Date.now()) { cooldowns.delete(id); return null; }
  return { reason: entry.reason, code: entry.code, secondsLeft: Math.ceil((entry.until - Date.now()) / 1000) };
}

function coolDown(id, code, seconds) {
  cooldowns.set(id, { until: Date.now() + seconds * 1000, code, reason: code });
}

const COOLDOWN_SECONDS = {
  rate_limit: 45,
  quota_exceeded: 600,
  unauthorized: 900,
  invalid_config: 900,
  network: 20,
  timeout: 30,
  provider_unavailable: 45,
  unknown: 30,
};

export function clearCooldown(id) { cooldowns.delete(id); }

/** Probe one provider. Cached for 45s; ?force=1 / force:true re-checks. */
export async function probeProvider(env, id, { force = false, signal } = {}) {
  const settings = await Store.getSettings();
  const config = await providerConfig(env, settings, id);
  if (!config) return { id, error: 'unknown provider' };

  // The cache key includes the credential and base URL: changing a key must
  // never keep serving a "verified" result that belonged to the old one.
  const cacheKey = `${id}|${Store.hint(config.key)}|${config.baseUrl}|${config.enabled}|${config.priority}`;
  const cached = probeCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.value;

  if (config.meta.requiresKey && !config.key) {
    const value = {
      id,
      label: config.meta.label,
      kind: config.meta.kind,
      freeTier: config.meta.freeTier,
      configured: false,
      enabled: Boolean(config.enabled),
      verified: false,
      status: 'unconfigured',
      models: [],
      modelStatus: {},
      message: `No API key found. Set ${config.meta.envKey} on the server, or add one in Settings → AI Models.`,
      checkedAt: new Date().toISOString(),
      envKey: config.meta.envKey,
      priority: config.priority,
      capabilities: config.meta.capabilities,
      note: config.meta.note,
      docsUrl: config.meta.docsUrl,
    };
    probeCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  if (!config.enabled) {
    const value = {
      id,
      label: config.meta.label,
      kind: config.meta.kind,
      freeTier: config.meta.freeTier,
      configured: Boolean(config.key) || !config.meta.requiresKey,
      enabled: false,
      verified: false,
      status: 'disabled',
      models: [],
      modelStatus: {},
      message: 'Disabled in Settings → AI Models.',
      checkedAt: new Date().toISOString(),
      keySource: config.keySource,
      priority: config.priority,
      capabilities: config.meta.capabilities,
      note: config.meta.note,
      docsUrl: config.meta.docsUrl,
    };
    probeCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  const started = Date.now();
  let result;
  try {
    result = await config.meta.probe({
      key: config.key,
      baseUrl: config.baseUrl,
      signal,
    });
  } catch (err) {
    result = { status: 'unreachable', verified: false, models: [], message: String(err?.message || err) };
  }

  // OpenRouter publishes prices: remember them so we can report real money.
  if (id === 'openrouter' && result.verified) {
    try {
      const res = await fetch(`${String(config.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${config.key}` },
      });
      if (res.ok) {
        const data = await res.json();
        const table = {};
        for (const m of data?.data || []) {
          if (!m?.id) continue;
          table[m.id] = {
            prompt: Number(m.pricing?.prompt || 0),
            completion: Number(m.pricing?.completion || 0),
          };
        }
        pricingCache.set('openrouter', table);
      }
    } catch { /* pricing is optional — the ledger simply shows no money */ }
  }

  let resolvedModels = { ...config.meta.models };
  if (config.meta.discover && result.verified) {
    try {
      const discovered = await config.meta.discover({ key: config.key, baseUrl: config.baseUrl });
      for (const tier of TIERS) if (discovered[tier]) resolvedModels[tier] = discovered[tier];
    } catch { /* keep defaults */ }
  }

  const modelStatus = {};
  for (const tier of TIERS) {
    const model = resolvedModels[tier];
    if (!model) { modelStatus[tier] = { model: '', verified: false, reason: 'no model configured' }; continue; }
    const known = (result.models || []).length;
    const exact = known ? result.models.includes(model) : false;
    const prefix = known ? result.models.some(m => m.startsWith(`${model}-`)) : false;
    modelStatus[tier] = {
      model,
      verified: result.verified && (exact || prefix),
      known: known > 0,
    };
  }

  const value = {
    id,
    label: config.meta.label,
    kind: config.meta.kind,
    freeTier: config.meta.freeTier,
    protocol: config.meta.protocol,
    configured: Boolean(config.key) || !config.meta.requiresKey,
    enabled: true,
    verified: Boolean(result.verified),
    status: result.status || 'unknown',
    httpStatus: result.httpStatus || 0,
    latencyMs: typeof result.latencyMs === 'number' ? result.latencyMs : Date.now() - started,
    modelCount: (result.models || []).length,
    models: resolvedModels,
    modelStatus,
    baseUrl: config.baseUrl,
    keySource: config.keySource || (config.meta.requiresKey ? '' : 'none'),
    message: result.message || '',
    checkedAt: new Date().toISOString(),
    priority: config.priority,
    paidAllowed: config.paidAllowed,
    capabilities: config.meta.capabilities,
    note: config.meta.note,
    docsUrl: config.meta.docsUrl,
    cooldown: cooldownState(id),
  };

  probeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export function invalidateProbes() { probeCache.clear(); }

export async function listProviders(env, { force = false } = {}) {
  const settings = await Store.getSettings();
  const states = await Promise.all(CATALOG.map(p => probeProvider(env, p.id, { force })));
  const ordered = [...states].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  const p = await policy(env, settings);
  const usage = await Store.getUsage();
  return { policy: p, usage, providers: ordered, checkedAt: new Date().toISOString() };
}

/* ------------------------------- selection -------------------------------- */

/**
 * Which tier does a task need? Keeping this in one place means a new task type
 * gets sensible routing without touching the callers.
 */
export function tierForTask(task = 'chat') {
  switch (task) {
    case 'plan': return 'smart';
    case 'review': return 'smart';
    case 'edit':
    case 'patch': return 'code';
    case 'repair': return 'code';
    case 'summarise': return 'fast';
    case 'research': return 'research';
    default: return 'smart';
  }
}

/**
 * Eligible providers in preference order.
 * @returns {Promise<{candidates:Array, blocked:Array, policy:object}>}
 */
export async function candidates(env, {
  tier = 'smart',
  task = 'chat',
  require = [],
  allowPaid = false,
  exclude = [],
  preferred = '',
} = {}) {
  const settings = await Store.getSettings();
  const p = await policy(env, settings);
  const resolvedTier = TIERS.includes(tier) ? tier : tierForTask(task);

  const states = [];
  for (const meta of CATALOG) {
    if (exclude.includes(meta.id)) continue;
    states.push(await probeProvider(env, meta.id));
  }

  const blocked = [];
  const eligible = [];

  for (const state of states) {
    // Cooldowns live outside the cached probe, so read them fresh.
    const cooldown = cooldownState(state.id);
    const usable = state.enabled && state.configured && state.verified && !cooldown;
    const model = state.models?.[resolvedTier];
    const capsOk = require.every(cap => state.capabilities?.[cap]);

    const reasons = [];
    if (!state.enabled) reasons.push('disabled');
    if (!state.configured) reasons.push('no key configured');
    else if (!state.verified) reasons.push(`not verified (${state.status})`);
    if (cooldown) reasons.push(`cooling down (${cooldown.code}, ${cooldown.secondsLeft}s)`);
    if (!model) reasons.push('no model for this task');
    if (!capsOk) reasons.push(`missing capability: ${require.filter(c => !state.capabilities?.[c]).join(', ')}`);

    const isPaidUse = state.kind === 'paid' || (!state.freeTier && !state.paidAllowed);
    if (isPaidUse) {
      const allowed = allowPaid || (p.paidFallback && (p.mode !== 'free-only'));
      const overLimit = p.monthlyLimitUsd > 0 && (Number(useUsage(env).estimatedUsd) || 0) >= p.monthlyLimitUsd;
      if (!allowed) reasons.push('paid usage not authorised');
      else if (overLimit) reasons.push(`monthly limit of $${p.monthlyLimitUsd} reached`);
      else if (!state.paidAllowed && p.paidFallback && state.freeTier) {
        // free-tier vendor, paid plan: allowed only if the user opted in for it
        reasons.push('paid usage not authorised for this provider');
      }
    }

    const entry = { ...state, cooldown, model, tier: resolvedTier, isPaidUse, reasons };
    if (usable && model && capsOk && reasons.length === 0) eligible.push(entry);
    else if (state.configured) blocked.push(entry);
  }

  const rank = (entry) => {
    // 1. free before paid (free-first), 2. explicit favourite, 3. user priority
    const freeScore = entry.isPaidUse ? 100 : 0;
    const preferScore = preferred === entry.id || p.preferProvider === entry.id ? -50 : 0;
    return freeScore + preferScore + (entry.priority ?? 999);
  };

  eligible.sort((a, b) => rank(a) - rank(b));
  return { candidates: eligible, blocked, policy: p, tier: resolvedTier };
}

// Tiny helper so the limit check reads clearly without async gymnastics.
let usageSnapshot = { estimatedUsd: 0 };
Store.getUsage().then(u => { usageSnapshot = u; }).catch(() => {});
function useUsage() { return usageSnapshot; }
export async function refreshUsageSnapshot() {
  usageSnapshot = await Store.getUsage();
  return usageSnapshot;
}

/* -------------------------------- completion ------------------------------ */

/**
 * Run one completion with failover. Returns the result plus the honest list of
 * attempts, so the UI can say "Gemini was rate limited, used Groq instead".
 */
export async function complete(env, {
  messages = [],
  instructions = '',
  tier = 'smart',
  task = 'chat',
  require = [],
  allowPaid = false,
  exclude = [],
  preferred = '',
  maxTokens = 4096,
  temperature,
  jsonMode = false,
  signal,
  onDelta,
  timeoutMs = 120_000,
} = {}) {
  await refreshUsageSnapshot();
  const { candidates: list, blocked, policy: p } = await candidates(env, {
    tier, task, require, allowPaid, exclude, preferred,
  });

  if (!list.length) {
    const paidWaiting = blocked.filter(b => b.reasons.includes('paid usage not authorised'));
    const err = new Error(
      paidWaiting.length
        ? 'No free model is available right now. Paid providers are configured but you have not authorised paid usage.'
        : 'No eligible model is available. Configure at least one provider in Settings → AI Models.',
    );
    err.code = paidWaiting.length ? CODES.paid_blocked : CODES.no_eligible_model;
    err.blocked = blocked.map(b => ({ id: b.id, label: b.label, reasons: b.reasons }));
    err.requiresPaidPermission = paidWaiting.length > 0;
    throw err;
  }

  const attempts = [];
  for (const candidate of list) {
    const started = Date.now();
    try {
      const adapter = byId(candidate.id);
      const result = await adapter.streamChat({
        key: (await providerConfig(env, await Store.getSettings(), candidate.id)).key,
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        messages,
        instructions,
        maxTokens,
        temperature,
        signal,
        timeoutMs,
        onDelta,
      });

      const usd = estimateUsd(candidate, result.usage);
      await Store.recordUsage({
        provider: candidate.id,
        model: result.model || candidate.model,
        kind: candidate.isPaidUse ? 'paid' : 'free',
        usage: result.usage,
        usd,
        ok: true,
      });
      await refreshUsageSnapshot();

      return {
        ...result,
        provider: candidate.id,
        providerLabel: candidate.label,
        paid: candidate.isPaidUse,
        attempts,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const code = err?.code || CODES.unknown;
      if (code === CODES.aborted) throw err;
      coolDown(candidate.id, code, COOLDOWN_SECONDS[code] || 30);
      attempts.push({
        provider: candidate.id,
        label: candidate.label,
        model: candidate.model,
        code,
        message: String(err?.message || 'The provider failed.'),
        ms: Date.now() - started,
      });
      await Store.recordUsage({
        provider: candidate.id,
        model: candidate.model,
        kind: candidate.isPaidUse ? 'paid' : 'free',
        ok: false,
      }).catch(() => {});
      await refreshUsageSnapshot();
    }
  }

  const err = new Error(attempts.length
    ? `Every eligible model failed. Last problem: ${attempts.at(-1).message}`
    : 'No eligible model is available.');
  err.code = CODES.no_eligible_model;
  err.attempts = attempts;
  throw err;
}

/** Buffered completion — used for planning, review and repair steps. */
export async function completeBuffered(env, opts = {}) {
  const result = await complete(env, { ...opts, onDelta: null, jsonMode: opts.jsonMode ?? true });
  return result;
}

/**
 * Money is reported only when the provider published a price. No price table,
 * no number — we never estimate a cost we cannot substantiate.
 */
export function estimateUsd(candidate, usage) {
  if (!usage) return null;
  const table = pricingCache.get(candidate?.id);
  if (!table) return null;
  const price = table[candidate.model] || table[usage.model] || null;
  if (!price) return null;
  const input = Number(usage.inputTokens || 0) / 1_000_000;
  const output = Number(usage.outputTokens || 0) / 1_000_000;
  return Number(((input * price.prompt) + (output * price.completion)).toFixed(6));
}

/* ------------------------------ collaboration ----------------------------- */

/**
 * Run a second model over the first model's output when the deployment allows
 * it and a *different* eligible provider exists. This is the "one model plans,
 * another reviews" path; it is skipped when it would cost money or when no
 * second free provider is available.
 */
export async function reviewWithSecondModel(env, {
  primaryProvider, output, instructions, task = 'review', signal,
} = {}) {
  const settings = await Store.getSettings();
  const p = await policy(env, settings);
  if (!p.reviewWithSecondModel) return null;

  const { candidates: list } = await candidates(env, {
    tier: 'smart', task, require: ['chat'], allowPaid: p.paidFallback, exclude: [primaryProvider],
  });
  if (!list.length) return null;

  const candidate = list[0];
  if (candidate.isPaidUse && !p.paidFallback) return null;

  try {
    const config = await providerConfig(env, settings, candidate.id);
    const adapter = byId(candidate.id);
    const result = await adapter.chat({
      key: config.key,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      messages: [{ role: 'user', content: output }],
      instructions,
      maxTokens: 2048,
      signal,
    });
    await Store.recordUsage({
      provider: candidate.id,
      model: result.model || candidate.model,
      kind: candidate.isPaidUse ? 'paid' : 'free',
      usage: result.usage,
      usd: estimateUsd(candidate, result.usage),
      ok: true,
    });
    return { provider: candidate.id, providerLabel: candidate.label, model: result.model, text: result.text };
  } catch (err) {
    coolDown(candidate.id, err?.code || CODES.unknown, 30);
    return { provider: candidate.id, error: String(err?.message || err) };
  }
}
