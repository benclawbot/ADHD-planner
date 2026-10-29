# Vendored browser speech runtime

These files are the browser runtime assets from the official `@huggingface/transformers` npm package, version 3.8.1. The app loads them from this same origin only after the user chooses **Download on-device model**.

- npm tarball integrity: `sha512-tsTk4zVjImqdqjS8/AOZg2yNLd1z9S5v+7oUPpXaasDRwEDhB+xnglK1k5cad26lL5/ZIaeREgWWy0bs9y9pPA==`
- Browser bundle: `transformers.min.js` — SHA-256 `aa5002b70e789798da263f5f99c62bd3e8fcd0c119258a493c40c180648365fa`
- ONNX Runtime loader: `ort-wasm-simd-threaded.jsep.mjs` — SHA-256 `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9`
- ONNX Runtime WebAssembly: `ort-wasm-simd-threaded.jsep.wasm` — SHA-256 `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39`

The package is licensed under Apache-2.0; see [LICENSE](./LICENSE). The model weights are downloaded separately from Hugging Face Hub and pinned in `src/voice-worker.js`.
