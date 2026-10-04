/* ==========================================================================
   util.js — small shared helpers
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

export function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

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

/** Day bucket used for the chat dividers. */
export function dayBucket(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if ((now - d) < 86400 * 7 * 1000) return 'Previous 7 days';
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

export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch {}
}

/** Rough token-ish estimate so we can show context pressure. */
export const estimateTokens = (text = '') => Math.ceil(String(text).length / 4);

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

/* --------------------------------- toast --------------------------------- */
let toastTimer = null;
export function toast(msg, ms = 2000) {
  const el = document.getElementById('toast');
  const txt = document.getElementById('toastText');
  if (!el || !txt) return;
  txt.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;                 // reflow to restart the animation
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* -------------------------------- confirm -------------------------------- */
export function confirmDialog(title, body, yesLabel = 'Yes') {
  return new Promise(resolve => {
    const back = document.getElementById('confirmSheet');
    const t = document.getElementById('confirmTitle');
    const b = document.getElementById('confirmBody');
    const yes = document.getElementById('confirmYes');
    const no  = document.getElementById('confirmNo');

    t.textContent = title;
    b.textContent = body;
    yes.textContent = yesLabel;
    back.hidden = false;
    requestAnimationFrame(() => back.classList.add('on'));

    const done = (val) => {
      back.classList.remove('on');
      setTimeout(() => { back.hidden = true; }, 280);
      yes.onclick = no.onclick = back.onclick = null;
      resolve(val);
    };
    yes.onclick = () => done(true);
    no.onclick  = () => done(false);
    back.onclick = (e) => { if (e.target === back) done(false); };
  });
}

/** Autosize a textarea to its content, capped by CSS max-height. */
export function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
}
