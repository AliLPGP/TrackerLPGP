# Wasteman's natural voice: third-party files

Pinned copies, served from the tracker itself so the code that runs cannot change
underneath it. Both are Apache-2.0 (see LICENSE). Loaded only by `/wasteman-voice.js`.

| File | From | SHA-256 |
| --- | --- | --- |
| `kokoro.web.js` | npm `kokoro-js@1.2.1`, `dist/kokoro.web.js` | `6067712fe4c43cdb36c762f860a5ab8d96ea1d9c8882466438eb9f3d0d20be8f` |
| `ort-wasm-simd-threaded.jsep.mjs` | npm `@huggingface/transformers@3.5.1`, `dist/` | `08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9` |

Two data files are not here because they are too large to serve from the app. The
browser downloads them once and keeps them:

- the speech engine binary, `ort-wasm-simd-threaded.jsep.wasm` (21.6 MB), from jsDelivr
  at the same pinned version. `/wasteman-voice.js` checks its SHA-256 before using it.
- the voice model, `onnx-community/Kokoro-82M-v1.0-ONNX` (about 92 MB), from Hugging Face.

To update: replace both files from the matching npm versions, then update the version
and fingerprint in `/wasteman-voice.js` and the table above.
