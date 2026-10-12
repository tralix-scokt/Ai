/*
 * voice.test.mjs — browser-API lifecycle tests with deterministic mocks.
 * Exercises runtime capability detection, STT stop/error/abort paths and the
 * built-in SpeechSynthesis integration without requiring a mic or paid service.
 */

let pass = 0;
let fail = 0;
function t(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-GB', onLine: true },
  configurable: true,
});
globalThis.window = {};

const unsupported = await import('../assets/js/voice.js?voice-test-unsupported');
t('\n— unsupported browser —', unsupported.sttSupported === false);
t('speech output support is runtime-detected', unsupported.ttsSupported === false);
let unsupportedMessage = '';
const unavailable = new unsupported.Listener({ onError: message => { unsupportedMessage = message; } });
t('unsupported speech input does not start', unavailable.start() === false);
t('unsupported speech input provides a keyboard fallback', /does not support speech input/i.test(unsupportedMessage), unsupportedMessage);
let unsupportedEnded = false;
unsupported.speak('Hello', { onEnd: () => { unsupportedEnded = true; } });
t('unsupported speech output ends gracefully', unsupportedEnded);

class RecognitionMock {
  static instances = [];
  static nextStartError = null;
  static nextConstructorError = null;

  constructor() {
    if (RecognitionMock.nextConstructorError) {
      const error = RecognitionMock.nextConstructorError;
      RecognitionMock.nextConstructorError = null;
      throw error;
    }
    this.startCalls = 0;
    this.stopCalls = 0;
    this.abortCalls = 0;
    RecognitionMock.instances.push(this);
  }

  start() {
    this.startCalls++;
    if (RecognitionMock.nextStartError) {
      const error = RecognitionMock.nextStartError;
      RecognitionMock.nextStartError = null;
      throw error;
    }
  }

  stop() { this.stopCalls++; }
  abort() { this.abortCalls++; }
}

const spoken = [];
const voices = [{ voiceURI: 'samantha-en-gb', name: 'Samantha', lang: 'en-GB', localService: true }];
const synthesis = {
  speaking: false,
  paused: false,
  cancelCount: 0,
  getVoices: () => voices,
  speak(utterance) { spoken.push(utterance); this.speaking = true; },
  cancel() { this.cancelCount++; this.speaking = false; this.paused = false; },
  pause() { this.paused = true; },
  resume() { this.paused = false; this.speaking = true; },
};
class UtteranceMock {
  constructor(text) { this.text = text; }
}

globalThis.window = {
  SpeechRecognition: RecognitionMock,
  speechSynthesis: synthesis,
};
globalThis.SpeechSynthesisUtterance = UtteranceMock;

const voice = await import('../assets/js/voice.js?voice-test-supported');
t('\n— supported browser —', voice.sttSupported === true);
t('native speech output is available when SpeechSynthesis exists', voice.ttsSupported === true);

let startCount = 0;
const results = [];
const ended = [];
const listener = new voice.Listener({
  onStart: () => { startCount++; },
  onResult: (text, isFinal) => results.push({ text, isFinal }),
  onEnd: text => ended.push(text),
});
t('recognition begins only when explicitly started', listener.start() === true);
const recognition = RecognitionMock.instances.at(-1);
t('browser recognition starts on activation', recognition.startCalls === 1);
recognition.onstart();
t('active recognition reports listening state', listener.active && voice.getVoiceState() === 'listening');
t('recognition start callback fires once', startCount === 1);

const final = Object.assign([{ transcript: 'Turn left' }], { isFinal: true });
const interim = Object.assign([{ transcript: 'at the next street' }], { isFinal: false });
recognition.onresult({ resultIndex: 0, results: [final] });
recognition.onresult({ resultIndex: 1, results: [final, interim] });
t('interim text is retained alongside final speech', listener.currentText === 'Turn left at the next street', listener.currentText);
t('manual stop asks the browser to finalize recognition', listener.stop() === 'Turn left at the next street' && recognition.stopCalls === 1);
recognition.onend();
t('recognition finalizes once and returns the complete transcript', ended.length === 1 && ended[0] === 'Turn left at the next street', ended[0] || '');
t('final transcript callback is marked final', results.at(-1)?.isFinal === true);
t('recognition returns to idle after finalization', voice.getVoiceState() === 'idle');

let initializationMessage = '';
let initializationEndCount = 0;
RecognitionMock.nextConstructorError = new Error('constructor failed');
const uninitialized = new voice.Listener({
  onError: message => { initializationMessage = message; },
  onEnd: () => { initializationEndCount++; },
});
t('recognition constructor failures return a handled start failure', uninitialized.start() === false);
t('constructor failure explains keyboard fallback and closes the UI lifecycle',
  /initialize speech recognition/i.test(initializationMessage) && initializationEndCount === 1, initializationMessage);

let deniedMessage = '';
let deniedEndCount = 0;
RecognitionMock.nextStartError = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
const denied = new voice.Listener({
  onError: message => { deniedMessage = message; },
  onEnd: () => { deniedEndCount++; },
});
t('synchronous microphone denial reports a failed start', denied.start() === false);
t('microphone denial explains permission recovery', /microphone access was denied/i.test(deniedMessage), deniedMessage);
t('failed startup closes the UI lifecycle', deniedEndCount === 1 && denied.starting === false);

const abortMessages = [];
const aborted = new voice.Listener({ onEnd: text => abortMessages.push(text) });
aborted.start();
const abortRecognition = RecognitionMock.instances.at(-1);
abortRecognition.onstart();
abortRecognition.onresult({ resultIndex: 0, results: [final] });
aborted.abort();
abortRecognition.onend();
t('aborting dictation never submits a partial transcript', abortMessages.length === 0);
t('abort closes the active recognition session', abortRecognition.abortCalls === 1 && !aborted.active);

await voice.loadVoices();
t('system voices load without a third-party service', voice.voiceList().length === 1 && voice.pickDefaultVoice()?.name === 'Samantha');
let speakStarts = 0;
let speakEnds = 0;
voice.speak('Hello from JARVIS.', {
  voiceURI: 'samantha-en-gb',
  rate: 1.2,
  pitch: 0.9,
  onStart: () => { speakStarts++; },
  onEnd: () => { speakEnds++; },
});
const utterance = spoken.at(-1);
t('speech uses the installed browser voice', utterance instanceof UtteranceMock && utterance.voice?.name === 'Samantha');
t('speech settings are passed to the browser', utterance?.rate === 1.2 && utterance?.pitch === 0.9 && utterance?.lang === 'en-GB');
utterance?.onstart();
t('speaking state is surfaced to the interface', speakStarts === 1 && voice.isSpeaking() && voice.getVoiceState() === 'speaking');
utterance?.onend();
t('speech completion returns to idle', speakEnds === 1 && !voice.isSpeaking() && voice.getVoiceState() === 'idle');

synthesis.speaking = true;
t('browser speech can be paused', voice.pauseSpeaking() && synthesis.paused);
t('browser speech can resume', voice.resumeSpeaking() && !synthesis.paused);
const cancelsBeforeStop = synthesis.cancelCount;
voice.stopSpeaking();
t('stop speech uses the native cancellation API', synthesis.cancelCount > cancelsBeforeStop);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
