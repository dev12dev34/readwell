// Runs the Kokoro AI voice on the phone (off the main thread).
// Model files are downloaded once from this app's own web address and kept
// in a private cache, so it works offline afterwards.
import * as ort from '../vendor/ort/ort.wasm.min.js';
import { textToPhonemes } from './kokoro-phonemes.js';
import { VOCAB } from './kokoro-vocab.js';

const BASE = new URL('../ai/', import.meta.url).href;
const CACHE = 'rw-ai-1';
const MAX_PH = 500;
// Where the voice files come from. If this website hosts its own copy (an ai/ folder
// with manifest.json) that is used; otherwise they come from Hugging Face and jsDelivr,
// which host these open-source files for free.
let HF = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';
let REMOTE = makeRemote(null);
function makeRemote(DEV) {
  if (DEV) HF = DEV + '/hf/'; // testing only
  return {
  model: [{ key: 'model/kokoro.onnx', url: HF + 'onnx/model_quantized.onnx', size: 92361116 }],
  wasm: { key: 'ort-wasm-simd-threaded.wasm', url: DEV ? DEV + '/jsd/ort-wasm-simd-threaded.wasm' : 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm', size: 11210254 },
  voice: (name) => ({ key: `voices/${name}.bin`, url: `${HF}voices/${name}.bin`, size: 522240 }),
  firstVoice: 'af_heart',
  };
}
let manifest = null, session = null, loading = null, warmMs = 0;
const voices = new Map();

const post = (m, t) => postMessage(m, t || []);

async function getManifest() {
  if (manifest) return manifest;
  const c = await caches.open(CACHE);
  const saved = await c.match(BASE + '_sources.json');
  if (saved) return (manifest = await saved.json());
  let m = null;
  try {
    const r = await fetch(BASE + 'manifest.json', { cache: 'no-store' });
    if (r.ok) {
      const own = await r.json();
      m = {
        model: own.parts.map((p, k) => ({ key: `model/part${k}`, url: BASE + p.path, size: p.size })),
        wasm: { key: 'ort-wasm-simd-threaded.wasm', url: BASE + own.wasm.path, size: own.wasm.size },
        voiceBase: BASE + 'voices/', firstVoice: own.voices[0],
      };
    }
  } catch {}
  if (!m) m = { model: REMOTE.model, wasm: REMOTE.wasm, voiceBase: HF + 'voices/', firstVoice: REMOTE.firstVoice };
  manifest = m;
  return m;
}
const voiceEntry = (m, name) => ({ key: `voices/${name}.bin`, url: `${m.voiceBase}${name}.bin`, size: 522240 });

async function fetchToCache(entry, onBytes) {
  const c = await caches.open(CACHE);
  const key = BASE + entry.key;
  const hit = await c.match(key);
  if (hit) { const b = await hit.arrayBuffer(); onBytes && onBytes(b.byteLength); return b; }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    let got = 0;
    try {
      const res = await fetch(entry.url, { cache: 'no-store', mode: 'cors' });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const reader = res.body.getReader(); const chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onBytes && onBytes(value.length, true); }
      const buf = new Uint8Array(got); let o = 0; for (const ch of chunks) { buf.set(ch, o); o += ch.length; }
      await c.put(key, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
      return buf.buffer;
    } catch (e) {
      lastErr = e;
      if (got && onBytes) onBytes(-got, true);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function status() {
  try {
    const m = await getManifest();
    const c = await caches.open(CACHE);
    const files = [...m.model, m.wasm];
    let have = 0;
    for (const f of files) if (await c.match(BASE + f.key)) have++;
    const total = files.reduce((a, f) => a + f.size, 0);
    return { installed: have === files.length, partial: have > 0 && have < files.length, total };
  } catch (e) {
    return { installed: false, error: e.message };
  }
}

async function install() {
  const m = await getManifest();
  const first = voiceEntry(m, m.firstVoice);
  const total = m.model.reduce((a, p) => a + p.size, 0) + m.wasm.size + first.size;
  let done = 0, lastPost = 0;
  const tick = (n, streaming) => {
    done += n;
    const now = Date.now();
    if (!streaming || now - lastPost > 200) { lastPost = now; post({ type: 'progress', loaded: done, total }); }
  };
  await fetchToCache(m.wasm, tick);
  for (const p of m.model) await fetchToCache(p, tick);
  await fetchToCache(first, tick);
  // remember where the files came from, so it all works offline
  const c = await caches.open(CACHE);
  await c.put(BASE + '_sources.json', new Response(JSON.stringify(m), { headers: { 'content-type': 'application/json' } }));
  post({ type: 'progress', loaded: total, total });
}

async function load() {
  if (session) return session;
  if (!loading) {
    loading = (async () => {
      const m = await getManifest();
      const st = await status();
      if (!st.installed) throw new Error('not-installed');
      post({ type: 'stage', text: 'Starting the speech engine…' });
      ort.env.wasm.wasmBinary = await fetchToCache(m.wasm);
      ort.env.wasm.wasmPaths = { mjs: new URL('../vendor/ort/ort-wasm-simd-threaded.js', import.meta.url).href };
      const cores = (self.navigator && navigator.hardwareConcurrency) || 2;
      // One thread: iPhones can stall when the engine uses several (shared-memory limits).
      ort.env.wasm.numThreads = 1; void cores;
      post({ type: 'stage', text: 'Loading the voice model (about 90 MB)…' });
      let model;
      if (m.model.length === 1) model = new Uint8Array(await fetchToCache(m.model[0]));
      else {
        const parts = [];
        for (const p of m.model) parts.push(new Uint8Array(await fetchToCache(p)));
        model = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
        for (const p of parts) { model.set(p, o); o += p.length; }
      }
      post({ type: 'stage', text: 'Setting up the voice…' });
      session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false });
      model = null;
      post({ type: 'stage', text: 'Testing the voice model…' });
      const t0 = performance.now();
      await infer(session, tokenize('hˈaɪ.'), await voice(m.firstVoice), 1);
      warmMs = performance.now() - t0;
      return session;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

async function voice(name) {
  if (voices.has(name)) return voices.get(name);
  const buf = await fetchToCache(voiceEntry(await getManifest(), name));
  const v = new Float32Array(buf);
  voices.set(name, v);
  return v;
}

function tokenize(ph) { const ids = []; for (const ch of ph) { const id = VOCAB[ch]; if (id !== undefined) ids.push(id); } return ids; }

function chunksOf(ph) {
  if (ph.length <= MAX_PH) return [ph];
  const out = []; let rest = ph;
  while (rest.length > MAX_PH) {
    let cut = Math.max(rest.lastIndexOf(', ', MAX_PH), rest.lastIndexOf('; ', MAX_PH));
    if (cut < 100) cut = rest.lastIndexOf(' ', MAX_PH);
    if (cut < 1) cut = MAX_PH;
    out.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

async function runPhonemes(ph, voiceName, speed = 1) {
  const s = await load();
  const v = await voice(voiceName);
  const pieces = [];
  for (const part of chunksOf(ph)) {
    const ids = tokenize(part);
    if (!ids.length) continue;
    pieces.push(await infer(s, ids, v, speed));
  }
  const len = pieces.reduce((a, p) => a + p.length, 0);
  const audio = new Float32Array(len); let o = 0;
  for (const p of pieces) { audio.set(p, o); o += p.length; }
  return audio;
}

async function infer(s, ids, v, speed) {
  const n = Math.min(ids.length, 510);
  const style = v.slice((n - 1) * 256, n * 256);
  const tokens = new ort.Tensor('int64', BigInt64Array.from([0, ...ids.slice(0, 510), 0].map(BigInt)), [1, n + 2]);
  const name = s.inputNames.find((x) => x !== 'style' && x !== 'speed') || 'input_ids';
  const out = await s.run({ [name]: tokens, style: new ort.Tensor('float32', style, [1, 256]), speed: new ort.Tensor('float32', [speed], [1]) });
  return out[s.outputNames[0]].data;
}

self.addEventListener('unhandledrejection', (e) => post({ type: 'stage', text: 'Problem: ' + (e.reason && e.reason.message || e.reason) }));
let queue = Promise.resolve();
let stallPhon = false; // testing only
const cancelled = new Set();
onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'config') { if (msg.remote) REMOTE = makeRemote(msg.remote); stallPhon = !!msg.stallPhon; return; }
  if (msg.cmd === 'cancel') { for (const id of msg.ids) cancelled.add(id); return; }
  const run = async () => {
    try {
      if (msg.cmd === 'status') post({ type: 'status', id: msg.id, ...(await status()), threads: self.crossOriginIsolated });
      else if (msg.cmd === 'install') { await install(); post({ type: 'installed', id: msg.id }); }
      else if (msg.cmd === 'load') { await load(); post({ type: 'ready', id: msg.id, threads: ort.env.wasm.numThreads, warmMs }); }
      else if (msg.cmd === 'phon') {
        const t0 = performance.now();
        if (stallPhon) return; // testing only: pretend it hangs
        const phonemes = await textToPhonemes(msg.text, msg.lang);
        post({ type: 'phon', id: msg.id, phonemes, ms: performance.now() - t0 });
      } else if (msg.cmd === 'run') {
        if (cancelled.has(msg.id)) { cancelled.delete(msg.id); return; }
        const t0 = performance.now();
        const audio = await runPhonemes(msg.phonemes, msg.voice, msg.speed || 1);
        post({ type: 'audio', id: msg.id, audio, ms: performance.now() - t0 }, [audio.buffer]);
      } else if (msg.cmd === 'remove') {
        await caches.delete(CACHE); manifest = null; session = null; loading = null; voices.clear();
        post({ type: 'removed', id: msg.id });
      }
    } catch (err) {
      post({ type: 'error', id: msg.id, error: err && err.message ? err.message : String(err) });
    }
  };
  // Voice-model runs happen one at a time; everything else runs at once.
  if (msg.cmd === 'run') queue = queue.then(run); else run();
};
