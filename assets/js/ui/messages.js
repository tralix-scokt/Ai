/* ==========================================================================
   ui/messages.js — message rendering and response actions.

   User turns render as a quiet bubble; TRALIX turns use the full column with a
   small identity row, markdown body and a restrained action bar that reveals
   secondary options behind "More".
   ========================================================================== */

import { escapeHtml, relTime } from '../util.js';
import { renderMarkdown } from '../markdown.js';

const ICON = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  speak: '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  up: '<path d="M7 11l5-6 5 6"/><path d="M7.5 15.5c1.3-1 2.9-1.5 4.5-1.5s3.2.5 4.5 1.5"/>',
  down: '<path d="M7 13l5 6 5-6"/><path d="M7.5 8.5c1.3 1 2.9 1.5 4.5 1.5s3.2-.5 4.5-1.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  edit: '<path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.1"/>',
  link: '<path d="M10 13a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6"/><path d="M14 11a4 4 0 0 0-5.7 0L5.7 13.6a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
};

const svg = (path, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}">${path}</svg>`;

/** The identity row above a TRALIX reply. */
function headHtml(modelLabel = '') {
  return `<div class="msg-head">
    <span class="msg-avatar" aria-hidden="true">T</span>
    <span class="msg-name">TRALIX</span>
    ${modelLabel ? `<span class="msg-model">· ${escapeHtml(modelLabel)}</span>` : ''}
  </div>`;
}

export function typingHtml(label = 'TRALIX is thinking…') {
  return `<div class="typing"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(label)}</div>`;
}

/**
 * Build a message element.
 * @param {object} msg
 * @param {object} ctx
 * @param {boolean} ctx.streaming
 * @param {string} ctx.modelLabel
 * @param {(action:string, msg:object)=>void} ctx.onAction
 */
export function messageNode(msg, ctx = {}) {
  const el = document.createElement('div');
  el.dataset.id = msg.id;

  if (msg.role === 'user') {
    el.className = 'msg msg-user';
    el.innerHTML = `<div class="bubble">${escapeHtml(msg.text)}</div>
      <div class="msg-actions"></div>`;
    buildUserActions(el, msg, ctx);
    return el;
  }

  el.className = `msg msg-bot${msg.error ? ' msg-error' : ''}${msg.incomplete ? ' incomplete' : ''}`;
  el.innerHTML = `${headHtml(ctx.streaming || msg.pending ? ctx.modelLabel : ctx.modelLabel)}
    <div class="msg-body"></div>
    <div class="msg-actions"></div>`;

  const body = el.querySelector('.msg-body');
  if (msg.pending && !msg.text) {
    body.innerHTML = typingHtml();
  } else if (msg.error) {
    body.innerHTML = errorHtml(msg);
  } else {
    body.innerHTML = renderMarkdown(msg.text || '');
  }

  if (!msg.pending) buildBotActions(el, msg, ctx);
  return el;
}

/** Update only the body of an existing node — used while streaming. */
export function updateMessageBody(node, msg, { caret = false } = {}) {
  const body = node?.querySelector('.msg-body');
  if (!body) return;
  body.innerHTML = renderMarkdown(msg.text || '') + (caret ? '<span class="caret" aria-hidden="true"></span>' : '');
}

export function updateMessageHead(node, modelLabel) {
  const head = node?.querySelector('.msg-head');
  if (head) head.innerHTML = headHtml(modelLabel).trim().replace(/^<div class="msg-head">|<\/div>$/g, '');
}

/* --------------------------------- errors --------------------------------- */
function errorHtml(msg) {
  const title = escapeHtml(msg.errorTitle || 'Unable to complete that request');
  const detail = escapeHtml(msg.text || '');
  return `<div class="err">
    <p class="err-title">${svg(ICON.warn)} ${title}</p>
    ${detail ? `<p>${detail}</p>` : ''}
  </div>`;
}

/* -------------------------------- actions -------------------------------- */
function actionButton({ label, icon, onClick, cls = '', title = '' }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `act ${cls}`.trim();
  b.innerHTML = `${icon ? svg(icon) : ''}<span>${escapeHtml(label)}</span>`;
  if (title) b.title = title;
  b.setAttribute('aria-label', title || label);
  b.addEventListener('click', onClick);
  return b;
}

function buildUserActions(node, msg, ctx) {
  const bar = node.querySelector('.msg-actions');
  if (!bar) return;
  bar.setAttribute('aria-label', 'Message actions');

  bar.appendChild(actionButton({
    label: 'Copy', icon: ICON.copy,
    onClick: () => ctx.onAction?.('copy', msg),
  }));
  if (ctx.isLast && !ctx.streaming) {
    bar.appendChild(actionButton({
      label: 'Edit', icon: ICON.edit,
      onClick: () => ctx.onAction?.('edit', msg),
    }));
  }
}

/** Codes that mean "the connection is the problem", not "the question was bad". */
const CONNECTION_CODES = new Set(['network', 'timeout', 'offline', 'unauthorized', 'invalid_config', 'provider_unavailable']);

function buildErrorActions(node, msg, ctx) {
  const bar = node.querySelector('.msg-actions');
  if (!bar) return;
  bar.setAttribute('aria-label', 'Failed response actions');

  /*
   * Retry is always offered on a failed turn. A config or connection failure is
   * precisely when the user needs it: they fix the backend and tap again. It
   * re-sends the same turn — nothing is invented and nothing is lost.
   */
  bar.appendChild(actionButton({
    label: 'Retry',
    icon: ICON.retry,
    cls: 'primary',
    title: 'Send this message again',
    onClick: () => ctx.onAction?.('retry', msg),
  }));
  if (CONNECTION_CODES.has(msg.code)) {
    bar.appendChild(actionButton({
      label: 'Connection',
      icon: ICON.link,
      title: 'Check the TRALIX backend connection',
      onClick: () => ctx.onAction?.('fix-connection', msg),
    }));
  }
  bar.appendChild(actionButton({
    label: 'Copy',
    icon: ICON.copy,
    onClick: () => ctx.onAction?.('copy', msg),
  }));
}

function buildBotActions(node, msg, ctx) {
  if (msg.error) return buildErrorActions(node, msg, ctx);
  const bar = node.querySelector('.msg-actions');
  if (!bar) return;
  bar.setAttribute('aria-label', 'Response actions');

  if (msg.incomplete) {
    // Real text, unfinished stream: keep the answer, offer the obvious next move.
    bar.appendChild(actionButton({
      label: 'Retry',
      icon: ICON.retry,
      cls: 'primary',
      title: 'Ask again — the previous answer was cut short',
      onClick: () => ctx.onAction?.('retry', msg),
    }));
  }

  bar.appendChild(actionButton({
    label: 'Copy', icon: ICON.copy,
    onClick: () => ctx.onAction?.('copy', msg),
  }));

  if (ctx.isLast && !ctx.streaming) {
    bar.appendChild(actionButton({
      label: 'Regenerate', icon: ICON.retry,
      onClick: () => ctx.onAction?.('regenerate', msg),
    }));
  }

  if (ctx.ttsSupported) {
    const speaking = ctx.speakingId === msg.id;
    const btn = actionButton({
      label: speaking ? 'Stop' : 'Read aloud',
      icon: speaking ? ICON.stop : ICON.speak,
      cls: speaking ? 'on' : '',
      onClick: () => ctx.onAction?.('speak', msg),
    });
    btn.dataset.role = 'speak';
    bar.appendChild(btn);
  }

  const good = actionButton({
    label: 'Good response', icon: ICON.up,
    cls: msg.feedback === 'up' ? 'on good' : '',
    onClick: () => ctx.onAction?.('feedback-up', msg),
  });
  good.dataset.role = 'feedback-up';
  bar.appendChild(good);

  const bad = actionButton({
    label: 'Bad response', icon: ICON.down,
    cls: msg.feedback === 'down' ? 'on bad' : '',
    onClick: () => ctx.onAction?.('feedback-down', msg),
  });
  bad.dataset.role = 'feedback-down';
  bar.appendChild(bad);

  const more = actionButton({
    label: 'More', icon: ICON.more,
    onClick: (event) => toggleMore(event.currentTarget),
  });
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  bar.appendChild(more);

  bar.appendChild(moreMenu(msg, ctx));
}

const MORE_ITEMS = [
  { id: 'continue', label: 'Continue' },
  { id: 'shorter', label: 'Shorter' },
  { id: 'longer', label: 'Longer' },
  { id: 'explain', label: 'Explain' },
  { id: 'rewrite', label: 'Rewrite' },
  { id: 'save', label: 'Save' },
];

function moreMenu(msg, ctx) {
  const menu = document.createElement('div');
  menu.className = 'more-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');

  for (const item of MORE_ITEMS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    b.addEventListener('click', () => {
      menu.hidden = true;
      ctx.onAction?.(`more:${item.id}`, msg);
    });
    menu.appendChild(b);
  }
  return menu;
}

function toggleMore(button) {
  const bar = button.parentElement;
  const menu = bar?.querySelector('.more-menu');
  if (!menu) return;
  const willOpen = menu.hidden;
  // close any other open menus first
  document.querySelectorAll('.more-menu:not([hidden])').forEach(m => { m.hidden = true; });
  document.querySelectorAll('.act[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  menu.hidden = !willOpen;
  button.setAttribute('aria-expanded', String(willOpen));
}

export function closeAllMoreMenus() {
  document.querySelectorAll('.more-menu:not([hidden])').forEach(m => { m.hidden = true; });
  document.querySelectorAll('.act[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}

/* ------------------------------- utilities -------------------------------- */
export function dayDivider(label) {
  const el = document.createElement('div');
  el.className = 'day-divider';
  el.textContent = label;
  return el;
}

export function messageMeta(msg) {
  return `${msg.role === 'assistant' ? 'TRALIX' : 'You'} · ${relTime(msg.ts)}`;
}
