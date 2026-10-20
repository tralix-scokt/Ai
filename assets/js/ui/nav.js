/* ==========================================================================
   ui/nav.js — the workspace navigation.

   Five areas: Home · Projects · JARVIS Assistant · AI Models · Settings.
   Desktop shows them in the rail; mobile shows the same five in the bottom
   bar. Both stay in sync because there is one source of truth here.

   Views stay mounted when hidden, so a stream that is still running in the
   Assistant keeps running while you look at a diff.
   ========================================================================== */

import { $ } from '../util.js';

export const VIEWS = ['home', 'projects', 'assistant', 'models', 'settings'];

export const VIEW_TITLES = {
  home: 'Overview',
  projects: 'Projects',
  assistant: 'JARVIS Assistant',
  models: 'AI Models',
  settings: 'Settings',
};

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings
 * @param {(settings:object)=>void} deps.saveSettings
 * @param {(view:string)=>void} [deps.onChange]
 */
export function createNav({ getSettings, saveSettings, onChange = () => {} } = {}) {
  const buttons = [...(document.querySelectorAll('[data-view]') || [])]
    .filter(el => VIEWS.includes(el.dataset.view));
  const views = new Map(
    VIEWS.map(name => [name, document.getElementById(`view-${name}`)]).filter(([, el]) => el),
  );
  const titleEl = $('#viewTitle');
  let current = 'assistant';

  function paint(view) {
    current = VIEWS.includes(view) ? view : 'assistant';
    for (const [name, el] of views) {
      const active = name === current;
      el.classList.toggle('is-active', active);
      el.hidden = !active;
    }
    for (const button of buttons) {
      const active = button.dataset.view === current;
      button.classList.toggle('is-active', active);
      if (button.classList.contains('rail-item')) {
        if (active) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      } else if (button.classList.contains('tab-item')) {
        button.setAttribute('aria-current', active ? 'page' : 'false');
      }
    }
    if (titleEl) titleEl.textContent = VIEW_TITLES[current] || '';
    document.documentElement.dataset.view = current;
  }

  function go(view, { persist = true } = {}) {
    if (!VIEWS.includes(view)) return;
    paint(view);
    if (persist) {
      const settings = getSettings?.() || {};
      saveSettings?.({ ...settings, view });
    }
    onChange?.(view);
  }

  for (const button of buttons) {
    button.addEventListener('click', () => go(button.dataset.view));
  }

  // ⌘/Ctrl + 1…5 jumps between the areas, matching the visible order.
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const index = Number(event.key);
    if (Number.isInteger(index) && index >= 1 && index <= VIEWS.length) {
      event.preventDefault();
      go(VIEWS[index - 1]);
    }
  });

  return {
    go,
    current: () => current,
    /** Restore the last area the user was in (defaults to the Assistant). */
    restore() {
      const saved = getSettings?.()?.view;
      go(VIEWS.includes(saved) ? saved : 'assistant', { persist: false });
    },
    views,
  };
}
