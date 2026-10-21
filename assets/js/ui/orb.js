/* ==========================================================================
   ui/orb.js — the JARVIS orb.

   One state, every orb. The state is what JARVIS is actually doing:
     idle · listening · thinking · speaking · error · offline
   The orb never animates for decoration — every movement maps to one of
   those states, and `prefers-reduced-motion` turns the movement off while
   keeping the colour cue.
   ========================================================================== */

const STATES = ['idle', 'listening', 'thinking', 'speaking', 'error', 'offline'];

const LABELS = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Needs attention',
  offline: 'Offline',
};

let current = 'idle';
const orbs = new Set();
const listeners = new Set();

export function registerOrb(element) {
  if (!element) return { release() {} };
  element.dataset.state = current;
  orbs.add(element);
  return {
    release() { orbs.delete(element); },
  };
}

export function onOrbState(fn) {
  listeners.add(fn);
  fn(current, LABELS[current]);
  return () => listeners.delete(fn);
}

/** @param {'idle'|'listening'|'thinking'|'speaking'|'error'|'offline'} state */
export function setOrbState(state, { detail = '' } = {}) {
  const next = STATES.includes(state) ? state : 'idle';
  if (next !== current) {
    current = next;
    for (const orb of [...orbs]) {
      if (!orb.isConnected) { orbs.delete(orb); continue; }
      orb.dataset.state = current;
      orb.setAttribute('aria-label', `JARVIS status: ${LABELS[current]}`);
    }
    for (const fn of [...listeners]) {
      try { fn(current, LABELS[current], detail); } catch { /* a bad listener must not break the UI */ }
    }
  }
  return current;
}

export const orbState = () => current;
export const orbLabel = (state = current) => LABELS[state] || LABELS.idle;

/** Bind every [data-orb] element found now, and any added later. */
export function bindOrbs(root = document) {
  for (const el of root.querySelectorAll?.('.orb') || []) registerOrb(el);
}
