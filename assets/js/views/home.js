/* ==========================================================================
   views/home.js — the workspace overview.

   Everything on this screen is measured, never assumed:
     • the system cards read /api/v2/health, which probes each provider;
     • "recent tasks" comes from /api/v2/tasks;
     • "recent conversations" comes from local storage.
   If the backend cannot be reached the screen says so and offers a retry —
   it does not fall back to invented numbers.
   ========================================================================== */

import { $, escapeHtml, relTime, greeting } from '../util.js';
import * as Api from '../api/v2.js';
import * as Store from '../store.js';
import { toast } from '../ui/feedback.js';

export function createHomeView({ nav, onOpenTask }) {
  const statGrid = $('#statGrid');
  const setupCard = $('#setupCard');
  const setupList = $('#setupList');
  const recentTasks = $('#recentTasks');
  const recentChats = $('#recentChats');
  const greetingEl = $('#homeGreeting');
  const heroSub = $('#heroSub');
  const orbStateText = $('#orbStateText');

  let snapshot = null;
  let loading = false;

  /* -------------------------------- rendering ----------------------------- */

  function renderStats(health) {
    const p = health?.providers?.providers || [];
    const ready = p.filter(x => x.enabled && x.configured && x.verified);
    const freeReady = ready.filter(x => x.kind !== 'paid');
    const paidReady = ready.filter(x => x.kind === 'paid');
    const policy = health?.providers?.policy || {};
    const usage = health?.providers?.usage || {};
    const sandbox = health?.sandbox || {};
    const github = health?.github || {};
    const voice = health?.voice || {};

    const cards = [
      {
        tone: freeReady.length ? 'ok' : 'warn',
        label: 'Free models',
        value: freeReady.length
          ? `${freeReady.length} ready`
          : 'None configured',
        note: freeReady.length
          ? freeReady.map(x => x.label).join(' · ')
          : 'Add a Gemini, Groq or OpenRouter key to get started — all three publish free tiers.',
        action: { label: 'Configure providers', view: 'models' },
      },
      {
        tone: policy.paidFallback ? 'warn' : 'ok',
        label: 'Paid usage',
        value: policy.paidFallback ? 'Authorised' : 'Blocked by default',
        note: policy.paidFallback
          ? `Ceiling ${policy.monthlyLimitUsd > 0 ? `$${policy.monthlyLimitUsd}/month` : 'not set'} · ${usage.paidRequests || 0} paid request(s) this month`
          : 'JARVIS will not call a paid provider unless you authorise it and set a monthly ceiling.',
        action: { label: 'Cost controls', view: 'models' },
      },
      {
        tone: github.connected ? 'ok' : 'bad',
        label: 'GitHub',
        value: github.connected ? `Connected · ${github.login}` : 'Not connected',
        note: github.connected
          ? `Repositories you can see are listed in Projects.${github.scopes?.length ? ` Scopes: ${github.scopes.join(', ')}.` : ''}`
          : (github.message || 'Set GITHUB_TOKEN on the backend, or add a token in Projects.'),
        action: { label: 'Connect a repository', view: 'projects' },
      },
      {
        tone: sandbox.available ? (sandbox.wrappers?.docker ? 'ok' : 'warn') : 'bad',
        label: 'Execution sandbox',
        value: sandbox.available
          ? (sandbox.wrappers?.docker ? 'Docker available' : 'Process sandbox only')
          : 'Cannot run commands here',
        note: sandbox.available
          ? (sandbox.recommendation || 'Allowlisted commands with timeouts and output caps.')
          : 'This runtime cannot spawn processes. Run the Node backend to enable project checks.',
        action: { label: 'Execution settings', view: 'settings' },
      },
      {
        tone: voice.configured ? 'ok' : 'warn',
        label: 'Voice',
        value: voice.configured ? 'Fish Audio configured' : 'Spoken replies off',
        note: voice.configured
          ? `Model ${voice.model || 's2-pro'}${voice.voiceId ? ' · custom voice' : ''}`
          : 'The microphone works without a key. Spoken replies need a Fish Audio key on the server.',
        action: { label: 'Voice settings', view: 'settings' },
      },
      {
        tone: 'ok',
        label: 'Backend',
        value: health?.storage === 'file' ? 'Connected' : 'Connected (memory store)',
        note: health?.storage === 'file'
          ? 'Settings, task history and keys are stored on the server.'
          : 'This is a serverless runtime: settings live in memory and reset on redeploy.',
        action: null,
      },
    ];

    statGrid.innerHTML = cards.map(card => `
      <div class="stat" data-tone="${card.tone}">
        <span class="stat-label">${escapeHtml(card.label)}</span>
        <span class="stat-value">${escapeHtml(card.value)}</span>
        <span class="stat-note">${escapeHtml(card.note)}</span>
        ${card.action ? `<button type="button" class="link-btn stat-action" data-goto="${card.action.view}">${escapeHtml(card.action.label)} →</button>` : ''}
      </div>
    `).join('');

    for (const button of statGrid.querySelectorAll('[data-goto]')) {
      button.addEventListener('click', () => nav.go(button.dataset.goto));
    }
  }

  function renderSetup(health) {
    const steps = [];
    const providers = health?.providers?.providers || [];
    const freeConfigured = providers.some(p => p.freeTier && p.configured && p.verified);
    const anyConfigured = providers.some(p => p.configured && p.verified);

    if (!anyConfigured) {
      steps.push({ text: 'Add at least one AI provider key (Gemini, Groq and OpenRouter have free tiers).', view: 'models' });
    } else if (!freeConfigured) {
      steps.push({ text: 'Only paid providers are configured. Add a free-tier key, or authorise paid usage with a ceiling.', view: 'models' });
    }
    if (!health?.github?.connected) {
      steps.push({ text: 'Connect GitHub so JARVIS can read repositories and prepare branches.', view: 'projects' });
    }
    if (health?.sandbox && !health.sandbox.available) {
      steps.push({ text: 'Run the Node backend to enable project checks (the serverless runtime cannot execute commands).', view: 'settings' });
    }
    if (!health?.voice?.configured) {
      steps.push({ text: 'Optional: add a Fish Audio key for spoken replies.', view: 'settings' });
    }

    setupCard.hidden = steps.length === 0;
    setupList.innerHTML = steps.map(step => `
      <li>${escapeHtml(step.text)} <button type="button" class="link-btn" data-goto="${step.view}">Open</button></li>
    `).join('');
    for (const button of setupList.querySelectorAll('[data-goto]')) {
      button.addEventListener('click', () => nav.go(button.dataset.goto));
    }
  }

  function renderTasks(tasks = []) {
    if (!tasks.length) {
      recentTasks.innerHTML = '<div class="mini-empty">No coding tasks yet. Describe one in the Assistant and JARVIS will plan it, change the files and show you the diff.</div>';
      return;
    }
    recentTasks.innerHTML = tasks.slice(0, 6).map(task => `
      <button type="button" class="mini-row" data-task="${escapeHtml(task.id)}">
        <span class="mr-main">
          <span class="mr-title">${escapeHtml(task.prompt.slice(0, 72))}</span>
          <span class="mr-sub">${escapeHtml(task.repo || '')}${task.branch ? ` · ${escapeHtml(task.branch)}` : ''}</span>
        </span>
        <span class="mr-side">
          <span class="badge ${badgeTone(task)}">${escapeHtml(task.stateLabel || task.state)}</span>
          <span>${relTime(task.updatedAt)}</span>
        </span>
      </button>
    `).join('');

    for (const button of recentTasks.querySelectorAll('[data-task]')) {
      button.addEventListener('click', () => onOpenTask?.(button.dataset.task));
    }
  }

  function badgeTone(task) {
    if (task.state === 'completed') return 'ok';
    if (task.state === 'failed') return 'bad';
    if (task.state === 'awaiting_review' || task.state === 'awaiting_plan_review') return 'warn';
    return '';
  }

  function renderChats() {
    const chats = Store.loadChats().slice(0, 6);
    if (!chats.length) {
      recentChats.innerHTML = '<div class="mini-empty">No conversations yet.</div>';
      return;
    }
    recentChats.innerHTML = chats.map(chat => `
      <button type="button" class="mini-row" data-chat="${escapeHtml(chat.id)}">
        <span class="mr-main">
          <span class="mr-title">${escapeHtml(chat.title || 'Conversation')}</span>
          <span class="mr-sub">${(chat.messages || []).length} message(s)</span>
        </span>
        <span class="mr-side">${relTime(chat.updatedAt)}</span>
      </button>
    `).join('');
    for (const button of recentChats.querySelectorAll('[data-chat]')) {
      button.addEventListener('click', () => {
        nav.go('assistant');
        window.dispatchEvent(new CustomEvent('jarvis:open-chat', { detail: { id: button.dataset.chat } }));
      });
    }
  }

  function renderHeadline(health) {
    const name = greeting();
    const ready = (health?.providers?.providers || []).filter(p => p.enabled && p.configured && p.verified);
    greetingEl.textContent = health ? `${name} — ${ready.length ? `${ready.length} model${ready.length === 1 ? '' : 's'} ready` : 'setup needed'}` : 'Checking systems…';
    heroSub.textContent = health?.github?.connected
      ? 'Ask JARVIS a question, or describe a coding task and it will work on a branch you can review.'
      : 'Connect GitHub and at least one AI provider, then describe a coding task — JARVIS will analyse the repository, plan the change and show you every diff before anything is committed.';
  }

  function renderError(error) {
    statGrid.innerHTML = `
      <div class="stat" data-tone="bad">
        <span class="stat-label">Backend</span>
        <span class="stat-value">Unreachable</span>
        <span class="stat-note">${escapeHtml(String(error?.message || 'The JARVIS backend did not answer.'))}</span>
        <button type="button" class="link-btn stat-action" data-retry>Retry</button>
      </div>`;
    statGrid.querySelector('[data-retry]')?.addEventListener('click', () => refresh({ force: true }));
    setupCard.hidden = true;
    renderTasks([]);
    renderChats();
    greetingEl.textContent = 'Backend unreachable';
    heroSub.textContent = 'The interface is running, but nothing on this page can be verified without the backend. Start it with: npm run serve';
    if (orbStateText) orbStateText.textContent = 'Offline — backend unreachable';
  }

  /* --------------------------------- data --------------------------------- */

  async function refresh({ force = false } = {}) {
    if (loading) return null;
    loading = true;
    try {
      const health = await Api.health({});
      snapshot = health;
      renderHeadline(health);
      renderStats(health);
      renderSetup(health);
      if (orbStateText) orbStateText.textContent = 'Idle — JARVIS is ready';
      return health;
    } catch (error) {
      snapshot = null;
      renderError(error);
      return null;
    } finally {
      loading = false;
    }
  }

  async function refreshTasks() {
    try {
      const data = await Api.tasks({});
      renderTasks(data.tasks || []);
    } catch {
      // The overview already reports the backend state; no need to shout twice.
      recentTasks.innerHTML = '<div class="mini-empty">Task history is unavailable while the backend is unreachable.</div>';
    }
  }

  /* --------------------------------- wiring ------------------------------- */

  $('#btnHomeTask')?.addEventListener('click', () => {
    nav.go('assistant');
    window.dispatchEvent(new CustomEvent('jarvis:focus-task'));
  });
  $('#btnHomeRepos')?.addEventListener('click', () => nav.go('projects'));
  $('#btnHomeModels')?.addEventListener('click', () => nav.go('models'));
  $('#btnAllTasks')?.addEventListener('click', () => nav.go('projects'));

  return {
    refresh: async () => {
      await refresh();
      await refreshTasks();
      renderChats();
    },
    refreshTasks,
    get snapshot() { return snapshot; },
  };
}
