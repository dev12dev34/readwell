import { db, uid, persist } from './db.js';
import { splitSentences, countWords } from './text.js';
import { importFile, importImage, importText, importUrl, Cancelled } from './importers.js';
import { lookup, cleanWord } from './dict.js';
import { Player, listVoices, voicesReady, voiceQuality, qualityLabel, cleanVoiceName, wordsOf } from './speech.js';
import { KokoroPlayer, KOKORO_VOICES, isKokoro, kokoroVoice, engine, selfTest, wavBytes } from './kokoro.js';

export const APP_VERSION = '1.1.1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const NOTE_COLORS = ['yellow', 'green', 'pink', 'blue'];
const hasHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

const state = {
  docs: [], words: [], notes: [], // notes: every note (all documents)
  doc: null, paras: [], sentences: [], paraStart: [],
  settings: { voiceURI: '', rate: 1, font: 1, theme: 'auto', face: 'serif', wordHl: true, follow: true, marks: true },
  voices: [], target: null, tab: 'library',
};
const sysPlayer = new Player();
const aiPlayer = new KokoroPlayer();
let active = sysPlayer;
// `player` always talks to whichever voice engine is in use.
const player = new Proxy({}, {
  get(_, k) { const v = active[k]; return typeof v === 'function' ? v.bind(active) : v; },
  set(_, k, v) { if (typeof k === 'string' && k.startsWith('on')) { sysPlayer[k] = v; aiPlayer[k] = v; } else active[k] = v; return true; },
});

// ================================================================ utilities
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function busy(text) {
  const el = $('#busy'); el.hidden = false;
  const ctl = { cancelled: false };
  $('#busyText').textContent = text; $('#busyFill').style.width = '0%';
  $('#busyCancel').onclick = () => { ctl.cancelled = true; $('#busyText').textContent = 'Stopping…'; };
  ctl.update = (t, f) => { if (!ctl.cancelled) $('#busyText').textContent = t; if (f != null) $('#busyFill').style.width = Math.round(f * 100) + '%'; };
  ctl.done = () => { el.hidden = true; };
  return ctl;
}

let sheetClose = null;
function openSheet(html, { onClose } = {}) {
  const body = $('#sheetBody');
  body.innerHTML = html; body.scrollTop = 0;
  $('#scrim').hidden = false; $('#sheet').hidden = false;
  sheetClose = onClose || null;
  return body;
}
function closeSheet() {
  if ($('#sheet').hidden) return;
  $('#scrim').hidden = true; $('#sheet').hidden = true;
  const f = sheetClose; sheetClose = null; f && f();
}
$('#scrim').addEventListener('click', closeSheet);
$('#sheetX').addEventListener('click', closeSheet);
// swipe the sheet down to close
(() => {
  const sh = $('#sheet'); let y0 = null, dy = 0;
  sh.addEventListener('touchstart', (e) => { if ($('#sheetBody').scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  sh.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
  sh.addEventListener('touchend', () => { sh.style.transform = ''; if (y0 != null && dy > 90) closeSheet(); y0 = null; });
})();

function confirmSheet(title, text, okLabel, danger = true) {
  return new Promise((resolve) => {
    let answered = false;
    const b = openSheet(`<h2>${esc(title)}</h2><p class="sub">${esc(text)}</p>
      <div class="actions"><button class="btn" data-x="no">Cancel</button><button class="btn ${danger ? 'primary' : 'primary'}" data-x="yes" ${danger ? 'style="background:var(--danger)"' : ''}>${esc(okLabel)}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    b.querySelector('[data-x=no]').onclick = () => closeSheet();
    b.querySelector('[data-x=yes]').onclick = () => { answered = true; closeSheet(); resolve(true); };
  });
}

/** Hand a file to the iPhone share sheet (Save to Files, AirDrop, Mail…), or download it. */
async function shareFile(name, data, type) {
  const file = new File([data], name, { type });
  if (navigator.canShare && navigator.share) {
    try { if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; } }
    catch (e) { if (e && e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return true;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {} ta.remove();
  }
  toast('Copied');
}

const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${sec} s`;
}
const CHARS_PER_SEC = 14.5;

// ================================================================ settings
async function loadSettings() {
  const saved = await db.setting('prefs', {});
  Object.assign(state.settings, saved);
  applySettings();
}
function saveSettings() { db.setSetting('prefs', state.settings); }
function applySettings() {
  const s = state.settings, root = document.documentElement;
  root.dataset.theme = s.theme; root.dataset.face = s.face;
  root.style.setProperty('--fs', (19 * s.font).toFixed(1) + 'px');
  const pct = Math.round(s.font * 100) + '%';
  $('#fontValue').textContent = pct; $('#fontPopValue').textContent = pct;
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
  $$('#fontSeg button').forEach((b) => b.classList.toggle('on', b.dataset.face === s.face));
  $('#setWordHl').checked = s.wordHl; $('#setFollow').checked = s.follow;
  const sp = s.rate + '×';
  $('#speedValue').textContent = sp; $('#speedBtn').textContent = sp;
  $('#marksBtn').setAttribute('aria-pressed', String(s.marks));
  const dark = s.theme === 'dark' || (s.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const bg = { sepia: '#f4ecd8' }[s.theme] || (dark ? '#16171a' : '#f7f7f5');
  $$('meta[name=theme-color]').forEach((m) => { m.setAttribute('content', bg); m.removeAttribute('media'); });
  sysPlayer.rate = s.rate; aiPlayer.setRate(s.rate);
}
function changeFont(d) {
  state.settings.font = Math.round(Math.max(0.7, Math.min(2, state.settings.font + d * 0.1)) * 10) / 10;
  applySettings(); saveSettings();
}
function changeSpeed(d) {
  let i = SPEEDS.indexOf(state.settings.rate); if (i < 0) i = 2;
  setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + d))]);
}
function setSpeed(r) {
  state.settings.rate = r; applySettings(); saveSettings(); player.setRate(r); updateTimeLabel();
}
$$('[data-font]').forEach((b) => b.addEventListener('click', () => changeFont(+b.dataset.font)));
$$('[data-speed]').forEach((b) => b.addEventListener('click', () => changeSpeed(+b.dataset.speed)));
$$('#themeSeg button').forEach((b) => b.addEventListener('click', () => { state.settings.theme = b.dataset.theme; applySettings(); saveSettings(); }));
$$('#fontSeg button').forEach((b) => b.addEventListener('click', () => { state.settings.face = b.dataset.face; applySettings(); saveSettings(); }));
$('#setWordHl').addEventListener('change', (e) => { state.settings.wordHl = e.target.checked; saveSettings(); if (!e.target.checked) clearWord(); });
$('#setFollow').addEventListener('change', (e) => { state.settings.follow = e.target.checked; saveSettings(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applySettings);

// ================================================================ voices
async function initVoices() {
  state.voices = await voicesReady();
  pickVoice();
  window.speechSynthesis?.addEventListener?.('voiceschanged', () => { state.voices = listVoices(); pickVoice(); });
}
function useEngine(next) {
  if (next === active) return;
  const { sentences, index } = active;
  active.stop();
  active = next;
  active.sentences = sentences; active.index = index;
  active.setRate(state.settings.rate);
  $('#player').classList.remove('waiting');
}
function pickVoice() {
  const uri = state.settings.voiceURI;
  if (isKokoro(uri) && state.settings.aiInstalled) {
    useEngine(aiPlayer);
    const v = kokoroVoice(uri);
    if (!aiPlayer.voice || aiPlayer.voice.voiceURI !== v.voiceURI) aiPlayer.setVoice(v);
    $('#voiceValue').textContent = `${v.name} · AI voice`;
    $('#voiceHint').hidden = true;
    return;
  }
  useEngine(sysPlayer);
  const v = state.voices.find((x) => x.voiceURI === uri) || state.voices[0] || null;
  if (sysPlayer.voice !== v) sysPlayer.setVoice(v);
  $('#voiceValue').textContent = v ? `${cleanVoiceName(v)}${voiceQuality(v) > 1 ? ' · ' + qualityLabel(voiceQuality(v)) : ''}` : (sysPlayer.supported ? 'Default' : 'Not available');
  const best = state.voices.length ? voiceQuality(state.voices[0]) : 0;
  $('#voiceHint').hidden = best >= 3;
}

// ---- AI voice download (one time, ~100 MB, kept on the phone)
const ai = { downloading: false, loaded: 0, total: 0, error: '', listeners: new Set() };
const mb = (n) => Math.round(n / 1048576);
function aiNotify() { ai.listeners.forEach((f) => f()); }
async function installAI() {
  if (ai.downloading) return;
  ai.downloading = true; ai.error = ''; ai.loaded = 0; aiNotify();
  persist();
  try {
    try {
      const est = await navigator.storage.estimate();
      if (est.quota && est.quota - est.usage < 160 * 1048576) throw new Error('There isn’t enough free space on this phone (about 100 MB is needed).');
    } catch (e) { if (e.message.startsWith('There')) throw e; }
    await engine.install((l, t) => { ai.loaded = l; ai.total = t; aiNotify(); });
    state.settings.aiInstalled = true;
    if (!isKokoro(state.settings.voiceURI)) state.settings.voiceURI = 'kokoro:af_heart';
    saveSettings(); pickVoice();
    toast('AI voices are ready ✓');
  } catch (e) {
    ai.error = /fetch|network|load failed/i.test(e.message) ? 'The download was interrupted. Tap Download to continue where it stopped.' : e.message;
  } finally { ai.downloading = false; aiNotify(); }
}
async function removeAI() {
  if (!(await confirmSheet('Remove AI voices?', 'This frees about 100 MB. You can download them again at any time.', 'Remove'))) return;
  await engine.remove().catch(() => {});
  state.settings.aiInstalled = false;
  if (isKokoro(state.settings.voiceURI)) state.settings.voiceURI = '';
  saveSettings(); pickVoice(); toast('AI voices removed');
}

function voiceSheet() {
  const vs = state.voices;
  const cur = player.voice;
  const sysHtml = vs.length ? vs.map((v, i) => {
    const q = voiceQuality(v);
    const on = cur && cur.voiceURI === v.voiceURI;
    return `<button data-i="${i}" class="${on ? 'on' : ''}"><span>${esc(cleanVoiceName(v))}<span class="q-tag q${q}">${qualityLabel(q)}</span><br><small>${esc(v.lang)}</small></span><span>${on ? '✓' : ''}</span></button>`;
  }).join('') : '<p class="sub">No English voices were found on this device.</p>';
  const best = vs.length ? voiceQuality(vs[0]) : 0;
  const b = openSheet(`<h2>Voice</h2>
    <div class="label">Speed</div>
    <div class="speeds">${SPEEDS.map((s) => `<button data-s="${s}" class="${s === state.settings.rate ? 'on' : ''}">${s}×</button>`).join('')}</div>
    <div class="label">✨ Natural AI voices (Kokoro)</div>
    <div id="aiBox"></div>
    <div class="label">Voices on this ${/iPad/.test(navigator.userAgent) ? 'iPad' : 'phone'}</div>
    ${best < 3 ? `<p class="hint" style="margin:0 0 6px">More natural iPhone voices are free too: Settings app → Accessibility → Spoken Content → Voices → English → pick one marked <b>Premium</b>.</p>` : ''}
    <div class="voice-list" id="sysVoices">${sysHtml}</div>`, { onClose: () => ai.listeners.delete(renderAI) });
  const box = b.querySelector('#aiBox');
  const mark = () => {
    const uri = state.settings.voiceURI;
    b.querySelectorAll('.voice-list button').forEach((x) => {
      const on = x.dataset.k ? isKokoro(uri) && state.settings.aiInstalled && uri === 'kokoro:' + x.dataset.k : !(isKokoro(uri) && state.settings.aiInstalled) && vs[+x.dataset.i] && player.voice && vs[+x.dataset.i].voiceURI === player.voice.voiceURI;
      x.classList.toggle('on', !!on); x.lastElementChild.textContent = on ? '✓' : '';
    });
  };
  function renderAI() {
    if (state.settings.aiInstalled) {
      const uri = state.settings.voiceURI;
      const rtf = engine.rtf;
      const speedNote = rtf == null ? '' : rtf < 0.85 ? `This phone makes speech ${(1 / rtf).toFixed(1)}× faster than it plays ✓` : `This phone makes speech a little slower than it plays, so there may be short pauses between sentences.`;
      box.innerHTML = `<div class="voice-list">${KOKORO_VOICES.map((v) => {
        const on = isKokoro(uri) && uri === 'kokoro:' + v.id;
        return `<button data-k="${v.id}" class="${on ? 'on' : ''}"><span>${v.star ? '★ ' : ''}${esc(v.name)}<span class="q-tag q3">AI</span><br><small>${v.accent === 'UK' ? 'British' : 'American'} · ${v.gender === 'F' ? 'female' : 'male'}${v.note ? ' · ' + v.note : ''}</small></span><span>${on ? '✓' : ''}</span></button>`;
      }).join('')}</div>
      <p class="hint" style="margin:6px 0 0">${speedNote ? esc(speedNote) + ' ' : ''}</p>
      <div class="actions" style="justify-content:flex-start"><button class="btn" id="aiTest">Test AI voice</button><button class="link" id="aiRemove" style="margin-left:auto">Remove AI voices</button></div>
      <p class="hint" id="aiTestOut" hidden></p>`;
      box.querySelector('#aiTest').onclick = async () => {
        const out = box.querySelector('#aiTestOut'); out.hidden = false;
        const btn = box.querySelector('#aiTest'); btn.disabled = true;
        const t0 = Date.now(); let step = 'Starting…';
        const tick = setInterval(() => { out.textContent = `${step} (${Math.round((Date.now() - t0) / 1000)} s)`; }, 500);
        try {
          player.pause();
          const r = await selfTest((s) => { step = s; });
          clearInterval(tick);
          const fast = r.rtf < 1;
          out.innerHTML = `${fast ? '✓' : '⚠︎'} It works. Loading took ${r.load.toFixed(0)} s; it made ${r.dur.toFixed(1)} s of speech in ${r.make.toFixed(1)} s` +
            (fast ? ` — fast enough for smooth reading.` : ` — slower than it speaks, so expect pauses between sentences. The iPhone’s Premium voices may suit this phone better.`);
          const a = new Audio(); a.src = URL.createObjectURL(new Blob([wavBytes(r.samples)], { type: 'audio/wav' })); a.play().catch(() => {});
        } catch (e) {
          clearInterval(tick);
          out.textContent = `✗ It didn’t work: ${/timeout/.test(e.message) ? 'it took too long (stuck at: ' + step + ')' : e.message}. Please send me this message.`;
        } finally { btn.disabled = false; }
      };
      box.querySelectorAll('[data-k]').forEach((btn) => btn.onclick = () => {
        state.settings.voiceURI = 'kokoro:' + btn.dataset.k; saveSettings(); pickVoice(); mark();
        if (!player.playing) { toast('Loading voice…', 1500); player.say(`Hello, I'm ${kokoroVoice(state.settings.voiceURI).name}.`); }
      });
      box.querySelector('#aiRemove').onclick = () => { closeSheet(); removeAI(); };
    } else if (ai.downloading) {
      const pct = ai.total ? Math.min(100, Math.round((ai.loaded / ai.total) * 100)) : 0;
      box.innerHTML = `<div class="ai-card"><b>Downloading AI voices… ${pct}%</b><div class="busy-bar" style="margin:10px 0 6px"><div style="width:${pct}%"></div></div><small>${mb(ai.loaded)} of ${mb(ai.total) || 100} MB. You can close this and keep reading; keep Readwell open until it finishes.</small></div>`;
    } else {
      box.innerHTML = `<div class="ai-card"><b>The same natural voices as Readwell for Mac</b>
        <p>17 lifelike voices (American and British) that run on this phone, with no account and no cost. One-time download of about <b>100 MB</b> (use Wi-Fi); they work offline afterwards.</p>
        <p class="small">Newer iPhones (2021 or later) work best. Older ones may pause briefly between sentences.</p>
        ${ai.error ? `<p class="err">${esc(ai.error)}</p>` : ''}
        <button class="btn primary" id="aiGet">Download AI voices</button></div>`;
      box.querySelector('#aiGet').onclick = () => installAI();
    }
  }
  ai.listeners.add(renderAI);
  renderAI();
  b.querySelector('#sysVoices').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
    const v = vs[+btn.dataset.i];
    state.settings.voiceURI = v.voiceURI; saveSettings(); pickVoice(); mark();
    if (!player.playing) player.say(`Hello, I'm ${cleanVoiceName(v)}.`);
  }));
  b.querySelectorAll('.speeds button').forEach((btn) => btn.addEventListener('click', () => {
    setSpeed(+btn.dataset.s);
    b.querySelectorAll('.speeds button').forEach((x) => x.classList.toggle('on', x === btn));
  }));
}
$('#voiceRow').addEventListener('click', voiceSheet);
$('#voiceBtn').addEventListener('click', voiceSheet);
$('#speedBtn').addEventListener('click', voiceSheet);

// ================================================================ tabs
function showTab(tab) {
  state.tab = tab;
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.tab === tab));
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'words') renderWords();
  if (tab === 'notes') renderAllNotes();
  if (tab === 'settings') renderSettingsInfo();
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ================================================================ library
async function loadAll() {
  [state.docs, state.words, state.notes] = await Promise.all([db.all('docs'), db.all('words'), db.all('notes')]);
}

function renderLibrary() {
  const docs = [...state.docs].sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  $('#libEmpty').hidden = docs.length > 0;
  $('#docList').innerHTML = docs.map((d) => {
    const pct = d.total ? Math.round(((d.pos || 0) / Math.max(1, d.total - 1)) * 100) : 0;
    const left = d.chars ? fmtDuration((d.chars * (1 - pct / 100)) / CHARS_PER_SEC / (state.settings.rate || 1)) : '';
    const nNotes = state.notes.filter((n) => n.docId === d.id).length;
    const label = { pdf: 'PDF', docx: 'DOC', epub: 'EPUB', web: 'WEB', image: 'PHOTO', text: 'TEXT', md: 'MD', html: 'HTML', odt: 'ODT', rtf: 'RTF', txt: 'TXT' }[d.kind] || 'TXT';
    return `<li class="doc" data-id="${d.id}">
      <div class="thumb">${label}</div>
      <div class="info"><div class="t">${esc(d.title)}</div>
        <div class="m">${pct >= 99 ? 'Finished' : pct ? `${pct}% · ${left} left` : `${left || ''}`}${nNotes ? ` · ${nNotes} note${nNotes > 1 ? 's' : ''}` : ''}</div>
        <div class="bar2"><i style="width:${pct}%"></i></div></div>
      <button class="more" data-more="${d.id}" aria-label="More">⋯</button></li>`;
  }).join('');
}
$('#docList').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) return docMenu(more.dataset.more);
  const li = e.target.closest('.doc');
  if (li) openDoc(li.dataset.id);
});

function docMenu(id) {
  const d = state.docs.find((x) => x.id === id);
  if (!d) return;
  const b = openSheet(`<h2>${esc(d.title)}</h2><div class="sub">Added ${fmtDate(d.added)}${d.source ? ' · ' + esc(new URL(d.source).hostname) : ''}</div>
    <div class="menu">
      <button data-m="rename"><span class="mi">✏️</span>Rename</button>
      <button data-m="share"><span class="mi">⇪</span>Share as text</button>
      <button data-m="delete" class="danger"><span class="mi">🗑</span>Delete</button>
    </div>`);
  b.querySelector('[data-m=rename]').onclick = () => renameDoc(id);
  b.querySelector('[data-m=share]').onclick = async () => {
    const t = await db.get('texts', id);
    shareFile(safeName(d.title) + '.txt', `${d.title}\n\n${t ? t.text : ''}\n`, 'text/plain');
  };
  b.querySelector('[data-m=delete]').onclick = async () => {
    closeSheet();
    const n = state.notes.filter((x) => x.docId === id).length;
    if (!(await confirmSheet('Delete this document?', `“${d.title}”${n ? ` and its ${n} note${n > 1 ? 's' : ''}` : ''} will be removed from this phone. Saved words stay in My Words.`, 'Delete'))) return;
    await db.del('docs', id); await db.del('texts', id);
    for (const nt of state.notes.filter((x) => x.docId === id)) await db.del('notes', nt.id);
    state.docs = state.docs.filter((x) => x.id !== id); state.notes = state.notes.filter((x) => x.docId !== id);
    renderLibrary(); toast('Deleted');
  };
}
const safeName = (s) => (s || 'Readwell').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Readwell';

function renameDoc(id) {
  const d = state.docs.find((x) => x.id === id);
  const b = openSheet(`<h2>Rename</h2><input type="text" id="renameInput" value="${esc(d.title)}" enterkeyhint="done">
    <div class="actions"><button class="btn" data-x="c">Cancel</button><button class="btn primary" data-x="s">Save</button></div>`);
  const inp = b.querySelector('#renameInput'); setTimeout(() => { inp.focus(); inp.select(); }, 250);
  const save = async () => {
    const t = inp.value.trim(); if (!t) return;
    d.title = t; await db.put('docs', d); closeSheet(); renderLibrary();
    if (state.doc && state.doc.id === id) { state.doc.title = t; $('#docTitle').textContent = t; const h = $('#page h1'); if (h) h.textContent = t; }
  };
  b.querySelector('[data-x=s]').onclick = save; b.querySelector('[data-x=c]').onclick = closeSheet;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// ================================================================ adding things
function addSheet() {
  const b = openSheet(`<h2>Add something to read</h2>
    <div class="menu">
      <button data-a="file"><span class="mi">📄</span><span>Choose a file<small>PDF, Word, EPUB, text or web page from Files, iCloud Drive…</small></span></button>
      <button data-a="camera"><span class="mi">📷</span><span>Scan a page<small>Take a photo of a page, letter or form</small></span></button>
      <button data-a="photo"><span class="mi">🖼</span><span>Photo or screenshot<small>Read the text in a picture</small></span></button>
      <button data-a="link"><span class="mi">🔗</span><span>Paste a link<small>Read a web article</small></span></button>
      <button data-a="text"><span class="mi">📋</span><span>Paste text<small>Read text you’ve copied</small></span></button>
    </div>`);
  b.querySelector('[data-a=file]').onclick = () => { closeSheet(); $('#fileInput').click(); };
  b.querySelector('[data-a=camera]').onclick = () => { closeSheet(); $('#cameraInput').click(); };
  b.querySelector('[data-a=photo]').onclick = () => { closeSheet(); $('#photoInput').click(); };
  b.querySelector('[data-a=link]').onclick = linkSheet;
  b.querySelector('[data-a=text]').onclick = textSheet;
}
$('#addBtn').addEventListener('click', addSheet);
$$('[data-action=add]').forEach((b) => b.addEventListener('click', addSheet));

async function clipboardText() {
  try { return await navigator.clipboard.readText(); } catch { return ''; }
}

function linkSheet() {
  const b = openSheet(`<h2>Paste a link</h2><p class="sub">Readwell fetches the article text (this needs the internet).</p>
    <input type="url" id="urlInput" placeholder="https://…" autocomplete="off" autocapitalize="off" enterkeyhint="go">
    <div class="actions"><button class="btn" data-x="paste">Paste</button><span class="spacer"></span><button class="btn primary" data-x="go">Open</button></div>`);
  const inp = b.querySelector('#urlInput'); setTimeout(() => inp.focus(), 250);
  b.querySelector('[data-x=paste]').onclick = async () => { const t = await clipboardText(); if (t) inp.value = t.trim(); };
  const go = async () => {
    const v = inp.value.trim(); if (!v) return;
    closeSheet(); await runImport((rep) => importUrl(v, rep), 'Fetching the page…');
  };
  b.querySelector('[data-x=go]').onclick = go;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

function textSheet() {
  const b = openSheet(`<h2>Paste text</h2>
    <input type="text" id="ptTitle" placeholder="Title (optional)">
    <div style="height:8px"></div>
    <textarea id="ptText" rows="9" placeholder="Paste or type text here"></textarea>
    <div class="actions"><button class="btn" data-x="paste">Paste</button><span class="spacer"></span><button class="btn primary" data-x="go">Read</button></div>`);
  b.querySelector('[data-x=paste]').onclick = async () => { const t = await clipboardText(); if (t) b.querySelector('#ptText').value = t; else toast('Tap the box, then tap Paste'); };
  b.querySelector('[data-x=go]').onclick = async () => {
    const text = b.querySelector('#ptText').value; const title = b.querySelector('#ptTitle').value.trim();
    if (!text.trim()) return toast('There’s no text to read');
    closeSheet(); await runImport(async () => importText(text, title), 'Adding…');
  };
}

async function runImport(fn, label) {
  const ctl = busy(label);
  try {
    const r = await fn((t, f) => ctl.update(t, f), () => ctl.cancelled);
    if (ctl.cancelled) throw new Cancelled();
    const doc = await addDoc(r);
    ctl.done();
    if (r.ocrPages) toast(`Read ${r.ocrPages} scanned page${r.ocrPages > 1 ? 's' : ''}`);
    openDoc(doc.id);
  } catch (e) {
    ctl.done();
    if (e instanceof Cancelled || ctl.cancelled) return toast('Cancelled');
    console.error(e);
    openSheet(`<h2>Couldn’t open that</h2><p class="sub">${esc(e.message || String(e))}</p><div class="actions"><button class="btn primary" id="okBtn">OK</button></div>`);
    $('#okBtn').onclick = closeSheet;
  }
}

function fileImport(input, fn) {
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0]; input.value = '';
    if (!f) return;
    const isImg = (f.type || '').startsWith('image/');
    const ctl = busy(isImg ? 'Reading text in the picture…' : `Opening ${f.name}…`);
    try {
      const r = await fn(f, (t, p) => ctl.update(t, p), () => ctl.cancelled);
      if (ctl.cancelled) throw new Cancelled();
      const doc = await addDoc(r);
      ctl.done();
      if (r.ocrPages) toast(`Read ${r.ocrPages} scanned page${r.ocrPages > 1 ? 's' : ''}`);
      openDoc(doc.id);
    } catch (e) {
      ctl.done();
      if (e instanceof Cancelled || ctl.cancelled) return toast('Cancelled');
      console.error(e);
      openSheet(`<h2>Couldn’t open that</h2><p class="sub">${esc(e.message || String(e))}</p><div class="actions"><button class="btn primary" id="okBtn">OK</button></div>`);
      $('#okBtn').onclick = closeSheet;
    }
  });
}
fileImport($('#fileInput'), importFile);
fileImport($('#photoInput'), (f, rep) => importImage(f, rep));
fileImport($('#cameraInput'), (f, rep) => importImage(f, rep));

async function addDoc(r) {
  const id = uid();
  let text = r.text.trim();
  // the title is shown as a heading, so don't repeat it as the first paragraph
  const first = text.split(/\n{2,}/)[0];
  if (r.title && !['text', 'txt', 'image'].includes(r.kind) && first.trim().toLowerCase() === r.title.trim().toLowerCase() && text.length > first.length) text = text.slice(first.length).trim();
  const sentences = text.split(/\n{2,}/).reduce((n, p) => n + splitSentences(p).length, 0);
  const doc = { id, title: r.title || 'Untitled', kind: r.kind || 'text', source: r.source || '', added: Date.now(), opened: Date.now(), pos: 0, total: sentences, chars: text.length, words: countWords(text) };
  await db.put('texts', { id, text });
  await db.put('docs', doc);
  state.docs.push(doc);
  renderLibrary();
  persist();
  return doc;
}

// ================================================================ reader
const page = $('#page');

async function openDoc(id) {
  const doc = state.docs.find((d) => d.id === id);
  if (!doc) return;
  const t = await db.get('texts', id);
  player.stop(); clearWord(); hideActionBar();
  state.doc = doc;
  doc.opened = Date.now(); db.put('docs', doc);
  state.paras = (t ? t.text : '').split(/\n{2,}/);
  state.sentences = []; state.paraStart = [];
  state.paras.forEach((p, pi) => {
    state.paraStart.push(state.sentences.length);
    let off = 0;
    for (const s of splitSentences(p)) { state.sentences.push({ p: pi, start: off, end: off + s.length, text: s }); off += s.length; }
  });
  const html = [`<h1 class="doc-title">${esc(doc.title)}</h1>`];
  if (doc.source) html.push(`<div class="src">${esc(doc.source)}</div>`);
  state.paras.forEach((p, pi) => {
    const a = state.paraStart[pi], z = pi + 1 < state.paras.length ? state.paraStart[pi + 1] : state.sentences.length;
    let inner = '';
    for (let i = a; i < z; i++) inner += `<span class="s" data-i="${i}">${esc(state.sentences[i].text)}</span>`;
    html.push(`<p data-p="${pi}">${inner}</p>`);
  });
  page.innerHTML = html.join('');
  $('#docTitle').textContent = doc.title;
  aiPlayer.title = doc.title;
  $('#reader').hidden = false; document.body.classList.add('reader-open');
  $('#tabs').hidden = true;
  player.load(state.sentences, Math.min(doc.pos || 0, state.sentences.length - 1));
  renderNoteMarks();
  markSentence(player.index, false);
  requestAnimationFrame(() => scrollToSentence(player.index, 'auto', 0.25));
  updateProgress();
  if (active === aiPlayer) aiPlayer.prepare(player.index);
  history.pushState({ reader: id }, '');
}

function closeReader(fromPop) {
  if ($('#reader').hidden) return;
  player.stop(); savePos();
  $('#reader').hidden = true; document.body.classList.remove('reader-open');
  $('#tabs').hidden = false; $('#fontPop').hidden = true; hideActionBar();
  clearWord(); if (hasHighlights) CSS.highlights.clear();
  state.doc = null; page.innerHTML = '';
  renderLibrary();
  if (!fromPop && history.state && history.state.reader) history.back();
}
$('#backBtn').addEventListener('click', () => closeReader(false));
window.addEventListener('popstate', () => { if (!$('#sheet').hidden) closeSheet(); if (!$('#reader').hidden) closeReader(true); });
$('#docTitle').addEventListener('click', () => state.doc && renameDoc(state.doc.id));
$('#fontBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#fontPop').hidden = !$('#fontPop').hidden; });
document.addEventListener('click', (e) => { if (!e.target.closest('#fontPop,#fontBtn')) $('#fontPop').hidden = true; });

let posTimer;
function savePos() {
  if (!state.doc) return;
  state.doc.pos = player.index;
  clearTimeout(posTimer); db.put('docs', state.doc);
}
function savePosSoon() { clearTimeout(posTimer); posTimer = setTimeout(savePos, 1500); }

// ---------------------------------------------------------------- highlighting
const spanOf = (i) => page.querySelector(`.s[data-i="${i}"]`);
let curSpan = null;
function markSentence(i, follow = true) {
  if (curSpan) curSpan.classList.remove('cur');
  curSpan = spanOf(i);
  if (curSpan) curSpan.classList.add('cur');
  if (follow && state.settings.follow && Date.now() > userScrollUntil) scrollToSentence(i, 'smooth');
}

function scrollToSentence(i, behavior = 'smooth', at = 0.28) {
  const el = spanOf(i); if (!el) return;
  const pr = page.getBoundingClientRect(), r = el.getBoundingClientRect();
  const visibleBottom = pr.bottom - 190;
  if (behavior !== 'smooth' || r.top < pr.top + 60 || r.bottom > visibleBottom) {
    page.scrollTo({ top: page.scrollTop + r.top - pr.top - pr.height * at, behavior });
  }
}

let userScrollUntil = 0;
page.addEventListener('touchmove', () => { userScrollUntil = Date.now() + 5000; hideActionBar(); }, { passive: true });
page.addEventListener('wheel', () => { userScrollUntil = Date.now() + 5000; }, { passive: true });

function rangeIn(span, start, len) {
  const node = span.firstChild; if (!node) return null;
  const r = document.createRange();
  const a = Math.min(start, node.length), z = Math.min(start + len, node.length);
  r.setStart(node, a); r.setEnd(node, z);
  return r;
}

const wordBoxes = [];
function clearWord() {
  if (hasHighlights) CSS.highlights.delete('rw-word');
  wordBoxes.splice(0).forEach((b) => b.remove());
}
function showWord(i, start, len) {
  if (!state.settings.wordHl || !len) return clearWord();
  const span = spanOf(i); if (!span) return;
  const r = rangeIn(span, start, len); if (!r) return;
  if (hasHighlights) { CSS.highlights.set('rw-word', new Highlight(r)); }
  else {
    clearWord();
    const pr = page.getBoundingClientRect();
    for (const rc of r.getClientRects()) {
      const b = document.createElement('div'); b.className = 'word-box';
      Object.assign(b.style, { left: rc.left - pr.left + page.scrollLeft - 2 + 'px', top: rc.top - pr.top + page.scrollTop + 'px', width: rc.width + 4 + 'px', height: rc.height + 'px' });
      page.appendChild(b); wordBoxes.push(b);
    }
  }
  if (state.settings.follow && Date.now() > userScrollUntil) {
    const pr = page.getBoundingClientRect(), rc = r.getBoundingClientRect();
    if (rc.bottom > pr.bottom - 200 || rc.top < pr.top + 40) page.scrollTo({ top: page.scrollTop + rc.top - pr.top - pr.height * 0.28, behavior: 'smooth' });
  }
}

player.onsentence = (i) => { markSentence(i); updateProgress(); savePosSoon(); };
player.onword = (i, start, len) => showWord(i, start, len);
player.onstate = (playing) => {
  $('#player').classList.toggle('playing', playing);
  $('#playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (!playing) savePos();
};
let statusTimer = null, statusSince = 0;
function setStatus(text) {
  const el = $('#pStatus');
  clearInterval(statusTimer);
  if (!text) { el.hidden = true; return; }
  statusSince = Date.now(); el.hidden = false;
  const draw = () => { const s = Math.round((Date.now() - statusSince) / 1000); el.textContent = s >= 3 ? `${text} ${s} s` : text; };
  draw(); statusTimer = setInterval(draw, 1000);
}
player.onwait = (on, msg) => { $('#player').classList.toggle('waiting', !!on); setStatus(on ? msg || 'Working…' : ''); };
player.onerror = (msg) => {
  $('#player').classList.remove('waiting'); setStatus('');
  if (/not-installed|manifest/.test(msg)) { state.settings.aiInstalled = false; saveSettings(); pickVoice(); toast('The AI voices need to be downloaded again (Voice menu).', 5000); return; }
  if (active === aiPlayer) {
    // Don't leave the reader stuck: fall back to the iPhone voice.
    state.settings.voiceURI = ''; saveSettings(); pickVoice();
    const why = /timeout/.test(msg) ? 'The AI voice is too slow or got stuck on this phone' : `The AI voice stopped (${msg})`;
    openSheet(`<h2>Switched to the iPhone voice</h2><p class="sub">${esc(why)}. Readwell is using the iPhone voice instead — tap ▶ to keep reading.</p>
      <p class="sub">You can try the AI voice again from the 🗣 voice menu, where <b>Test AI voice</b> shows what happens on this phone.</p>
      <div class="actions"><button class="btn primary" id="okBtn">OK</button></div>`);
    $('#okBtn').onclick = closeSheet;
    return;
  }
  toast(msg, 4500);
};
player.onend = () => { clearWord(); if (state.doc) { state.doc.pos = state.sentences.length - 1; savePos(); toast('Finished'); } };

$('#playBtn').addEventListener('click', () => {
  if (!player.supported) return toast('Speech isn’t available in this browser');
  hideActionBar(); player.toggle();
});
$('#prevBtn').addEventListener('click', () => player.skip(-1));
$('#nextBtn').addEventListener('click', () => player.skip(1));

function updateProgress() {
  const n = state.sentences.length;
  const i = player.index;
  $('#progFill').style.width = n > 1 ? (i / (n - 1)) * 100 + '%' : '0%';
  const s = state.sentences[i];
  $('#posLabel').textContent = n ? `${Math.round(n > 1 ? (i / (n - 1)) * 100 : 0)}%` : '';
  updateTimeLabel(s);
}
function updateTimeLabel() {
  if (!state.sentences.length) return;
  let rest = 0;
  for (let k = player.index; k < state.sentences.length; k++) rest += state.sentences[k].text.length;
  $('#timeLabel').textContent = `${fmtDuration(rest / CHARS_PER_SEC / (state.settings.rate || 1))} left`;
}

// scrub along the progress bar
(() => {
  const bar = $('.progress');
  let dragging = false, wasPlaying = false;
  const at = (x) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left - 14) / (r.width - 28))); };
  const move = (x) => {
    const i = Math.round(at(x) * (state.sentences.length - 1));
    player.index = i; markSentence(i, false); scrollToSentence(i, 'auto', 0.28); updateProgress();
  };
  bar.addEventListener('pointerdown', (e) => { dragging = true; wasPlaying = player.playing; player.pause(); clearWord(); bar.setPointerCapture(e.pointerId); move(e.clientX); });
  bar.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX); });
  bar.addEventListener('pointerup', () => { if (!dragging) return; dragging = false; userScrollUntil = 0; savePos(); if (wasPlaying) player.play(player.index, 0); });
})();

// ---------------------------------------------------------------- tapping & selecting
/** DOM position → {i: sentence index, off: offset in that sentence} */
function domPoint(node, offset) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  const span = el && el.closest && el.closest('.s');
  if (span) return { i: +span.dataset.i, off: node.nodeType === 3 ? offset : (offset > 0 ? span.textContent.length : 0) };
  // selection edge on the paragraph itself
  const p = el && el.closest && el.closest('p[data-p]');
  if (p) {
    const kids = [...p.querySelectorAll('.s')];
    const k = node === p ? Math.min(offset, kids.length) : 0;
    if (k >= kids.length && kids.length) { const last = kids[kids.length - 1]; return { i: +last.dataset.i, off: last.textContent.length }; }
    if (kids[k]) return { i: +kids[k].dataset.i, off: 0 };
  }
  return null;
}
const toPara = (pt) => { const s = state.sentences[pt.i]; return { p: s.p, off: s.start + pt.off }; };

function paraRange(p, start, end) {
  // build a DOM range covering [start,end) of paragraph p
  const a = state.paraStart[p], z = p + 1 < state.paras.length ? state.paraStart[p + 1] : state.sentences.length;
  let r = null;
  for (let i = a; i < z; i++) {
    const s = state.sentences[i]; const span = spanOf(i); if (!span || !span.firstChild) continue;
    if (!r && start < s.end) { r = document.createRange(); r.setStart(span.firstChild, Math.max(0, start - s.start)); }
    if (r && end <= s.end) { r.setEnd(span.firstChild, Math.max(0, Math.min(end - s.start, span.firstChild.length))); return r; }
  }
  if (r) { const last = spanOf(z - 1); if (last && last.firstChild) r.setEnd(last.firstChild, last.firstChild.length); }
  return r;
}

function caretAt(x, y) {
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); return r && { node: r.startContainer, offset: r.startOffset }; }
  if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x, y); return c && { node: c.offsetNode, offset: c.offset }; }
  return null;
}

page.addEventListener('click', (e) => {
  if (e.target.closest('.note-pin')) return openNoteById(e.target.closest('.note-pin').dataset.note);
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return;
  const c = caretAt(e.clientX, e.clientY);
  if (!c || c.node.nodeType !== 3) return hideActionBar();
  const pt = domPoint(c.node, c.offset); if (!pt) return hideActionBar();
  const s = state.sentences[pt.i];
  const w = wordsOf(s.text).find(([st, len]) => pt.off >= st && pt.off <= st + len);
  if (!w) return hideActionBar();
  // A tap on a note highlight opens that note.
  const P = toPara({ i: pt.i, off: w[0] });
  const hit = state.settings.marks && docNotes().find((n) => n.p === P.p && P.off >= n.start && P.off < n.end);
  if (hit) return openNote(hit);
  const target = { kind: 'word', i: pt.i, start: w[0], end: w[0] + w[1], text: s.text.substr(w[0], w[1]), p: P.p, pstart: P.off, pend: P.off + w[1] };
  if (hasHighlights) { const r = rangeIn(spanOf(pt.i), w[0], w[1]); r && CSS.highlights.set('rw-tap', new Highlight(r)); }
  showActionBar(target);
});

let selTimer;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if ($('#reader').hidden) return;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { if (state.target && state.target.kind === 'sel') hideActionBar(); return; }
    const r = sel.getRangeAt(0);
    if (!page.contains(r.commonAncestorContainer)) return;
    const a = domPoint(r.startContainer, r.startOffset), z = domPoint(r.endContainer, r.endOffset);
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!a || !z || !text) return;
    const A = toPara(a), Z = toPara(z);
    // notes stay inside one paragraph; longer selections are trimmed to the first one
    const pend = Z.p === A.p ? Z.off : state.paras[A.p].length;
    if (hasHighlights) CSS.highlights.delete('rw-tap');
    showActionBar({ kind: 'sel', i: a.i, start: a.off, text, p: A.p, pstart: A.off, pend });
  }, 250);
});

function showActionBar(t) {
  state.target = t;
  const bar = $('#actionBar');
  const words = t.text.split(/\s+/).length;
  $('#abWord').textContent = t.kind === 'word' ? t.text : `“${t.text.length > 60 ? t.text.slice(0, 60) + '…' : t.text}”`;
  bar.querySelector('[data-act=define]').hidden = words > 4;
  bar.querySelector('[data-act=save]').hidden = words > 4;
  bar.hidden = false;
}
function hideActionBar() {
  $('#actionBar').hidden = true; state.target = null;
  if (hasHighlights) CSS.highlights.delete('rw-tap');
}
$('#actionBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b || !state.target) return;
  const t = state.target;
  const act = b.dataset.act;
  if (act === 'read') { hideActionBar(); getSelection().removeAllRanges(); userScrollUntil = 0; player.play(t.i, t.start); }
  else if (act === 'define') { dictSheet(t.text, contextOf(t)); }
  else if (act === 'save') { dictSheet(t.text, contextOf(t), true); }
  else if (act === 'note') { noteSheet({ p: t.p, start: t.pstart, end: t.pend, quote: state.paras[t.p].slice(t.pstart, t.pend) }); }
  else if (act === 'copy') {
    if (t.kind === 'sel') { copyText(t.text); hideActionBar(); return; }
    const s = state.sentences[t.i];
    const sb = openSheet(`<h2>Copy</h2><div class="menu">
      <button data-c="w"><span class="mi">Aa</span><span>Word<small>${esc(t.text)}</small></span></button>
      <button data-c="s"><span class="mi">❝</span><span>Sentence<small>${esc(s.text.trim().slice(0, 90))}${s.text.length > 90 ? '…' : ''}</small></span></button>
      <button data-c="p"><span class="mi">¶</span><span>Paragraph</span></button></div>`);
    sb.querySelector('[data-c=w]').onclick = () => { copyText(t.text); closeSheet(); hideActionBar(); };
    sb.querySelector('[data-c=s]').onclick = () => { copyText(s.text.trim()); closeSheet(); hideActionBar(); };
    sb.querySelector('[data-c=p]').onclick = () => { copyText(state.paras[s.p]); closeSheet(); hideActionBar(); };
  }
});
const contextOf = (t) => (state.sentences[t.i] ? state.sentences[t.i].text.trim() : '');

// ================================================================ dictionary
async function dictSheet(raw, context = '', saveNow = false) {
  const word = cleanWord(raw.split(/\s+/).length > 1 ? raw : raw);
  if (!word) return;
  const b = openSheet(`<div class="dict-head"><h2>${esc(word)}</h2><button class="say" aria-label="Say it">🔊</button></div><div id="dictBody"><div class="spinner" style="margin:24px auto"></div></div>`);
  b.querySelector('.say').onclick = () => player.say(word);
  let r = null, err = null;
  try { r = await lookup(word); } catch (e) { err = e; }
  if ($('#sheet').hidden || !b.querySelector('#dictBody')) return;
  const existing = state.words.find((w) => w.word.toLowerCase() === word.toLowerCase());
  const head = b.querySelector('.dict-head');
  if (r && r.pron) head.insertAdjacentHTML('beforeend', `<span class="pron">/${esc(r.pron)}/</span>`);
  let html = '';
  if (err) html += `<p class="sub">${esc(err.message)}</p>`;
  else if (!r || !r.found) html += `<p class="sub">No definition found for “${esc(word)}”.</p>`;
  else {
    for (const e of r.entries) {
      html += `<div class="pos">${esc(e.pos)}</div><ol class="defs">${e.defs.map((d) => `<li>${esc(d.def)}${d.example ? `<span class="ex">“${esc(d.example)}”</span>` : ''}</li>`).join('')}</ol>`;
    }
    if (r.synonyms.length) html += `<div class="label">Synonyms</div><div class="chips">${r.synonyms.map((s) => `<button data-w="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    if (r.antonyms.length) html += `<div class="label">Opposites</div><div class="chips ant">${r.antonyms.map((s) => `<button data-w="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
  }
  html += `<div class="label">My note</div><textarea id="wordNote" rows="2" placeholder="Add your own meaning, translation or example">${esc(existing ? existing.note || '' : '')}</textarea>
    <div class="actions">${existing ? '<button class="btn danger" id="unsave">Remove</button>' : ''}<span class="spacer"></span><button class="btn primary" id="saveWord">${existing ? 'Update' : 'Save to My Words'}</button></div>`;
  b.querySelector('#dictBody').innerHTML = html;
  b.querySelectorAll('.chips button').forEach((c) => c.onclick = () => dictSheet(c.dataset.w, context));
  const doSave = async (quiet) => {
    const note = b.querySelector('#wordNote').value.trim();
    const first = r && r.entries[0];
    let w = state.words.find((x) => x.word.toLowerCase() === word.toLowerCase());
    if (!w) {
      w = { id: uid(), word, added: Date.now(), srs: { due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0 } };
      state.words.push(w);
    }
    Object.assign(w, {
      pos: first ? first.pos : (w.pos || ''), pron: (r && r.pron) || w.pron || '',
      definition: first ? first.defs[0].def : (w.definition || ''),
      definitions: r ? r.entries.slice(0, 3).map((e) => ({ pos: e.pos, defs: e.defs.slice(0, 2).map((d) => d.def) })) : (w.definitions || []),
      synonyms: r ? r.synonyms.slice(0, 10) : (w.synonyms || []),
      note, context: w.context || context, docId: w.docId || (state.doc && state.doc.id) || '', docTitle: w.docTitle || (state.doc && state.doc.title) || '',
    });
    await db.put('words', w);
    updateBadge();
    if (!quiet) { closeSheet(); hideActionBar(); toast('Saved to My Words'); }
    return w;
  };
  b.querySelector('#saveWord').onclick = () => doSave(false);
  const un = b.querySelector('#unsave');
  if (un) un.onclick = async () => { await deleteWord(existing.id); closeSheet(); toast('Removed'); };
  if (saveNow && !existing) {
    await doSave(true);
    const btn = b.querySelector('#saveWord'); btn.textContent = 'Done'; toast('Saved to My Words');
  }
}

async function deleteWord(id) {
  await db.del('words', id); state.words = state.words.filter((w) => w.id !== id); updateBadge();
  if (state.tab === 'words') renderWords();
}

// ================================================================ notes
const docNotes = () => (state.doc ? state.notes.filter((n) => n.docId === state.doc.id) : []);

function renderNoteMarks() {
  page.querySelectorAll('.note-pin').forEach((x) => x.remove());
  if (hasHighlights) NOTE_COLORS.forEach((c) => CSS.highlights.delete('rw-note-' + c));
  const notes = docNotes();
  const n = notes.length;
  $('#notesBadge').hidden = !n; $('#notesBadge').textContent = n;
  if (!state.settings.marks || !n) return;
  const groups = {};
  for (const nt of notes) {
    const r = paraRange(nt.p, nt.start, nt.end);
    if (r) (groups[nt.color || 'yellow'] ||= []).push(r);
    const p = page.querySelector(`p[data-p="${nt.p}"]`);
    if (p && nt.text) p.insertAdjacentHTML('beforeend', `<button class="note-pin" data-note="${nt.id}" aria-label="Note">✎</button>`);
  }
  if (hasHighlights) for (const [c, rs] of Object.entries(groups)) CSS.highlights.set('rw-note-' + c, new Highlight(...rs));
}
$('#marksBtn').addEventListener('click', () => {
  state.settings.marks = !state.settings.marks; saveSettings(); applySettings(); renderNoteMarks();
  toast(state.settings.marks ? 'Note highlights shown' : 'Note highlights hidden');
});

function openNoteById(id) { const n = state.notes.find((x) => x.id === id); if (n) openNote(n); }
function openNote(n) { noteSheet(n, true); }

function noteSheet(n, existing = false) {
  let color = n.color || 'yellow';
  const b = openSheet(`<h2>${existing ? 'Note' : 'New note'}</h2>
    <div class="context">${esc((n.quote || '').slice(0, 300))}${(n.quote || '').length > 300 ? '…' : ''}</div>
    <div class="colors">${NOTE_COLORS.map((c) => `<button data-c="${c}" style="background:var(--note-${c})" class="${c === color ? 'on' : ''}" aria-label="${c}"></button>`).join('')}</div>
    <textarea id="noteText" rows="4" placeholder="What needs to change, or what to remember">${esc(n.text || '')}</textarea>
    ${existing ? `<label class="row" style="padding:8px 0;border:0"><span>Done</span><input type="checkbox" class="switch" id="noteDone" ${n.done ? 'checked' : ''}></label>` : ''}
    <div class="actions">${existing ? '<button class="btn danger" id="noteDel">Delete</button><button class="btn" id="noteGo">Show</button>' : ''}<span class="spacer"></span><button class="btn primary" id="noteSave">Save</button></div>`);
  b.querySelectorAll('.colors button').forEach((x) => x.onclick = () => { color = x.dataset.c; b.querySelectorAll('.colors button').forEach((y) => y.classList.toggle('on', y === x)); });
  if (!existing) setTimeout(() => b.querySelector('#noteText').focus(), 300);
  b.querySelector('#noteSave').onclick = async () => {
    const note = existing ? n : { id: uid(), docId: state.doc.id, p: n.p, start: n.start, end: n.end, quote: n.quote, created: Date.now() };
    note.text = b.querySelector('#noteText').value.trim(); note.color = color; note.updated = Date.now();
    const d = b.querySelector('#noteDone'); if (d) note.done = d.checked;
    await db.put('notes', note);
    if (!existing) state.notes.push(note);
    closeSheet(); hideActionBar(); getSelection().removeAllRanges();
    if (state.doc && note.docId === state.doc.id) renderNoteMarks();
    if (state.tab === 'notes') renderAllNotes();
    toast(existing ? 'Note updated' : 'Note added');
  };
  const del = b.querySelector('#noteDel');
  if (del) del.onclick = async () => {
    await db.del('notes', n.id); state.notes = state.notes.filter((x) => x.id !== n.id);
    closeSheet(); renderNoteMarks(); if (state.tab === 'notes') renderAllNotes(); toast('Note deleted');
  };
  const go = b.querySelector('#noteGo');
  if (go) go.onclick = () => { closeSheet(); jumpToNote(n); };
}

async function jumpToNote(n) {
  if (!state.doc || state.doc.id !== n.docId) { await openDoc(n.docId); }
  const i = state.sentences.findIndex((s) => s.p === n.p && n.start < s.end);
  if (i < 0) return;
  player.pause(); player.index = i; markSentence(i, false); updateProgress();
  setTimeout(() => {
    scrollToSentence(i, 'smooth', 0.3);
    const r = paraRange(n.p, n.start, n.end);
    if (r && hasHighlights) { CSS.highlights.set('rw-tap', new Highlight(r)); setTimeout(() => CSS.highlights.delete('rw-tap'), 1800); }
  }, 60);
}

function noteListHtml(notes, withDoc = false) {
  return notes.map((n) => `<button class="note-item ${n.done ? 'done' : ''}" data-note="${n.id}" style="--c:var(--note-${n.color || 'yellow'})">
    <div class="q">${esc((n.quote || '').slice(0, 160))}${(n.quote || '').length > 160 ? '…' : ''}</div>
    ${n.text ? `<div class="tx">${esc(n.text)}</div>` : ''}
    <div class="dt">${n.done ? '✓ Done · ' : ''}${fmtDate(n.updated || n.created)}</div></button>`).join('');
}
const sortNotes = (ns) => [...ns].sort((a, b) => (a.p - b.p) || (a.start - b.start));

$('#notesBtn').addEventListener('click', () => {
  const notes = sortNotes(docNotes());
  const open = notes.filter((n) => !n.done).length;
  const b = openSheet(`<h2>Notes</h2><div class="sub">${notes.length ? `${notes.length} note${notes.length > 1 ? 's' : ''}${open !== notes.length ? ` · ${open} to do` : ''}` : 'No notes in this document yet. Select some text and tap Note.'}</div>
    ${noteListHtml(notes)}
    ${notes.length ? '<div class="actions"><button class="btn" id="expDocNotes">Export notes</button></div>' : ''}`);
  b.querySelectorAll('.note-item').forEach((x) => x.onclick = () => { const n = state.notes.find((y) => y.id === x.dataset.note); closeSheet(); jumpToNote(n); });
  const ex = b.querySelector('#expDocNotes');
  if (ex) ex.onclick = () => shareFile(safeName(state.doc.title) + ' – notes.md', notesMarkdown([state.doc]), 'text/markdown');
});

function notesMarkdown(docs) {
  const out = [];
  for (const d of docs) {
    const ns = sortNotes(state.notes.filter((n) => n.docId === d.id));
    if (!ns.length) continue;
    out.push(`# ${d.title}\n`);
    ns.forEach((n, k) => {
      out.push(`${k + 1}. ${n.done ? '~~' : ''}> “${(n.quote || '').replace(/\n/g, ' ')}”${n.done ? '~~ (done)' : ''}`);
      if (n.text) out.push(`   ${n.text.replace(/\n/g, '\n   ')}`);
      out.push('');
    });
  }
  return out.join('\n') + '\n';
}

function renderAllNotes() {
  const byDoc = new Map();
  for (const n of state.notes) { if (!byDoc.has(n.docId)) byDoc.set(n.docId, []); byDoc.get(n.docId).push(n); }
  const docs = state.docs.filter((d) => byDoc.has(d.id)).sort((a, b) => Math.max(...byDoc.get(b.id).map((n) => n.updated || n.created)) - Math.max(...byDoc.get(a.id).map((n) => n.updated || n.created)));
  $('#notesEmpty').hidden = docs.length > 0;
  $('#notesExportAllBtn').hidden = !docs.length;
  $('#allNotes').innerHTML = docs.map((d) => {
    const ns = sortNotes(byDoc.get(d.id)); const open = ns.filter((n) => !n.done).length;
    return `<div class="note-group"><h3><span>${esc(d.title)}</span><span>${open ? `${open} to do` : 'all done'}</span></h3>${noteListHtml(ns, true)}</div>`;
  }).join('');
}
$('#allNotes').addEventListener('click', (e) => {
  const x = e.target.closest('.note-item'); if (!x) return;
  const n = state.notes.find((y) => y.id === x.dataset.note); if (n) jumpToNote(n);
});
$('#notesExportAllBtn').addEventListener('click', () => shareFile('Readwell notes.md', notesMarkdown(state.docs), 'text/markdown'));

// ================================================================ my words
function updateBadge() {
  const due = state.words.filter((w) => (w.srs?.due || 0) <= Date.now()).length;
  $('#tabBadge').hidden = !due; $('#tabBadge').textContent = due > 99 ? '99+' : due;
  $('#dueCount').textContent = due; $('#dueLabel').textContent = due === 1 ? 'word to review' : 'words to review';
  $('#reviewBtn').disabled = !due; $('#reviewBtn').style.opacity = due ? 1 : 0.4;
  $('#reviewBanner').hidden = !state.words.length;
}

function renderWords() {
  updateBadge();
  const q = $('#wordSearch').value.trim().toLowerCase();
  const list = [...state.words].sort((a, b) => b.added - a.added)
    .filter((w) => !q || w.word.toLowerCase().includes(q) || (w.definition || '').toLowerCase().includes(q) || (w.note || '').toLowerCase().includes(q));
  $('#wordsEmpty').hidden = state.words.length > 0;
  $('#wordSearch').hidden = state.words.length < 6;
  $('#wordsExportBtn').hidden = !state.words.length;
  $('#wordList').innerHTML = list.map((w) => `<li data-id="${w.id}"><div class="w">${esc(w.word)}${w.pos ? `<small>${esc(w.pos)}</small>` : ''}</div>
    ${w.definition ? `<div class="d">${esc(w.definition)}</div>` : ''}${w.note ? `<div class="n">✎ ${esc(w.note)}</div>` : ''}</li>`).join('');
}
$('#wordSearch').addEventListener('input', renderWords);
$('#wordList').addEventListener('click', (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const w = state.words.find((x) => x.id === li.dataset.id); if (!w) return;
  wordDetail(w);
});

function wordDetail(w) {
  const defs = (w.definitions && w.definitions.length) ? w.definitions.map((e) => `<div class="pos">${esc(e.pos)}</div><ol class="defs">${e.defs.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>`).join('')
    : (w.definition ? `<p>${esc(w.definition)}</p>` : '<p class="sub">No definition saved.</p>');
  const b = openSheet(`<div class="dict-head"><h2>${esc(w.word)}</h2>${w.pron ? `<span class="pron">/${esc(w.pron)}/</span>` : ''}<button class="say">🔊</button></div>
    ${defs}
    ${w.synonyms && w.synonyms.length ? `<div class="label">Synonyms</div><div class="chips">${w.synonyms.map((s) => `<button data-w="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
    ${w.context ? `<div class="label">Found in${w.docTitle ? ' ' + esc(w.docTitle) : ''}</div><div class="context">${esc(w.context)}</div>` : ''}
    <div class="label">My note</div><textarea id="wNote" rows="2" placeholder="Add a note">${esc(w.note || '')}</textarea>
    <div class="sub" style="margin-top:8px">Added ${fmtDate(w.added)} · ${w.srs && w.srs.reps ? `next review ${w.srs.due <= Date.now() ? 'now' : fmtDate(w.srs.due)}` : 'not reviewed yet'}</div>
    <div class="actions"><button class="btn danger" id="wDel">Remove</button><span class="spacer"></span><button class="btn" id="wLook">Look up again</button><button class="btn primary" id="wSave">Save</button></div>`);
  b.querySelector('.say').onclick = () => player.say(w.word);
  b.querySelectorAll('.chips button').forEach((c) => c.onclick = () => dictSheet(c.dataset.w));
  b.querySelector('#wSave').onclick = async () => { w.note = b.querySelector('#wNote').value.trim(); await db.put('words', w); closeSheet(); renderWords(); toast('Saved'); };
  b.querySelector('#wDel').onclick = async () => { await deleteWord(w.id); closeSheet(); toast('Removed'); };
  b.querySelector('#wLook').onclick = () => dictSheet(w.word, w.context);
}

$('#wordsExportBtn').addEventListener('click', () => {
  const b = openSheet(`<h2>Export ${state.words.length} word${state.words.length > 1 ? 's' : ''}</h2>
    <div class="menu">
      <button data-f="csv"><span class="mi">▦</span><span>Spreadsheet (CSV)<small>Opens in Numbers, Excel or Google Sheets</small></span></button>
      <button data-f="anki"><span class="mi">🗂</span><span>Anki flashcards<small>In Anki: File → Import</small></span></button>
    </div>`);
  b.querySelector('[data-f=csv]').onclick = () => shareFile('My Words.csv', wordsCsv(), 'text/csv');
  b.querySelector('[data-f=anki]').onclick = () => shareFile('My Words (Anki).txt', wordsAnki(), 'text/plain');
});
const sortedWords = () => [...state.words].sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }));
function wordsCsv() {
  const cell = (v) => { v = String(v ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const rows = [['Word', 'Part of speech', 'Pronunciation', 'Definition', 'Synonyms', 'My note', 'Found in', 'Context', 'Added']];
  for (const w of sortedWords()) rows.push([w.word, w.pos, w.pron, w.definition, (w.synonyms || []).join(', '), w.note, w.docTitle, w.context, new Date(w.added).toISOString().slice(0, 10)]);
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
function wordsAnki() {
  const lines = ['#separator:tab', '#html:true', '#columns:Front\tBack\tTags', '#tags column:3'];
  for (const w of sortedWords()) {
    const back = [];
    if (w.pron) back.push(`<i>/${esc(w.pron)}/</i>`);
    if (w.definition) back.push((w.pos ? `<b>${esc(w.pos)}</b> ` : '') + esc(w.definition));
    if (w.synonyms && w.synonyms.length) back.push('Synonyms: ' + esc(w.synonyms.slice(0, 8).join(', ')));
    if (w.context) back.push(`<i>“${esc(w.context)}”</i>`);
    if (w.note) back.push('Note: ' + esc(w.note));
    lines.push([esc(w.word), back.join('<br><br>'), 'readwell'].map((c) => c.replace(/\t/g, ' ').replace(/\n/g, '<br>')).join('\t'));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- flashcards (simplified SM-2, same as the Mac app)
export function schedule(srs, grade, now = Date.now()) {
  let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = srs || {};
  let due;
  if (grade === 1) { lapses++; reps = 0; interval = 0; ease = Math.max(1.3, ease - 0.2); due = now + 10 * 60 * 1000; }
  else {
    reps++;
    if (reps === 1) interval = { 2: 1, 3: 1, 4: 3 }[grade];
    else if (reps === 2) interval = { 2: 2, 3: 3, 4: 6 }[grade];
    else interval = Math.max(interval + 1, Math.round(interval * { 2: 1.2, 3: ease, 4: ease * 1.3 }[grade]));
    ease = Math.max(1.3, ease + { 2: -0.15, 3: 0, 4: 0.15 }[grade]);
    due = now + interval * DAY;
  }
  return { ease: Math.round(ease * 100) / 100, interval, reps, lapses, due, last: now };
}
const dayLabel = (d) => (d === 1 ? '1 day' : d < 30 ? `${d} days` : d < 365 ? `${Math.round(d / 30)} mo` : `${(d / 365).toFixed(1)} yr`);

let queue = [], current = null;
function startReview() {
  queue = state.words.filter((w) => (w.srs?.due || 0) <= Date.now()).sort((a, b) => (a.srs?.due || 0) - (b.srs?.due || 0));
  if (!queue.length) return toast('Nothing to review right now');
  $('#cards').hidden = false; nextCard();
}
function nextCard() {
  current = queue.shift();
  if (!current) { $('#cards').hidden = true; renderWords(); toast('Review finished 🎉'); return; }
  $('#cardsCount').textContent = `${queue.length + 1} left`;
  $('#card').innerHTML = `<div class="front">${esc(current.word)}</div>${current.pron ? `<div class="pron">/${esc(current.pron)}/</div>` : ''}`;
  $('#grades').hidden = true; $('#revealBtn').hidden = false;
}
$('#revealBtn').addEventListener('click', () => {
  const w = current; if (!w) return;
  const defs = (w.definitions && w.definitions.length) ? w.definitions.map((e) => `<div class="pos">${esc(e.pos)}</div><ol class="defs">${e.defs.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>`).join('') : (w.definition ? `<p>${esc(w.definition)}</p>` : '');
  $('#card').insertAdjacentHTML('beforeend', `<div class="back">${defs}${w.synonyms && w.synonyms.length ? `<div class="label">Synonyms</div><div>${esc(w.synonyms.slice(0, 6).join(', '))}</div>` : ''}${w.context ? `<div class="label">Context</div><div class="context">${esc(w.context)}</div>` : ''}${w.note ? `<div class="label">My note</div><div>${esc(w.note)}</div>` : ''}</div>`);
  for (const g of [2, 3, 4]) $('#g' + g).textContent = dayLabel(schedule(w.srs, g).interval);
  $('#grades').hidden = false; $('#revealBtn').hidden = true;
});
$('#card').addEventListener('click', () => { if (!$('#revealBtn').hidden) $('#revealBtn').click(); else if (current) player.say(current.word); });
$('#grades').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-grade]'); if (!b || !current) return;
  const g = +b.dataset.grade;
  current.srs = schedule(current.srs, g);
  await db.put('words', current);
  if (g === 1) queue.push(current);
  nextCard(); updateBadge();
});
$('#reviewBtn').addEventListener('click', startReview);
$('#cardsClose').addEventListener('click', () => { $('#cards').hidden = true; renderWords(); });

// ================================================================ settings: data
async function renderSettingsInfo() {
  $('#versionValue').textContent = APP_VERSION;
  try {
    const est = await navigator.storage.estimate();
    $('#storageValue').textContent = `${(est.usage / 1048576).toFixed(1)} MB`;
  } catch { $('#storageValue').textContent = '–'; }
  const offline = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  $('#offlineValue').textContent = offline ? 'Yes ✓' : (location.protocol === 'file:' ? 'No (open it from the web address)' : 'After the next launch');
}

let pendingBackup = null;
$('#backupBtn').addEventListener('click', async () => {
  const ctl = busy('Preparing backup…');
  try {
    const [docs, texts, words, notes] = await Promise.all([db.all('docs'), db.all('texts'), db.all('words'), db.all('notes')]);
    const data = JSON.stringify({ app: 'readwell', format: 1, version: APP_VERSION, exported: new Date().toISOString(), settings: state.settings, docs, texts, words, notes });
    pendingBackup = data;
    ctl.done();
    const b = openSheet(`<h2>Backup ready</h2><p class="sub">${docs.length} document${docs.length === 1 ? '' : 's'}, ${words.length} word${words.length === 1 ? '' : 's'} and ${notes.length} note${notes.length === 1 ? '' : 's'} (${(data.length / 1048576).toFixed(1)} MB). Choose <b>Save to Files</b> to keep it in iCloud Drive or on this phone.</p>
      <div class="actions"><button class="btn primary big" id="doBackup">Save backup</button></div>`);
    b.querySelector('#doBackup').onclick = async () => {
      const ok = await shareFile(`Readwell backup ${new Date().toISOString().slice(0, 10)}.json`, pendingBackup, 'application/json');
      if (ok) { closeSheet(); db.setSetting('lastBackup', Date.now()); }
    };
  } catch (e) { ctl.done(); toast('Backup failed: ' + e.message); }
});
$('#restoreBtn').addEventListener('click', () => $('#restoreInput').click());
$('#restoreInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'readwell') throw new Error('This isn’t a Readwell backup.');
    const ok = await confirmSheet('Restore this backup?', `It adds ${data.docs.length} documents, ${data.words.length} words and ${data.notes.length} notes. Anything with the same name in both is replaced by the backup copy.`, 'Restore', false);
    if (!ok) return;
    const ctl = busy('Restoring…');
    for (const t of data.texts || []) await db.put('texts', t);
    for (const d of data.docs || []) await db.put('docs', d);
    for (const w of data.words || []) await db.put('words', w);
    for (const n of data.notes || []) await db.put('notes', n);
    if (data.settings) { Object.assign(state.settings, data.settings); saveSettings(); applySettings(); pickVoice(); }
    await loadAll(); ctl.done(); renderLibrary(); updateBadge(); toast('Backup restored');
  } catch (err) { toast(err.message || 'That file couldn’t be read'); }
});

// ================================================================ install & updates
function maybeInstallTip() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  db.setting('installTipDismissed', false).then((dismissed) => { $('#installTip').hidden = standalone || !ios || dismissed; });
}
$$('[data-dismiss]').forEach((b) => b.addEventListener('click', () => { $('#' + b.dataset.dismiss).hidden = true; db.setSetting('installTipDismissed', true); }));

let swReg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    swReg = await navigator.serviceWorker.register('sw.js');
    swReg.addEventListener('updatefound', () => {
      const w = swReg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Readwell was updated. It’ll use the new version next time you open it.', 4500);
      });
    });
  } catch (e) { console.warn('Service worker failed', e); }
}
$('#updateBtn').addEventListener('click', async () => {
  if (!swReg) return toast('Updates work once Readwell is installed from its web address');
  toast('Checking…');
  try { await swReg.update(); setTimeout(() => toast(swReg.waiting || swReg.installing ? 'Update downloaded. Close and reopen Readwell to use it.' : 'You have the latest version'), 1500); }
  catch { toast('Couldn’t check. Are you online?'); }
});

// keep the reading position when the app is backgrounded
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePos(); });

// ================================================================ start
async function start() {
  await loadSettings();
  await loadAll();
  renderLibrary(); updateBadge(); maybeInstallTip();
  initVoices();
  registerSW();
  // Links opened as …/?url=… or ?text=… (handy with iPhone Shortcuts)
  const qs = new URLSearchParams(location.search);
  if (qs.get('url')) { history.replaceState(null, '', location.pathname); runImport((rep) => importUrl(qs.get('url'), rep), 'Fetching the page…'); }
  else if (qs.get('text')) { history.replaceState(null, '', location.pathname); runImport(async () => importText(qs.get('text'), qs.get('title') || ''), 'Adding…'); }
}
start();

// for tests
window.__readwell = { state, player, schedule, engine, aiPlayer, sysPlayer };
