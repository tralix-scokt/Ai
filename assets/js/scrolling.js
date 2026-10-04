/* ========================================================================
   scrolling.js — scroll, viewport and scroll-lock helpers.

   The mobile scroll contract (requirement 31):
     • the document itself never scrolls; the message column does
     • nothing sets `overflow:hidden` on html/body permanently
     • a real modal/drawer takes the lock and always releases it on close
   ======================================================================== */

/** Is a scroll container close enough to its end to stay pinned? */
export function isNearBottom(scroller, slack = 120) {
  if (!scroller) return true;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < slack;
}

/**
 * Keep the app fitted to the visible viewport (mobile keyboard, Safari chrome,
 * rotation) while preserving the reader's scroll intent.
 * Returns a cleanup function.
 */
export function bindVisualViewport({
  app,
  chat,
  visualViewport = typeof window !== 'undefined' ? window.visualViewport : null,
  scrollToBottom,
  scheduleFrame = (callback) => requestAnimationFrame(callback),
  onResize,
}) {
  if (!visualViewport || !app) return () => {};

  let lastHeight = visualViewport.height;
  let lastOffsetTop = visualViewport.offsetTop || 0;

  const fit = () => {
    const wasNearBottom = isNearBottom(chat);
    const height = visualViewport.height;
    const offsetTop = visualViewport.offsetTop || 0;
    const changed = Math.abs(height - lastHeight) > 0.5 || Math.abs(offsetTop - lastOffsetTop) > 0.5;

    // CSS custom properties drive the layout; the explicit height is the
    // fallback for browsers without `dvh` support.
    if (app.style) {
      app.style.setProperty?.('--vvh', `${height}px`);
      app.style.height = `${height}px`;
      app.style.transform = offsetTop ? `translateY(${offsetTop}px)` : '';
    }

    lastHeight = height;
    lastOffsetTop = offsetTop;

    onResize?.({ height, offsetTop, changed });

    if (changed && wasNearBottom) scheduleFrame(() => scrollToBottom(true));
  };

  visualViewport.addEventListener('resize', fit);
  visualViewport.addEventListener('scroll', fit);
  fit();

  return () => {
    visualViewport.removeEventListener('resize', fit);
    visualViewport.removeEventListener('scroll', fit);
  };
}

/* ----------------------------- scroll locking ----------------------------- */
/**
 * Reference-counted body scroll lock. Used only while a drawer or modal is
 * genuinely open, and released the moment the last one closes — including on
 * page hide, orientation change and route-ish transitions.
 */
const lock = {
  count: 0,
  scrollY: 0,
  saved: null,
};

export function acquireScrollLock() {
  lock.count += 1;
  if (lock.count > 1 || typeof document === 'undefined') return;

  const body = document.body;
  lock.scrollY = (typeof window !== 'undefined' && window.scrollY) || 0;
  lock.saved = {
    overflow: body.style.overflow,
    overscroll: body.style.overscrollBehavior,
  };

  // Overflow only: position-fixed locking and touch-action:none are the classic
  // causes of "the page will not scroll any more" on iOS, and touch-action
  // would also stop the sheet's own inner scroller from panning.
  body.style.overflow = 'hidden';
  body.style.overscrollBehavior = 'contain';
}

export function releaseScrollLock() {
  lock.count = Math.max(0, lock.count - 1);
  if (lock.count > 0 || typeof document === 'undefined') return;

  const body = document.body;
  if (lock.saved) {
    body.style.overflow = lock.saved.overflow || '';
    body.style.overscrollBehavior = lock.saved.overscroll || '';
  } else {
    body.style.overflow = '';
    body.style.overscrollBehavior = '';
  }
  lock.saved = null;
  try { window.scrollTo(0, lock.scrollY || 0); } catch { /* jsdom / sandboxed webviews */ }
}

/** Safety valve: never leave the page locked (page hide, SW update, bfcache). */
export function forceReleaseScrollLock() {
  lock.count = 0;
  releaseScrollLock();
}

export const scrollLockActive = () => lock.count > 0;
export const scrollLockCount = () => lock.count;

/** Scroll a container to the end, optionally without animation. */
export function scrollToEnd(scroller, instant = false) {
  if (!scroller) return;
  scroller.classList.toggle('no-anim', instant);
  scroller.scrollTop = scroller.scrollHeight;
  if (instant) requestAnimationFrame(() => scroller.classList.remove('no-anim'));
}

/**
 * Scroll the first changed element into view inside a scroller, used by the
 * streaming renderer so the growing reply stays visible without jitter.
 */
export function keepElementVisible(scroller, element, slack = 160) {
  if (!scroller || !element) return;
  const rect = element.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const overflowBottom = rect.bottom - box.bottom;
  if (overflowBottom > 0 && overflowBottom < slack * 4) {
    scroller.scrollTop += overflowBottom;
  }
}
