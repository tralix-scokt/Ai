/* ==========================================================================
   views/settings.js — JARVIS-specific configuration.

   Sections: GitHub · task execution · execution sandbox · voice · security ·
   environment · (link to the original appearance/memory/data sheet).

   Every value here is read from the server and written back to it. Nothing is
   stored in the browser except the last open area.
   ========================================================================== */

import { $, escapeHtml } from '../util.js';
import * as Api from '../api/v2.js';
import { toast } from '../ui/feedback.js';
import { openSheet } from '../ui/sheets.js';
import { TralixError } from '../errors.js';

export function createSettingsView({ nav, settingsUi }) {
  const githubEl = $('#settingsGithub');
  const sandboxEl = $('#sandboxReport');
  const sandboxStatus = $('#sandboxStatusLine');
  const voiceEl = $('#voiceReport');
  const voiceStatus = $('#voiceStatusLine');
  const securityEl = $('#securityReport');
  const envList = $('#envList');
  const stamp = $('#buildStampStudio');

  let settings = null;

  /* -------------------------------- rendering ----------------------------- */

  function row({ title, sub, tone = '', side = '' }) {
    return `
      <div class="mini-row">
        <span class="mr-main">
          <span class="mr-title">${escapeHtml(title)}</span>
          ${sub ? `<span class="mr-sub">${escapeHtml(sub)}</span>` : ''}
        </span>
        <span class="mr-side">${side ? `<span class="badge ${tone}">${escapeHtml(side)}</span>` : ''}</span>
      </div>`;
  }

  function renderGithub(status) {
    githubEl.innerHTML = [
      row({
        title: status?.connected ? `Connected as ${status.login}` : 'Not connected',
        sub: status?.message || '',
        tone: status?.connected ? 'ok' : 'bad',
        side: status?.connected ? status.mode : 'Setup needed',
      }),
      row({
        title: 'Permissions JARVIS needs',
        sub: 'Contents: Read and write · Metadata: Read-only · Pull requests: Read and write. Nothing is pushed to the default branch and no pull request is ever merged.',
      }),
    ].join('');
  }

  function renderSandbox(report) {
    if (!report) {
      sandboxEl.innerHTML = '<div class="mini-empty">Sandbox status unavailable.</div>';
      return;
    }
    const wrappers = report.wrappers || {};
    sandboxEl.innerHTML = [
      row({
        title: report.available ? 'Command execution available' : 'Command execution unavailable',
        sub: report.platform || '',
        tone: report.available ? 'ok' : 'bad',
        side: report.available ? report.driver : 'unavailable',
      }),
      row({
        title: 'Kernel limits',
        sub: wrappers.prlimit ? 'CPU, address space, file size and process limits are applied.' : 'prlimit is not installed — only timeouts and output caps apply.',
        tone: wrappers.prlimit ? 'ok' : 'warn',
        side: wrappers.prlimit ? 'prlimit' : 'missing',
      }),
      row({
        title: 'Network isolation',
        sub: wrappers.unshare ? 'A private network namespace is created for each run.' : 'User namespaces are unavailable — commands can reach the network.',
        tone: wrappers.unshare ? 'ok' : 'warn',
        side: wrappers.unshare ? 'unshare -rn' : 'missing',
      }),
      row({
        title: 'Container isolation',
        sub: wrappers.docker ? 'Docker is installed: choose the docker driver for a real boundary.' : 'Docker is not available. Run the backend on a host with Docker for true isolation.',
        tone: wrappers.docker ? 'ok' : 'warn',
        side: wrappers.docker ? 'docker' : 'missing',
      }),
      ...(report.notes || []).map(noteText => row({ title: 'Note', sub: noteText, tone: 'warn' })),
    ].join('');
  }

  function renderVoice(status) {
    if (!status) return;
    voiceEl.innerHTML = [
      row({
        title: status.configured ? 'Fish Audio configured' : 'Spoken replies not configured',
        sub: status.note || '',
        tone: status.configured ? 'ok' : 'warn',
        side: status.configured ? status.model : 'off',
      }),
      row({
        title: 'Speech recognition',
        sub: 'The microphone uses your browser’s speech recognition (Safari on iOS, Chrome on Android and desktop). It is independent of text-to-speech and needs no key.',
      }),
    ].join('');
  }

  function renderSecurity(report) {
    if (!report) return;
    const rows = [
      row({
        title: report.writeTokenRequired ? 'Write token required' : 'No write token set',
        sub: report.writeTokenRequired
          ? 'Mutating API calls need a shared secret. Recommended for any deployment reachable from the internet.'
          : 'Anyone who can reach this backend can change settings. Set JARVIS_WRITE_TOKEN if it is exposed.',
        tone: report.writeTokenRequired ? 'ok' : 'warn',
        side: report.writeTokenRequired ? 'enforced' : 'open',
      }),
      row({
        title: 'Where secrets live',
        sub: 'Provider keys, the GitHub token and the Fish Audio key are stored on the server in a 0600 file, never in the browser and never in this repository. Reads return a four-character hint.',
      }),
    ];
    securityEl.innerHTML = rows.join('');
  }

  function renderEnv(report) {
    const list = report?.variables || [];
    if (!list.length) {
      envList.innerHTML = '<div class="mini-empty">The environment report is unavailable.</div>';
      return;
    }
    envList.innerHTML = list.map(variable => `
      <div class="mini-row">
        <span class="mr-main">
          <span class="mr-title"><code>${escapeHtml(variable.name)}</code>${variable.secret ? ' · secret' : ''}</span>
          <span class="mr-sub">${escapeHtml(variable.purpose)}</span>
        </span>
        <span class="mr-side"><span class="badge ${variable.set ? 'ok' : 'subtle'}">${variable.set ? 'set' : 'not set'}</span></span>
      </div>
    `).join('');
  }

  function applySettings(next) {
    settings = next;
    if (!next) return;
    $('#setAutonomy').value = next.tasks?.autonomy || 'review-changes';
    $('#setBranchPrefix').value = next.github?.branchPrefix || 'jarvis/';
    $('#setRunChecks').checked = next.tasks?.runChecks !== false;
    $('#setRepair').value = String(next.tasks?.maxRepairAttempts ?? 2);
    $('#setDriver').value = next.sandbox?.driver || 'process';
    $('#setNetwork').value = next.sandbox?.network || 'off';
    $('#setTimeout').value = String(Math.round((next.sandbox?.timeoutMs || 180000) / 1000));
    $('#setVoiceRef').value = next.voice?.referenceId || '';
    $('#setVoiceModel').value = next.voice?.model || 's2-pro';
    $('#setVoiceSpeed').value = String(next.voice?.speed || 1);
  }

  /* --------------------------------- saving ------------------------------- */

  async function save(patch, statusEl, message) {
    try {
      const result = await Api.saveSettings(patch, {});
      applySettings(result.settings);
      if (statusEl) {
        statusEl.textContent = message || 'Saved.';
        statusEl.className = 'status-line ok';
      }
      return result.settings;
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = error instanceof TralixError ? error.message : 'The change could not be saved.';
        statusEl.className = 'status-line bad';
      }
      return null;
    }
  }

  $('#btnSaveTasks')?.addEventListener('click', () => {
    const seconds = Number($('#setTimeout').value);
    save({
      tasks: {
        autonomy: $('#setAutonomy').value,
        maxRepairAttempts: Number($('#setRepair').value),
        runChecks: $('#setRunChecks').checked,
      },
      ...(Number.isFinite(seconds) ? { sandbox: { timeoutMs: Math.max(5000, seconds * 1000) } } : {}),
      github: { branchPrefix: $('#setBranchPrefix').value || 'jarvis/' },
    }, $('#tasksStatus'), 'Task preferences saved.');
  });

  $('#btnSaveSandbox')?.addEventListener('click', () => {
    const seconds = Number($('#setTimeout').value);
    save({
      sandbox: {
        driver: $('#setDriver').value,
        network: $('#setNetwork').value,
        timeoutMs: Number.isFinite(seconds) ? Math.max(5000, seconds * 1000) : 180000,
      },
    }, sandboxStatus, 'Sandbox preferences saved.');
  });

  $('#btnSaveVoice')?.addEventListener('click', () => {
    save({
      voice: {
        referenceId: $('#setVoiceRef').value.trim(),
        model: $('#setVoiceModel').value.trim() || 's2-pro',
        speed: Number($('#setVoiceSpeed').value) || 1,
      },
    }, voiceStatus, 'Voice preferences saved.');
  });

  $('#btnVoiceTest')?.addEventListener('click', async () => {
    const button = $('#btnVoiceTest');
    button.disabled = true;
    button.textContent = 'Requesting speech…';
    try {
      const { speak } = await import('../api/v2.js');
      const audio = await speak('JARVIS is online. Spoken replies are working.', {});
      const player = new Audio(audio.url);
      await player.play();
      player.addEventListener('ended', () => audio.revoke(), { once: true });
      if (voiceStatus) { voiceStatus.textContent = 'Fish Audio returned audio.'; voiceStatus.className = 'status-line ok'; }
    } catch (error) {
      if (voiceStatus) {
        voiceStatus.textContent = error instanceof TralixError ? error.message : 'The voice test failed.';
        voiceStatus.className = 'status-line bad';
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Test voice (real request)';
    }
  });

  $('#btnOpenClassicSettings')?.addEventListener('click', () => settingsUi?.open('general'));
  $('#btnOpenVoiceClassic')?.addEventListener('click', () => settingsUi?.open('voice'));
  $('#btnOpenDoctor')?.addEventListener('click', () => settingsUi?.openDoctor());
  $('#btnRefreshEnv')?.addEventListener('click', () => refresh());

  /* --------------------------------- refresh ------------------------------ */

  async function refresh() {
    const [settingsResult, envResult, githubResult, sandboxResult, voiceResult] = await Promise.allSettled([
      Api.settings({}),
      Api.envReport({}),
      Api.githubStatus({}),
      Api.sandboxStatus({ force: true }),
      Api.voiceStatus({}),
    ]);

    applySettings(settingsResult.status === 'fulfilled' ? settingsResult.value.settings : null);
    renderSecurity(settingsResult.status === 'fulfilled' ? settingsResult.value : null);
    renderEnv(envResult.status === 'fulfilled' ? envResult.value : null);
    renderGithub(githubResult.status === 'fulfilled' ? githubResult.value : { connected: false, message: 'GitHub status unavailable.' });
    renderSandbox(sandboxResult.status === 'fulfilled' ? sandboxResult.value : null);
    renderVoice(voiceResult.status === 'fulfilled' ? voiceResult.value : null);

    if (stamp) {
      stamp.textContent = settingsResult.status === 'fulfilled'
        ? `Settings stored on the server${envResult.value?.storage === 'file' ? ' (file store)' : ' (memory store — resets on redeploy)'}`
        : 'Settings could not be loaded from the server.';
    }
    return settings;
  }

  return { refresh, get settings() { return settings; } };
}
