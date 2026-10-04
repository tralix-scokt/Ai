/* ==========================================================================
   ui/feedback.js — toast, confirm and prompt dialogs.

   The toast supports one action button, which is how "undo" works for chat
   deletion and archiving.
   ========================================================================== */

import { $ } from '../util.js';
import { openSheet, closeSheet } from './sheets.js';

/* --------------------------------- toast --------------------------------- */
let toastTimer = null;
let toastActionHandler = null;

/**
 * @param {string} message
 * @param {object} [opts]
 * @param {number} [opts.ms]        how long to show
 * @param {string} [opts.action]    label for the action button
 * @param {Function} [opts.onAction]
 * @param {'info'|'error'|'success'} [opts.tone]
 */
export function toast(message, { ms = 2200, action, onAction, tone = 'info' } = {}) {
  const el = $('#toast');
  const txt = $('#toastText');
  const btn = $('#toastAction');
  if (!el || !txt) return;

  txt.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;                 // reflow so the animation restarts
  el.style.animation = '';

  if (action && typeof onAction === 'function') {
    btn.hidden = false;
    btn.textContent = action;
    toastActionHandler = () => {
      toastActionHandler = null;
      hideToast();
      onAction();
    };
  } else {
    btn.hidden = true;
    toastActionHandler = null;
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  const el = $('#toast');
  if (el) el.hidden = true;
  toastActionHandler = null;
}

export function initToast() {
  const btn = $('#toastAction');
  btn?.addEventListener('click', () => toastActionHandler?.());
}

/* -------------------------------- confirm -------------------------------- */
/**
 * @param {string} title
 * @param {string} body
 * @param {string} [yesLabel]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(title, body, yesLabel = 'Yes') {
  return new Promise(resolve => {
    const back = $('#confirmSheet');
    const t = $('#confirmTitle');
    const b = $('#confirmBody');
    const yes = $('#confirmYes');
    const no = $('#confirmNo');
    if (!back) return resolve(false);

    t.textContent = title;
    b.textContent = body;
    yes.textContent = yesLabel;

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      yes.onclick = no.onclick = null;
      closeSheet('confirmSheet');
      resolve(value);
    };

    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    openSheet('confirmSheet', { focus: true });

    // focus the safe option first
    requestAnimationFrame(() => no.focus({ preventScroll: true }));
  });
}

/* --------------------------------- prompt -------------------------------- */
/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.value]
 * @param {string} [opts.placeholder]
 * @param {string} [opts.confirmLabel]
 * @param {number} [opts.maxLength]
 * @returns {Promise<string|null>}
 */
export function promptDialog({
  title,
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  maxLength = 120,
} = {}) {
  return new Promise(resolve => {
    const input = $('#promptInput');
    const confirm = $('#promptConfirm');
    const cancel = $('#promptCancel');
    const titleEl = $('#promptTitle');
    if (!input || !confirm) return resolve(null);

    titleEl.textContent = title;
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    confirm.textContent = confirmLabel;

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      input.onkeydown = null;
      confirm.onclick = cancel.onclick = null;
      closeSheet('promptSheet');
      resolve(result);
    };

    confirm.onclick = () => done(input.value.trim() || null);
    cancel.onclick = () => done(null);
    input.onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); done(input.value.trim() || null); }
      if (event.key === 'Escape') { event.preventDefault(); done(null); }
    };

    openSheet('promptSheet', { focus: false });
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  });
}

/* ------------------------------- skeletons -------------------------------- */
export const skeletonHtml = (rows = 3) =>
  `<div class="skeleton" aria-hidden="true">${'<span></span>'.repeat(rows)}</div>`;
