/* ==========================================================================
   views/projects.js — repositories, branches, files and task history.

   Only repositories the server's GitHub credential can actually see are
   listed: the list comes from GET /user/repos on the backend. Selecting a
   repository and branch is what a coding task works against.
   ========================================================================== */

import { $, escapeHtml, relTime, formatBytes } from '../util.js';
import * as Api from '../api/v2.js';
import { highlight } from '../highlight.js';
import { toast } from '../ui/feedback.js';
import { openSheet } from '../ui/sheets.js';
import { TralixError } from '../errors.js';

export function createProjectsView({ nav, onOpenTask }) {
  const badgeEl = $('#githubBadge');
  const noteEl = $('#githubNote');
  const tokenInput = $('#githubTokenInput');
  const saveBtn = $('#btnGithubSaveKey');
  const oauthBtn = $('#btnGithubOAuth');
  const removeBtn = $('#btnGithubRemoveKey');
  const repoListEl = $('#repoList');
  const repoFilter = $('#repoFilter');
  const branchSelect = $('#branchSelect');
  const chipEl = $('#selectedRepoChip');
  const treeEl = $('#fileTree');
  const viewerEl = $('#fileViewer');
  const pathEl = $('#filePath');
  const codeEl = $('#fileCode');
  const repoTasksEl = $('#repoTasks');

  let state = { repos: [], branches: [], tree: [], repo: '', branch: '', connected: false, oauthUrl: '' };

  /* -------------------------------- GitHub -------------------------------- */

  async function refreshStatus() {
    try {
      const status = await Api.githubStatus({});
      state.connected = Boolean(status.connected);
      badgeEl.className = `badge ${status.connected ? 'ok' : 'bad'}`;
      badgeEl.textContent = status.connected ? `Connected · ${status.login}` : 'Not connected';
      noteEl.textContent = status.message || '';
      removeBtn.hidden = !status.connected;
      if (status.selectedRepo) {
        state.repo = status.selectedRepo;
        await selectRepo(status.selectedRepo, status.selectedBranch || '', { silent: true });
      }
      return status;
    } catch (error) {
      state.connected = false;
      badgeEl.className = 'badge bad';
      badgeEl.textContent = 'Unreachable';
      noteEl.textContent = String(error?.message || 'The backend could not be reached.');
      return null;
    }
  }

  async function refreshRepos() {
    if (!state.connected) {
      repoListEl.innerHTML = '<div class="mini-empty">Connect GitHub to see your repositories.</div>';
      return;
    }
    repoListEl.innerHTML = '<div class="mini-empty">Loading repositories…</div>';
    try {
      const data = await Api.repos({});
      state.repos = data.repos || [];
      renderRepos();
    } catch (error) {
      repoListEl.innerHTML = `<div class="mini-empty">${escapeHtml(String(error?.message || 'Repositories could not be loaded.'))}</div>`;
    }
  }

  function renderRepos() {
    const query = String(repoFilter.value || '').toLowerCase();
    const list = state.repos.filter(repo => !query || repo.fullName.toLowerCase().includes(query));
    if (!list.length) {
      repoListEl.innerHTML = '<div class="mini-empty">No repositories match.</div>';
      return;
    }
    repoListEl.innerHTML = list.map(repo => `
      <button type="button" class="repo-row${repo.fullName === state.repo ? ' is-selected' : ''}" data-repo="${escapeHtml(repo.fullName)}">
        <span class="rr-main">
          <span class="rr-title">${escapeHtml(repo.fullName)}${repo.private ? ' · private' : ''}</span>
          <span class="rr-sub">${escapeHtml(repo.language || '—')} · default ${escapeHtml(repo.defaultBranch)}${repo.permissions?.push ? '' : ' · read-only'}</span>
        </span>
        <span class="rr-side badge subtle">${escapeHtml(repo.description ? repo.description.slice(0, 40) : '')}</span>
      </button>
    `).join('');

    for (const button of repoListEl.querySelectorAll('[data-repo]')) {
      button.addEventListener('click', () => selectRepo(button.dataset.repo, ''));
    }
  }

  async function selectRepo(repo, branch = '', { silent = false } = {}) {
    state.repo = repo;
    chipEl.textContent = repo;
    renderRepos();

    branchSelect.innerHTML = '<option>Loading…</option>';
    treeEl.innerHTML = '<div class="mini-empty">Loading files…</div>';

    try {
      if (!silent) await Api.selectRepo(repo, branch);
      const data = await Api.branches(repo, {});
      state.branches = data.branches || [];
      const chosen = branch || state.branches.find(b => b.name === 'main')?.name || state.branches[0]?.name || '';
      branchSelect.innerHTML = state.branches.map(b => `
        <option value="${escapeHtml(b.name)}"${b.name === chosen ? ' selected' : ''}>${escapeHtml(b.name)}${b.protected ? ' (protected)' : ''}</option>
      `).join('');
      state.branch = chosen;
      await refreshTree();
      await refreshRepoTasks();
    } catch (error) {
      branchSelect.innerHTML = '<option>Unavailable</option>';
      treeEl.innerHTML = `<div class="mini-empty">${escapeHtml(String(error?.message || 'Branches could not be loaded.'))}</div>`;
    }
  }

  async function refreshTree() {
    if (!state.repo) return;
    treeEl.innerHTML = '<div class="mini-empty">Loading files…</div>';
    try {
      const data = await Api.tree(state.repo, state.branch, {});
      state.tree = data.tree || [];
      renderTree();
    } catch (error) {
      treeEl.innerHTML = `<div class="mini-empty">${escapeHtml(String(error?.message || 'The file tree could not be loaded.'))}</div>`;
    }
  }

  function renderTree() {
    if (!state.tree.length) {
      treeEl.innerHTML = '<div class="mini-empty">No readable files found.</div>';
      return;
    }
    treeEl.innerHTML = state.tree.slice(0, 300).map(item => `
      <button type="button" class="tree-row" data-path="${escapeHtml(item.path)}">
        <span>${escapeHtml(item.path)}</span>
        <span class="tr-size">${escapeHtml(formatBytes(item.size))}</span>
      </button>
    `).join('');
    for (const button of treeEl.querySelectorAll('[data-path]')) {
      button.addEventListener('click', () => openFile(button.dataset.path));
    }
  }

  async function openFile(path) {
    pathEl.textContent = path;
    codeEl.textContent = 'Loading…';
    viewerEl.hidden = false;
    try {
      const data = await Api.file(state.repo, state.branch, path, {});
      codeEl.innerHTML = highlight(String(data.content || ''), path.split('.').pop() || '');
      pathEl.textContent = data.truncated
        ? `${path} — too large to preview (${formatBytes(data.size)})`
        : path;
    } catch (error) {
      codeEl.textContent = String(error?.message || 'The file could not be read.');
    }
  }

  async function refreshRepoTasks() {
    try {
      const data = await Api.tasks({});
      const tasksForRepo = (data.tasks || []).filter(task => !state.repo || task.repo === state.repo);
      if (!tasksForRepo.length) {
        repoTasksEl.innerHTML = '<div class="mini-empty">No tasks for this repository yet.</div>';
        return;
      }
      repoTasksEl.innerHTML = tasksForRepo.slice(0, 12).map(task => `
        <button type="button" class="mini-row" data-task="${escapeHtml(task.id)}">
          <span class="mr-main">
            <span class="mr-title">${escapeHtml(task.prompt.slice(0, 70))}</span>
            <span class="mr-sub">${escapeHtml(task.branch || task.baseBranch || '')} · ${task.fileCount} file(s)${task.additions ? ` · +${task.additions}/−${task.deletions}` : ''}</span>
          </span>
          <span class="mr-side">
            <span class="badge ${task.state === 'completed' ? 'ok' : task.state === 'failed' ? 'bad' : ''}">${escapeHtml(task.stateLabel || task.state)}</span>
            <span>${relTime(task.updatedAt)}</span>
          </span>
        </button>
      `).join('');
      for (const button of repoTasksEl.querySelectorAll('[data-task]')) {
        button.addEventListener('click', () => onOpenTask?.(button.dataset.task));
      }
    } catch {
      repoTasksEl.innerHTML = '<div class="mini-empty">Task history is unavailable.</div>';
    }
  }

  /* --------------------------------- wiring ------------------------------- */

  repoFilter.addEventListener('input', renderRepos);

  branchSelect.addEventListener('change', async () => {
    state.branch = branchSelect.value;
    await refreshTree();
  });

  $('#btnRefreshRepos')?.addEventListener('click', async () => {
    await refreshStatus();
    await refreshRepos();
  });

  saveBtn?.addEventListener('click', async () => {
    const token = String(tokenInput.value || '').trim();
    if (!token) { toast('Paste a GitHub token first', { tone: 'error' }); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Checking…';
    try {
      const result = await Api.saveGithubToken(token, {});
      tokenInput.value = '';
      toast(result.status?.connected ? `Connected as ${result.status.login}` : 'Key saved, but GitHub rejected it',
        { tone: result.status?.connected ? 'success' : 'error' });
      await refreshStatus();
      await refreshRepos();
    } catch (error) {
      toast(error instanceof TralixError ? error.message : 'The token could not be saved', { tone: 'error', ms: 4200 });
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save token';
    }
  });

  oauthBtn?.addEventListener('click', async () => {
    try {
      const data = await Api.oauthStartUrl({});
      if (data?.url) window.location.href = data.url;
      else toast('GitHub OAuth is not configured on the backend.', { tone: 'error', ms: 4200 });
    } catch (error) {
      toast(error instanceof TralixError ? error.message : 'OAuth is not available here.', { tone: 'error', ms: 4200 });
    }
  });

  removeBtn?.addEventListener('click', async () => {
    await Api.removeGithubToken({}).catch(() => {});
    state.connected = false;
    state.repos = [];
    state.repo = '';
    chipEl.textContent = 'No repository selected';
    await refreshStatus();
    renderRepos();
  });

  $('#btnOpenProjectsSheet')?.addEventListener('click', () => openSheet('projectsSheet'));
  $('#btnCopyFile')?.addEventListener('click', async () => {
    const { copyText } = await import('../util.js');
    const ok = await copyText(codeEl.textContent || '');
    toast(ok ? 'File copied' : 'Copy failed', { tone: ok ? 'success' : 'error' });
  });

  window.addEventListener('jarvis:github-connected', () => {
    refreshStatus().then(refreshRepos);
  });

  return {
    refresh: async () => {
      await refreshStatus();
      await refreshRepos();
      await refreshRepoTasks();
    },
    get selection() { return { repo: state.repo, branch: state.branch }; },
    refreshRepoTasks,
  };
}
