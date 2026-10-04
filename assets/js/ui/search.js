/* ==========================================================================
   ui/search.js — conversation search.

   Searches titles and message bodies (store.searchChats), shows a snippet of
   the matching text, and supports keyboard navigation.
   ========================================================================== */

import { $, escapeHtml, relTime, debounce } from '../util.js';
import * as Store from '../store.js';
import { openSheet, closeSheet } from './sheets.js';

export function createSearch({ onOpenChat }) {
  const input = $('#searchInput');
  const results = $('#searchResults');
  let activeIndex = 0;
  let current = [];

  function render(query) {
    const chats = Store.searchChats(query);
    current = chats;
    activeIndex = Math.min(activeIndex, Math.max(0, chats.length - 1));
    results.innerHTML = '';

    if (!chats.length) {
      results.innerHTML = `<div class="chat-empty">${query
        ? 'No conversations match that.'
        : 'Search across every conversation — titles and message text.'}</div>`;
      return;
    }

    chats.slice(0, 40).forEach((chat, index) => {
      const snippet = Store.searchSnippets.get(chat.id);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `search-item${index === activeIndex ? ' active' : ''}`;
      item.innerHTML = `
        <strong>${escapeHtml(chat.title)}</strong>
        ${snippet ? `<span class="search-snippet">…${escapeHtml(snippet)}…</span>` : ''}
        <span class="search-meta">${relTime(chat.updatedAt)} · ${chat.messages.length} messages</span>`;
      item.addEventListener('click', () => choose(chat.id));
      results.appendChild(item);
    });
  }

  function choose(id) {
    onOpenChat(id);
    closeSheet('searchSheet');
  }

  function move(delta) {
    if (!current.length) return;
    activeIndex = (activeIndex + delta + current.length) % current.length;
    const items = [...results.querySelectorAll('.search-item')];
    items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', debounce(() => {
    activeIndex = 0;
    render(input.value);
  }, 120));

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chat = current[activeIndex];
      if (chat) choose(chat.id);
    }
  });

  function open() {
    input.value = '';
    activeIndex = 0;
    render('');
    openSheet('searchSheet', { focus: false });
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  return { open, render, isOpen: () => !(document.getElementById('searchSheet')?.hidden ?? true) };
}
