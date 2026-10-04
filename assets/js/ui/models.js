/* ==========================================================================
   ui/models.js — the model picker and capability report.

   Users choose a TRALIX tier. The provider model behind it stays an
   implementation detail (visible only in Advanced/debug).
   ========================================================================== */

import { $, escapeHtml } from '../util.js';
import { MODELS, modelById, resolvedSummary } from '../models.js';
import { FEATURES, APP } from '../config.js';
import { TOOLS } from '../tools.js';
import { toast } from './feedback.js';
import { openSheet } from './sheets.js';

export function createModelPicker({ getSettings, onSelect = () => {} }) {
  const listEl = $('#modelList');
  const noteEl = $('#modelNote');
  const capEl = $('#capabilityList');

  function render() {
    const settings = getSettings();
    const active = settings.model;
    listEl.innerHTML = '';

    for (const tier of MODELS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `model-opt${tier.id === active ? ' sel' : ''}`;
      button.setAttribute('aria-pressed', String(tier.id === active));
      button.innerHTML = `
        <div class="mo-body">
          <span class="mo-name">${escapeHtml(tier.label)}
            ${tier.recommended ? '<span class="mo-tag">Recommended</span>' : ''}
          </span>
          <span class="mo-desc">${escapeHtml(tier.tagline)} — ${escapeHtml(tier.description)}</span>
          <span class="mo-badges">
            ${(tier.strengths || []).map(s => `<span class="mo-badge">${escapeHtml(s)}</span>`).join('')}
          </span>
        </div>
        <svg class="mo-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4 10-10"/></svg>`;

      button.addEventListener('click', () => {
        if (settings.model === tier.id) { openSheet('modelSheet'); return; }
        settings.model = tier.id;
        onSelect(tier.id);
        render();
        toast(`${tier.label} selected`, { tone: 'success' });
      });

      listEl.appendChild(button);
    }

    const tier = modelById(active);
    noteEl.textContent = settings.advanced.devMode
      ? `Resolves to: ${resolvedSummary(active)}`
      : 'Model names are internal — TRALIX picks the right provider model for the job.';

    renderCapabilities(tier);
  }

  function renderCapabilities() {
    if (!capEl) return;
    const caps = [
      { label: 'Conversation and reasoning', on: true },
      { label: 'Web search', on: FEATURES.webSearch, note: FEATURES.webSearch ? '' : 'needs a search-enabled backend' },
      { label: 'File attachments', on: FEATURES.attachments, note: FEATURES.attachments ? '' : 'not deployed yet' },
      { label: 'Voice input and read-aloud', on: FEATURES.voice },
      { label: 'Memory', on: FEATURES.memory },
      { label: 'Code execution sandbox', on: FEATURES.codeExecution, note: FEATURES.codeExecution ? '' : 'not deployed yet' },
    ];

    capEl.innerHTML = caps.map(cap => `
      <div class="cap-item">
        <span>${escapeHtml(cap.label)}</span>
        <span class="cap-state ${cap.on ? 'cap-on' : 'cap-off'}">
          ${cap.on ? 'Available' : `Unavailable${cap.note ? ` · ${escapeHtml(cap.note)}` : ''}`}
        </span>
      </div>`).join('');

    const unavailable = TOOLS.filter(t => !t.available);
    if (unavailable.length) {
      const row = document.createElement('div');
      row.className = 'cap-item';
      row.innerHTML = `<span>Planned tools</span><span class="cap-state cap-off">${escapeHtml(unavailable.map(t => t.label).join(', '))}</span>`;
      capEl.appendChild(row);
    }
  }

  return {
    render,
    open() { render(); openSheet('modelSheet'); },
    appVersion: APP.version,
  };
}
