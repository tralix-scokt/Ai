/* ==========================================================================
   ui/doctor.js — diagnostics and debug information.

   Everything here is read-only inspection: backend reachability, transport,
   model mapping, storage usage, voice support, PWA state. It never talks to a
   provider directly and never prints keys.
   ========================================================================== */

import { $, formatBytes } from '../util.js';
import { APP, apiBase, apiBaseSource, apiUrl, FEATURES } from '../config.js';
import * as Store from '../store.js';
import { activeTransport, transportLabel } from '../api/chat.js';
import { modelById, resolvedSummary } from '../models.js';
import { availableTools } from '../tools.js';
import * as Voice from '../voice.js';

function storageBytes() {
  let total = 0;
  try {
    for (const key of Object.values(Store.storageKeys)) {
      total += (localStorage.getItem(key) || '').length;
    }
    for (const key of Object.values(Store.legacyKeys)) {
      total += (localStorage.getItem(key) || '').length;
    }
    total += (localStorage.getItem('tralix.backend.v1') || '').length;
  } catch { /* private mode */ }
  return total;
}

/**
 * Build the diagnostic rows.
 * @param {object} opts
 * @param {object} opts.settings
 * @param {object} [opts.health] health report from api/backend.js
 * @returns {Array<{label:string, detail:string, state:'ok'|'warn'|'bad'|'info'}>}
 */
export function collectDiagnostics({ settings, health }) {
  const rows = [];
  const transport = activeTransport(settings);

  const statusWord = health?.ok ? 'verified'
    : health?.status === 'unconfigured' ? 'reachable, no key'
    : health?.status === 'unauthorized' ? 'key rejected'
    : health?.status === 'rate_limit' ? 'rate limited'
    : health?.reachable ? 'reachable, AI service unreachable'
    : 'unreachable';

  rows.push({
    label: 'Backend + AI service',
    detail: `${apiUrl('')} · ${statusWord}`
      + (health?.model ? ` · ${health.provider || 'openai'}/${health.model}` : '')
      + (health?.latencyMs ? ` · ${health.latencyMs}ms` : ''),
    state: health?.ok ? 'ok' : (health?.reachable ? 'warn' : 'bad'),
  });

  rows.push({
    label: 'Backend URL source',
    detail: `${apiBase() || 'same origin'} · ${apiBaseSource()}`,
    state: 'info',
  });

  if (transport === 'backend' && health?.reachable && !health?.configured) {
    rows.push({
      label: 'Recommended fix',
      detail: 'Set OPENAI_API_KEY as a server secret on the backend (wrangler secret put OPENAI_API_KEY). The key never goes in this app.',
      state: 'info',
    });
  } else if (transport === 'backend' && health?.status === 'unauthorized') {
    rows.push({
      label: 'Recommended fix',
      detail: 'The AI service rejected the backend key. Replace OPENAI_API_KEY and redeploy the backend.',
      state: 'info',
    });
  }

  rows.push({
    label: 'Transport',
    detail: transportLabel(settings),
    state: transport === 'backend' ? 'ok' : 'warn',
  });

  if (transport === 'backend' && !health?.ok) {
    rows.push({
      label: 'Recommended fix',
      detail: 'Deploy server/ and set the Backend URL in Settings → Advanced.',
      state: 'info',
    });
  }

  rows.push({
    label: 'Active model tier',
    detail: `${modelById(settings.model).label} → ${resolvedSummary(settings.model)}`,
    state: 'info',
  });

  rows.push({
    label: 'Backend URL',
    detail: apiBase() || 'same origin (/api)',
    state: apiBase() ? 'info' : 'info',
  });

  rows.push({
    label: 'Tools advertised',
    detail: availableTools().length ? availableTools().map(t => t.label).join(', ') : 'none',
    state: availableTools().length ? 'ok' : 'warn',
  });

  rows.push({
    label: 'Web search',
    detail: FEATURES.webSearch ? 'enabled by the backend' : 'unavailable — TRALIX will say so rather than guess',
    state: FEATURES.webSearch ? 'ok' : 'warn',
  });

  rows.push({
    label: 'Attachments',
    detail: FEATURES.attachments ? 'enabled' : 'not deployed (button explains this in-app)',
    state: FEATURES.attachments ? 'ok' : 'warn',
  });

  rows.push({
    label: 'Speech synthesis',
    detail: Voice.ttsSupported ? `${Voice.voiceList().length} voices available` : 'unsupported in this browser',
    state: Voice.ttsSupported ? 'ok' : 'warn',
  });

  rows.push({
    label: 'Speech recognition',
    detail: Voice.sttSupported ? 'available' : 'unsupported in this browser',
    state: Voice.sttSupported ? 'ok' : 'warn',
  });

  rows.push({
    label: 'Conversations stored',
    detail: `${Store.loadChats().length} chats · ${Store.loadMemory().length} memories`,
    state: 'info',
  });

  rows.push({
    label: 'Local storage used',
    detail: formatBytes(storageBytes()),
    state: 'info',
  });

  rows.push({
    label: 'Install mode',
    detail: window.matchMedia('(display-mode: standalone)').matches ? 'standalone (Home Screen)' : 'browser tab',
    state: 'info',
  });

  rows.push({
    label: 'Service worker',
    detail: 'serviceWorker' in navigator ? 'supported' : 'unsupported',
    state: 'serviceWorker' in navigator ? 'ok' : 'warn',
  });

  rows.push({
    label: 'Network',
    detail: navigator.onLine ? 'online' : 'offline',
    state: navigator.onLine ? 'ok' : 'bad',
  });

  return rows;
}

export function renderDoctor(container, rows) {
  if (!container) return;
  container.innerHTML = rows.map(row => `
    <div class="doctor-row">
      <div>${row.label}<small>${escapeText(row.detail)}</small></div>
      <div class="doctor-state ${row.state === 'info' ? '' : row.state}">${stateLabel(row.state)}</div>
    </div>`).join('');
}

const stateLabel = (state) => ({ ok: 'OK', warn: 'Check', bad: 'Problem', info: 'Info' }[state] || 'Info');

function escapeText(value = '') {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Compact rows for the Advanced → debug panel. */
export function debugRows({ settings, health }) {
  const rows = [
    ['App', `${APP.name} v${APP.version}`],
    ['Transport', activeTransport(settings)],
    ['Model tier', `${settings.model} (${resolvedSummary(settings.model)})`],
    ['Backend', apiBase() || 'same origin'],
    ['Backend health', health?.ok ? 'ok' : (health?.error || 'unknown')],
    ['Schema', String(Store.meta().schema || Store.SCHEMA_VERSION)],
    ['Migrated from', Store.meta().migratedFrom || '—'],
    ['Chats', String(Store.loadChats().length)],
    ['Memories', String(Store.loadMemory().length)],
    ['Projects', String(Store.loadProjects().length)],
    ['Storage', formatBytes(storageBytes())],
    ['Display mode', window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'],
    ['Reduced motion', window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'on' : 'off'],
  ];
  return rows;
}

export function renderDebug(container, rows) {
  if (!container) return;
  container.innerHTML = rows.map(([label, value]) => `
    <div class="debug-row"><span>${escapeText(label)}</span><span>${escapeText(value)}</span></div>`).join('');
}

export function reportText(rows) {
  return rows.map(r => `${r.label}: ${r.detail} [${r.state}]`).join('\n');
}

export async function runDoctor({ settings, onHealth }) {
  const health = await onHealth();
  const rows = collectDiagnostics({ settings, health });
  renderDoctor($('#doctorOutput'), rows);
  return rows;
}
