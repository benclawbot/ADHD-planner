export const VOICE_MODEL = Object.freeze({
  id: 'onnx-community/whisper-tiny',
  revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
  transformersVersion: '3.8.1',
  approximateBytes: 45_000_000,
});

export const MAX_RECORDING_MS = 120_000;
const SAMPLE_RATE = 16_000;
const WHISPER_LANGUAGES = new Set('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su'.split(' '));
export function voiceLanguage(locale = globalThis.navigator?.language || 'en') {
  const code = String(locale).toLowerCase().split(/[-_]/)[0];
  return WHISPER_LANGUAGES.has(code) ? code : 'en';
}


export function downsampleToMono(channels, sourceRate, targetRate = SAMPLE_RATE) {
  if (!Array.isArray(channels) || channels.length === 0 || !channels[0]?.length) return new Float32Array();
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new TypeError('Audio sample rates must be positive numbers.');
  }

  const sourceLength = Math.min(...channels.map((channel) => channel.length));
  if (!sourceLength) return new Float32Array();
  const outputLength = Math.max(1, Math.floor(sourceLength * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const channelCount = channels.length;
  const monoAt = (index) => {
    let sample = 0;
    for (const channel of channels) sample += channel[index] ?? 0;
    return sample / channelCount;
  };

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * sourceRate / targetRate;
    const leftIndex = Math.min(Math.floor(position), sourceLength - 1);
    const rightIndex = Math.min(leftIndex + 1, sourceLength - 1);
    const blend = position - leftIndex;
    output[index] = monoAt(leftIndex) + (monoAt(rightIndex) - monoAt(leftIndex)) * blend;
  }
  return output;
}

export function appendTranscript(existing, transcript) {
  const addition = String(transcript ?? '').trim();
  if (!addition) return String(existing ?? '');
  const draft = String(existing ?? '').trimEnd();
  return draft ? `${draft}\n${addition}` : addition;
}

export function voiceErrorMessage(error) {
  const code = error?.code || error?.name;
  if (code === 'voice_unsupported') {
    return 'This browser cannot run on-device voice capture. Try a current Chrome or Edge browser, or type your thoughts instead.';
  }
  if (code === 'voice_insecure_context') {
    return 'Microphone access needs Tempo to be open over HTTPS or localhost.';
  }
  if (code === 'NotAllowedError' || code === 'SecurityError') {
    return 'Microphone permission was denied. Allow microphone access for Tempo in your browser settings, then try again.';
  }
  if (code === 'NotFoundError' || code === 'DevicesNotFoundError') {
    return 'No microphone is available. Connect or enable a microphone, then try again.';
  }
  if (code === 'NotReadableError' || code === 'TrackStartError') {
    return 'The microphone could not start. Close other apps that may be using it, then try again.';
  }
  if (code === 'OverconstrainedError') {
    return 'The available microphone does not meet this browser’s recording requirements.';
  }
  if (code === 'empty_recording') {
    return 'No audio was recorded. Try again and speak after recording starts.';
  }
  if (code === 'empty_transcript') {
    return 'No speech was recognized. Try speaking a little longer, or type your thoughts instead.';
  }
  if (code === 'model_load') {
    return 'The on-device speech model could not be loaded. Check your connection and available browser storage, then retry.';
  }
  return 'On-device transcription did not finish. Your audio was not uploaded. Try again or type your thoughts instead.';
}

export class LocalVoiceCapture {
  constructor({
    mediaDevices = globalThis.navigator?.mediaDevices,
    MediaRecorderClass = globalThis.MediaRecorder,
    AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
    BlobClass = globalThis.Blob,
    workerFactory,
    maxRecordingMs = MAX_RECORDING_MS,
  } = {}) {
    this.mediaDevices = mediaDevices;
    this.MediaRecorderClass = MediaRecorderClass;
    this.AudioContextClass = AudioContextClass;
    this.BlobClass = BlobClass;
    this.workerFactory = workerFactory ?? (() => {
      if (typeof Worker !== 'function') throw Object.assign(new Error('voice_unsupported'), { code: 'voice_unsupported' });
      return new Worker(new URL('./voice-worker.js', import.meta.url), { type: 'module' });
    });
    this.maxRecordingMs = maxRecordingMs;
    this.worker = null;
    this.workerReady = false;
    this.loading = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.recording = null;
    this.recordingTimer = null;
  }

  get supported() {
    return Boolean(
      globalThis.isSecureContext !== false
      && this.mediaDevices?.getUserMedia
      && this.MediaRecorderClass
      && this.AudioContextClass
      && this.BlobClass,
    );
  }

  async load(onProgress = () => {}) {
    if (this.workerReady) return;
    if (!this.supported) {
      const error = new Error('voice_unsupported');
      error.code = 'voice_unsupported';
      throw error;
    }
    if (this.loading) return this.loading;

    this.loading = this.#request({ type: 'load' }, { onProgress })
      .then(() => { this.workerReady = true; })
      .catch((error) => {
        this.worker?.terminate?.();
        this.worker = null;
        this.workerReady = false;
        throw error;
      })
      .finally(() => { this.loading = null; });
    return this.loading;
  }

  async startRecording({ onMaximumDuration = () => {} } = {}) {
    if (!this.supported) {
      const error = new Error('voice_unsupported');
      error.code = 'voice_unsupported';
      throw error;
    }
    if (!this.workerReady) throw new Error('The on-device model is not ready.');
    if (this.recording) throw new Error('A recording is already in progress.');
    if (globalThis.isSecureContext === false) {
      const error = new Error('voice_insecure_context');
      error.code = 'voice_insecure_context';
      throw error;
    }

    const stream = await this.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let recorder;
    try {
      recorder = this.#createRecorder(stream);
      const chunks = [];
      const stopped = new Promise((resolve, reject) => {
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data?.size) chunks.push(event.data);
        });
        recorder.addEventListener('error', (event) => reject(event.error ?? new Error('Recording failed.')), { once: true });
        recorder.addEventListener('stop', () => resolve(new this.BlobClass(chunks, { type: recorder.mimeType || chunks[0]?.type || '' })), { once: true });
      });
      recorder.start();
      const recording = { recorder, stream, stopped, discarded: false };
      this.recording = recording;
      this.recordingTimer = setTimeout(() => {
        this.stopRecording().then((blob) => onMaximumDuration(blob)).catch(() => {});
      }, this.maxRecordingMs);
      return true;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  async stopRecording() {
    const recording = this.recording;
    if (!recording) throw new Error('No recording is in progress.');
    clearTimeout(this.recordingTimer);
    this.recordingTimer = null;
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    recording.stream.getTracks().forEach((track) => track.stop());
    this.recording = null;
    const blob = await recording.stopped;
    if (recording.discarded) return new this.BlobClass();
    if (!blob.size) {
      const error = new Error('empty_recording');
      error.code = 'empty_recording';
      throw error;
    }
    return blob;
  }

  async cancelRecording() {
    const recording = this.recording;
    if (!recording) return;
    clearTimeout(this.recordingTimer);
    this.recordingTimer = null;
    recording.discarded = true;
    this.recording = null;
    if (recording.recorder.state !== 'inactive') recording.recorder.stop();
    recording.stream.getTracks().forEach((track) => track.stop());
    await recording.stopped.catch(() => {});
  }

  async transcribe(blob, { onProgress = () => {} } = {}) {
    if (!this.workerReady) throw new Error('The on-device model is not ready.');
    if (!this.AudioContextClass) {
      const error = new Error('voice_unsupported');
      error.code = 'voice_unsupported';
      throw error;
    }

    let context;
    try {
      context = new this.AudioContextClass();
      const audio = await context.decodeAudioData(await blob.arrayBuffer());
      const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
      const samples = downsampleToMono(channels, audio.sampleRate);
      if (!samples.length) {
        const error = new Error('empty_recording');
        error.code = 'empty_recording';
        throw error;
      }
      const result = await this.#request({ type: 'transcribe', audio: samples, language: voiceLanguage() }, { onProgress, transfer: [samples.buffer] });
      const transcript = String(result.text ?? '').trim();
      if (!transcript) {
        const error = new Error('empty_transcript');
        error.code = 'empty_transcript';
        throw error;
      }
      return transcript;
    } finally {
      await context?.close?.().catch?.(() => {});
    }
  }

  async #ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    worker.addEventListener('message', (event) => this.#onWorkerMessage(event.data));
    worker.addEventListener('error', (event) => this.#onWorkerError(event.error ?? new Error(event.message || 'Speech worker failed.')));
    this.worker = worker;
    return worker;
  }

  async #request(message, { onProgress = () => {}, transfer = [] } = {}) {
    const worker = await this.#ensureWorker();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress });
      try {
        worker.postMessage({ ...message, requestId }, transfer);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  #onWorkerMessage(message) {
    const pending = this.pending.get(message?.requestId);
    if (!pending) return;
    if (message.type === 'progress') {
      pending.onProgress(message.progress ?? null);
      return;
    }
    this.pending.delete(message.requestId);
    if (message.type === 'error') {
      const error = new Error(message.message || 'The on-device speech engine failed.');
      error.code = message.code || (message.requestType === 'load' ? 'model_load' : 'transcription');
      pending.reject(error);
    } else if (message.type === 'ready' || message.type === 'transcript') {
      pending.resolve(message);
    } else {
      pending.reject(new Error('Unexpected response from the on-device speech worker.'));
    }
  }

  #onWorkerError(error) {
    this.workerReady = false;
    this.worker?.terminate?.();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  #createRecorder(stream) {
    const Recorder = this.MediaRecorderClass;
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
    const mimeType = typeof Recorder.isTypeSupported === 'function'
      ? mimeTypes.find((type) => Recorder.isTypeSupported(type))
      : null;
    return mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream);
  }
}
