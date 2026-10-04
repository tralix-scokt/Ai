/* ==========================================================================
   ui/sidebar.js — navigation: conversation list, grouping, drawer, collapse.

   Desktop: a permanent column that can collapse to zero width.
   Mobile: a slide-out drawer behind a scrim, with the body scroll lock
   acquired while it is open and always released on close.
   ========================================================================== */

import { $, escapeHtml, dayBucket, plural, downloadJson } from '../util.js';
import * as Store from '../store.js';
import { acquireScrollLock, releaseScrollLock } from '../scrolling.js';
import { toast, confirmDialog, promptDialog } from './feedback.js';
import { openSheet, closeSheet } from './sheets.js';
import { closeAllMoreMenus } from './messages.js';

const MOBILE = () => window.matchMedia('(max-width: 899px)').matches;

export function createSidebar(deps) {
  const {
    getSettings, saveSettings, getChat,
    onOpenChat, onNewChat, onOpenSearch, onOpenProjects,
    onOpenMemory, onOpenSettings, onOpenConnect, onChatsChanged, onOpenModel = () => {},
  } = deps;

  const app = $('#app');
  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const listEl = $('#chatList');
  const labelEl = $('#historyLabel');
  const btnMenu = $('#btnMenu');

  let drawerOpen = false;

  /* ------------------------------- rendering ------------------------------ */
  function render() {
    const settings = getSettings();
    const current = getChat();
    const chats = Store.loadChats();
    const query = '';
    const filtered = query ? Store.searchChats(query) : chats;

    listEl.innerHTML = '';

    if (!filtered.length) {
      listEl.innerHTML = `<div class="chat-empty">No conversations yet.<br>Start with “New chat”.</div>`;
      labelEl.textContent = 'Recent conversations';
      return;
    }

    const pinned = filtered.filter(c => c.pinned);
    const rest = filtered.filter(c => !c.pinned);

    if (pinned.length) {
      listEl.appendChild(group('Pinned', pinned, current, settings));
    }

    const groups = new Map();
    for (const chat of rest) {
      const bucket = dayBucket(chat.updatedAt);
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push(chat);
    }
    for (const [bucket, items] of groups) {
      listEl.appendChild(group(bucket, items, current, settings));
    }

    const archived = filtered.filter(c => c.archived).length;
    labelEl.textContent = archived
      ? `Recent conversations · ${plural(archived, 'archived chat')}`
      : 'Recent conversations';
  }

  function group(title, chats, current, settings) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-group';

    const heading = document.createElement('div');
    heading.className = 'list-label';
    heading.textContent = title;
    wrap.appendChild(heading);

    for (const chat of chats) {
      wrap.appendChild(chatRow(chat, current, settings));
    }
    return wrap;
  }

  function chatRow(chat, current, settings) {
    const row = document.createElement('div');
    row.className = `chat-item${chat.id === current?.id ? ' active' : ''}`;
    row.setAttribute('role', 'listitem');

    const project = chat.projectId ? Store.projectById(chat.projectId) : null;

    row.innerHTML = `
      <button type="button" class="ci-title" title="${escapeHtml(chat.title)}">
        ${chat.pinned ? '<span class="ci-pin" aria-label="Pinned">📌</span> ' : ''}${escapeHtml(chat.title)}
      </button>
      <button type="button" class="ci-more" aria-label="Chat options for ${escapeHtml(chat.title)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="18.5" r="1.3"/></svg>
      </button>`;

    if (project) {
      const chip = document.createElement('span');
      chip.className = 'project-chip';
      chip.textContent = project.name;
      chip.title = `In project: ${project.name}`;
      row.insertBefore(chip, row.querySelector('.ci-more'));
    }

    const open = () => {
      onOpenChat(chat.id);
      closeDrawer();
    };
    row.querySelector('.ci-title').addEventListener('click', open);
    row.addEventListener('dblclick', open);
    row.querySelector('.ci-more').addEventListener('click', async (event) => {
      event.stopPropagation();
      await openChatMenu(chat.id);
    });

    return row;
  }

  /* ----------------------------- chat menu -------------------------------- */
  async function openChatMenu(chatId) {
    const chat = Store.getChat(chatId);
    if (!chat) return;
    const menu = $('#chatMenuList');
    menu.innerHTML = '';
    $('#chatMenuTitle').textContent = chat.title.length > 34 ? `${chat.title.slice(0, 34)}…` : chat.title;

    const item = (label, icon, handler, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.innerHTML = `${icon}<span>${escapeHtml(label)}</span>`;
      b.addEventListener('click', async () => {
        closeSheet('chatMenuSheet');
        await handler();
      });
      menu.appendChild(b);
      return b;
    };

    const sep = () => { const s = document.createElement('div'); s.className = 'sep'; menu.appendChild(s); };

    item(`Model · ${deps.getModelLabel?.() || 'TRALIX'}`, '<svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.4L20 10l-4.4 3.6L16.6 19 12 16.2 7.4 19l1-5.4L4 10l5.8-1.6z"/></svg>', async () => {
      onOpenModel();
    });

    sep();

    item('Rename', '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z"/></svg>', async () => {
      const name = await promptDialog({
        title: 'Rename conversation',
        value: chat.title,
        confirmLabel: 'Rename',
        maxLength: 90,
      });
      if (!name) return;
      Store.upsertChat({ ...chat, title: name.slice(0, 120), updatedAt: Date.now() });
      render();
      onChatsChanged();
      toast('Renamed');
    });

    item(chat.pinned ? 'Unpin' : 'Pin', '<svg viewBox="0 0 24 24"><path d="M12 17v5M8 3h8l-1 7 3 3H6l3-3z"/></svg>', async () => {
      Store.upsertChat({ ...chat, pinned: !chat.pinned });
      render();
      toast(chat.pinned ? 'Unpinned' : 'Pinned to the top');
    });

    item(chat.archived ? 'Unarchive' : 'Archive', '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/></svg>', async () => {
      Store.upsertChat({ ...chat, archived: !chat.archived });
      render();
      toast(chat.archived ? 'Unarchived' : 'Archived', {
        action: 'Undo',
        onAction: () => {
          Store.upsertChat({ ...chat, archived: chat.archived });
          render();
        },
      });
    });

    item('Move to project', '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>', async () => {
      const projects = Store.loadProjects();
      const names = projects.map(p => p.name);
      const answer = await promptDialog({
        title: 'Move to project',
        value: chat.projectId ? (Store.projectById(chat.projectId)?.name || '') : '',
        placeholder: names.length ? `Existing: ${names.join(', ')}` : 'Project name',
        confirmLabel: 'Move',
        maxLength: 60,
      });
      if (answer === null) return;
      if (!answer) {
        Store.upsertChat({ ...chat, projectId: null });
        toast('Removed from project');
      } else {
        const existing = projects.find(p => p.name.toLowerCase() === answer.toLowerCase());
        const project = existing || Store.addProject({ name: answer });
        Store.upsertChat({ ...chat, projectId: project.id });
        toast(`Moved to ${project.name}`);
      }
      render();
      onChatsChanged();
    });

    item('Export as JSON', '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5M5 21h14"/></svg>', () => {
      downloadJson(`tralix-chat-${chat.id}.json`, {
        app: 'tralix',
        exportedAt: new Date().toISOString(),
        chat,
      });
      toast('Conversation exported');
    });

    sep();

    item('Delete', '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>', async () => {
      const ok = await confirmDialog(
        'Delete this conversation?',
        `“${chat.title}” will be removed from this device.`,
        'Delete',
      );
      if (!ok) return;
      Store.deleteChat(chat.id);
      if (getChat()?.id === chat.id) onNewChat();
      render();
      onChatsChanged();
      toast('Conversation deleted', {
        action: 'Undo',
        ms: 6000,
        onAction: () => {
          Store.upsertChat(chat);
          render();
          onChatsChanged();
          toast('Restored');
        },
      });
    }, 'danger');

    openSheet('chatMenuSheet');
  }

  /* -------------------------------- drawer -------------------------------- */
  function openDrawer() {
    if (!MOBILE()) return;
    render();
    app.classList.add('drawer-open');
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('on'));
    btnMenu?.setAttribute('aria-expanded', 'true');
    acquireScrollLock();
    drawerOpen = true;
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    app.classList.remove('drawer-open');
    scrim.classList.remove('on');
    setTimeout(() => { if (!drawerOpen) scrim.hidden = true; }, 280);
    btnMenu?.setAttribute('aria-expanded', 'false');
    releaseScrollLock();
    drawerOpen = false;
  }

  const toggleDrawer = () => (drawerOpen ? closeDrawer() : openDrawer());

  /* ------------------------------- collapse ------------------------------- */
  function applyCollapsed() {
    const collapsed = Boolean(getSettings().sidebarCollapsed);
    app.classList.toggle('sidebar-collapsed', collapsed && !MOBILE());
    $('#btnToggleSidebar')?.setAttribute('aria-expanded', String(!collapsed));
  }

  function toggleCollapse() {
    if (MOBILE()) { toggleDrawer(); return; }
    const settings = getSettings();
    settings.sidebarCollapsed = !settings.sidebarCollapsed;
    saveSettings(settings);
    applyCollapsed();
  }

  /* ------------------------------- counts --------------------------------- */
  function refreshCounts() {
    $('#memCount').textContent = String(Store.loadMemory().length);
    const projects = Store.loadProjects();
    $('#projectCount').textContent = String(projects.length);
  }

  /* -------------------------------- wiring -------------------------------- */
  $('#btnNewChat').addEventListener('click', () => { onNewChat(); closeDrawer(); });
  $('#btnNewChatTop').addEventListener('click', () => { onNewChat(); closeDrawer(); });
  $('#btnSearch').addEventListener('click', () => { onOpenSearch(); closeDrawer(); });
  $('#btnProjects').addEventListener('click', () => { onOpenProjects(); closeDrawer(); });
  $('#btnMemory').addEventListener('click', () => { onOpenMemory(); closeDrawer(); });
  $('#btnSettings').addEventListener('click', () => { onOpenSettings(); closeDrawer(); });
  $('#userArea').addEventListener('click', () => { onOpenSettings(); closeDrawer(); });
  $('#btnConnInfo').addEventListener('click', () => { onOpenConnect(); closeDrawer(); });
  $('#btnMenu').addEventListener('click', toggleDrawer);
  $('#btnCloseSidebar').addEventListener('click', closeDrawer);
  $('#btnToggleSidebar').addEventListener('click', toggleCollapse);
  $('#btnSidebarCollapse').addEventListener('click', toggleCollapse);
  $('#btnChatMenu').addEventListener('click', () => {
    const chat = getChat();
    if (chat) openChatMenu(chat.id);
  });
  scrim.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawerOpen) closeDrawer();
  });

  window.addEventListener('resize', () => {
    if (!MOBILE() && drawerOpen) closeDrawer();
    applyCollapsed();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('.msg-actions')) closeAllMoreMenus();
  });

  applyCollapsed();

  return { render, refreshCounts, openDrawer, closeDrawer, toggleDrawer, openChatMenu, applyCollapsed };
}
