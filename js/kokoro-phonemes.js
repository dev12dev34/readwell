// Text → phonemes for Kokoro, ported from kokoro-js (Apache-2.0, hexgrad & Xenova)
// so the phone produces the same pronunciation as the reference implementation.
import { phonemize } from '../vendor/phonemizer.js';

function splitNum(e) {
  if (e.includes('.')) return e;
  if (e.includes(':')) {
    const [h, m] = e.split(':').map(Number);
    return m === 0 ? `${h} o'clock` : m < 10 ? `${h} oh ${m}` : `${h} ${m}`;
  }
  const year = parseInt(e.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return e;
  const left = e.slice(0, 2), right = parseInt(e.slice(2, 4), 10), s = e.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${s}`;
    if (right < 10) return `${left} oh ${right}${s}`;
  }
  return `${left} ${right}${s}`;
}

function flipMoney(e) {
  const bill = e[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${bill}s`;
  if (!e.includes('.')) return `${e.slice(1)} ${bill}${e.slice(1) === '1' ? '' : 's'}`;
  const [b, c] = e.slice(1).split('.');
  const d = parseInt(c.padEnd(2, '0'), 10);
  const coins = e[0] === '$' ? (d === 1 ? 'cent' : 'cents') : (d === 1 ? 'penny' : 'pence');
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`;
}

const pointNum = (e) => { const [a, b] = e.split('.'); return `${a} point ${b.split('').join(' ')}`; };

export function normalizeText(t) {
  return t
    .replace(/[‘’]/g, "'").replace(/«/g, '“').replace(/»/g, '”').replace(/[“”]/g, '"')
    .replace(/\(/g, '«').replace(/\)/g, '»')
    .replace(/、/g, ', ').replace(/。/g, '. ').replace(/！/g, '! ').replace(/，/g, ', ')
    .replace(/：/g, ': ').replace(/；/g, '; ').replace(/？/g, '? ')
    .replace(/[^\S \n]/g, ' ').replace(/  +/, ' ').replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCT = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RE = new RegExp(`(\\s*[${PUNCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

function splitKeep(text, re) {
  const out = []; let last = 0;
  for (const m of text.matchAll(re)) {
    if (last < m.index) out.push({ match: false, text: text.slice(last, m.index) });
    if (m[0].length) out.push({ match: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ match: false, text: text.slice(last) });
  return out;
}

/** lang 'a' = American English, 'b' = British English (the first letter of the voice name). */
export async function textToPhonemes(text, lang = 'a') {
  text = normalizeText(text);
  const espeakLang = lang === 'a' ? 'en-us' : 'en';
  const parts = splitKeep(text, PUNCT_RE);
  const ph = (await Promise.all(parts.map(async ({ match, text: t }) => (match ? t : (await phonemize(t, espeakLang)).join(' '))))).join('');
  let s = ph
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ').replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j').replace(/r/g, 'ɹ').replace(/x/g, 'k').replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (lang === 'a') s = s.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return s.trim();
}
