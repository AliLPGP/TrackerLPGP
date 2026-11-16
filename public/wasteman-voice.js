// Wasteman's natural voice: speech made on this device by the Kokoro model (open source,
// Apache-2.0), so nothing typed or said leaves the browser. It runs in its own worker
// because making a sentence is a second or two of solid work that would freeze the page.
//
// All the code is in /vendor/kokoro, pinned copies served by the tracker itself. Two data
// files come from outside, once, and the browser then keeps them: the speech engine's
// WebAssembly binary (checked against a known fingerprint before it is used) and the
// voice model from Hugging Face.
//
// The page sends  { type: 'load', voice, pace }                      get ready (pace: already measured here)
//                 { type: 'say', run, index, text, voice, speed }    make one sentence
//                 { type: 'stop', run }                              drop sentences up to this answer
// and is sent     { type: 'loading', step, pct }  { type: 'ready', pace }  { type: 'error', message }
//                 { type: 'audio', run, index, samples, rate }       { type: 'failed', run, index }
// `pace` is how many seconds this computer needs to make one second of speech: under 1 it
// keeps up with itself, well over 1 it cannot, and the page falls back to the browser's voice.
import { KokoroTTS, env } from './vendor/kokoro/kokoro.web.js';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const ENGINE = {
  url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/ort-wasm-simd-threaded.jsep.wasm',
  sha256: 'c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39',
  loader: new URL('./vendor/kokoro/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href,
};

// The engine binary: from this browser's own store when it is there, else downloaded.
// Either way it is only used if it is exactly the file this was written against.
async function engineBinary() {
  const store = await caches.open('wasteman-voice').catch(() => null);
  const kept = store && await store.match(ENGINE.url);
  const res = kept || await fetch(ENGINE.url);
  if (!res.ok) throw new Error(`The speech engine could not be downloaded (${res.status})`);
  const bytes = await res.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if ([...digest].map(b => b.toString(16).padStart(2, '0')).join('') !== ENGINE.sha256) {
    if (store) await store.delete(ENGINE.url);
    throw new Error('The speech engine file is not the one expected, so it was not used');
  }
  if (store && !kept) store.put(ENGINE.url, new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } })).catch(() => {});
  return URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
}

let tts = null, loading = null;
function load(voice, pace) {
  return loading || (loading = (async () => {
    postMessage({ type: 'loading', step: 'engine' });
    env.wasmPaths = { mjs: ENGINE.loader, wasm: await engineBinary() };
    postMessage({ type: 'loading', step: 'model' });
    let shown = -1;   // progress arrives hundreds of times a second: pass on each whole percent once
    tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm',
      progress_callback: p => {
        const pct = p.status === 'progress' && /\.onnx$/.test(p.file || '') ? Math.round(p.progress) : shown;
        if (pct !== shown) postMessage({ type: 'loading', step: 'model', pct: (shown = pct) });
      } });
    // A first phrase to wake the engine up (the first one is always slow), then, unless this
    // computer has been timed before, one against the clock
    postMessage({ type: 'loading', step: 'pace' });
    await tts.generate('Hello.', { voice });
    if (!pace) {
      const started = performance.now(), { audio, sampling_rate } = await tts.generate('Ready when you are, boss.', { voice });
      pace = +((performance.now() - started) / 1000 / (audio.length / sampling_rate)).toFixed(2);
    }
    postMessage({ type: 'ready', pace });
  })().catch(e => { loading = null; postMessage({ type: 'error', message: String((e && e.message) || e) }); throw e; }));
}

// One sentence at a time, in the order asked. `dropped` is the last answer that was cut
// off: its sentences still waiting are skipped rather than made for nobody.
let queue = Promise.resolve(), dropped = 0;
async function say({ run, index, text, voice, speed }) {
  if (run <= dropped) return;
  try {
    await load();
    if (run <= dropped) return;
    const { audio, sampling_rate } = await tts.generate(text, { voice, speed });
    postMessage({ type: 'audio', run, index, samples: audio, rate: sampling_rate }, [audio.buffer]);
  } catch (e) {
    postMessage({ type: 'failed', run, index, message: String((e && e.message) || e) });
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'load') load(data.voice, data.pace).catch(() => {});
  else if (data.type === 'stop') dropped = Math.max(dropped, data.run);
  else if (data.type === 'say') queue = queue.then(() => say(data));
};
