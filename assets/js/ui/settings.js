/* ==========================================================================
   ui/settings.js — Settings, wired into its six sections.

   General · AI · Voice · Memory · Data · Advanced

   The module owns the form; the app owns the state and the side effects, which
   arrive here as callbacks so settings stay a pure view over store.js.
   ========================================================================== */

import { $, $$, copyText, downloadJson, formatBytes } from '../util.js';
import { APP, apiBase, setApiBase, normaliseBase } from '../config.js';
import { ERROR_CODES, TralixError } from '../errors.js';
import * as Store from '../store.js';
import { MODELS, modelById, normaliseModelId, resolvedSummary } from '../models.js';
import { PERSONALITIES } from '../personality.js';
import * as Voice from '../voice.js';
import * as Api from '../api/chat.js';
import { toast, confirmDialog } from './feedback.js';
import { openSheet } from './sheets.js';
import { debugRows, renderDebug, collectDiagnostics, renderDoctor, reportText } from './doctor.js';

const VALID_TABS = ['general', 'ai', 'voice', 'memory', 'data', 'advanced'];

export function createSettings(deps) {
  const {
    getSettings, saveSettings,
    onTheme = () => {}, onDensity = () => {}, onHaptics = () => {},
    onModelChanged = () => {},
    onVoiceChanged = () => {},
    onMemoryChanged = () => {}, onChatsChanged = () => {},
    onDataReplaced = () => {},
    getHealth = () => null, refreshHealth = async () => null,
    openConnect = () => {},
    memoryManager = null,
    modelPicker = null,
  } = deps;

  /* -------------------------------- tabs ---------------------------------- */
  const tabs = $$('#settingsSheet .tab');
  const sections = $$('#settingsBody .set-block');

  function showTab(id) {
    const tab = VALID_TABS.includes(id) ? id : 'general';
    tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    sections.forEach(s => { s.hidden = s.dataset.section !== tab; });
    $('#settingsBody').scrollTop = 0;
    if (tab === 'advanced') refreshDebug();
    if (tab === 'voice') renderVoices();
    if (tab === 'memory') memoryManager?.refresh();
  }

  tabs.forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

  /* ------------------------------- general -------------------------------- */
  function wireGeneral() {
    $('#setTheme').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.theme = event.target.value;
      saveSettings(settings);
      onTheme();
    });

    $('#setDensity').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.density = event.target.value;
      saveSettings(settings);
      onDensity();
    });

    $('#setLanguage').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.language = event.target.value;
      saveSettings(settings);
      document.documentElement.lang = settings.language === 'system' ? 'en' : settings.language;
      toast('Language updated');
    });

    $('#setHaptics').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.haptics = event.target.checked;
      saveSettings(settings);
      onHaptics();
    });
  }

  /* ---------------------------------- ai ---------------------------------- */
  function wireAI() {
    const select = $('#setModel');
    select.innerHTML = '';
    for (const tier of MODELS) {
      const option = document.createElement('option');
      option.value = tier.id;
      option.textContent = `${tier.label} — ${tier.tagline}`;
      select.appendChild(option);
    }

    select.addEventListener('change', (event) => {
      const settings = getSettings();
      settings.model = normaliseModelId(event.target.value);
      saveSettings(settings);
      onModelChanged();
      updateAIHints();
      toast(`${modelById(settings.model).label} selected`, { tone: 'success' });
    });

    $('#setStyle').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.responseStyle = event.target.value;
      saveSettings(settings);
      toast('Response style updated');
    });

    const seg = $('#personalitySeg');
    seg.innerHTML = '';
    for (const personality of PERSONALITIES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'seg';
      button.setAttribute('role', 'radio');
      button.dataset.value = personality.id;
      button.innerHTML = `<span title="${personality.hint}">${personality.label}</span>`;
      button.addEventListener('click', () => {
        const settings = getSettings();
        settings.personality = personality.id;
        saveSettings(settings);
        renderPersonality();
        toast(personality.id === 'jarvis' ? 'JARVIS mode enabled' : `${personality.label} personality`, { tone: 'success' });
      });
      seg.appendChild(button);
    }

    $('#personaInput').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.persona = event.target.value.trim();
      if (settings.persona) settings.personality = 'custom';
      saveSettings(settings);
      renderPersonality();
    });
  }

  function renderPersonality() {
    const settings = getSettings();
    $$('#personalitySeg .seg').forEach(seg => {
      seg.setAttribute('aria-checked', String(seg.dataset.value === settings.personality));
    });
    const custom = settings.personality === 'custom';
    $('#personaInput').disabled = false;
    $('#personaInput').placeholder = custom
      ? 'Describe how TRALIX should talk to you'
      : 'Switch to Custom to write your own instructions';
  }

  function updateAIHints() {
    const settings = getSettings();
    const hint = $('#setModelHint');
    const tier = modelById(settings.model);
    hint.textContent = settings.advanced.devMode
      ? `Resolves to ${resolvedSummary(settings.model)}`
      : `${tier.description} Provider model details stay internal — see Advanced for debugging.`;
  }

  /* --------------------------------- voice -------------------------------- */
  function renderVoices() {
    const settings = getSettings();
    const select = $('#voicePick');
    const voices = Voice.voiceList();
    select.innerHTML = '';

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Automatic (best available)';
    select.appendChild(auto);

    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} — ${voice.lang}${voice.localService ? '' : ' (cloud)'}`;
      select.appendChild(option);
    }
    select.value = settings.voice.voiceURI || '';

    const note = $('#voiceSupportNote');
    if (!Voice.ttsSupported) note.textContent = 'This browser cannot speak text aloud.';
    else if (!voices.length) note.textContent = 'Voices load after the first tap on iOS — reopen Settings if the list is empty.';
    else note.textContent = `${voices.length} voices available on this device.`;
  }

  function wireVoice() {
    $('#setVoiceEnabled').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.voice.enabled = event.target.checked;
      saveSettings(settings);
      if (!event.target.checked) Voice.stopSpeaking();
      onVoiceChanged();
    });

    $('#setVoiceAuto').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.voice.auto = event.target.checked;
      if (event.target.checked) settings.voice.enabled = true;
      saveSettings(settings);
      syncVoiceControls();
      if (event.target.checked && Voice.ttsSupported) {
        Voice.speak('Voice output is on.', {
          voiceURI: settings.voice.voiceURI,
          rate: settings.voice.rate,
          pitch: settings.voice.pitch,
        });
      }
      onVoiceChanged();
    });

    $('#voicePick').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.voice.voiceURI = event.target.value;
      saveSettings(settings);
      const voice = Voice.voiceList().find(v => v.voiceURI === event.target.value);
      Voice.speak(`This is ${voice ? voice.name : 'the automatic voice'}.`, {
        voiceURI: settings.voice.voiceURI,
        rate: settings.voice.rate,
        pitch: settings.voice.pitch,
      });
    });

    $('#voiceRate').addEventListener('input', (event) => {
      $('#voiceRateVal').textContent = `${Number(event.target.value).toFixed(2)}×`;
    });
    $('#voiceRate').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.voice.rate = Number(event.target.value);
      saveSettings(settings);
      Voice.speak('This is my speaking speed.', {
        voiceURI: settings.voice.voiceURI,
        rate: settings.voice.rate,
        pitch: settings.voice.pitch,
      });
    });

    $('#voicePitch').addEventListener('input', (event) => {
      $('#voicePitchVal').textContent = Number(event.target.value).toFixed(2);
    });
    $('#voicePitch').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.voice.pitch = Number(event.target.value);
      saveSettings(settings);
      Voice.speak('Pitch adjusted.', {
        voiceURI: settings.voice.voiceURI,
        rate: settings.voice.rate,
        pitch: settings.voice.pitch,
      });
    });

    $('#btnTestVoice').addEventListener('click', () => {
      if (!Voice.ttsSupported) { toast('This browser cannot speak.', { tone: 'error' }); return; }
      const settings = getSettings();
      Voice.speak(`Hello. I am ${APP.name}. Ready when you are.`, {
        voiceURI: settings.voice.voiceURI,
        rate: settings.voice.rate,
        pitch: settings.voice.pitch,
      });
    });
  }

  function syncVoiceControls() {
    const settings = getSettings();
    $('#setVoiceEnabled').checked = Boolean(settings.voice.enabled);
    $('#setVoiceAuto').checked = Boolean(settings.voice.auto);
    $('#voiceRate').value = String(settings.voice.rate ?? 1);
    $('#voiceRateVal').textContent = `${Number(settings.voice.rate ?? 1).toFixed(2)}×`;
    $('#voicePitch').value = String(settings.voice.pitch ?? 1);
    $('#voicePitchVal').textContent = Number(settings.voice.pitch ?? 1).toFixed(2);
  }

  /* --------------------------------- memory ------------------------------- */
  function wireMemory() {
    $('#setMemoryEnabled').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.memory.enabled = event.target.checked;
      saveSettings(settings);
    });
    $('#setMemoryAuto').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.memory.autoCapture = event.target.checked;
      saveSettings(settings);
    });
    $('#btnMemClear').addEventListener('click', async () => {
      const cleared = await memoryManager?.clearAll();
      if (cleared) onMemoryChanged();
    });
  }

  /* ---------------------------------- data -------------------------------- */
  function wireData() {
    $('#btnExport').addEventListener('click', () => {
      try {
        downloadJson(`tralix-backup-${new Date().toISOString().slice(0, 10)}.json`, Store.exportAll());
        toast('Backup downloaded', { tone: 'success' });
      } catch (err) {
        toast('Export failed', { tone: 'error' });
        console.warn('[tralix] export failed', err);
      }
    });

    $('#btnImport').addEventListener('click', () => $('#importFile').click());

    $('#importFile').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const ok = await confirmDialog(
          'Import this backup?',
          'Conversations, memories and settings from the file will be merged into this device. Your stored key is never overwritten.',
          'Import',
        );
        if (!ok) return;
        Store.importAll(data);
        onDataReplaced();
        toast('Backup imported', { tone: 'success' });
      } catch (err) {
        toast('That file is not a TRALIX backup', { tone: 'error' });
        console.warn('[tralix] import failed', err);
      }
    });

    $('#btnClearChats').addEventListener('click', async () => {
      const ok = await confirmDialog(
        'Clear all conversations?',
        'Every conversation on this device will be deleted. Memories and settings stay.',
        'Clear conversations',
      );
      if (!ok) return;
      const backup = Store.loadChats();
      Store.deleteAllChats();
      onChatsChanged();
      toast('Conversations cleared', {
        action: 'Undo',
        ms: 8000,
        onAction: () => {
          Store.saveChats(backup);
          onChatsChanged();
          toast('Conversations restored');
        },
      });
    });

    $('#btnWipe').addEventListener('click', async () => {
      const ok = await confirmDialog(
        'Erase everything?',
        'All conversations, memories and settings are removed from this device. Any saved provider key is kept so you are not locked out.',
        'Erase everything',
      );
      if (!ok) return;
      Store.wipeAll({ keepAdvanced: true });
      onDataReplaced();
      toast('Everything erased');
    });
  }

  function renderStorageInfo() {
    let bytes = 0;
    try {
      for (const key of [...Object.values(Store.storageKeys), ...Object.values(Store.legacyKeys)]) {
        bytes += (localStorage.getItem(key) || '').length;
      }
    } catch {}
    const chats = Store.loadChats().length;
    const memories = Store.loadMemory().length;
    $('#storageInfo').textContent =
      `${chats} conversations · ${memories} memories · about ${formatBytes(bytes)} of local storage.`;
  }

  /* -------------------------------- advanced ------------------------------ */
  function syncAdvanced() {
    const settings = getSettings();
    $('#advBase').value = apiBase();
    $('#advBaseHint').textContent = apiBase()
      ? 'Requests go to this URL.'
      : 'Leave empty to use this origin (works when the backend is deployed alongside the app).';
    $('#advTransport').value = settings.advanced.transport;
    $('#advProvider').value = settings.advanced.localProvider;
    $('#advKey').value = settings.advanced.apiKey || '';
    $('#advDev').checked = Boolean(settings.advanced.devMode);
    $('#debugBlock').hidden = !settings.advanced.devMode;
    syncTransportHint();
  }

  function syncTransportHint() {
    const settings = getSettings();
    const hint = $('#advTransportHint');
    $('#advLocalBlock').hidden = settings.advanced.transport !== 'local';
    hint.textContent = settings.advanced.transport === 'local'
      ? 'Requests go straight from this device to the provider. Your key stays in this browser — but it is exposed to the client, so only use this with a key you control.'
      : 'Recommended. The key lives on the TRALIX server and never reaches this app.';
  }

  function wireAdvanced() {
    $('#btnAdvSaveBase').addEventListener('click', async () => {
      setApiBase(normaliseBase($('#advBase').value));
      syncAdvanced();
      const health = await refreshHealth({ force: true });
      setAdvStatus(health.ok
        ? `Connected · ${health.provider || 'backend'} · ${health.model || 'default model'}`
        : (health.message || 'No response — check the URL'), health.ok ? 'ok' : 'bad');
    });

    $('#btnAdvTest').addEventListener('click', async () => {
      setAdvStatus('Testing…');
      try {
        const health = await refreshHealth({ force: true });
        if (!health.ok) throw new TralixError(ERROR_CODES.network, { message: health.message });
        const result = await Api.testConnection();
        setAdvStatus(`Stream works · replied “${result.text.slice(0, 40)}”`, 'ok');
      } catch (err) {
        const code = err?.code || ERROR_CODES.unknown;
        setAdvStatus(`${err.message} (${code})`, 'bad');
      }
    });

    $('#advTransport').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.advanced.transport = event.target.value;
      saveSettings(settings);
      syncAdvanced();
      toast(event.target.value === 'local' ? 'Using your own key on this device' : 'Using the TRALIX backend');
    });

    $('#advProvider').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.advanced.localProvider = event.target.value;
      saveSettings(settings);
      $('#advKey').placeholder = event.target.value === 'openai' ? 'sk-…' : 'AIza…';
    });

    $('#btnAdvEye').addEventListener('click', () => {
      const input = $('#advKey');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    $('#btnAdvSaveKey').addEventListener('click', () => {
      const settings = getSettings();
      const key = $('#advKey').value.trim();
      settings.advanced.apiKey = key;
      if (key) settings.advanced.transport = 'local';
      saveSettings(settings);
      syncAdvanced();
      toast(key ? 'Key saved on this device' : 'Key removed', { tone: key ? 'success' : 'info' });
    });

    $('#btnAdvTestKey').addEventListener('click', async () => {
      const settings = getSettings();
      const key = $('#advKey').value.trim();
      if (!key) { setAdvKeyStatus('Paste a key first.', 'bad'); return; }
      setAdvKeyStatus('Checking…');
      try {
        const models = await Api.testLocalKey(settings.advanced.localProvider, key);
        setAdvKeyStatus(`Key works · ${models.length} models reachable`, 'ok');
      } catch (err) {
        setAdvKeyStatus(err.message, 'bad');
      }
    });

    $('#btnAdvDocs').addEventListener('click', () => {
      const provider = getSettings().advanced.localProvider;
      window.open(provider === 'openai'
        ? 'https://platform.openai.com/api-keys'
        : 'https://aistudio.google.com/apikey', '_blank', 'noopener');
    });

    $('#advDev').addEventListener('change', (event) => {
      const settings = getSettings();
      settings.advanced.devMode = event.target.checked;
      saveSettings(settings);
      $('#debugBlock').hidden = !event.target.checked;
      updateAIHints();
      if (event.target.checked) refreshDebug();
    });

    $('#btnDoctor').addEventListener('click', () => openDoctor());
    $('#btnCopyDebug').addEventListener('click', async () => {
      const rows = collectDiagnostics({ settings: getSettings(), health: getHealth() });
      const ok = await copyText(reportText(rows));
      toast(ok ? 'Diagnostics copied' : 'Copy failed', { tone: ok ? 'success' : 'error' });
    });
  }

  function setAdvStatus(message, cls = '') {
    const el = $('#advStatus');
    el.textContent = message;
    el.className = `status-line ${cls}`;
  }

  function setAdvKeyStatus(message, cls = '') {
    const el = $('#advKeyStatus');
    el.textContent = message;
    el.className = `status-line ${cls}`;
  }

  function refreshDebug() {
    renderDebug($('#debugInfo'), debugRows({ settings: getSettings(), health: getHealth() }));
  }

  /* -------------------------------- doctor -------------------------------- */
  async function openDoctor() {
    openSheet('doctorSheet');
    $('#doctorOutput').innerHTML = '<div class="doctor-row"><div>Running checks…</div></div>';
    const health = await refreshHealth({ force: true });
    renderDoctor($('#doctorOutput'), collectDiagnostics({ settings: getSettings(), health }));
  }

  $('#btnDoctorRerun')?.addEventListener('click', () => openDoctor());
  $('#btnDoctorCopy')?.addEventListener('click', async () => {
    const health = getHealth();
    const ok = await copyText(reportText(collectDiagnostics({ settings: getSettings(), health })));
    toast(ok ? 'Report copied' : 'Copy failed', { tone: ok ? 'success' : 'error' });
  });

  /* --------------------------------- open --------------------------------- */
  function syncForm() {
    const settings = getSettings();

    $('#setTheme').value = settings.theme;
    $('#setDensity').value = settings.density;
    $('#setLanguage').value = settings.language;
    $('#setHaptics').checked = Boolean(settings.haptics);

    $('#setModel').value = settings.model;
    $('#setStyle').value = settings.responseStyle;
    renderPersonality();
    updateAIHints();
    $('#personaInput').value = settings.persona || '';

    syncVoiceControls();
    $('#setMemoryEnabled').checked = Boolean(settings.memory.enabled);
    $('#setMemoryAuto').checked = Boolean(settings.memory.autoCapture);
    memoryManager?.refresh();

    renderStorageInfo();
    syncAdvanced();
    $('#buildStamp').textContent = `${APP.name} v${APP.version} · backend ${apiBase() || 'same origin'}`;
  }

  function open(tab = 'general') {
    syncForm();
    showTab(tab);
    openSheet('settingsSheet');
  }

  function init() {
    wireGeneral();
    wireAI();
    wireVoice();
    wireMemory();
    wireData();
    wireAdvanced();
    // fill the voice picker once iOS has handed over its voice list
    Voice.loadVoices().then(() => { if (!$('#settingsSheet').hidden) renderVoices(); });
  }

  return { init, open, refresh: syncForm, refreshDebug, showTab, openDoctor };
}
