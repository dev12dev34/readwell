// Reading aloud with the iPhone's built-in voices (speechSynthesis).
// One utterance per sentence; word positions come from boundary events, or
// are estimated when a voice doesn't report them.
const synth = window.speechSynthesis;

const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|grandma|grandpa|rocko|shelley|sandy|reed|flo|eddy)\b/i;

export function voiceQuality(v) {
  const id = `${v.name} ${v.voiceURI}`.toLowerCase();
  if (id.includes('premium')) return 3;
  if (id.includes('enhanced') || id.includes('siri') || id.includes('neural') || id.includes('natural')) return 2;
  return 1;
}
export const qualityLabel = (q) => ({ 3: 'Premium', 2: 'Enhanced', 1: 'Standard' }[q]);

export function listVoices() {
  if (!synth) return [];
  const all = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
  const seen = new Set();
  return all
    .filter((v) => { const k = v.voiceURI || v.name; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((v) => ({ v, q: voiceQuality(v) }))
    .sort((a, b) => (b.q - a.q) || ((a.v.lang === navigator.language ? 0 : 1) - (b.v.lang === navigator.language ? 0 : 1)) || a.v.name.localeCompare(b.v.name))
    .map((x) => x.v);
}

export function voicesReady(timeout = 2500) {
  return new Promise((resolve) => {
    if (!synth) return resolve([]);
    if (synth.getVoices().length) return resolve(listVoices());
    const done = () => { clearTimeout(t); synth.removeEventListener?.('voiceschanged', done); resolve(listVoices()); };
    const t = setTimeout(done, timeout);
    synth.addEventListener?.('voiceschanged', done);
  });
}

export function cleanVoiceName(v) {
  return v.name.replace(/\s*\((premium|enhanced)\)\s*/i, '').replace(/^(com\.apple\.\S+)$/, 'Voice');
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
export function wordsOf(text) {
  const out = []; let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text))) out.push([m.index, m[0].length]);
  return out;
}

export class Player {
  constructor() {
    this.sentences = [];
    this.index = 0;
    this.rate = 1;
    this.voice = null;
    this.playing = false;
    this.gen = 0;
    this.keep = []; // Safari can drop utterances that aren't referenced
    this.boundarySeen = false;
    this.onword = () => {}; this.onsentence = () => {}; this.onstate = () => {}; this.onend = () => {};
    this.wakeLock = null;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.playing) this._lock(); });
  }

  get supported() { return !!synth; }

  load(sentences, index = 0) { this.stop(); this.sentences = sentences; this.index = Math.max(0, Math.min(index, sentences.length - 1)); }

  setRate(r) { this.rate = r; if (this.playing) this.play(this.index, this.wordOffset || 0); }
  setVoice(v) { this.voice = v; this.boundarySeen = false; if (this.playing) this.play(this.index, this.wordOffset || 0); }

  async _lock() {
    try { if ('wakeLock' in navigator && !this.wakeLock) { this.wakeLock = await navigator.wakeLock.request('screen'); this.wakeLock.addEventListener('release', () => { this.wakeLock = null; }); } } catch {}
  }
  _unlock() { try { this.wakeLock && this.wakeLock.release(); } catch {} this.wakeLock = null; }

  play(index = this.index, charOffset = 0) {
    if (!synth || !this.sentences.length) return;
    const gen = ++this.gen;
    synth.cancel();
    this.index = Math.max(0, Math.min(index, this.sentences.length - 1));
    this.playing = true;
    this.onstate(true);
    this._lock();
    // iOS sometimes ignores speak() right after cancel(); a short pause avoids that.
    setTimeout(() => { if (gen === this.gen) this._speak(gen, charOffset); }, 60);
  }

  _speak(gen, charOffset) {
    const s = this.sentences[this.index];
    if (!s) return this._finish();
    this.onsentence(this.index);
    const full = s.text;
    const offset = Math.max(0, Math.min(charOffset, full.length));
    const text = full.slice(offset);
    if (!text.trim()) return this._next(gen);
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; }
    u.rate = this.rate;
    const words = wordsOf(text);
    let lastWord = -1;
    const showWord = (i) => {
      if (i <= lastWord || i >= words.length) return;
      lastWord = i;
      this.wordOffset = offset + words[i][0];
      this.onword(this.index, offset + words[i][0], words[i][1]);
    };
    // Estimated timing, used until (unless) the voice reports real word boundaries.
    let est = null;
    const startEstimate = () => {
      if (this.boundarySeen) return;
      const msPerChar = 1000 / (14.5 * this.rate);
      const t0 = performance.now();
      est = setInterval(() => {
        if (gen !== this.gen || this.boundarySeen) { clearInterval(est); return; }
        const pos = (performance.now() - t0) / msPerChar;
        let i = lastWord; while (i + 1 < words.length && words[i + 1][0] <= pos) i++;
        showWord(i);
      }, 90);
    };
    u.onstart = () => { if (gen !== this.gen) return; showWord(0); startEstimate(); };
    u.onboundary = (e) => {
      if (gen !== this.gen || (e.name && e.name !== 'word')) return;
      this.boundarySeen = true;
      const ci = e.charIndex;
      let i = words.findIndex(([st, len]) => ci < st + len);
      if (i < 0) i = words.length - 1;
      if (i < lastWord) return;
      lastWord = i - 1; showWord(i);
    };
    const finish = () => { clearInterval(est); this.keep = this.keep.filter((x) => x !== u); };
    u.onend = () => { finish(); if (gen === this.gen) this._next(gen); };
    u.onerror = (e) => {
      finish();
      if (gen !== this.gen || e.error === 'interrupted' || e.error === 'canceled') return;
      this._next(gen);
    };
    this.keep.push(u);
    synth.speak(u);
  }

  _next(gen) {
    if (gen !== this.gen) return;
    if (this.index + 1 >= this.sentences.length) return this._finish();
    this.index++;
    this.wordOffset = 0;
    this._speak(gen, 0);
  }

  _finish() {
    this.playing = false; this.gen++;
    this._unlock();
    this.onstate(false);
    this.onend();
  }

  pause() {
    if (!this.playing) return;
    this.gen++;
    this.playing = false;
    synth && synth.cancel();
    this._unlock();
    this.onstate(false);
  }
  stop() { this.pause(); this.wordOffset = 0; }
  toggle() { this.playing ? this.pause() : this.play(this.index, this.wordOffset || 0); }
  skip(delta) {
    const i = Math.max(0, Math.min(this.sentences.length - 1, this.index + delta));
    this.wordOffset = 0;
    if (this.playing) this.play(i, 0); else { this.index = i; this.onsentence(i); this.onword(i, 0, 0); }
  }

  /** Speak a single word or phrase (dictionary pronunciation). */
  say(text) {
    if (!synth) return;
    this.pause();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; }
    u.rate = Math.min(this.rate, 1);
    this.keep.push(u); u.onend = () => { this.keep = this.keep.filter((x) => x !== u); };
    synth.speak(u);
  }
}
