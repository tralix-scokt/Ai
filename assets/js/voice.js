/* ==========================================================================
   voice.js — speech in and speech out.

   Built around iOS Safari: webkitSpeechRecognition for input, speechSynthesis
   for output. Long replies are spoken in sentence-sized chunks because iOS
   truncates very long utterances, and the module reports state changes so the
   UI can show a calm Listening / Thinking / Speaking indicator.
   ========================================================================== */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const sttSupported = Boolean(SR);
export const ttsSupported = 'speechSynthesis' in window;

/* ------------------------------ speaking state ---------------------------- */
/** @type {'idle'|'listening'|'thinking'|'generating'|'speaking'|'error'} */
let voiceState = 'idle';
const stateListeners = new Set();

export function onVoiceState(fn) {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

function setVoiceState(next) {
  if (voiceState === next) return;
  voiceState = next;
  for (const fn of stateListeners) {
    try { fn(next); } catch { /* listener errors must not break speech */ }
  }
}

export const getVoiceState = () => voiceState;

/* ================================== STT =================================== */
export class Listener {
  /**
   * @param {object} opts
   * @param {(text:string, isFinal:boolean)=>void} opts.onResult
   * @param {(msg:string)=>void} opts.onError
   * @param {()=>void} opts.onStart
   * @param {(text:string)=>void} opts.onEnd
   */
  constructor({ onResult, onError, onStart, onEnd } = {}) {
    this.onResult = onResult || (() => {});
    this.onError = onError || (() => {});
    this.onStart = onStart || (() => {});
    this.onEnd = onEnd || (() => {});

    this.rec = null;
    this.active = false;
    this.starting = false;
    this.finalText = '';
    this.currentText = '';
    this.manualStop = false;
    this.restarting = false;
    this.lastSpeechAt = 0;
    this.silenceTimer = null;
    this.finishTimer = null;
  }

  get supported() { return Boolean(SR); }

  start() {
    if (!SR) {
      this.onError('This browser does not support speech input. Try keyboard dictation instead.');
      return false;
    }
    if (this.active || this.starting) return true;

    this.manualStop = false;
    this.finalText = '';
    this.currentText = '';
    this.lastSpeechAt = Date.now();
    this._emitted = false;
    this.starting = true;
    return this._spawn();
  }

  _spawn() {
    let rec;
    try {
      rec = new SR();
    } catch (error) {
      this.starting = false;
      this.active = false;
      this.manualStop = true;
      if (error?.name !== 'InvalidStateError') {
        setVoiceState('error');
        this.onError(error?.name === 'NotAllowedError'
          ? 'Microphone access was denied. Check Safari microphone permissions and try again.'
          : 'Could not initialize speech recognition. Try the keyboard dictation fallback.');
      }
      this._finish();
      return false;
    }
    this.rec = rec;

    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;          // chunked restarts are managed here
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.active = true;
      this.starting = false;
      this.restarting = false;
      setVoiceState('listening');
      this.onStart();
      this._watchForSilence();
    };

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript || '';
        if (res.isFinal) this.finalText += (this.finalText ? ' ' : '') + txt.trim();
        else interim += txt;
      }
      const shown = (this.finalText + (interim ? ' ' + interim : '')).trim();
      if (shown) {
        this.currentText = shown;
        this.lastSpeechAt = Date.now();
        this.onResult(shown, false);
      }
    };

    rec.onerror = (event) => {
      const code = event.error;
      // These are soft on iOS. The silence watchdog below ends an actually
      // silent session without turning the browser's normal restart into an error.
      if (code === 'no-speech' || code === 'aborted') return;

      this.active = false;
      this.starting = false;
      this._clearTimers();
      setVoiceState('error');

      const messages = {
        'not-allowed': 'Microphone access is blocked. On iPhone: Settings → Safari → Microphone, then reload.',
        'service-not-allowed': 'Speech recognition is not allowed here. Make sure the page is on HTTPS.',
        'audio-capture': 'No microphone was found or it is already in use.',
        'network': 'Speech recognition needs an internet connection in this browser.',
        'language-not-supported': 'That language is not supported for dictation.',
      };
      this.onError(messages[code] || `Microphone error: ${code || 'unknown'}`);
    };

    rec.onend = () => {
      this.starting = false;
      // iOS stops recognition after a short interval. Restart it only while the
      // user still has an active session; never restart after Stop or an error.
      if (!this.manualStop && this.active) {
        this.restarting = true;
        try { rec.start(); } catch {
          this.active = false;
          this._finish();
        }
        return;
      }
      this.active = false;
      this._finish();
    };

    try {
      rec.start();
      return true;
    } catch (error) {
      this.starting = false;
      this.active = false;
      this.manualStop = true;
      if (error?.name !== 'InvalidStateError') {
        setVoiceState('error');
        this.onError(error?.name === 'NotAllowedError'
          ? 'Microphone access was denied. Check Safari microphone permissions and try again.'
          : 'Could not start speech recognition. Try the keyboard dictation fallback.');
      }
      // Resolve the pending UI lifecycle too: otherwise a synchronous browser
      // start failure can leave the composer stuck in its recording state.
      this._finish();
      return false;
    }
  }

  _watchForSilence() {
    this._clearSilenceTimer();
    this.silenceTimer = setInterval(() => {
      if (!this.active || this.manualStop) return;
      if (Date.now() - this.lastSpeechAt < 14000) return;

      this.manualStop = true;
      this.active = false;
      this._clearSilenceTimer();
      if (!this.finalText.trim() && !this.currentText.trim()) {
        this.onError('No speech was detected. Tap the microphone to try again, or use keyboard dictation.');
      }
      try { this.rec?.stop(); } catch { this._finish(); }
    }, 1800);
  }

  _clearSilenceTimer() {
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = null;
  }

  _clearTimers() {
    this._clearSilenceTimer();
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
  }

  _finish() {
    if (this._emitted) return;        // onend and the stop safety timer can both land here
    this._emitted = true;
    this.active = false;
    this.starting = false;
    this._clearTimers();
    const text = (this.currentText || this.finalText).trim();
    if (voiceState === 'listening') setVoiceState('idle');
    this.onResult(text, true);
    this.onEnd(text);
  }

  stop() {
    this.manualStop = true;
    this._clearSilenceTimer();
    if (!this.active && !this.starting) {
      this._finish();
      return (this.currentText || this.finalText).trim();
    }
    try {
      this.rec?.stop();
      // Let the browser deliver a final result before the safety finish.
      this.finishTimer = setTimeout(() => this._finish(), 1400);
    } catch {
      this._finish();
    }
    return (this.currentText || this.finalText).trim();
  }

  abort() {
    this.manualStop = true;
    this.active = false;
    this.starting = false;
    this._emitted = true;             // an abort must never finalize/submit a partial transcript
    this._clearTimers();
    try { this.rec?.abort(); } catch {}
    if (voiceState === 'listening') setVoiceState('idle');
  }
}

/* ================================== TTS =================================== */
const tts = {
  voices: [],
  loaded: false,
  queue: [],
  speaking: false,
  cancelled: false,
};

/** iOS loads voices asynchronously — this resolves once they arrive. */
export function loadVoices() {
  return new Promise(resolve => {
    if (!ttsSupported) return resolve([]);
    const grab = () => {
      const all = window.speechSynthesis.getVoices() || [];
      if (all.length) {
        tts.voices = all;
        tts.loaded = true;
      }
      resolve(tts.voices);
    };
    grab();
    if (!tts.voices.length) {
      window.speechSynthesis.onvoiceschanged = grab;
      // iOS sometimes never fires the event — poll briefly as a backstop
      let tries = 0;
      const poll = setInterval(() => {
        tries++;
        if (tts.voices.length || tries > 12) {
          clearInterval(poll);
          grab();
        }
      }, 250);
    }
  });
}

/** Best available English voice, preferring Apple's higher-quality ones. */
export function pickDefaultVoice() {
  const v = tts.voices;
  if (!v.length) return null;
  const en = v.filter(x => /^en(-|_|$)/i.test(x.lang));
  const pool = en.length ? en : v;

  const ranked = [
    /samantha/i, /karen/i, /moira/i, /tessa/i, /fiona/i, /serena/i,
    /daniel/i, /alex/i, /google us english/i, /google uk english/i,
    /enhanced/i, /premium/i,
  ];
  for (const re of ranked) {
    const hit = pool.find(x => re.test(x.name));
    if (hit) return hit;
  }
  return pool.find(x => x.localService) || pool[0];
}

export function voiceList() {
  return [...tts.voices].sort((a, b) => {
    const aEn = /^en/i.test(a.lang) ? 0 : 1;
    const bEn = /^en/i.test(b.lang) ? 0 : 1;
    return aEn - bEn || a.name.localeCompare(b.name);
  });
}

let unlocked = false;

/**
 * iOS only allows speech to start after a user gesture.
 * Speaking a silent utterance on the first tap unlocks it for later.
 */
export function warmupSpeech() {
  if (unlocked || !ttsSupported) return;
  unlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.rate = 1;
    window.speechSynthesis.speak(u);
  } catch {}
}

/** Split long text into speakable chunks at sentence boundaries. */
export function chunkText(text = '', max = 220) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const sentences = clean.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [clean];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if ((current + ' ' + s).trim().length <= max) {
      current = (current ? current + ' ' : '') + s;
    } else {
      if (current) chunks.push(current);
      if (s.length > max) {
        for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max));
        current = '';
      } else {
        current = s;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Speak a reply aloud.
 * @param {string} text
 * @param {{voiceURI?:string, rate?:number, pitch?:number, onStart?:Function, onEnd?:Function, onStateChange?:Function}} opts
 */
export function speak(text, { voiceURI = '', rate = 1, pitch = 1, onStart, onEnd } = {}) {
  if (!ttsSupported) { onEnd?.(); return; }
  const chunks = chunkText(text);
  if (!chunks.length) { onEnd?.(); return; }

  stopSpeaking();
  tts.cancelled = false;
  tts.queue = chunks.slice();
  const chosen = tts.voices.find(v => v.voiceURI === voiceURI) || pickDefaultVoice();

  const speakNext = () => {
    if (tts.cancelled) { finish(); return; }
    const next = tts.queue.shift();
    if (!next) { finish(); return; }

    const u = new SpeechSynthesisUtterance(next);
    u.rate = Math.min(2, Math.max(0.5, Number(rate) || 1));
    u.pitch = Math.min(2, Math.max(0.5, Number(pitch) || 1));
    u.volume = 1;
    u.lang = chosen?.lang || 'en-US';
    if (chosen) u.voice = chosen;

    u.onstart = () => { tts.speaking = true; setVoiceState('speaking'); onStart?.(); };
    u.onend = () => speakNext();
    u.onerror = () => speakNext();

    try {
      window.speechSynthesis.speak(u);
    } catch {
      finish();
    }
  };

  const finish = () => {
    tts.speaking = false;
    if (voiceState === 'speaking') setVoiceState('idle');
    onEnd?.();
  };

  try {
    window.speechSynthesis.cancel();
    speakNext();
    // Safari sometimes pauses itself after ~15s of speech
    setTimeout(() => {
      if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }, 300);
  } catch {
    finish();
  }
}

export function pauseSpeaking() {
  if (!ttsSupported) return false;
  try {
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      return true;
    }
  } catch {}
  return false;
}

export function resumeSpeaking() {
  if (!ttsSupported) return false;
  try {
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      return true;
    }
  } catch {}
  return false;
}

export function stopSpeaking() {
  tts.cancelled = true;
  tts.queue = [];
  if (!ttsSupported) return;
  try { window.speechSynthesis.cancel(); } catch {}
  tts.speaking = false;
  if (voiceState === 'speaking') setVoiceState('idle');
}

export const isSpeaking = () => tts.speaking;

/** Approximate duration of spoken text, for a progress hint. */
export const estimatedSpeechSeconds = (text = '', rate = 1) =>
  Math.max(1, Math.round((String(text).split(/\s+/).filter(Boolean).length / 2.6) / (Number(rate) || 1)));
