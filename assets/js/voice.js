/* ==========================================================================
   voice.js — speech in and speech out
   Built around iOS Safari: webkitSpeechRecognition for input,
   speechSynthesis for output. Handles the iOS quirks explicitly.
   ========================================================================== */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

export const sttSupported = Boolean(SR);
export const ttsSupported = 'speechSynthesis' in window;

/* ================================== STT =================================== */
export class Listener {
  /**
   * @param {object} opts
   * @param {(text:string, isFinal:boolean)=>void} opts.onResult
   * @param {(msg:string)=>void} opts.onError
   * @param {()=>void} opts.onStart
   * @param {()=>void} opts.onEnd
   */
  constructor({ onResult, onError, onStart, onEnd } = {}) {
    this.onResult = onResult || (() => {});
    this.onError = onError || (() => {});
    this.onStart = onStart || (() => {});
    this.onEnd = onEnd || (() => {});

    this.rec = null;
    this.active = false;
    this.finalText = '';
    this.manualStop = false;
    this.restarting = false;
  }

  get supported() { return Boolean(SR); }

  start() {
    if (!SR) {
      this.onError('This browser cannot do speech input. Try Safari on iPhone.');
      return false;
    }
    if (this.active) return true;

    this.manualStop = false;
    this.finalText = '';
    this._emitted = false;
    this._spawn();
    return true;
  }

  _spawn() {
    const rec = new SR();
    this.rec = rec;

    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = true;          // we manage chunked restarts ourselves
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.active = true;
      this.restarting = false;
      this.onStart();
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
      if (shown) this.onResult(shown, false);
    };

    rec.onerror = (event) => {
      const code = event.error;
      // 'no-speech' / 'aborted' happen constantly on iOS — treat as soft
      if (code === 'no-speech' || code === 'aborted') return;

      this.active = false;

      const messages = {
        'not-allowed':    'Microphone access is blocked. On iPhone: Settings → Safari → Microphone, then reload.',
        'service-not-allowed': 'Speech recognition is not allowed here. Make sure the page is on HTTPS.',
        'audio-capture':  'No microphone found.',
        'network':        'Speech recognition needs a connection right now.',
        'language-not-supported': 'That language is not supported for dictation.',
      };
      this.onError(messages[code] || `Microphone error: ${code}`);
    };

    rec.onend = () => {
      // iOS cuts recognition off every few seconds — restart if the user
      // is still holding the button, otherwise finish cleanly.
      if (!this.manualStop && this.active) {
        this.restarting = true;
        try { rec.start(); } catch { this.active = false; this._finish(); }
        return;
      }
      this.active = false;
      this._finish();
    };

    try {
      rec.start();
    } catch {
      // starting twice throws on iOS — ignore, it is already running
    }
  }

  _finish() {
    if (this._emitted) return;        // rec.onend and stop() can both land here
    this._emitted = true;
    const text = this.finalText.trim();
    this.onResult(text, true);
    this.onEnd(text);
  }

  stop() {
    this.manualStop = true;
    this.active = false;
    try { this.rec?.stop(); } catch {}
    this._finish();                   // no-op if onend already fired
    return this.finalText.trim();
  }

  abort() {
    this.manualStop = true;
    this.active = false;
    try { this.rec?.abort(); } catch {}
  }
}

/* ================================== TTS =================================== */
const tts = {
  voices: [],
  loaded: false,
};

/** iOS loads voices asynchronously — this fires after they arrive. */
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
  // then any local (offline-capable) voice — most reliable on iPhone
  return pool.find(x => x.localService) || pool[0];
}

export function voiceList() {
  return tts.voices
    .filter(v => /^en/i.test(v.lang) || true)   // keep all, English first
    .sort((a, b) => {
      const aEn = /^en/i.test(a.lang) ? 0 : 1;
      const bEn = /^en/i.test(b.lang) ? 0 : 1;
      return aEn - bEn || a.name.localeCompare(b.name);
    });
}

let speaking = false;
let unlocked = false;

/**
 * iOS only allows speech to start once the page has been touched.
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

/**
 * Speak text aloud.
 * @param {string} text
 * @param {{voiceURI?:string, rate?:number, onStart?:Function, onEnd?:Function}} opts
 */
export function speak(text, { voiceURI = '', rate = 1, onStart, onEnd } = {}) {
  if (!ttsSupported) { onEnd?.(); return; }

  const clean = String(text).trim();
  if (!clean) { onEnd?.(); return; }

  stopSpeaking();

  const u = new SpeechSynthesisUtterance(clean);
  u.rate = rate;
  u.pitch = 1;
  u.volume = 1;
  u.lang = 'en-US';

  const chosen = tts.voices.find(v => v.voiceURI === voiceURI) || pickDefaultVoice();
  if (chosen) { u.voice = chosen; u.lang = chosen.lang; }

  u.onstart = () => { speaking = true; onStart?.(); };
  u.onend   = () => { speaking = false; onEnd?.(); };
  u.onerror = () => { speaking = false; onEnd?.(); };

  // iOS: the first speak() must come from a user gesture, and it silently
  // fails if a previous utterance is still queued — hence the resume below.
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    // Safari sometimes pauses itself after ~15s of speech
    setTimeout(() => {
      if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    }, 300);
  } catch {
    speaking = false;
    onEnd?.();
  }
}

export function stopSpeaking() {
  if (!ttsSupported) return;
  try { window.speechSynthesis.cancel(); } catch {}
  speaking = false;
}

export const isSpeaking = () => speaking;
