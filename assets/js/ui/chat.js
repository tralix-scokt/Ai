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
import * as V2 from '../api/v2.js';
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

  /*
   * Whether the server has a voice configured is cached briefly, not forever:
   * a key can be added in Settings → Voice while the app is open, and the next
   * reply should use it without a reload. "Not configured" is trusted for a
   * shorter time than "configured", because that is the answer that changes.
   */
  const VOICE_TTL_MS = { configured: 300_000, unconfigured: 30_000 };
  let voiceLookup = { value: null, at: 0 };

  function contextFor(msg, index, messages) {
    const visible = messages.filter(m => !m.hidden);
    const isLast = visible[visible.length - 1]?.id === msg.id;
    return {
      streaming: streaming && isLast && msg.role === 'assistant',
      isLast,
      speakingId,
      // A server voice (Fish Audio) can speak in browsers that have no
      // device voices at all, so the control follows either of them.
      ttsSupported: Voice.ttsSupported || Boolean(voiceLookup.value),
      modelLabel: modelLabelFor(msg),
      onAction: handleAction,
    };
  }

  /**
   * Which model answered. Before routing, that was the tier the user picked
   * ("JARVIS Smart"); with routing it is the provider that actually replied,
   * because claiming a model that did not answer would be a lie.
   */
  function modelLabelFor(msg) {
    if (msg?.providerLabel && msg?.model) return `${msg.providerLabel} · ${msg.model}`;
    if (msg?.provider) return `${msg.provider} · ${msg.model || ''}`.trim();
    return modelLabel(getSettings().model);
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
        text.textContent = health.message || 'The JARVIS backend is not reachable.';
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

    // A new question replaces the answer being read out: two voices at once is
    // not helpful, and the old reply is no longer what the user is asking about.
    if (speakingId) stopSpeaking();

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
    let result = null;                  // declared outside: the outcome is read after the catch
    try {
      result = await Api.send({
        settings,
        messages,
        instructions,
        signal: controller.signal,
        onDelta,
        onModel: (info) => {
          botMsg.provider = info?.provider || '';
          botMsg.providerLabel = info?.providerLabel || info?.provider || '';
          botMsg.model = info?.model || botMsg.model;
          botMsg.paid = Boolean(info?.paid);
        },
      });
      full = result?.text ?? full;
      if (result?.model) botMsg.model = result.model;
      if (result?.providerLabel) botMsg.providerLabel = result.providerLabel;
      if (result?.provider) botMsg.provider = result.provider;
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
      botMsg.retryable = failure.retryable !== false;
      persist();
      render();
      pinToBottom();
      setError(failure.message);
      // Tell the app to re-measure the connection: the status line, the Retry
      // button and reality must agree with each other.
      window.dispatchEvent(new CustomEvent('tralix:connection-suspect', { detail: failure.toDebug?.() || {} }));
      return;
    }

    botMsg.text = full.trim() || '_No reply came back. Try again._';
    if (result?.status === 'incomplete' && result?.note === 'connection-dropped') {
      // The answer is real but unfinished — say so instead of pretending, and
      // offer Retry without throwing away the text that did arrive.
      botMsg.incomplete = true;
      botMsg.text += '\n\n> ⚠️ The connection dropped before this answer finished.';
    }
    persist();
    refreshNode(botMsg);
    onChatsChanged();
    setStatus('idle');
    if (result?.status === 'completed') {
      // A verified round-trip means the connection is genuinely working.
      deps.onRequestSucceeded?.();
    }

    // Auto-speak must not depend on the device having its own voices: when the
    // server has a provider configured, that is what speaks. Only stay silent
    // when there is genuinely nothing to speak with.
    if (settings.voice.enabled && settings.voice.auto && (Voice.ttsSupported || await serverVoice())) {
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

  /* --------------------------------- retry -------------------------------- */
  /**
   * Retry is the honest sibling of Regenerate: it removes the failed assistant
   * bubble and re-sends the *same* turn, including the user's message that is
   * already on screen. Nothing is invented, and the draft is never lost.
   */
  async function retry(botId) {
    if (streaming) { toast('Still working on the previous reply'); return false; }
    const chat = getChat();
    if (!chat) return false;

    const index = chat.messages.findIndex(m => m.id === botId);
    if (index === -1) return false;

    const target = chat.messages[index];
    if (!target?.error) return false;

    // Remove the failed bubble (and anything hidden queued behind it).
    chat.messages.splice(index, 1);
    while (chat.messages.length && chat.messages[chat.messages.length - 1].hidden) chat.messages.pop();

    const lastUser = [...chat.messages].reverse().find(m => m.role === 'user' && !m.hidden);
    if (!lastUser) {
      toast('There is nothing to retry');
      return false;
    }

    persist();
    render();
    await streamReply();
    return true;
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

      case 'retry':
        await retry(msg.id);
        return;

      case 'fix-connection':
        deps.onOpenConnect?.();
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
      toast('That looks sensitive, so JARVIS did not store it.', { tone: 'error' });
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
  /*
   * Two engines, tried in this order:
   *   1. the server's voice provider (Fish Audio) when the backend has one —
   *      the key lives on the server, the browser only plays audio;
   *   2. the device's own speech synthesis, which needs no key and no network.
   * If the first is not configured or fails, the second takes over and nothing
   * is claimed about which one spoke.
   */
  let serverAudio = null;
  let stopCurrentChunk = null;        // settles the chunk that is playing

  /** The server refuses text longer than 1200 characters (see server/tts.js). */
  const SERVER_SPEECH_CHUNK = 1100;

  async function serverVoice() {
    const now = Date.now();
    if (voiceLookup.value !== null
      && now - voiceLookup.at < (voiceLookup.value ? VOICE_TTL_MS.configured : VOICE_TTL_MS.unconfigured)) {
      return voiceLookup.value;
    }
    try {
      const status = await V2.voiceStatus({});
      voiceLookup = { value: status?.configured ? status : false, at: now };
    } catch {
      voiceLookup = { value: false, at: now };
    }
    return voiceLookup.value;
  }

  /*
   * Ask once whether the server can speak, so the Read-aloud control is offered
   * for a server voice from the start instead of only after the first reply.
   * Runs at most once per (re)configuration.
   */
  let voicePrimed = false;
  async function primeVoice() {
    if (voicePrimed) return;
    voicePrimed = true;
    const before = Boolean(voiceLookup.value);
    const now = await serverVoice();
    if (Boolean(now) !== before) render();
  }

  // Settings → Voice adds or removes a key: drop the cached answer at once.
  window.addEventListener('jarvis:voice-changed', () => {
    voiceLookup = { value: null, at: 0 };
    if (getSettings().voice.enabled) { voicePrimed = false; primeVoice(); }
  });

  /**
   * Speak one piece of text through the server provider.
   * Resolves `{ stopped: true }` when Stop interrupts it instead of hanging.
   */
  function playServerSpeech(text, { speed = 1 }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        stopCurrentChunk = null;
        try { serverAudio?.pause(); } catch { /* already stopped */ }
        serverAudio = null;
        resolve(value);
      };

      // Stop must be able to end a chunk: pausing alone never fires 'ended',
      // which would leave this promise pending for the rest of the session.
      stopCurrentChunk = () => settle({ stopped: true });

      V2.speak(text, { speed }).then(({ url, revoke }) => {
        if (settled) { revoke?.(); return; }
        serverAudio = new Audio(url);
        serverAudio.addEventListener('ended', () => { revoke?.(); settle({ stopped: false }); }, { once: true });
        serverAudio.addEventListener('error', () => {
          revoke?.();
          if (settled) return;
          settled = true;
          stopCurrentChunk = null;
          serverAudio = null;
          reject(new Error('The spoken audio could not be played.'));
        }, { once: true });
        serverAudio.play().catch((err) => {
          revoke?.();
          if (settled) return;
          settled = true;
          stopCurrentChunk = null;
          serverAudio = null;
          reject(err instanceof Error ? err : new Error('Playback was blocked by the browser.'));
        });
      }).catch(reject);
    });
  }

  async function speakMessage(msg, { auto = false } = {}) {
    const settings = getSettings();
    const text = stripMarkdown(msg.text);
    if (!text) return;

    const clear = () => {
      if (speakingId === msg.id) {
        speakingId = null;
        onSpeakingChange(null);
        const chat = getChat();
        const current = chat?.messages.find(m => m.id === msg.id);
        if (current) refreshNode(current);
      }
      setStatus('idle');
    };

    const begin = () => {
      speakingId = msg.id;
      onSpeakingChange(speakingId);
      refreshNode(msg);
      setStatus('speaking');
    };

    const voice = await serverVoice();
    if (voice) {
      // The server voice has its own speed; the device rate applies only to
      // the browser's own speech synthesis below.
      const speed = Number(voice.speed) || Number(settings.voice.rate) || 1;
      begin();
      let spoken = 0;
      try {
        // A long reply is spoken in sentence-sized pieces: sending it whole
        // would be refused for length and would silently switch voices
        // halfway through the answer.
        for (const chunk of Voice.chunkText(text, SERVER_SPEECH_CHUNK)) {
          if (speakingId !== msg.id) break;                 // Stop was pressed
          const { stopped } = await playServerSpeech(chunk, { speed });
          if (stopped) break;
          spoken += 1;
        }
        if (speakingId === msg.id) clear();
        if (!auto) haptic(4);
        return;
      } catch (error) {
        // Ask again next time: a transient failure is not a configuration.
        voiceLookup = { value: null, at: 0 };
        if (spoken > 0) {
          // Something was already said — restarting in a different voice would
          // be worse than saying plainly that the audio stopped early.
          toast(`Spoken audio stopped after ${spoken} part${spoken === 1 ? '' : 's'}: ${error?.message || 'unknown error'}`, { tone: 'error', ms: 4200 });
          clear();
          return;
        }
      }
    }

    if (!Voice.ttsSupported) {
      composerToast('Speech is not available in this browser.');
      clear();
      return;
    }

    begin();
    Voice.speak(text, {
      voiceURI: settings.voice.voiceURI,
      rate: settings.voice.rate,
      pitch: settings.voice.pitch,
      onEnd: clear,
    });
    if (!auto) haptic(4);
  }

  function stopSpeaking() {
    Voice.stopSpeaking();
    // Settle the chunk that is playing first: pausing alone never ends it.
    stopCurrentChunk?.();
    if (serverAudio) {
      try { serverAudio.pause(); } catch { /* nothing to stop */ }
      serverAudio = null;
    }
    speakingId = null;
    onSpeakingChange(null);
    render();
    setStatus('idle');
  }

  function composerToast(message) {
    toast(message, { tone: 'error' });
  }

  /* --------------------------------- public ------------------------------- */

  // Find out whether the server can speak, without waiting for a reply.
  if (getSettings().voice.enabled) primeVoice();

  return {
    render,
    newChat,
    openChat,
    send,
    stopStreaming,
    regenerate,
    retry,
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
