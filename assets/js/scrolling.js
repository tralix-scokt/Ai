/* ========================================================================
   scrolling.js — scroll and visual-viewport helpers for the chat layout.
   ======================================================================== */

/** Return whether a scroll container is close enough to its end to stay pinned. */
export function isNearBottom(scroller, slack = 120) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < slack;
}

/**
 * Keep the fixed app inside the visible viewport (not behind a mobile keyboard)
 * and preserve the user's current scroll intent while the viewport changes.
 *
 * Returns a cleanup function so callers/tests can remove the viewport listeners.
 */
export function bindVisualViewport({
  app,
  chat,
  visualViewport,
  scrollToBottom,
  scheduleFrame = (callback) => requestAnimationFrame(callback),
}) {
  if (!visualViewport) return () => {};

  let lastHeight = visualViewport.height;
  let lastOffsetTop = visualViewport.offsetTop || 0;

  const fit = () => {
    // Read before resizing the app: this captures whether the reader was at the
    // bottom before the keyboard or browser chrome changed the visible height.
    const wasNearBottom = isNearBottom(chat);
    const height = visualViewport.height;
    const offsetTop = visualViewport.offsetTop || 0;
    const viewportChanged = Math.abs(height - lastHeight) > 0.5
      || Math.abs(offsetTop - lastOffsetTop) > 0.5;

    app.style.height = `${height}px`;
    app.style.transform = offsetTop ? `translateY(${offsetTop}px)` : '';

    lastHeight = height;
    lastOffsetTop = offsetTop;

    // Keep the latest reply visible only when the user was already following it.
    // In particular, do not yank someone back down while they read older messages
    // with the keyboard open.
    if (viewportChanged && wasNearBottom) {
      scheduleFrame(() => scrollToBottom(true));
    }
  };

  visualViewport.addEventListener('resize', fit);
  visualViewport.addEventListener('scroll', fit);
  fit();

  return () => {
    visualViewport.removeEventListener('resize', fit);
    visualViewport.removeEventListener('scroll', fit);
  };
}
