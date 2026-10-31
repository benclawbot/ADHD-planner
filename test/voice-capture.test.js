import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  LocalVoiceCapture,
  VOICE_MODEL,
  appendTranscript,
  downsampleToMono,
  voiceErrorMessage,
} from '../src/voice-capture.js';

class FakeWorker {
  listeners = new Map();
  messages = [];
  transfers = [];

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  postMessage(message, transfer = []) {
    this.messages.push(message);
    if (message.type === 'transcribe') this.transfers = transfer;
    queueMicrotask(() => {
      const response = message.type === 'load'
        ? { requestId: message.requestId, type: 'ready' }
        : { requestId: message.requestId, type: 'transcript', text: 'Call the dentist tomorrow.' };
      for (const handler of this.listeners.get('message') ?? []) handler({ data: response });
    });
  }

  terminate() {}
}

class FakeRecorder {
  static isTypeSupported() { return true; }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType ?? 'audio/webm';
    this.state = 'inactive';
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  start() { this.state = 'recording'; }

  stop() {
    this.state = 'inactive';
    for (const handler of this.listeners.get('dataavailable') ?? []) handler({ data: new Blob(['fake audio'], { type: this.mimeType }) });
    for (const handler of this.listeners.get('stop') ?? []) handler();
  }
}

class FakeAudioContext {
  async decodeAudioData() {
    const channels = [new Float32Array([1, 1, 1, 1]), new Float32Array([-1, -1, 1, 1])];
    return { numberOfChannels: channels.length, sampleRate: 32_000, getChannelData: (index) => channels[index] };
  }

  async close() {}
}

function makeCapture() {
  const worker = new FakeWorker();
  let micRequests = 0;
  let stoppedTracks = 0;
  const capture = new LocalVoiceCapture({
    mediaDevices: {
      async getUserMedia() {
        micRequests += 1;
        return { getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] };
      },
    },
    MediaRecorderClass: FakeRecorder,
    AudioContextClass: FakeAudioContext,
    workerFactory: () => worker,
    maxRecordingMs: 60_000,
  });
  return { capture, worker, getMicRequests: () => micRequests, getStoppedTracks: () => stoppedTracks };
}

test('mono conversion averages channels and resamples to the model rate', () => {
  assert.deepEqual(
    [...downsampleToMono([new Float32Array([1, 1, 1, 1]), new Float32Array([-1, -1, 1, 1])], 32_000)],
    [0, 1],
  );
  assert.deepEqual([...downsampleToMono([new Float32Array([0, 1, 2, 3])], 32_000)], [0, 2]);
  assert.deepEqual([...downsampleToMono([], 48_000)], []);
  assert.throws(() => downsampleToMono([new Float32Array([1])], 0), /sample rates/);
});

test('recognized text is appended without replacing an existing editable draft', () => {
  assert.equal(appendTranscript('', '  Call the dentist tomorrow.  '), 'Call the dentist tomorrow.');
  assert.equal(appendTranscript('Buy milk\n', 'Call the dentist tomorrow.'), 'Buy milk\nCall the dentist tomorrow.');
  assert.equal(appendTranscript('Existing text', '  '), 'Existing text');
});

test('permission and model errors give a concrete recovery path', () => {
  assert.match(voiceErrorMessage({ name: 'NotAllowedError' }), /Allow microphone access/);
  assert.match(voiceErrorMessage({ code: 'model_load' }), /connection and available browser storage/);
  assert.match(voiceErrorMessage({ code: 'voice_insecure_context' }), /HTTPS or localhost/);
});

test('model setup does not request the microphone; recording and transcription stay in the local worker', async () => {
  const { capture, worker, getMicRequests, getStoppedTracks } = makeCapture();
  await capture.load();
  assert.equal(getMicRequests(), 0, 'model setup must not open the microphone');
  assert.equal(worker.messages[0].type, 'load');

  await capture.startRecording();
  assert.equal(getMicRequests(), 1, 'the microphone is requested only after the user starts recording');
  const recording = await capture.stopRecording();
  assert.ok(recording.size > 0);
  assert.equal(getStoppedTracks(), 1, 'the microphone track is stopped when recording ends');

  assert.equal(await capture.transcribe(recording), 'Call the dentist tomorrow.');
  assert.equal(worker.messages[1].type, 'transcribe');
  assert.ok(worker.messages[1].audio instanceof Float32Array);
  assert.match(worker.messages[1].language, /^[a-z]{2,3}$/);
  assert.deepEqual([...worker.messages[1].audio], [0, 1]);
  assert.equal(worker.transfers[0], worker.messages[1].audio.buffer, 'PCM is transferred to the same-origin worker');
});

test('discard stops the microphone and does not submit audio for transcription', async () => {
  const { capture, worker, getMicRequests, getStoppedTracks } = makeCapture();
  await capture.load();
  await capture.startRecording();
  assert.equal(getMicRequests(), 1);
  await capture.cancelRecording();
  assert.equal(getStoppedTracks(), 1);
  assert.deepEqual(worker.messages.map((message) => message.type), ['load']);
});

test('pinned voice runtime uses same-origin WASM assets and has no Web Speech or cloud audio path', async () => {
  const workerSource = await readFile(new URL('../src/voice-worker.js', import.meta.url), 'utf8');
  assert.match(workerSource, /\/src\/vendor\/transformers\/transformers\.min\.js/);
  assert.match(workerSource, /whisper-tiny/);
  assert.match(workerSource, /device: 'wasm'/);
  assert.match(workerSource, /task: 'transcribe'/);
  assert.doesNotMatch(workerSource, /SpeechRecognition|webkitSpeechRecognition|\bfetch\s*\(/);

  const pinnedFiles = {
    'transformers.min.js': 'aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa',
    'ort-wasm-simd-threaded.jsep.mjs': '08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9',
    'ort-wasm-simd-threaded.jsep.wasm': 'c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39',
  };
  for (const [filename, expectedHash] of Object.entries(pinnedFiles)) {
    const contents = await readFile(new URL(`../src/vendor/transformers/${filename}`, import.meta.url));
    const digest = createHash('sha256').update(contents).digest('hex');
    assert.equal(digest, expectedHash, `${filename} must match the pinned Transformers.js release`);
  }
});
