/* ==========================================================================
   ui/status.js — the TRALIX intelligence indicator.

   One tiny state machine drives every indicator on screen (sidebar, top bar,
   composer voice bar). States: idle · listening · thinking · generating ·
   speaking · error. Animations are CSS-only and respect prefers-reduced-motion.
   ========================================================================== */

import { $$ } from '../util.js';

export const STATES = ['idle', 'listening', 'thinking', 'generating', 'speaking', 'error'];

const LABELS = {
  idle: 'Idle',
  listening: 'Listening…',
  thinking: 'TRALIX is thinking…',
  generating: 'TRALIX is generating…',
  speaking: 'Speaking…',
  error: 'Something went wrong',
};

let current = 'idle';
const nodes = new Set();

function paint(state, label) {
  for (const node of nodes) {
    node.dataset.state = state;
    node.setAttribute('aria-label', `TRALIX status: ${label || LABELS[state]}`);
  }
  const labelEl = document.getElementById('statusSidebarLabel');
  if (labelEl) labelEl.textContent = label || LABELS[state];
}

/** Register an element as a status indicator. */
export function registerStatusNode(el) {
  if (!el) return () => {};
  nodes.add(el);
  el.dataset.state = current;
  return () => nodes.delete(el);
}

export function setStatus(state, { label } = {}) {
  const next = STATES.includes(state) ? state : 'idle';
  current = next;
  paint(next, label);
  return next;
}

export function getStatus() { return current; }

/** Remember the last good state so an error can be cleared back to idle. */
let errorTimer = null;
export function setError(message, { ms = 6000 } = {}) {
  setStatus('error');
  const labelEl = document.getElementById('statusSidebarLabel');
  if (labelEl) labelEl.textContent = message || LABELS.error;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => setStatus('idle'), ms);
}

export function initStatus() {
  for (const el of $$('.tralix-status')) registerStatusNode(el);
  setStatus('idle');
}
