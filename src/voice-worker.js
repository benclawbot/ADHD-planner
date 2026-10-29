import { env, pipeline } from './vendor/transformers/transformers.min.js';

const MODEL_ID = 'onnx-community/whisper-tiny';
const MODEL_REVISION = 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7';
const WASM_ASSET_DIRECTORY = new URL('./vendor/transformers/', import.meta.url).href;

let transcriber = null;
let loading = null;

self.addEventListener('message', async (event) => {
  const { requestId, type } = event.data ?? {};
  if (!Number.isInteger(requestId)) return;

  try {
    if (type === 'load') {
      await loadTranscriber(requestId);
      self.postMessage({ requestId, type: 'ready' });
      return;
    }

    if (type === 'transcribe') {
      if (!transcriber) throw new Error('The local speech model is not ready.');
      const audio = event.data.audio instanceof Float32Array
        ? event.data.audio
        : new Float32Array(event.data.audio);
      const output = await transcriber(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        task: 'transcribe',
        language: event.data.language || 'en',
      });
      self.postMessage({ requestId, type: 'transcript', text: output?.text ?? '' });
      return;
    }

    throw new Error('Unsupported speech worker request.');
  } catch (error) {
    self.postMessage({
      requestId,
      requestType: type,
      type: 'error',
      code: type === 'load' ? 'model_load' : 'transcription',
      message: error?.message || 'The on-device speech engine failed.',
    });
  }
});

async function loadTranscriber(requestId) {
  if (transcriber) return transcriber;
  if (loading) return loading;

  loading = (async () => {
    env.useBrowserCache = true;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = WASM_ASSET_DIRECTORY;
      env.backends.onnx.wasm.numThreads = 1;
    }

    transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
      revision: MODEL_REVISION,
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (progress) => {
        self.postMessage({ requestId, type: 'progress', progress });
      },
    });
    return transcriber;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}
