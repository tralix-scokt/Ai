/* ==========================================================================
   ui/composer.js — the message composer.

   Behaviour: auto-resize, Enter to send (Shift+Enter for a newline), disabled
   send while empty, stop button while streaming, mic with a clear recording
   state, and the draft is never lost on error.
   ========================================================================== */

import { $, autosize, haptic } from '../util.js';

export function createComposer({
  onSubmit = () => {},
  onStop = () => {},
  onMic = () => {},
  onAttach = () => {},
  onDraft = () => {},
} = {}) {
  const form = $('#composer');
  const input = $('#composer-input');
  const send = $('#btnSend');
  const stop = $('#btnStop');
  const mic = $('#btnMic');
  const attach = $('#btnAttach');

  let streaming = false;

  const sync = () => {
    const has = input.value.trim().length > 0;
    send.disabled = !has || streaming;
    send.hidden = streaming;
    stop.hidden = !streaming;
    mic.hidden = false;
    mic.setAttribute('aria-pressed', String(mic.classList.contains('rec')));
  };

  const resize = () => autosize(input);

  input.addEventListener('input', () => {
    resize();
    sync();
    onDraft(input.value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (event.shiftKey || event.altKey || event.metaKey) return;   // newline
    event.preventDefault();
    if (!send.disabled) form.requestSubmit();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || streaming) return;
    haptic(6);
    onSubmit(text);
  });

  stop.addEventListener('click', () => onStop());
  mic.addEventListener('click', () => onMic());
  attach.addEventListener('click', () => onAttach());

  // Keep the layout honest when the keyboard resizes the visual viewport.
  window.visualViewport?.addEventListener('resize', () => {
    if (document.activeElement === input) resize();
  });

  return {
    el: input,
    get value() { return input.value; },
    setValue(text, { focus = true, caretAtEnd = true } = {}) {
      input.value = text;
      resize();
      sync();
      onDraft(input.value);
      if (focus) {
        input.focus({ preventScroll: true });
        if (caretAtEnd) {
          try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
        }
      }
    },
    clear() { this.setValue('', { focus: false }); },
    focus() { try { input.focus({ preventScroll: true }); } catch {} },
    blur() { input.blur(); },
    append(text) {
      const next = this.value ? `${this.value.trimEnd()} ${text}` : text;
      this.setValue(next);
    },
    setStreaming(on) {
      streaming = Boolean(on);
      sync();
    },
    isStreaming: () => streaming,
    setRecording(on) {
      mic.classList.toggle('rec', Boolean(on));
      form.classList.toggle('rec', Boolean(on));
      mic.setAttribute('aria-pressed', String(Boolean(on)));
    },
    setAttachEnabled(on) {
      attach.disabled = !on;
    },
    sync,
    resize,
  };
}
