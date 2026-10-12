/* ==========================================================================
   ui/status.js — one state machine for JARVIS and its animated energy core.

   States: idle · listening · thinking · generating · speaking · error.
   CSS owns the motion; the small JS update only changes data attributes.
   ========================================================================== */

import { $$ } from '../util.js';

export const STATES = ['idle', 'listening', 'thinking', 'generating', 'speaking', 'error'];

const LABELS = {
  idle: 'Idle',
  listening: 'Listening…',
  thinking: 'JARVIS is thinking…',
  generating: 'JARVIS is generating…',
  speaking: 'Speaking…',
  error: 'Something needs attention',
};

const CORE_LABELS = {
  idle: 'SYSTEMS NOMINAL',
  listening: 'VOICE INPUT · LISTENING',
  thinking: 'ANALYSING REQUEST',
  generating: 'COMPOSING RESPONSE',
  speaking: 'VOICE OUTPUT · ACTIVE',
  error: 'ATTENTION REQUIRED',
};

let current = 'idle';
const nodes = new Set();

function paint(state, label) {
  for (const node of nodes) {
    node.dataset.state = state;
    node.setAttribute('aria-label', `JARVIS status: ${label || LABELS[state]}`);
  }

  const app = document.getElementById('app');
  if (app) app.dataset.state = state;

  const core = document.getElementById('aiCore');
  if (core) {
    core.dataset.state = state;
    core.setAttribute('aria-label', `JARVIS energy core, ${label || LABELS[state]}`);
  }

  const coreLabel = document.getElementById('coreStateLabel');
  if (coreLabel) coreLabel.textContent = CORE_LABELS[state] || CORE_LABELS.idle;

  const stopSpeech = document.getElementById('btnStopSpeaking');
  if (stopSpeech) stopSpeech.hidden = state !== 'speaking';

  const inputStatus = document.getElementById('micStatusLabel');
  if (inputStatus) {
    inputStatus.textContent = state === 'listening'
      ? 'Listening…'
      : (inputStatus.dataset.baseLabel || 'Voice input available');
  }
  const voiceStatus = document.getElementById('voiceStatusLabel');
  if (voiceStatus) {
    voiceStatus.textContent = state === 'speaking'
      ? 'Speaking now'
      : state === 'listening'
        ? 'Listening…'
        : (voiceStatus.dataset.baseLabel || 'System voice status unavailable');
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

/** Keep the error visible briefly, then return the core to its calm idle state. */
let errorTimer = null;
export function setError(message, { ms = 6000 } = {}) {
  setStatus('error', { label: message || LABELS.error });
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => setStatus('idle'), ms);
}

export function initStatus() {
  for (const el of $$('.tralix-status')) registerStatusNode(el);
  setStatus('idle');
}
