// Kokoro AI voices on the phone: download manager + a player with the same
// interface as the system-voice Player in speech.js.
import { wordsOf } from './speech.js';

export const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', accent: 'US', gender: 'F', star: true },
  { id: 'af_bella', name: 'Bella', accent: 'US', gender: 'F', star: true },
  { id: 'af_nicole', name: 'Nicole', accent: 'US', gender: 'F', note: 'soft, close-up' },
  { id: 'af_aoede', name: 'Aoede', accent: 'US', gender: 'F' },
  { id: 'af_kore', name: 'Kore', accent: 'US', gender: 'F' },
  { id: 'af_sarah', name: 'Sarah', accent: 'US', gender: 'F' },
  { id: 'af_nova', name: 'Nova', accent: 'US', gender: 'F' },
  { id: 'af_sky', name: 'Sky', accent: 'US', gender: 'F' },
  { id: 'am_michael', name: 'Michael', accent: 'US', gender: 'M', star: true },
  { id: 'am_fenrir', name: 'Fenrir', accent: 'US', gender: 'M' },
  { id: 'am_puck', name: 'Puck', accent: 'US', gender: 'M' },
  { id: 'am_echo', name: 'Echo', accent: 'US', gender: 'M' },
  { id: 'bf_emma', name: 'Emma', accent: 'UK', gender: 'F', star: true },
  { id: 'bf_isabella', name: 'Isabella', accent: 'UK', gender: 'F' },
  { id: 'bm_george', name: 'George', accent: 'UK', gender: 'M', star: true },
  { id: 'bm_fable', name: 'Fable', accent: 'UK', gender: 'M' },
  { id: 'bm_lewis', name: 'Lewis', accent: 'UK', gender: 'M' },
];
export const isKokoro = (uri) => typeof uri === 'string' && uri.startsWith('kokoro:');
export const kokoroVoice = (uri) => {
  const id = (uri || '').replace(/^kokoro:/, '');
  const v = KOKORO_VOICES.find((x) => x.id === id) || KOKORO_VOICES[0];
  return { voiceURI: 'kokoro:' + v.id, name: v.name, lang: v.accent === 'UK' ? 'en-GB' : 'en-US', kokoro: v.id, meta: v };
};

const SR = 24000;

// ------------------------------------------------------------------ engine
class Engine {
  constructor() { this.w = null; this.seq = 0; this.wait = new Map(); this.onprogress = null; this.rtf = null; this.ready = false; this.threads = 1; }
  worker() {
    if (!this.w) {
      const url = new URL('./kokoro-worker.js', import.meta.url);
      this.w = new Worker(url, { type: 'module' });
      try { const dev = localStorage.getItem('rw-ai-remote'); if (dev) this.w.postMessage({ cmd: 'config', remote: dev }); } catch {}
      this.w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { this.onprogress && this.onprogress(m.loaded, m.total); return; }
        if (m.type === 'stage') { this.stage = m.text; this.onstage && this.onstage(m.text); return; }
        const p = this.wait.get(m.id); if (!p) return;
        this.wait.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.error)); else p.resolve(m);
      };
      this.w.onerror = (e) => {
        const err = new Error(e.message || 'The AI voice stopped working (the phone may be low on memory).');
        for (const p of this.wait.values()) p.reject(err);
        this.wait.clear(); this.w = null; this.ready = false;
      };
    }
    return this.w;
  }
  send(cmd, data = {}, transfer) {
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => this.wait.set(id, { resolve, reject }));
    this.worker().postMessage({ cmd, id, ...data }, transfer || []);
    p.id = id;
    return p;
  }
  cancel(ids) { if (this.w && ids.length) { this.w.postMessage({ cmd: 'cancel', ids }); for (const id of ids) { const p = this.wait.get(id); if (p) { this.wait.delete(id); p.reject(Object.assign(new Error('cancelled'), { cancelled: true })); } } } }
  /** Throw the voice engine away (if it is stuck) and start fresh next time. */
  reset(reason = 'reset') {
    if (this.w) { try { this.w.terminate(); } catch {} }
    this.w = null; this.ready = false;
    const err = Object.assign(new Error(reason), { reset: true });
    for (const p of this.wait.values()) p.reject(err);
    this.wait.clear();
  }
  status() { return this.send('status'); }
  install(onprogress) { this.onprogress = onprogress; return this.send('install').finally(() => { this.onprogress = null; }); }
  async load() {
    if (this.ready) return;
    if (!this.loadP) {
      this.loadP = withTimeout(this.send('load'), 150000, 'ai-timeout-load')
        .then((r) => { this.ready = true; this.threads = r.threads; })
        .finally(() => { this.loadP = null; });
    }
    return this.loadP;
  }
  remove() { this.ready = false; return this.send('remove'); }
  synth(text, voice, speed = 1) {
    const p = this.send('synth', { text, voice, speed });
    const out = p.then((m) => {
      const dur = (m.audio.length / SR) * speed;
      if (dur > 0.5) { const r = (m.ms / 1000) / dur; this.rtf = this.rtf == null ? r : this.rtf * 0.7 + r * 0.3; }
      return m.audio;
    });
    out.id = p.id;
    return out;
  }
}
export const engine = new Engine();

export function withTimeout(p, ms, code) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { engine.reset(code); rej(Object.assign(new Error(code), { timeout: true })); }, ms); })])
    .finally(() => clearTimeout(t));
}

/** Check the AI voice on this phone, step by step. */
export async function selfTest(onstep) {
  const t0 = performance.now();
  engine.onstage = (s) => onstep(s);
  try {
    onstep('Starting the voice engine…');
    await engine.load();
    const tl = (performance.now() - t0) / 1000;
    onstep(`Engine ready in ${tl.toFixed(1)} s. Making a test sentence…`);
    const t1 = performance.now();
    const a = await withTimeout(engine.synth('This is a short test of the natural AI voice.', 'af_heart', 1), 120000, 'ai-timeout');
    const make = (performance.now() - t1) / 1000, dur = a.length / SR;
    return { ok: true, load: tl, make, dur, rtf: make / dur, samples: a };
  } finally { engine.onstage = null; }
}

// ------------------------------------------------------------------ helpers
export function wavBytes(samples) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return buf;
}
function wavUrl(samples) { return URL.createObjectURL(new Blob([wavBytes(samples)], { type: 'audio/wav' })); }
const SILENT = (() => wavUrl(new Float32Array(1200)))();

/** Estimate when each word is spoken, from the audio's loud part and word lengths. */
function timeWords(text, samples) {
  const thr = 0.012; let a = 0, z = samples.length - 1;
  while (a < z && Math.abs(samples[a]) < thr) a++;
  while (z > a && Math.abs(samples[z]) < thr) z--;
  const t0 = Math.max(0, a / SR - 0.03), t1 = (z + 1) / SR;
  const words = wordsOf(text);
  if (!words.length) return [];
  const weights = words.map(([st, len], k) => {
    let w = len + 2.2;
    if (k < words.length - 1) {
      const gap = text.slice(st + len, words[k + 1][0]);
      if (/[.!?…]/.test(gap)) w += 7; else if (/[,;:—–)]/.test(gap)) w += 4; else if (/["”]/.test(gap)) w += 1;
    }
    return w;
  });
  const total = weights.reduce((x, y) => x + y, 0);
  let acc = 0;
  return words.map(([st, len], k) => { const t = t0 + (acc / total) * (t1 - t0); acc += weights[k]; return { st, len, t }; });
}

/** Split a sentence into pieces of at most ~170 characters at natural pauses. */
function piecesOf(text) {
  if (text.length <= 190) return [{ start: 0, text }];
  const out = []; let pos = 0;
  while (text.length - pos > 190) {
    const win = text.slice(pos, pos + 170);
    let cut = -1;
    for (const m of win.matchAll(/[,;:—–]\s+/g)) if (m.index > 50) cut = m.index + m[0].length;
    if (cut < 0) { cut = win.lastIndexOf(' '); if (cut < 40) cut = win.length; else cut += 1; }
    out.push({ start: pos, text: text.slice(pos, pos + cut) }); pos += cut;
  }
  out.push({ start: pos, text: text.slice(pos) });
  return out;
}

// ------------------------------------------------------------------ player
export class KokoroPlayer {
  constructor() {
    this.sentences = []; this.index = 0; this.rate = 1; this.voice = kokoroVoice('kokoro:af_heart');
    this.playing = false; this.wordOffset = 0; this.supported = true; this.gen = 0;
    this.cache = new Map(); this.cur = null; this.title = 'Readwell';
    this.onword = () => {}; this.onsentence = () => {}; this.onstate = () => {}; this.onend = () => {};
    this.onwait = () => {}; this.onerror = () => {};
    this.audio = new Audio(); this.audio.preload = 'auto'; this.audio.preservesPitch = true;
    this.unlocked = false; this.wakeLock = null;
    this.audio.addEventListener('ended', () => this._ended());
    this.audio.addEventListener('pause', () => { if (this.playing && !this._internalPause && !this._switching && !this.audio.ended) { this.playing = false; this.onstate(false); } });
    this._media();
  }

  _media() {
    const ms = navigator.mediaSession; if (!ms) return;
    try {
      ms.setActionHandler('play', () => this.toggle());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('nexttrack', () => this.skip(1));
      ms.setActionHandler('previoustrack', () => this.skip(-1));
    } catch {}
  }
  _meta() {
    try { if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: this.title, artist: `Readwell · ${this.voice.name}` }); } catch {}
  }

  load(sentences, index = 0) { this.stop(); this.sentences = sentences; this.index = Math.max(0, Math.min(index, sentences.length - 1)); this._clearCache(); }
  // Kokoro speaks faster or slower itself (sounds better and is quicker to make);
  // the audio player covers whatever is outside the model's 0.5×–2× range.
  _native() { return Math.max(0.5, Math.min(2, this.rate)); }
  setRate(r) {
    const before = this._native();
    this.rate = r;
    this.audio.playbackRate = r / this._native();
    if (this._native() !== before) {
      this._clearCache();
      if (this.playing) this.play(this.index, this.wordOffset || 0); else this.cur = null;
    }
  }
  setVoice(v) {
    const was = this.playing; const at = this.wordOffset || 0;
    this.voice = v; this._clearCache();
    if (was) this.play(this.index, at); else this.cur = null;
  }
  _clearCache() { engine.cancel([...this.cache.values()].map((p) => p.id).filter(Boolean)); this.cache.clear(); }

  _unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    try { this._switching = true; this.audio.src = SILENT; const p = this.audio.play(); p && p.then(() => { this._switching = false; }, () => { this._switching = false; this.unlocked = false; }); } catch { this.unlocked = false; }
  }

  async _lock() { try { if ('wakeLock' in navigator && !this.wakeLock) { this.wakeLock = await navigator.wakeLock.request('screen'); this.wakeLock.addEventListener('release', () => { this.wakeLock = null; }); } } catch {} }
  _unlockScreen() { try { this.wakeLock && this.wakeLock.release(); } catch {} this.wakeLock = null; }

  _unitAt(i, off, quick = false) {
    const s = this.sentences[i]; if (!s) return null;
    const ps = piecesOf(s.text);
    if (quick) {
      // make the first clip short so reading starts sooner
      const rest = s.text.slice(off);
      const m = rest.length > 90 && [...rest.matchAll(/[,;:—–]\s+/g)].find((x) => x.index > 25 && x.index < 110);
      if (m) return { i, start: off, text: rest.slice(0, m.index + m[0].length) };
    }
    let u = ps[0];
    for (const p of ps) if (p.start <= off) u = p;
    if (off > u.start) {
      const end = u.start + u.text.length;
      return { i, start: off, text: s.text.slice(off, end) };
    }
    return { i, start: u.start, text: u.text };
  }
  _next(u) {
    const s = this.sentences[u.i];
    const end = u.start + u.text.length;
    if (s && end < s.text.length) return this._unitAt(u.i, end);
    for (let i = u.i + 1; i < this.sentences.length; i++) { const n = this._unitAt(i, 0); if (n && n.text.trim()) return n; }
    return null;
  }
  _key(u) { return `${u.i}:${u.start}:${u.text.length}`; }
  /** Load the voice and make the first clips in the background, so Play starts quickly. */
  prepare(index = this.index) {
    if (!this.sentences.length) return;
    const u = this._unitAt(index, 0, true);
    engine.load().then(() => { if (!this.playing && this.sentences.length) { this._get(u); this._prefetch(u); } }).catch(() => {});
  }
  _get(u) {
    const k = this._key(u);
    if (!this.cache.has(k)) {
      const p = engine.synth(u.text, this.voice.kokoro, this._native());
      p.catch(() => this.cache.delete(k));
      this.cache.set(k, p);
    }
    return this.cache.get(k);
  }
  _prefetch(u) {
    let n = u;
    for (let k = 0; k < 3 && n; k++) { n = this._next(n); if (n && n.text.trim()) this._get(n); }
    // forget audio we have passed
    for (const key of [...this.cache.keys()]) {
      const [i] = key.split(':').map(Number);
      if (i < u.i - 1) this.cache.delete(key);
    }
  }

  play(index = this.index, charOffset = 0) {
    if (!this.sentences.length) return;
    this._unlock();
    const gen = ++this.gen;
    this._internalPause = true; this.audio.pause(); this._internalPause = false;
    this.index = Math.max(0, Math.min(index, this.sentences.length - 1));
    // drop queued clips that are no longer near where we're reading
    const stale = [];
    for (const [key, p] of this.cache) { const i = +key.split(':')[0]; if (i < this.index || i > this.index + 3) { stale.push(p.id); this.cache.delete(key); } }
    engine.cancel(stale.filter(Boolean));
    // start on a word boundary
    const s = this.sentences[this.index];
    const w = wordsOf(s.text).find(([st, len]) => charOffset < st + len);
    const off = charOffset > 0 && w ? w[0] : 0;
    this.playing = true; this.onstate(true); this._lock(); this._meta();
    this._playUnit(this._unitAt(this.index, off, true), gen, true);
  }

  async _playUnit(u, gen, first = false) {
    if (gen !== this.gen) return;
    if (!u) return this._finish();
    if (first || u.i !== this.index) { this.index = u.i; this.onsentence(u.i); }
    this.cur = u;
    const p = this._get(u);
    this._prefetch(u);
    let samples, waited = false;
    const t = setTimeout(() => { if (gen === this.gen) { waited = true; this.onwait(true, 'Making speech…'); } }, 150);
    try {
      if (!engine.ready) {
        clearTimeout(t); waited = true; this.onwait(true, 'Preparing the AI voice (first time can take up to a minute)…');
        engine.onstage = (s) => { if (gen === this.gen) this.onwait(true, s); };
        await engine.load();
        engine.onstage = null;
        this.onwait(true, 'Making speech…');
      }
      samples = await withTimeout(p, 30000 + u.text.length * 600, 'ai-timeout');
    } catch (e) {
      engine.onstage = null;
      clearTimeout(t); if (waited) this.onwait(false);
      if (gen !== this.gen || e.cancelled) return;
      if (e.reset && e.message === 'reset') return;
      this.playing = false; this.onstate(false); this._unlockScreen();
      this.onerror(e.message || String(e));
      return;
    }
    clearTimeout(t); if (waited) this.onwait(false);
    if (gen !== this.gen) return;
    // keep the buffer reusable for "pause / resume"
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = wavUrl(samples);
    this.times = timeWords(u.text, samples);
    this.lastWord = -1;
    this._switching = true;
    this.audio.src = this.url;
    this.audio.playbackRate = this.rate / this._native();
    try { await this.audio.play(); this._switching = false; }
    catch (e) {
      this._switching = false;
      if (gen !== this.gen) return;
      this.playing = false; this.onstate(false);
      this.onerror('Tap play again to start the AI voice.');
      return;
    }
    this._tick(gen);
  }

  _tick(gen) {
    const step = () => {
      if (gen !== this.gen || !this.playing) return;
      const t = this.audio.currentTime;
      const ts = this.times || [];
      let k = this.lastWord;
      while (k + 1 < ts.length && ts[k + 1].t <= t) k++;
      if (k !== this.lastWord && k >= 0) {
        this.lastWord = k;
        const w = ts[k];
        this.wordOffset = this.cur.start + w.st;
        this.onword(this.cur.i, this.cur.start + w.st, w.len);
      }
      if (document.visibilityState === 'visible') requestAnimationFrame(step); else setTimeout(step, 250);
    };
    step();
  }

  _ended() {
    if (!this.playing || !this.cur || this.audio.src === SILENT) return;
    const gen = this.gen;
    this._playUnit(this._next(this.cur), gen);
  }

  _finish() {
    this.playing = false; this.gen++; this.cur = null;
    this._unlockScreen(); this.onstate(false); this.onend();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._internalPause = true; this.audio.pause(); this._internalPause = false;
    this._unlockScreen();
    this.onwait(false);
    this.onstate(false);
  }
  stop() { this.gen++; this.pause(); this.cur = null; this.wordOffset = 0; }
  toggle() {
    if (this.playing) return this.pause();
    // resume the clip we paused in, if it's still loaded
    if (this.cur && this.url && this.audio.src === this.url && !this.audio.ended && this.cur.i === this.index) {
      this._unlock();
      this.playing = true; this.onstate(true); this._lock();
      const gen = this.gen;
      this.audio.play().then(() => this._tick(gen)).catch(() => this.play(this.index, this.wordOffset || 0));
      return;
    }
    this.play(this.index, this.wordOffset || 0);
  }
  skip(delta) {
    const i = Math.max(0, Math.min(this.sentences.length - 1, this.index + delta));
    this.wordOffset = 0;
    if (this.playing) this.play(i, 0);
    else { this.gen++; this.cur = null; this.index = i; this.onsentence(i); this.onword(i, 0, 0); }
  }

  async say(text) {
    this.pause();
    try {
      await engine.load();
      const samples = await engine.synth(text, this.voice.kokoro, 1);
      const a = new Audio(wavUrl(samples)); a.play().catch(() => {});
    } catch (e) { this.onerror(e.message); }
  }
}
