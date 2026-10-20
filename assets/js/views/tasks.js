/* ==========================================================================
   views/tasks.js — the coding-task panel.

   Shows the real state of a task: the plan a model produced, the files it
   changed, the diffs, the captured output of the checks that ran, and the
   second-model review when one exists.

   Approval is explicit. The "Commit" button is the only thing that writes to
   GitHub, "Open pull request" prepares a PR, and nothing here merges anything.
   ========================================================================== */

import { $, escapeHtml, relTime } from '../util.js';
import * as Api from '../api/v2.js';
import { renderDiff, diffStatsHtml, toPatchText } from '../diff.js';
import { toast } from '../ui/feedback.js';
import { confirmDialog } from '../ui/feedback.js';
import { TralixError } from '../errors.js';
import { setOrbState } from '../ui/orb.js';

const RUNNING = ['queued', 'analyzing', 'planning', 'editing', 'testing', 'repairing'];
const ORDER = ['queued', 'analyzing', 'planning', 'editing', 'testing', 'repairing', 'awaiting_review', 'completed'];

export function createTaskPanel({ nav, onChanged = () => {} }) {
  const panel = $('#taskPanel');
  const grid = $('.assistant-grid');
  const titleEl = $('#taskTitle');
  const bodyEl = $('#taskBody');

  let currentId = null;
  let current = null;
  let pollTimer = null;
  let busy = false;

  /* -------------------------------- controls ------------------------------ */

  function show() {
    panel.hidden = false;
    grid?.classList.add('has-task');
  }

  function hide() {
    panel.hidden = true;
    grid?.classList.remove('has-task');
    stopPolling();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (!currentId) return stopPolling();
      refresh({ silent: true });
    }, 2500);
  }

  /* -------------------------------- rendering ----------------------------- */

  function renderTimeline(task) {
    const events = task.events || [];
    const latest = events[events.length - 1]?.state;
    const latestIndex = ORDER.indexOf(latest);

    return `<ol class="timeline">${events.map(event => {
      const index = ORDER.indexOf(event.state);
      const done = latestIndex > -1 && index < latestIndex;
      const active = event.state === latest;
      const failed = event.state === 'failed' || event.state === 'cancelled';
      return `<li class="${done ? 'is-done' : ''} ${active && RUNNING.includes(event.state) ? 'is-active' : ''} ${failed ? 'is-failed' : ''}">
        <div class="tl-state">${escapeHtml(labelFor(event.state))}</div>
        ${event.message ? `<div class="tl-msg">${escapeHtml(event.message)} · ${relTime(event.ts)}</div>` : ''}
      </li>`;
    }).join('')}</ol>`;
  }

  function labelFor(state) {
    return {
      queued: 'Queued',
      analyzing: 'Analyzing the repository',
      planning: 'Planning',
      awaiting_plan_review: 'Waiting for plan approval',
      editing: 'Editing files',
      testing: 'Running checks',
      repairing: 'Repairing',
      awaiting_review: 'Waiting for your review',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    }[state] || state;
  }

  function renderPlan(plan) {
    if (!plan) return '';
    return `
      <section>
        <div class="list-label">Plan</div>
        <p style="margin:6px 0 8px;font-size:13.5px;line-height:1.6">${escapeHtml(plan.summary || '')}</p>
        ${(plan.files || []).length ? `<div class="mini-list">${plan.files.map(file => `
          <div class="mini-row">
            <span class="mr-main">
              <span class="mr-title">${escapeHtml(file.path)}</span>
              <span class="mr-sub">${escapeHtml(file.reason || '')}</span>
            </span>
            <span class="badge subtle">${escapeHtml(file.action)}</span>
          </div>`).join('')}</div>` : ''}
        <p class="hint">Produced by ${escapeHtml(plan.providerLabel || plan.provider || 'a model')}${plan.model ? ` · ${escapeHtml(plan.model)}` : ''}</p>
        ${(plan.risks || []).length ? `<div class="list-label" style="margin-top:10px">Risks</div><ul class="setup-list">${plan.risks.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
      </section>`;
  }

  function renderChanges(changes = []) {
    if (!changes.length) return '';
    return `<section>
      <div class="list-label">Changed files (${changes.length})</div>
      ${changes.map((change, index) => `
        <div class="diff-card" data-change="${index}">
          <div class="diff-head">
            <span class="diff-path">${escapeHtml(change.path)}</span>
            ${diffStatsHtml(change.additions, change.deletions)}
            <span class="badge subtle">${escapeHtml(change.mode)}</span>
          </div>
          ${renderDiff(change.diff)}
          <div class="diff-head" style="border-top:1px solid var(--border);border-bottom:0">
            <span class="hint" style="flex:1">${escapeHtml(change.notes || '')}</span>
            <button type="button" class="btn-ghost tiny" data-copy-patch="${index}">Copy patch</button>
            <button type="button" class="btn-ghost tiny" data-view-file="${index}">View new file</button>
          </div>
        </div>`).join('')}
    </section>`;
  }

  function renderChecks(tests) {
    if (!tests) return '';
    if (tests.skipped && !tests.ran) {
      return `<section><div class="list-label">Checks</div><p class="hint">${escapeHtml(tests.note || 'Checks did not run.')}</p></section>`;
    }
    const checks = tests.checks || [];
    return `<section>
      <div class="list-label">Checks ${tests.ran ? '' : '(skipped)'}</div>
      ${checks.map(check => `
        <div class="check-row">
          <div class="check-head">
            <span class="badge ${check.ok ? 'ok' : 'bad'}">${check.ok ? 'passed' : `failed${check.exitCode !== null ? ` (exit ${check.exitCode})` : ''}`}</span>
            <span>${escapeHtml(check.label)}</span>
          </div>
          ${check.refused ? `<p class="hint">${escapeHtml(check.stderr || '')}</p>` : ''}
          ${check.stdout?.trim() ? `<pre class="check-out">${escapeHtml(check.stdout.trim().slice(-4000))}</pre>` : ''}
          ${check.stderr?.trim() ? `<pre class="check-out">${escapeHtml(check.stderr.trim().slice(-4000))}</pre>` : ''}
        </div>`).join('')}
      ${(tests.skipped || []).length ? `<p class="hint">Skipped: ${escapeHtml(tests.skipped.map(s => `${s.label} (${s.reason})`).join('; '))}</p>` : ''}
      ${tests.isolation?.warnings?.length ? `<p class="hint">${escapeHtml(tests.isolation.warnings.join(' '))}</p>` : ''}
    </section>`;
  }

  function renderReview(review) {
    if (!review?.text) return '';
    return `<section>
      <div class="list-label">Second-model review</div>
      <p style="font-size:13px;line-height:1.6;white-space:pre-wrap">${escapeHtml(review.text)}</p>
      <p class="hint">Reviewed by ${escapeHtml(review.providerLabel || review.provider || '')}${review.model ? ` · ${escapeHtml(review.model)}` : ''}</p>
    </section>`;
  }

  function renderActions(task) {
    const buttons = [];
    if (RUNNING.includes(task.state)) {
      buttons.push('<button type="button" class="btn-ghost" data-act="cancel">Cancel task</button>');
    }
    if (task.state === 'awaiting_plan_review') {
      buttons.push('<button type="button" class="btn-primary" data-act="advance">Approve plan and continue</button>');
      buttons.push('<button type="button" class="btn-ghost" data-act="cancel">Cancel task</button>');
    }
    if (task.state === 'awaiting_review' && task.changes?.length) {
      buttons.push('<button type="button" class="btn-primary" data-act="approve">Commit to branch</button>');
      buttons.push('<button type="button" class="btn-ghost" data-act="cancel">Discard</button>');
    }
    if (task.state === 'completed' && task.result?.committed && !task.result?.pr) {
      buttons.push('<button type="button" class="btn-primary" data-act="pr">Open pull request</button>');
    }
    if (task.error) {
      buttons.push('<button type="button" class="btn-ghost" data-act="retry">Run again</button>');
    }
    if (!buttons.length) return '';
    return `<div class="task-actions">${buttons.join('')}</div>`;
  }

  function render(task) {
    current = task;
    titleEl.textContent = String(task.prompt || '').slice(0, 80) || 'Coding task';
    const meta = `
      <div class="pc-meta">
        <span>${escapeHtml(task.repo || '')}</span>
        ${task.branch ? `<span>branch <code>${escapeHtml(task.branch)}</code></span>` : ''}
        ${task.baseBranch ? `<span>from <code>${escapeHtml(task.baseBranch)}</code></span>` : ''}
        ${task.repairAttempts ? `<span>${task.repairAttempts} repair attempt(s)</span>` : ''}
      </div>`;

    let banner = '';
    if (task.error) {
      banner = `<div class="status-line bad">${escapeHtml(task.error.message || 'The task failed.')}</div>`;
    } else if (task.state === 'awaiting_review') {
      banner = `<div class="status-line warn">Nothing has been committed. Review the diff, then commit to the task branch.</div>`;
    } else if (task.state === 'completed' && task.result?.pr) {
      banner = `<div class="status-line ok">Pull request #${escapeHtml(String(task.result.pr.number))} is open. <a href="${escapeHtml(task.result.pr.url)}" target="_blank" rel="noopener noreferrer">Review on GitHub ↗</a></div>`;
    }

    bodyEl.innerHTML = `
      ${banner}
      ${meta}
      ${renderTimeline(task)}
      ${renderPlan(task.plan)}
      ${renderChanges(task.changes)}
      ${renderChecks(task.tests)}
      ${renderReview(task.review)}
      ${renderActions(task)}
    `;

    for (const button of bodyEl.querySelectorAll('[data-act]')) {
      button.addEventListener('click', () => onAction(button.dataset.act));
    }
    for (const button of bodyEl.querySelectorAll('[data-copy-patch]')) {
      button.addEventListener('click', async () => {
        const change = task.changes?.[Number(button.dataset.copyPatch)];
        if (!change) return;
        const { copyText } = await import('../util.js');
        const ok = await copyText(toPatchText(change.path, change.diff));
        toast(ok ? 'Patch copied' : 'Copy failed', { tone: ok ? 'success' : 'error' });
      });
    }
    for (const button of bodyEl.querySelectorAll('[data-view-file]')) {
      button.addEventListener('click', () => {
        const change = task.changes?.[Number(button.dataset.viewFile)];
        if (!change) return;
        const win = window.open('', '_blank');
        if (win) {
          win.document.write(`<pre style="font:12px ui-monospace;padding:16px;background:#05070d;color:#e6edf8">${escapeHtml(change.after || '')}</pre>`);
          win.document.title = change.path;
        }
      });
    }
  }

  /* --------------------------------- actions ------------------------------ */

  async function onAction(action) {
    if (busy || !currentId) return;

    if (action === 'cancel') {
      const ok = await confirmDialog({
        title: 'Discard this task?',
        body: 'No files on GitHub will change. The plan and the diff stay in this panel until you close it.',
        danger: true,
      });
      if (!ok) return;
      await run(() => Api.cancelTask(currentId, {}), 'Task cancelled.');
      return;
    }

    if (action === 'advance') {
      await run(() => Api.advanceTask(currentId, {}), 'Continuing…');
      return;
    }

    if (action === 'approve') {
      const ok = await confirmDialog({
        title: 'Commit these changes?',
        body: `JARVIS will commit ${current?.changes?.length || 0} file(s) to the branch "${current?.branch || ''}" on ${current?.repo || ''}. The default branch is never touched and no pull request is opened yet.`,
        confirmLabel: 'Commit',
      });
      if (!ok) return;
      await run(() => Api.approveTask(currentId, current?.plan?.summary || '', {}), 'Changes committed.');
      return;
    }

    if (action === 'pr') {
      const ok = await confirmDialog({
        title: 'Open a pull request?',
        body: `A pull request will be opened from "${current?.branch || ''}" into "${current?.baseBranch || ''}". JARVIS never merges it — you review and merge on GitHub.`,
        confirmLabel: 'Open pull request',
      });
      if (!ok) return;
      await run(() => Api.openPullRequest(currentId, current?.plan?.summary || '', '', {}), 'Pull request opened.');
      return;
    }

    if (action === 'retry') {
      await run(() => Api.advanceTask(currentId, {}), 'Running again…');
    }
  }

  async function run(request, message) {
    busy = true;
    setOrbState('thinking');
    try {
      const result = await request();
      const task = result?.task || result;
      if (task?.id) render(task);
      if (message) toast(message, { tone: 'success' });
      onChanged?.(task);
      if (task && RUNNING.includes(task.state)) startPolling();
      else stopPolling();
      return task;
    } catch (error) {
      toast(error instanceof TralixError ? error.message : 'The action failed.', { tone: 'error', ms: 4600 });
      return null;
    } finally {
      busy = false;
      setOrbState('idle');
    }
  }

  /* ---------------------------------- API --------------------------------- */

  async function refresh({ silent = false } = {}) {
    if (!currentId) return null;
    try {
      const result = await Api.task(currentId, {});
      const task = result.task;
      render(task);
      onChanged?.(task);
      if (RUNNING.includes(task.state)) {
        if (!silent) setOrbState('thinking');
        startPolling();
      } else {
        stopPolling();
        if (!silent) setOrbState(task.state === 'failed' ? 'error' : 'idle');
        if (task.state === 'awaiting_review' && !silent) {
          toast('JARVIS finished the change — review the diff', { tone: 'success', ms: 3600 });
        }
      }
      return task;
    } catch (error) {
      stopPolling();
      if (!silent) toast(error instanceof TralixError ? error.message : 'The task could not be loaded.', { tone: 'error' });
      return null;
    }
  }

  async function openTask(id) {
    currentId = id;
    show();
    await refresh();
  }

  /**
   * Start a new coding task.
   * @returns {Promise<object|null>} the created task summary
   */
  async function start({ prompt, repo, branch, autonomy }) {
    if (!prompt || prompt.trim().length < 8) {
      toast('Describe the task in a sentence or two.', { tone: 'error' });
      return null;
    }
    if (!repo) {
      toast('Choose a repository in Projects first.', { tone: 'error', ms: 4200 });
      nav?.go('projects');
      return null;
    }

    currentId = null;
    show();
    titleEl.textContent = String(prompt).slice(0, 80);
    bodyEl.innerHTML = '<p class="hint">Queued. JARVIS is reading the repository…</p>';
    setOrbState('thinking');

    try {
      const result = await Api.createTask({ prompt, repo, branch, autonomy }, {});
      currentId = result.task?.id;
      toast('Task queued', { tone: 'success', ms: 2200 });
      startPolling();
      await refresh({ silent: true });
      return result.task;
    } catch (error) {
      stopPolling();
      setOrbState('error');
      bodyEl.innerHTML = `<div class="status-line bad">${escapeHtml(error instanceof TralixError ? error.message : 'The task could not be created.')}</div>`;
      return null;
    }
  }

  $('#btnCloseTask')?.addEventListener('click', hide);

  return {
    start,
    openTask,
    refresh,
    hide,
    show,
    current: () => current,
    currentId: () => currentId,
    isRunning: () => Boolean(current && RUNNING.includes(current.state)),
  };
}

/**
 * Should a message be treated as a coding task rather than a chat message?
 * Deliberately conservative — a false positive sends the user's words to a
 * repository workflow instead of a conversation.
 */
export function looksLikeCodingTask(text = '') {
  const value = String(text || '').toLowerCase();
  if (value.length < 12) return false;
  return /(^|\b)(add|implement|fix|refactor|update|create|write|remove|rename|migrate|convert|extract|replace|patch|bump|optimise|optimize)\b/.test(value);
}
