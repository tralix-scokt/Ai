/* ==========================================================================
   ui/sheets.js — overlay manager for every dialog, sheet and drawer backdrop.

   Responsibilities:
     • show/hide with the transition classes
     • reference-counted body scroll lock (released on the last close)
     • Escape to close, focus restore, focus containment
     • swipe-down-to-dismiss on mobile
   Nothing else in the app toggles overflow or `hidden` on an overlay directly.
   ========================================================================== */

import { $, $$ } from '../util.js';
import { acquireScrollLock, releaseScrollLock } from '../scrolling.js';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** @type {string[]} open sheet ids, in open order */
const stack = [];
const lastFocus = new Map();

const backdropOf = (id) => document.getElementById(id);

export function isSheetOpen(id) {
  return stack.includes(id);
}

export const openSheets = () => [...stack];

export function openSheet(id, { focus = true, trigger = null } = {}) {
  const back = backdropOf(id);
  if (!back || stack.includes(id)) return;

  if (trigger instanceof HTMLElement) lastFocus.set(id, trigger);
  else if (document.activeElement instanceof HTMLElement) lastFocus.set(id, document.activeElement);

  back.hidden = false;
  document.documentElement.classList.add('sheet-open');
  stack.push(id);
  acquireScrollLock();

  requestAnimationFrame(() => {
    back.classList.add('on');
    if (focus) focusFirst(back);
  });
}

export function closeSheet(id) {
  const back = backdropOf(id);
  const index = stack.indexOf(id);
  if (index === -1) return;
  stack.splice(index, 1);

  if (back) {
    back.classList.remove('on');
    const finish = () => {
      if (stack.includes(id)) return;                 // reopened during the animation
      back.hidden = true;
      resetDrag(back);
    };
    const sheet = back.querySelector('.sheet, .search-panel');
    if (sheet) {
      const done = () => { sheet.removeEventListener('transitionend', done); finish(); };
      sheet.addEventListener('transitionend', done);
      setTimeout(done, 340);                          // fallback if the event never fires
    } else {
      finish();
    }
  }

  if (!stack.length) document.documentElement.classList.remove('sheet-open');
  releaseScrollLock();

  const previous = lastFocus.get(id);
  if (previous && document.contains(previous)) {
    try { previous.focus({ preventScroll: true }); } catch {}
  }
  lastFocus.delete(id);
}

export function closeTopSheet() {
  const top = stack[stack.length - 1];
  if (top) closeSheet(top);
  return top;
}

export function closeAllSheets() {
  for (const id of [...stack].reverse()) closeSheet(id);
}

/* ------------------------------- behaviour -------------------------------- */
function focusFirst(back) {
  const auto = back.querySelector('[data-autofocus]');
  const target = auto || [...back.querySelectorAll(FOCUSABLE)]
    .find(el => el.offsetParent !== null && el.tabIndex !== -1);
  if (target) {
    try { target.focus({ preventScroll: true }); } catch {}
  }
}

function trapFocus(event) {
  if (event.key !== 'Tab' || !stack.length) return;
  const back = backdropOf(stack[stack.length - 1]);
  if (!back) return;
  const items = [...back.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* swipe to dismiss ------------------------------------------------------- */
let drag = null;

function resetDrag(back) {
  const sheet = back?.querySelector?.('.sheet');
  if (sheet) sheet.style.transform = '';
}

function bindSwipe(back) {
  const sheet = back.querySelector('.sheet');
  const grip = back.querySelector('.sheet-grip');
  if (!sheet || !grip) return;

  grip.addEventListener('pointerdown', (event) => {
    if (window.matchMedia('(min-width: 900px)').matches) return;
    drag = { startY: event.clientY, sheet, offset: 0, active: true, back };
    sheet.style.transition = 'none';
    grip.setPointerCapture?.(event.pointerId);
  });

  const move = (event) => {
    if (!drag?.active) return;
    drag.offset = Math.max(0, event.clientY - drag.startY);
    drag.sheet.style.transform = `translateY(${drag.offset}px)`;
  };

  const end = () => {
    if (!drag?.active) return;
    const { offset, back: owner } = drag;
    const sheetEl = drag.sheet;
    drag = null;
    sheetEl.style.transition = '';
    if (offset > 90) {
      sheetEl.style.transform = '';
      const id = [...stack].reverse().find(s => backdropOf(s) === owner);
      if (id) closeSheet(id);
    } else {
      sheetEl.style.transform = '';
    }
  };

  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

/* --------------------------------- wiring --------------------------------- */
export function initSheets() {
  // backdrop click + [data-close] buttons
  document.addEventListener('click', (event) => {
    const closer = event.target.closest?.('[data-close]');
    if (closer) {
      event.preventDefault();
      closeSheet(closer.dataset.close);
      return;
    }
    const backdrop = event.target.classList?.contains('sheet-backdrop') ? event.target : null;
    if (backdrop && !backdrop.hidden) {
      // the search panel spans the backdrop, so check it was a real backdrop hit
      if (event.target === backdrop) closeSheet(backdrop.id);
    }
  });

  // Escape + focus containment
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && stack.length) {
      event.preventDefault();
      closeTopSheet();
      return;
    }
    trapFocus(event);
  });

  // never leave the page locked if the tab is backgrounded mid-dialog
  const unlock = () => { if (stack.length) stack.forEach(() => releaseScrollLock()); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) unlock(); });

  for (const back of $$('.sheet-backdrop')) bindSwipe(back);
}

/** Small helper for sheets created before init runs. */
export function sheetElement(id) { return backdropOf(id); }
export { $ as query, $$ as queryAll };
