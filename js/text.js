// Text clean-up and layout rebuilding — a port of the desktop app's
// extract.py / ocr.py so the phone produces the same reading order.

export function tidy(text) {
  text = (text || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/­/g, '');
  text = text.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n');
  return text.split(/\n{2,}/).map((p) => p.trim().replace(/\n/g, ' ')).filter(Boolean).join('\n\n').trim();
}

/** Plain text where single newlines are paragraph breaks (HTML, EPUB, Word). */
export function linesToParagraphs(text) {
  return tidy((text || '').replace(/\r\n?/g, '\n').replace(/\n+/g, '\n\n'));
}

export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*(.*)$/gm, '\n$1\n')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/gm, '\n$1\n')
    .replace(/(\*\*|__|\*|_|`)/g, '');
}

export function titleFromText(text, fallback = 'Untitled') {
  const first = (text || '').trim().split('\n')[0].trim();
  if (!first) return fallback;
  return first.length > 70 ? first.slice(0, 70) + '…' : first;
}

// ------------------------------------------------------------------ layout
// A Line is {text, x, y, w, h} in fractions of the page, origin top-left.
const PAGE_NUM = /^(page\s*)?(\d{1,4}|[ivxlc]{1,6}|[IVXLC]{1,6})(\s*(of|\/)\s*\d+)?$/i;
const END_SENTENCE = /[.!?:;"”’)\]]$/;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const right = (l) => l.x + l.w;
const bottom = (l) => l.y + l.h;
const normRepeat = (t) => t.trim().toLowerCase().replace(/\d+/g, '#');

function dropRunningHeads(pages) {
  const counts = new Map();
  for (const lines of pages) {
    const seen = new Set();
    for (const l of lines) {
      if (l.y < 0.08 || bottom(l) > 0.92) seen.add(normRepeat(l.text));
    }
    for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const need = pages.length >= 2 ? Math.max(2, Math.ceil(pages.length / 2)) : 99;
  return pages.map((lines) => lines.filter((l) => {
    const edge = l.y < 0.08 || bottom(l) > 0.92;
    return !(edge && (PAGE_NUM.test(l.text.trim()) || (counts.get(normRepeat(l.text)) || 0) >= need));
  }));
}

function findColumnSplit(lines) {
  const body = lines.filter((l) => l.text.length > 3);
  if (body.length < 8) return null;
  let best = null;
  for (let i = 30; i <= 70; i++) {
    const x = i / 100;
    let crossing = 0, left = 0, rightN = 0;
    for (const l of body) {
      if (l.x < x - 0.005 && right(l) > x + 0.005) crossing++;
      if (right(l) <= x + 0.005) left++;
      if (l.x >= x - 0.005) rightN++;
    }
    if (left >= 0.2 * body.length && rightN >= 0.2 * body.length && crossing <= 0.12 * body.length) {
      const score = crossing - Math.min(left, rightN) / body.length;
      if (!best || score < best[0]) best = [score, x];
    }
  }
  return best ? best[1] : null;
}

function readingOrder(lines) {
  lines = [...lines].sort((a, b) => (Math.round(a.y * 1000) - Math.round(b.y * 1000)) || (a.x - b.x));
  const split = findColumnSplit(lines);
  if (split == null) return [lines];
  const blocks = []; let left = [], rgt = [];
  const flush = () => {
    if (left.length) blocks.push(left.sort((a, b) => a.y - b.y));
    if (rgt.length) blocks.push(rgt.sort((a, b) => a.y - b.y));
    left = []; rgt = [];
  };
  for (const l of lines) {
    if (l.x < split - 0.005 && right(l) > split + 0.005) { flush(); blocks.push([l]); }
    else if (right(l) <= split + 0.005) left.push(l);
    else rgt.push(l);
  }
  flush();
  return blocks;
}

function mergeSameRow(lines) {
  const out = [];
  for (const l of [...lines].sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
    const p = out[out.length - 1];
    if (p) {
      const sameRow = Math.abs((p.y + p.h / 2) - (l.y + l.h / 2)) < 0.5 * Math.min(p.h, l.h);
      const gap = l.x - right(p);
      if (sameRow && gap >= -0.002 && gap < 0.06) {
        const y = Math.min(p.y, l.y);
        out[out.length - 1] = { text: p.text + (gap > 0.004 ? ' ' : '') + l.text, x: p.x, y, w: right(l) - p.x, h: Math.max(bottom(p), bottom(l)) - y };
        continue;
      }
    }
    out.push({ ...l });
  }
  return out;
}

function paragraphs(block) {
  block = mergeSameRow(block);
  if (!block.length) return [];
  const lh = median(block.map((l) => l.h).filter((h) => h > 0)) || 0.015;
  const gaps = [];
  for (let i = 1; i < block.length; i++) { const g = block[i].y - bottom(block[i - 1]); if (g > 0) gaps.push(g); }
  const normalGap = gaps.length ? median(gaps) : lh * 0.4;
  const leftEdge = Math.min(...block.map((l) => l.x));
  const widths = block.map((l) => l.w).sort((a, b) => a - b);
  const fullW = widths[Math.floor(widths.length * 0.8)] || 1;
  const paras = []; let cur = ''; let prev = null;
  for (const l of block) {
    const text = l.text.trim();
    if (!text) continue;
    if (prev) {
      const gap = l.y - bottom(prev);
      const prevEnds = END_SENTENCE.test(prev.text.trim());
      const indent = l.x - leftEdge > 0.025 && prev.x - leftEdge < 0.015;
      const shortPrev = prev.w < 0.75 * fullW && prevEnds;
      const bigGap = gap > Math.max(normalGap * 1.8, lh * 0.9);
      const sizeChange = prev.h > l.h * 1.18 || l.h > prev.h * 1.18;
      const heading = prev.w < 0.55 * fullW && !prevEnds && /^[A-Z0-9“"]/.test(text) && prev.text.trim().split(/\s+/).length <= 8;
      if (bigGap || (indent && prevEnds) || shortPrev || (sizeChange && prev.w < 0.85 * fullW) || heading) { paras.push(cur); cur = ''; }
    }
    if (cur.endsWith('-') && /^[a-z]/.test(text) && !cur.endsWith(' -')) cur = cur.slice(0, -1) + text;
    else cur = cur ? `${cur} ${text}` : text;
    prev = l;
  }
  if (cur) paras.push(cur);
  return paras;
}

/** pages: arrays of Lines → array of page texts (paragraphs joined by blank lines). */
export function rebuildPages(pages) {
  pages = dropRunningHeads(pages);
  const texts = pages.map((lines) => readingOrder(lines).flatMap(paragraphs));
  for (let i = 0; i < texts.length - 1; i++) {
    const a = texts[i], b = texts[i + 1];
    if (a.length && b.length) {
      const tail = a[a.length - 1], head = b[0];
      if (!END_SENTENCE.test(tail) && /^[a-z(]/.test(head)) {
        a[a.length - 1] = tail.endsWith('-') ? tail.slice(0, -1) + head : `${tail} ${head}`;
        texts[i + 1] = b.slice(1);
      }
    }
  }
  return texts.map((p) => p.join('\n\n'));
}

// ------------------------------------------------------------------ sentences
const segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'sentence' }) : null;

export function splitSentences(p) {
  const parts = segmenter ? Array.from(segmenter.segment(p), (x) => x.segment)
    : (p.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*)?\s*/g) || [p]);
  const out = [];
  for (const part of parts) {
    if (out.length && out[out.length - 1].trim().split(/\s+/).length < 3) out[out.length - 1] += part;
    else out.push(part);
  }
  const final = [];
  for (const s of out) {
    if (s.length <= 420) { final.push(s); continue; }
    let rest = s;
    while (rest.length > 420) {
      const win = rest.slice(0, 420);
      let cut = Math.max(win.lastIndexOf('; '), win.lastIndexOf(', '), win.lastIndexOf(' — '));
      if (cut < 120) cut = win.lastIndexOf(' ');
      if (cut < 1) cut = 420;
      final.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1);
    }
    if (rest) final.push(rest);
  }
  return final;
}

export function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}
