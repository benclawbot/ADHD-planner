const TRANSFORMERS_URL = '/src/vendor/transformers/transformers.min.js';

let transcriber = null;
let loading = null;
const nativeFetch = globalThis.fetch.bind(globalThis);

// Workers static assets are limited to 25 MiB each. Reassemble the 29 MiB
// quantized decoder from same-origin parts before ONNX Runtime reads it.
globalThis.fetch = async (input, init) => {
  const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const requestUrl = new URL(inputUrl, self.location.origin);
  const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
  if (requestUrl.pathname !== '/src/vendor/whisper-tiny/onnx/decoder_model_merged_quantized.onnx' || method !== 'GET') {
    return nativeFetch(input, init);
  }
  const parts = await Promise.all([0, 1, 2, 3].map(async (part) => {
    const response = await nativeFetch(`${requestUrl.pathname}.part-${String(part).padStart(3, '0')}`);
    if (!response.ok) throw new Error(`Speech model part ${part + 1} could not be loaded.`);
    return response.arrayBuffer();
  }));
  return new Response(new Blob(parts, { type: 'application/octet-stream' }), {
    headers: { 'content-type': 'application/octet-stream' },
  });
};

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
    const { env, pipeline } = await import(new URL(TRANSFORMERS_URL, self.location.origin));
    env.useBrowserCache = true;
    env.useWasmCache = true;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '/src/vendor/';
    env.backends.onnx.wasm.wasmPaths = '/src/vendor/transformers/';
    if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;

    transcriber = await pipeline('automatic-speech-recognition', 'whisper-tiny', {
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
