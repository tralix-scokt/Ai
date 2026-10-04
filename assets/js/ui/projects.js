/* ==========================================================================
   ui/projects.js — project organisation for conversations.

   A project is a label on conversations: create, rename, delete (conversations
   are kept, never deleted with the project), and open any conversation inside.
   ========================================================================== */

import { $, escapeHtml, relTime } from '../util.js';
import * as Store from '../store.js';
import { toast, confirmDialog, promptDialog } from './feedback.js';

export function createProjects({ onOpenChat, onChanged = () => {} }) {
  const listEl = $('#projectList');
  const input = $('#projectInput');

  function render() {
    const projects = Store.loadProjects();
    const chats = Store.loadChats();
    listEl.innerHTML = '';

    if (!projects.length) {
      listEl.innerHTML = `<div class="chat-empty">No projects yet. Create one to group related conversations.</div>`;
      return;
    }

    for (const project of projects) {
      const items = chats.filter(c => c.projectId === project.id);
      const item = document.createElement('div');
      item.className = 'project-item';
      item.innerHTML = `
        <div class="pi-head">
          <span class="pi-name">${escapeHtml(project.name)}</span>
          <span class="project-chip">${items.length} ${items.length === 1 ? 'chat' : 'chats'}</span>
          <button type="button" class="icon-btn ghost tiny" data-role="rename" aria-label="Rename project">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z"/></svg>
          </button>
          <button type="button" class="icon-btn ghost tiny" data-role="delete" aria-label="Delete project">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
          </button>
        </div>
        <div class="pi-meta">Created ${escapeHtml(relTime(project.createdAt))}</div>`;

      if (items.length) {
        const list = document.createElement('div');
        list.className = 'pi-chats';
        for (const chat of items.slice(0, 6)) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'pi-chat';
          row.innerHTML = `<span>${escapeHtml(chat.title)}</span>`;
          row.addEventListener('click', () => onOpenChat(chat.id));
          list.appendChild(row);
        }
        if (items.length > 6) {
          const more = document.createElement('div');
          more.className = 'pi-empty';
          more.textContent = `+ ${items.length - 6} more`;
          list.appendChild(more);
        }
        item.appendChild(list);
      } else {
        const empty = document.createElement('div');
        empty.className = 'pi-empty';
        empty.textContent = 'No conversations yet. Use ⋯ on a chat to move it here.';
        item.appendChild(empty);
      }

      item.querySelector('[data-role="rename"]').addEventListener('click', async () => {
        const name = await promptDialog({
          title: 'Rename project', value: project.name, confirmLabel: 'Rename', maxLength: 60,
        });
        if (!name) return;
        Store.updateProject(project.id, { name });
        render();
        onChanged();
      });

      item.querySelector('[data-role="delete"]').addEventListener('click', async () => {
        const ok = await confirmDialog(
          'Delete this project?',
          `“${project.name}” will be removed. Its conversations are kept.`,
          'Delete project',
        );
        if (!ok) return;
        Store.deleteProject(project.id);
        render();
        onChanged();
        toast('Project deleted — conversations kept');
      });

      listEl.appendChild(item);
    }
  }

  function add() {
    const name = input.value.trim();
    if (!name) { toast('Give the project a name'); return; }
    const existing = Store.loadProjects().find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) { toast('A project with that name already exists'); return; }
    Store.addProject({ name });
    input.value = '';
    render();
    onChanged();
    toast('Project created', { tone: 'success' });
  }

  $('#btnProjectAdd')?.addEventListener('click', add);
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); add(); }
  });

  return { render, focus: () => input?.focus({ preventScroll: true }) };
}
