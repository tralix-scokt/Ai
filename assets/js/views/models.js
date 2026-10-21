/* ==========================================================================
   views/models.js — providers, Free-first routing and cost controls.

   Everything shown here is reported by the server, which probes each provider
   with a real request. A provider is only ever shown as working after it has
   answered; keys are displayed as four-character hints.
   ========================================================================== */

import { $, escapeHtml } from '../util.js';
import * as Api from '../api/v2.js';
import { toast } from '../ui/feedback.js';
import { TralixError } from '../errors.js';

const KIND_LABEL = {
  free: 'Free tier',
  paid: 'Paid',
  local: 'Local',
};

export function createModelsView({ nav }) {
  const gridEl = $('#providerGrid');
  const badgeEl = $('#providersBadge');
  const modeEl = $('#routingMode');
  const paidEl = $('#paidFallback');
  const limitEl = $('#monthlyLimit');
  const statusEl = $('#routingStatus');
  const usageTable = $('#usageTable');
  const usagePeriod = $('#usagePeriod');
  const eligibleEl = $('#eligibleList');
  const blockedEl = $('#blockedList');

  let data = null;
  let busy = false;

  /* ------------------------------- rendering ------------------------------ */

  function renderProviders(report) {
    const list = report?.providers || [];
    const ready = list.filter(p => p.enabled && p.configured && p.verified);
    badgeEl.textContent = `${ready.length} of ${list.length} ready`;
    badgeEl.className = `badge ${ready.length ? 'ok' : 'warn'}`;

    gridEl.innerHTML = list.map(provider => card(provider)).join('');

    for (const button of gridEl.querySelectorAll('[data-action]')) {
      button.addEventListener('click', () => onCardAction(button));
    }
    for (const input of gridEl.querySelectorAll('[data-toggle]')) {
      input.addEventListener('change', () => onToggle(input));
    }
    for (const input of gridEl.querySelectorAll('[data-priority]')) {
      input.addEventListener('change', () => onPriority(input));
    }
  }

  function card(provider) {
    const ready = provider.enabled && provider.configured && provider.verified;
    const tone = ready ? 'ok' : provider.configured ? 'warn' : '';
    const status = ready
      ? `Verified ${provider.checkedAt ? `· ${new Date(provider.checkedAt).toLocaleTimeString()}` : ''}${provider.latencyMs ? ` · ${provider.latencyMs}ms` : ''}`
      : provider.message || 'Not configured';

    return `
      <article class="provider-card ${ready ? 'is-ready' : 'is-off'}">
        <div class="pc-head">
          <div>
            <div class="pc-name">${escapeHtml(provider.label)}</div>
            <div class="pc-kind">${escapeHtml(KIND_LABEL[provider.kind] || provider.kind)} · ${escapeHtml(provider.protocol || '')}</div>
          </div>
          <div class="pc-badges">
            <span class="badge ${tone}">${ready ? 'Ready' : provider.configured ? 'Not verified' : 'No key'}</span>
            ${provider.freeTier ? '<span class="badge ok">Free tier</span>' : ''}
            ${provider.cooldown ? `<span class="badge warn">Cooldown ${provider.cooldown.secondsLeft}s</span>` : ''}
          </div>
        </div>

        <p class="pc-status">${escapeHtml(status)}</p>

        <div class="pc-meta">
          <span>Key: ${escapeHtml(provider.keySource ? `${provider.keySource}${provider.keyHint ? ` (${provider.keyHint})` : ''}` : 'none')}</span>
          <span>Priority ${escapeHtml(String(provider.priority ?? '—'))}</span>
          ${provider.modelCount ? `<span>${provider.modelCount} models available</span>` : ''}
        </div>

        <div class="pc-meta">
          ${Object.entries(provider.models || {}).map(([tier, model]) => {
            const state = provider.modelStatus?.[tier] || {};
            return model ? `<span>${escapeHtml(tier)}: ${escapeHtml(model)}${state.verified ? ' ✓' : ''}</span>` : '';
          }).join('')}
        </div>

        <div class="pc-actions">
          <label class="toggle-row compact" style="border:0;padding:0">
            <span><small>Enabled</small></span>
            <input type="checkbox" class="switch" role="switch" data-toggle="${escapeHtml(provider.id)}" ${provider.enabled ? 'checked' : ''}>
          </label>
          <button type="button" class="btn-ghost" data-action="test" data-id="${escapeHtml(provider.id)}">Test connection</button>
          ${provider.envKey ? `<button type="button" class="btn-ghost" data-action="key" data-id="${escapeHtml(provider.id)}">${provider.configured ? 'Replace key' : 'Add key'}</button>` : ''}
          <a class="btn-ghost" href="${escapeHtml(provider.docsUrl || '')}" target="_blank" rel="noopener noreferrer">Docs ↗</a>
        </div>

        <details class="pc-details">
          <summary>Priority and notes</summary>
          <label class="field compact">
            <span>Priority (lower is used first)</span>
            <input type="number" min="1" max="999" step="1" data-priority="${escapeHtml(provider.id)}" value="${escapeHtml(String(provider.priority ?? 99))}">
          </label>
          <p class="hint">${escapeHtml(provider.note || '')}</p>
          ${provider.envKey ? `<p class="hint">Environment variable: <code>${escapeHtml(provider.envKey)}</code></p>` : ''}
        </details>
      </article>`;
  }

  function renderPolicy(report) {
    const policy = report?.policy || {};
    modeEl.value = policy.mode || 'free-first';
    paidEl.checked = Boolean(policy.paidFallback);
    limitEl.value = policy.monthlyLimitUsd || '';
    note(statusEl, policy.paidFallback
      ? 'Paid fallback is ON. Free models are still tried first; a paid provider is only used when no free model is eligible.'
      : 'Paid fallback is OFF. JARVIS will stop with a clear message instead of spending money.', policy.paidFallback ? 'warn' : 'ok');
  }

  function renderUsage(report) {
    const usage = report?.usage || {};
    usagePeriod.textContent = usage.period || '';
    const entries = Object.entries(usage.providers || {});
    if (!entries.length) {
      usageTable.innerHTML = '<div class="mini-empty">Nothing used yet this month.</div>';
      return;
    }
    const rows = entries.map(([id, entry]) => `
      <div class="usage-row">
        <span>${escapeHtml(id)}</span>
        <span class="num">${entry.requests} req</span>
        <span class="num">${entry.inputTokens || 0} in</span>
        <span class="num">${entry.outputTokens || 0} out</span>
        <span class="num">${entry.estimatedUsd ? `$${entry.estimatedUsd.toFixed(4)}` : 'not priced'}</span>
      </div>
    `).join('');
    usageTable.innerHTML = `
      <div class="usage-row head">
        <span>Provider</span><span>Requests</span><span>Input</span><span>Output</span><span>Cost</span>
      </div>
      ${rows}
      <p class="hint">Paid requests this month: ${usage.paidRequests || 0} · reported spend: ${usage.estimatedUsd ? `$${usage.estimatedUsd.toFixed(4)}` : '$0 (no provider published a price)'}</p>`;
  }

  function renderRouting(routing) {
    const eligible = routing?.eligible || [];
    const blocked = routing?.blocked || [];
    eligibleEl.innerHTML = eligible.length
      ? eligible.map(item => `
        <div class="mini-row">
          <span class="mr-main">
            <span class="mr-title">${escapeHtml(item.label)}</span>
            <span class="mr-sub">${escapeHtml(item.model || '')}${item.paid ? ' · paid' : ' · free tier'}</span>
          </span>
          <span class="badge ok">Eligible</span>
        </div>`).join('')
      : '<div class="mini-empty">No eligible model right now. Add or enable a provider.</div>';

    blockedEl.innerHTML = blocked.length
      ? blocked.map(item => `
        <div class="mini-row">
          <span class="mr-main">
            <span class="mr-title">${escapeHtml(item.label)}</span>
            <span class="mr-sub">${escapeHtml((item.reasons || []).join(' · '))}</span>
          </span>
          <span class="badge warn">Blocked</span>
        </div>`).join('')
      : '<div class="mini-empty">Nothing is blocked.</div>';
  }

  function note(el, text, tone = '') {
    if (!el) return;
    el.textContent = text;
    el.className = `status-line ${tone}`;
  }

  /* -------------------------------- actions ------------------------------- */

  async function onCardAction(button) {
    const id = button.dataset.id;
    const action = button.dataset.action;

    if (action === 'test') {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'Testing…';
      try {
        const result = await Api.testProvider(id, {}, {});
        toast(result.verified ? `${result.label} responded` : `${result.label}: ${result.message || 'not verified'}`,
          { tone: result.verified ? 'success' : 'error', ms: 4200 });
        await refresh({ force: true });
      } catch (error) {
        toast(error instanceof TralixError ? error.message : 'The test failed', { tone: 'error', ms: 4600 });
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
      return;
    }

    if (action === 'key') {
      const value = window.prompt(`Paste your ${id} API key. It is sent to your own backend once and stored there — never in the browser.`);
      if (!value) return;
      button.disabled = true;
      try {
        const result = await Api.saveProviderKey(id, value.trim(), {}, {});
        toast(result.state?.verified ? 'Key saved and verified' : 'Key saved, but the provider did not verify it',
          { tone: result.state?.verified ? 'success' : 'warn', ms: 4600 });
        await refresh({ force: true });
      } catch (error) {
        toast(error instanceof TralixError ? error.message : 'The key could not be saved', { tone: 'error', ms: 4600 });
      } finally {
        button.disabled = false;
      }
    }
  }

  async function onToggle(input) {
    const id = input.dataset.toggle;
    try {
      await Api.saveProviderConfig({ [id]: { enabled: input.checked } }, {});
      await refresh({ force: true });
    } catch (error) {
      input.checked = !input.checked;
      toast(error instanceof TralixError ? error.message : 'The change was not saved', { tone: 'error' });
    }
  }

  async function onPriority(input) {
    const id = input.dataset.priority;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    try {
      await Api.saveProviderConfig({ [id]: { priority: value } }, {});
      await refresh({ force: true });
    } catch (error) {
      toast(error instanceof TralixError ? error.message : 'The priority was not saved', { tone: 'error' });
    }
  }

  async function savePolicy() {
    if (busy) return;
    const patch = { mode: modeEl.value, paidFallback: paidEl.checked };
    if (limitEl.value !== '') patch.monthlyLimitUsd = Number(limitEl.value);

    if (patch.paidFallback && !(Number(patch.monthlyLimitUsd) > 0)) {
      note(statusEl, 'Set a monthly ceiling before allowing paid usage — the server refuses otherwise.', 'bad');
      limitEl.focus();
      return;
    }

    busy = true;
    try {
      await Api.saveRouting(patch, {});
      note(statusEl, 'Routing policy saved.', 'ok');
      await refresh({ force: true });
    } catch (error) {
      note(statusEl, error instanceof TralixError ? error.message : 'The policy could not be saved.', 'bad');
    } finally {
      busy = false;
    }
  }

  /* --------------------------------- wiring ------------------------------- */

  modeEl?.addEventListener('change', savePolicy);
  paidEl?.addEventListener('change', savePolicy);
  limitEl?.addEventListener('change', savePolicy);
  $('#btnRefreshModels')?.addEventListener('click', () => refresh({ force: true }));

  async function refresh({ force = false } = {}) {
    try {
      const [providerReport, routingReport] = await Promise.all([
        Api.providers({ force }),
        Api.routing({}),
      ]);
      data = providerReport;
      renderProviders(providerReport);
      renderPolicy(providerReport);
      renderUsage(providerReport);
      renderRouting(routingReport);
      return providerReport;
    } catch (error) {
      gridEl.innerHTML = `<div class="mini-empty">${escapeHtml(String(error?.message || 'The backend could not be reached.'))}</div>`;
      note(statusEl, 'The provider list could not be loaded.', 'bad');
      return null;
    }
  }

  window.addEventListener('jarvis:refresh-models', () => refresh({ force: true }));

  return { refresh, get data() { return data; } };
}
