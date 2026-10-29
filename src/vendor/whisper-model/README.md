# On-device speech model

Tempo downloads the ONNX conversion of the multilingual OpenAI Whisper Tiny checkpoint from Hugging Face Hub when the user chooses to set up voice capture.

- Model: [`onnx-community/whisper-tiny`](https://huggingface.co/onnx-community/whisper-tiny)
- Base model: [`openai/whisper-tiny`](https://huggingface.co/openai/whisper-tiny)
- Pinned model revision: `ff4177021cc41f7db950912b73ea4fdf7d01d8e7`
- Approximate first-use model download: 45 MB (q8 encoder and merged decoder plus tokenizer/config files)
- The pinned ONNX model card names `openai/whisper-tiny` as its base model and does not declare a separate license. The upstream OpenAI Whisper repository lists the MIT license; a copy is included as [LICENSE](./LICENSE).
- Transformers.js runs this model locally through browser WASM. Tempo sends no recorded audio to Hugging Face or any other recognition service.

For model setup, Transformers.js fetches model configuration, tokenizer and quantized ONNX weights from Hugging Face Hub `resolve` URLs at the pinned revision. Large files may redirect to Hugging Face's file-delivery CDN. The browser caches those model assets in the Cache API. Browser storage may be evicted or cleared, requiring another download.
