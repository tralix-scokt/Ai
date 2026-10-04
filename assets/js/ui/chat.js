/* ==========================================================================
   ui/chat.js — the conversation controller.

   Owns: which conversation is open, sending, streaming, stopping, regenerating,
   response actions, memory capture and auto-speak. It renders through
   ui/messages.js and reports state changes to the app shell.
   ========================================================================== */

import { $, uid, haptic, copyText, dayBucket } from '../util.js';
import { stripMarkdown, toCopyText } from '../markdown.js';
import { FEATURES, LIMITS } from '../config.js';
import { TralixError, ERROR_CODES, errorLabel } from '../errors.js';
import { modelLabel, RESPONSE_ACTIONS } from '../models.js';
import { isRememberRequest, extractMemoryCandidates, replySummary } from '../personality.js';
import { needsLiveInfo } from '../tools.js';
import * as Store from '../store.js';
import * as Voice from '../voice.js';
import * as Api from '../api/chat.js';
import { isNearBottom, scrollToEnd } from '../scrolling.js';
import { messageNode, updateMessageBody, dayDivider, closeAllMoreMenus } from './messages.js';
import { toast } from './feedback.js';
import { setStatus, setError } from './status.js';

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings
 * @param {() => object|null} deps.getChat
 * @param {(chat:object|null)=>void} deps.setChat
 * @param {() => void} deps.persist               save the current chat and refresh lists
 * @param {() => void} [deps.onChatsChanged]
 * @param {object} deps.composer                  from ui/composer.js
 * @param {(id:string|null)=>void} [deps.onSpeakingChange]
 */
export function createChatController(deps) {
  const {
    getSettings, getChat, setChat, persist,
    onChatsChanged = () => {},
    composer,
    onSpeakingChange = () => {},
  } = deps;

  const scrollEl = $('#chatScroll');
  const welcomeEl = $('#welcome');
  const messagesEl = $('#messages');
  const jumpBtn = $('#jumpBtn');

  let streaming = false;
  let controller = null;
  let speakingId = null;

  /* ------------------------------- rendering ------------------------------ */
  function render() {
    const chat = getChat();
    const messages = chat?.messages || [];

    closeAllMoreMenus();
    messagesEl.innerHTML = '';
    messagesEl.hidden = messages.length === 0;
    welcomeEl.hidden = messages.length > 0;

    let bucket = null;
    messages.forEach((msg, index) => {
      if (msg.hidden) return;
      const next = dayBucket(msg.ts);
      if (next !== bucket) {
        bucket = next;
        messagesEl.appendChild(dayDivider(next));
      }
      messagesEl.appendChild(messageNode(msg, contextFor(msg, index, messages)));
    });

    if (!messages.length) renderWelcome();
    syncJumpButton();
  }

  function contextFor(msg, index, messages) {
    const visible = messages.filter(m => !m.hidden);
    const isLast = visible[visible.length - 1]?.id === msg.id;
    return {
      streaming: streaming && isLast && msg.role === 'assistant',
      isLast,
      speakingId,
      ttsSupported: Voice.ttsSupported,
      modelLabel: modelLabel(getSettings().model),
      onAction: handleAction,
    };
  }

  /** Re-render a single message node in place (keeps scroll position stable). */
  function refreshNode(msg) {
    const node = messagesEl.querySelector(`[data-id="${msg.id}"]`);
    if (!node) { render(); return; }
    const chat = getChat();
    const index = chat.messages.findIndex(m => m.id === msg.id);
    const fresh = messageNode(msg, contextFor(msg, index, chat.messages));
    node.replaceWith(fresh);
  }

  function renderWelcome() {
    const settings = getSettings();
    $('#welcomeQuestion').textContent = 'What can I help you accomplish?';
    const note = $('#welcomeNote');
    const text = $('#welcomeNoteText');
    const btn = $('#welcomeNoteBtn');

    if (settings.advanced.transport === 'local') {
      note.hidden = false;
      text.textContent = 'Using your own provider key on this device.';
      btn.textContent = 'Change';
      btn.onclick = () => deps.onOpenSettings?.('advanced');
    } else {
      const health = deps.getHealth?.();
      if (health && !health.ok) {
        note.hidden = false;
        text.textContent = health.message || 'The TRALIX backend is not reachable.';
        btn.textContent = 'Set up';
        btn.onclick = () => deps.onOpenConnect?.();
      } else {
        note.hidden = true;
      }
    }
  }

  /* -------------------------------- scrolling ----------------------------- */
  function syncJumpButton() {
    jumpBtn.hidden = isNearBottom(scrollEl, 140) || !(getChat()?.messages?.length);
  }

  function pinToBottom(instant = false) {
    scrollToEnd(scrollEl, instant);
    jumpBtn.hidden = true;
  }

  scrollEl.addEventListener('scroll', () => { syncJumpButton(); }, { passive: true });
  jumpBtn.addEventListener('click', () => pinToBottom());

  /* --------------------------------- chats -------------------------------- */
  function newChat({ focus = true } = {}) {
    stopStreaming({ silent: true });
    const chat = Store.newChat({ projectId: null });
    setChat(chat);
    render();
    if (focus) composer.focus();
    onChatsChanged();
    pinToBottom(true);
  }

  function openChat(id) {
    const chat = Store.getChat(id);
    if (!chat) return;
    stopStreaming({ silent: true });
    setChat(chat);
    render();
    pinToBottom(true);
    onChatsChanged();
  }

  /* -------------------------------- sending ------------------------------- */
  async function send(text) {
    const settings = getSettings();
    const chat = getChat();
    if (!chat || streaming) return;

    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (trimmed.length > LIMITS.maxInputChars) {
      toast('That message is too long. Trim it a little.', { tone: 'error' });
      return;
    }

    haptic(8);
    if (!chat.messages.length) chat.title = Store.titleFrom(trimmed);

    chat.messages.push({ id: uid(), role: 'user', text: trimmed, ts: Date.now() });
    composer.clear();
    persist();
    render();
    pinToBottom();

    if (settings.memory.enabled && settings.memory.autoCapture && isRememberRequest(trimmed)) {
      captureMemories(trimmed);
    }

    await streamReply();
  }

  function buildRequest() {
    const settings = getSettings();
    const chat = getChat();
    const messages = Api.buildMessages(chat, { turns: settings.historyTurns });
    const lastUser = [...(chat.messages || [])].reverse().find(m => m.role === 'user');
    const liveRisk = lastUser && needsLiveInfo(lastUser.text) && !FEATURES.webSearch;

    let instructions = Api.buildInstructions({
      settings,
      memoryText: settings.memory.enabled ? Store.memoryToPrompt() : '',
      hasWebSearch: FEATURES.webSearch,
    });
    if (liveRisk) {
      instructions += '\n\nThe current question likely needs up-to-date information and no live search tool is available to you. Say clearly that you cannot check live data, then answer with the most useful general knowledge you have.';
    }
    return { messages, instructions };
  }

  async function streamReply() {
    const settings = getSettings();
    const chat = getChat();
    if (!chat) return;

    const botMsg = { id: uid(), role: 'assistant', text: '', ts: Date.now(), pending: true, model: settings.model };
    chat.messages.push(botMsg);
    streaming = true;
    composer.setStreaming(true);
    setStatus('thinking');
    render();
    pinToBottom();

    const node = messagesEl.querySelector(`[data-id="${botMsg.id}"]`);
    let pendingPaint = null;
    let full = '';

    const paint = () => {
      pendingPaint = null;
      if (!node) return;
      updateMessageBody(node, { ...botMsg, text: full }, { caret: true });
      if (isNearBottom(scrollEl, 160)) scrollEl.scrollTop = scrollEl.scrollHeight;
    };

    const onDelta = (_delta, whole) => {
      full = whole;
      if (streaming) setStatus('generating');
      if (!pendingPaint) pendingPaint = requestAnimationFrame(paint);
    };

    controller = new AbortController();
    const { messages, instructions } = buildRequest();

    let failure = null;
    try {
      const result = await Api.send({
        settings,
        messages,
        instructions,
        signal: controller.signal,
        onDelta,
      });
      full = result?.text ?? full;
      if (result?.model) botMsg.model = result.model;
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === ERROR_CODES.aborted) {
        failure = null;                                  // deliberate stop
      } else {
        failure = err instanceof TralixError ? err : new TralixError(ERROR_CODES.unknown, { detail: String(err?.message || err) });
      }
    }

    if (pendingPaint) cancelAnimationFrame(pendingPaint);
    streaming = false;
    controller = null;
    composer.setStreaming(false);

    botMsg.pending = false;

    if (failure) {
      console.warn('[tralix] request failed', failure.toDebug());
      if (full.trim()) {
        botMsg.text = `${full.trim()}\n\n> ⚠️ ${failure.message}`;
      } else {
        botMsg.text = failure.message;
        botMsg.errorTitle = errorLabel(failure.code);
      }
      botMsg.error = true;
      botMsg.code = failure.code;
      persist();
      render();
      pinToBottom();
      setError(failure.message);
      return;
    }

    botMsg.text = full.trim() || '_No reply came back. Try again._';
    persist();
    refreshNode(botMsg);
    onChatsChanged();
    setStatus('idle');

    if (settings.voice.enabled && settings.voice.auto && Voice.ttsSupported) {
      speakMessage(botMsg, { auto: true });
    }
  }

  function stopStreaming({ silent = false } = {}) {
    if (controller) {
      try { controller.abort(); } catch {}
      controller = null;
    }
    if (streaming) {
      streaming = false;
      composer.setStreaming(false);
      if (!silent) toast('Stopped');
    }
    setStatus('idle');
  }

  /* ------------------------------- regenerate ----------------------------- */
  async function regenerate(botId) {
    if (streaming) return;
    const chat = getChat();
    if (!chat) return;
    const index = chat.messages.findIndex(m => m.id === botId);
    if (index === -1) return;

    chat.messages.splice(index, 1);
    // drop any hidden follow-up instruction left over from a previous action
    while (chat.messages.length && chat.messages[chat.messages.length - 1].hidden) chat.messages.pop();
    persist();
    render();
    await streamReply();
  }

  /* ---------------------------- response actions -------------------------- */
  async function handleAction(action, msg) {
    const chat = getChat();
    if (!chat) return;

    switch (action) {
      case 'copy': {
        const ok = await copyText(msg.role === 'assistant' ? toCopyText(msg.text) : msg.text);
        toast(ok ? 'Copied' : 'Copy failed — select the text manually', { tone: ok ? 'success' : 'error' });
        haptic(4);
        return;
      }

      case 'edit':
        composer.setValue(msg.text);
        toast('Editing your message — send when ready');
        return;

      case 'regenerate':
        await regenerate(msg.id);
        return;

      case 'speak':
        if (speakingId === msg.id) { stopSpeaking(); return; }
        speakMessage(msg);
        return;

      case 'feedback-up':
      case 'feedback-down': {
        const value = action === 'feedback-up' ? 'up' : 'down';
        msg.feedback = msg.feedback === value ? null : value;
        persist();
        refreshNode(msg);
        toast(msg.feedback ? (value === 'up' ? 'Good to know — thanks' : 'Noted. Try Regenerate for a different answer.') : 'Feedback cleared');
        return;
      }

      default:
        break;
    }

    if (action.startsWith('more:')) {
      await runFollowUp(action.slice(5), msg);
    }
  }

  /** Continue / Shorter / Longer / Explain / Rewrite / Save. */
  async function runFollowUp(id, msg) {
    if (streaming) { toast('Wait for the current reply to finish'); return; }
    const chat = getChat();
    if (!chat) return;

    if (id === 'save') {
      saveToMemory(msg);
      return;
    }

    const action = RESPONSE_ACTIONS.find(a => a.id === id);
    if (!action?.prompt) return;

    // The instruction is sent to the model but not shown as a user bubble.
    chat.messages.push({ id: uid(), role: 'user', text: action.prompt, ts: Date.now(), hidden: true });
    persist();
    await streamReply();
  }

  function saveToMemory(msg) {
    const summary = replySummary(stripMarkdown(msg.text), 200);
    if (!summary) return;
    const saved = Store.addMemory(summary, { source: 'saved-response' });
    if (saved?.refused) {
      toast('That looks sensitive, so TRALIX did not store it.', { tone: 'error' });
      return;
    }
    if (!saved) {
      toast('Already in memory');
      return;
    }
    toast('Saved to memory', { tone: 'success' });
    deps.onMemoryChanged?.();
  }

  /* --------------------------------- memory ------------------------------- */
  function captureMemories(text) {
    const candidates = extractMemoryCandidates(text);
    if (!candidates.length) return;

    const added = [];
    let refused = false;
    for (const candidate of candidates) {
      const result = Store.addMemory(candidate, { source: 'chat' });
      if (result?.refused) refused = true;
      else if (result) added.push(result);
    }

    if (refused) {
      toast('That looked sensitive, so it was not saved.', { tone: 'error' });
    }
    if (added.length) {
      deps.onMemoryChanged?.();
      toast(`Remembered: ${added.map(a => a.text).join(' · ')}`, { ms: 2600, tone: 'success' });
    }
  }

  /* ---------------------------------- voice ------------------------------- */
  function speakMessage(msg, { auto = false } = {}) {
    const settings = getSettings();
    if (!Voice.ttsSupported) {
      composerToast('Speech is not available in this browser.');
      return;
    }
    const text = stripMarkdown(msg.text);
    if (!text) return;

    speakingId = msg.id;
    onSpeakingChange(speakingId);
    refreshNode(msg);
    setStatus('speaking');

    Voice.speak(text, {
      voiceURI: settings.voice.voiceURI,
      rate: settings.voice.rate,
      pitch: settings.voice.pitch,
      onEnd: () => {
        if (speakingId === msg.id) {
          speakingId = null;
          onSpeakingChange(null);
          const chat = getChat();
          const current = chat?.messages.find(m => m.id === msg.id);
          if (current) refreshNode(current);
          setStatus('idle');
        }
      },
    });
    if (!auto) haptic(4);
  }

  function stopSpeaking() {
    Voice.stopSpeaking();
    speakingId = null;
    onSpeakingChange(null);
    render();
    setStatus('idle');
  }

  function composerToast(message) {
    toast(message, { tone: 'error' });
  }

  /* --------------------------------- public ------------------------------- */
  return {
    render,
    newChat,
    openChat,
    send,
    stopStreaming,
    regenerate,
    runFollowUp,
    speakMessage,
    stopSpeaking,
    get speakingId() { return speakingId; },
    get streaming() { return streaming; },
    scrollToBottom: pinToBottom,
    syncJumpButton,
    handleAction,
  };
}
