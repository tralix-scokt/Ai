/* ==========================================================================
   ui/assistant.js — JARVIS home, view-mode and capability controls.

   This view never handles chat transport. It only reflects verified backend
   and browser capabilities, and keeps the assistant's visual mode in sync.
   ========================================================================== */

import { $ } from '../util.js';

export function isDemoMode(settings = {}, health = null) {
  const preference = settings.assistantMode || 'auto';
  if (preference === 'demo') return true;
  if (preference === 'live') return false;

  // Auto mode uses a device key when the owner explicitly enabled that path;
  // otherwise it uses local samples until a backend proves it can answer.
  const localConfigured = settings.advanced?.transport === 'local'
    && Boolean(String(settings.advanced?.apiKey || '').trim());
  if (localConfigured) return false;
  return health?.ok !== true;
}

export function createAssistantUI({
  getSettings = () => ({}),
  saveSettings = () => {},
  getHealth = () => null,
  onOpenConnect = () => {},
  onModeChange = () => {},
} = {}) {
  const app = $('#app');
  const modeButton = $('#btnViewMode');
  const modeLabel = $('#viewModeLabel');
  const runtimeButtons = [$('#runtimeBadge'), $('#demoModeButton')].filter(Boolean);
  const runtimeLabels = [$('#runtimeLabel'), $('#demoModeLabel')].filter(Boolean);
  let viewMode = 'immersive';
  let speechCapabilities = { input: false, output: false, voices: 0 };

  function setViewMode(next, { notify = true } = {}) {
    viewMode = next === 'conversation' ? 'conversation' : 'immersive';
    if (app) app.dataset.mode = viewMode;
    if (modeButton) {
      const label = viewMode === 'immersive' ? 'CHAT' : 'CORE';
      const action = viewMode === 'immersive' ? 'Switch to conversation mode' : 'Return to immersive assistant mode';
      modeButton.setAttribute('aria-label', action);
      modeButton.title = action;
      if (modeLabel) modeLabel.textContent = label;
      modeButton.setAttribute('aria-pressed', String(viewMode === 'conversation'));
    }
    if (notify) onModeChange(viewMode);
    return viewMode;
  }

  function updateConnection(health = getHealth()) {
    const node = $('#connectionStatusLabel');
    if (!node) return;
    const settings = getSettings();
    const localConfigured = settings.advanced?.transport === 'local'
      && Boolean(String(settings.advanced?.apiKey || '').trim());
    if (localConfigured && settings.assistantMode !== 'demo') {
      node.textContent = 'Device key active';
      node.dataset.state = 'ready';
    } else if (health?.ok === true) {
      node.textContent = 'Backend connected';
      node.dataset.state = 'ready';
    } else if (health?.status === 'unconfigured') {
      node.textContent = 'Setup required';
      node.dataset.state = 'offline';
    } else if (health?.reachable === false) {
      node.textContent = 'Not connected';
      node.dataset.state = 'offline';
    } else {
      node.textContent = 'Checking connection';
      node.dataset.state = 'checking';
    }
    updateRuntimeMode();
  }

  function updateCapabilities({ input = speechCapabilities.input, output = speechCapabilities.output, voices = speechCapabilities.voices } = {}) {
    speechCapabilities = { input: Boolean(input), output: Boolean(output), voices: Number(voices) || 0 };
    const inputNode = $('#micStatusLabel');
    const outputNode = $('#voiceStatusLabel');

    if (inputNode) {
      inputNode.dataset.baseLabel = speechCapabilities.input
        ? 'Voice input available'
        : 'Keyboard dictation fallback';
      inputNode.textContent = inputNode.dataset.baseLabel;
      inputNode.title = speechCapabilities.input
        ? 'The browser exposes native speech recognition; microphone access is requested only when you tap the microphone.'
        : 'Native speech recognition is unavailable here. Type normally or use the iPhone keyboard microphone.';
      inputNode.dataset.supported = String(speechCapabilities.input);
    }
    if (outputNode) {
      outputNode.dataset.baseLabel = !speechCapabilities.output
        ? 'System speech unavailable'
        : speechCapabilities.voices
          ? `System voice ready · ${speechCapabilities.voices}`
          : 'System voice available';
      outputNode.textContent = outputNode.dataset.baseLabel;
      outputNode.title = speechCapabilities.output
        ? 'Uses the browser’s built-in SpeechSynthesis API and voices installed on this device.'
        : 'This browser does not expose SpeechSynthesis.';
      outputNode.dataset.supported = String(speechCapabilities.output);
    }

    const mic = $('#btnMic');
    if (mic) {
      mic.setAttribute('aria-label', speechCapabilities.input
        ? 'Start voice input'
        : 'Voice recognition unavailable. Use text input or iPhone keyboard dictation');
      mic.title = speechCapabilities.input
        ? 'Start voice input'
        : 'Voice recognition is unavailable here; use the message field or keyboard dictation.';
    }
  }

  function updateRuntimeMode() {
    const settings = getSettings();
    const health = getHealth();
    const demo = isDemoMode(settings, health);
    if (app) app.dataset.runtime = demo ? 'demo' : 'live';

    runtimeButtons.forEach((button) => {
      button.dataset.mode = demo ? 'demo' : 'live';
      button.setAttribute('aria-pressed', String(demo));
      const next = demo ? 'live' : 'demo';
      const connected = health?.ok === true;
      const action = demo
        ? (connected ? 'Switch to the live AI backend' : 'Choose live mode and connect a backend')
        : 'Switch to local demo examples';
      button.setAttribute('aria-label', action);
      button.title = action;
      button.classList.toggle('needs-setup', next === 'live' && !connected);
    });

    runtimeLabels.forEach((label) => {
      label.textContent = demo ? (label.id === 'demoModeLabel' ? 'DEMO MODE' : 'DEMO') : (label.id === 'demoModeLabel' ? 'LIVE MODE' : 'LIVE');
    });

    const footnote = $('#demoFootnote');
    if (footnote) {
      const connected = health?.ok === true;
      footnote.hidden = !demo;
      footnote.textContent = connected
        ? 'DEMO MODE · Local examples only. Switch to LIVE to use the connected AI backend.'
        : 'DEMO MODE · Local example responses. No AI model is connected.';
    }

    const stateText = $('#connectionStatusLabel');
    if (stateText && demo && health?.ok !== true) {
      stateText.textContent = health?.status === 'unconfigured' ? 'Setup required' : 'Local demo';
    }
    return demo;
  }

  function toggleRuntimeMode() {
    const settings = getSettings();
    const next = isDemoMode(settings, getHealth()) ? 'live' : 'demo';
    settings.assistantMode = next;
    saveSettings(settings);
    updateRuntimeMode();
    if (next === 'live' && getHealth()?.ok !== true) onOpenConnect();
  }

  modeButton?.addEventListener('click', () => {
    setViewMode(viewMode === 'immersive' ? 'conversation' : 'immersive');
  });
  $('#btnResumeConversation')?.addEventListener('click', () => setViewMode('conversation'));
  runtimeButtons.forEach(button => button.addEventListener('click', toggleRuntimeMode));

  updateCapabilities();
  updateConnection();
  updateRuntimeMode();

  return {
    setViewMode,
    updateConnection,
    updateCapabilities,
    updateRuntimeMode,
    get viewMode() { return viewMode; },
    get demoMode() { return isDemoMode(getSettings(), getHealth()); },
    toggleRuntimeMode,
  };
}
