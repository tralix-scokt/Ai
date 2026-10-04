/* ==========================================================================
   util.js — small shared helpers (pure + tiny DOM utilities).
   No app state lives here; anything stateful belongs in its own module.
   ========================================================================== */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Escape untrusted text before it ever touches innerHTML. */
export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow safe link targets. */
export function safeUrl(url = '') {
  const u = String(url).trim();
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
  if (/^#/.test(u)) return u;
  return '#';
}

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** "3m ago" / "Yesterday" style relative time, iPhone-ish. */
export function relTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;

  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';

  if (diff < 86400 * 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatDateTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString([], {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

/** Day bucket used for chat dividers and the sidebar's chat groups. */
export function dayBucket(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if ((now - d) < 86400 * 7 * 1000) return 'Previous 7 days';
  if ((now - d) < 86400 * 30 * 1000) return 'Previous 30 days';
  return 'Older';
}

export function greeting() {
  const h = new Date().getHours();
  if (h < 5)  return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Good night';
}

/** Yield to the browser so streaming stays smooth. */
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch {}
}

export function debounce(fn, ms = 150) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Rough token-ish estimate so we can show context pressure. */
export const estimateTokens = (text = '') => Math.ceil(String(text).length / 4);

export function formatBytes(bytes = 0) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/* ------------------------------- clipboard ------------------------------- */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // iOS Safari fallback
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* -------------------------------- downloads ------------------------------- */
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Autosize a textarea to its content, capped by CSS max-height. */
export function autosize(ta, maxPx) {
  if (!ta) return;
  const cap = maxPx || Math.min(Math.round(window.innerHeight * 0.42), 260);
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, cap)}px`;
}

/** prefers-reduced-motion, read live. */
export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
