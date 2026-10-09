// Dictionary & thesaurus using two free services (no account needed):
//   dictionaryapi.dev — definitions, pronunciation, examples
//   Datamuse          — synonyms and antonyms
// Every word you look up is cached on the phone, so it works offline next time.
import { db } from './db.js';

const clean = (w) => (w || '').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/[’]/g, "'");

async function getJson(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function fromDictApi(data) {
  if (!Array.isArray(data) || !data.length) return null;
  let pron = '';
  const groups = new Map();
  const syn = new Set(), ant = new Set();
  for (const e of data) {
    if (!pron) pron = (e.phonetic || (e.phonetics || []).map((p) => p.text).find(Boolean) || '').replace(/^\/|\/$/g, '');
    for (const m of e.meanings || []) {
      const g = groups.get(m.partOfSpeech) || [];
      for (const d of m.definitions || []) {
        if (g.length < 5) g.push({ def: d.definition, example: d.example || '' });
        (d.synonyms || []).forEach((s) => syn.add(s)); (d.antonyms || []).forEach((s) => ant.add(s));
      }
      (m.synonyms || []).forEach((s) => syn.add(s)); (m.antonyms || []).forEach((s) => ant.add(s));
      groups.set(m.partOfSpeech, g);
    }
  }
  return { word: data[0].word, pron, entries: [...groups].map(([pos, defs]) => ({ pos, defs })), synonyms: [...syn], antonyms: [...ant] };
}

export async function lookup(raw) {
  const word = clean(raw);
  if (!word) return null;
  const key = word.toLowerCase();
  const cached = await db.get('dictcache', key).catch(() => null);
  if (cached && cached.result && Date.now() - cached.at < 180 * 864e5) return cached.result;

  const q = encodeURIComponent(key);
  const [defs, syns, ants] = await Promise.allSettled([
    getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${q}`),
    getJson(`https://api.datamuse.com/words?rel_syn=${q}&max=24`),
    getJson(`https://api.datamuse.com/words?rel_ant=${q}&max=10`),
  ]);
  if (defs.status === 'rejected' && syns.status === 'rejected') {
    if (cached) return cached.result;
    throw new Error(navigator.onLine ? 'The dictionary isn’t responding. Try again in a moment.' : 'You’re offline. Words you’ve looked up before still work.');
  }
  const r = (defs.status === 'fulfilled' && fromDictApi(defs.value)) || { word, pron: '', entries: [], synonyms: [], antonyms: [] };
  const add = (set, list) => { for (const x of list || []) if (x && x.word && !set.includes(x.word)) set.push(x.word); };
  if (syns.status === 'fulfilled') add(r.synonyms, syns.value);
  if (ants.status === 'fulfilled') add(r.antonyms, ants.value);
  r.synonyms = r.synonyms.filter((s) => s.toLowerCase() !== key).slice(0, 24);
  r.antonyms = r.antonyms.slice(0, 10);
  r.found = r.entries.length > 0 || r.synonyms.length > 0;
  await db.put('dictcache', { key, at: Date.now(), result: r }).catch(() => {});
  return r;
}

export const cleanWord = clean;
