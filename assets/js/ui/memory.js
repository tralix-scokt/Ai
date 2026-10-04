/* ==========================================================================
   ui/memory.js — the memory manager.

   Used in two places (Settings → Memory and the Memory sheet) with the same
   component. Memories are grouped by category, editable inline, and deletable
   with undo. Nothing sensitive is ever added (store.isSensitive guards it).
   ========================================================================== */

import { escapeHtml, formatDateTime } from '../util.js';
import * as Store from '../store.js';
import { toast, confirmDialog } from './feedback.js';

/**
 * @param {HTMLElement} container
 * @param {object} deps
 * @param {() => void} [deps.onChange]
 */
export function createMemoryManager(container, { onChange = () => {} } = {}) {
  if (!container) return { refresh() {} };

  let editingId = null;

  function refresh() {
    const list = Store.loadMemory();
    container.innerHTML = '';

    /* add row */
    const add = document.createElement('div');
    add.className = 'mem-add';
    add.innerHTML = `
      <input type="text" placeholder="Add something TRALIX should remember" autocomplete="off" maxlength="200">
      <button type="button" class="btn-ghost">Add</button>`;
    const input = add.querySelector('input');
    const button = add.querySelector('button');

    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      const result = Store.addMemory(value, { source: 'manual' });
      if (result?.refused) {
        toast('That looks sensitive, so it was not saved.', { tone: 'error' });
        return;
      }
      if (!result) { toast('Already remembered'); return; }
      input.value = '';
      refresh();
      onChange();
      toast('Saved to memory', { tone: 'success' });
    };

    button.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
    });
    container.appendChild(add);

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'mem-empty';
      empty.textContent = 'Nothing remembered yet. Say “remember that…” in a chat, or add it above.';
      container.appendChild(empty);
      return;
    }

    /* grouped by category */
    for (const category of Store.MEMORY_CATEGORIES) {
      const items = list.filter(m => m.category === category.id);
      if (!items.length) continue;

      const group = document.createElement('div');
      group.className = 'mem-group';
      group.innerHTML = `<div class="mem-cat">${escapeHtml(category.label)}<span class="project-chip">${items.length}</span></div>`;

      for (const memory of items) {
        group.appendChild(memoryRow(memory));
      }
      container.appendChild(group);
    }
  }

  function memoryRow(memory) {
    const row = document.createElement('div');
    row.className = 'mem-item';

    if (editingId === memory.id) {
      row.innerHTML = `
        <div class="mem-edit">
          <input type="text" value="${escapeHtml(memory.text)}" maxlength="200" aria-label="Edit memory">
          <button type="button" class="btn-ghost" data-role="save">Save</button>
          <button type="button" class="btn-ghost" data-role="cancel">Cancel</button>
        </div>`;
      const input = row.querySelector('input');
      const save = () => {
        const value = input.value.trim();
        if (!value) return;
        const result = Store.updateMemory(memory.id, { text: value });
        editingId = null;
        refresh();
        onChange();
        toast(result ? 'Memory updated' : 'Could not update that memory', { tone: result ? 'success' : 'error' });
      };
      row.querySelector('[data-role="save"]').addEventListener('click', save);
      row.querySelector('[data-role="cancel"]').addEventListener('click', () => { editingId = null; refresh(); });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); save(); }
        if (event.key === 'Escape') { editingId = null; refresh(); }
      });
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
      return row;
    }

    row.innerHTML = `
      <div class="mem-text">${escapeHtml(memory.text)}
        <span class="mem-meta">${escapeHtml(categoryLabel(memory.category))} · ${escapeHtml(formatDateTime(memory.editedAt || memory.ts))}</span>
      </div>
      <div class="mem-actions">
        <button type="button" data-role="edit" aria-label="Edit memory">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z"/></svg>
        </button>
        <button type="button" data-role="delete" aria-label="Delete memory">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
        </button>
      </div>`;

    row.querySelector('[data-role="edit"]').addEventListener('click', () => {
      editingId = memory.id;
      refresh();
    });

    row.querySelector('[data-role="delete"]').addEventListener('click', () => {
      Store.removeMemory(memory.id);
      refresh();
      onChange();
      toast('Forgotten', {
        action: 'Undo',
        onAction: () => {
          Store.addMemory(memory.text, { category: memory.category, source: memory.source });
          refresh();
          onChange();
        },
      });
    });

    return row;
  }

  const categoryLabel = (id) =>
    Store.MEMORY_CATEGORIES.find(c => c.id === id)?.label || 'Other';

  refresh();

  return {
    refresh,
    /** Confirm-and-clear, shared by both manager instances. */
    async clearAll() {
      const ok = await confirmDialog(
        'Clear all memories?',
        'TRALIX will forget everything it has saved about you. This cannot be undone.',
        'Clear all',
      );
      if (!ok) return false;
      Store.clearMemory();
      refresh();
      onChange();
      toast('Memory cleared');
      return true;
    },
  };
}
