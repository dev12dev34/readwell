// Turns files, links and pasted text into {title, text} where paragraphs are
// separated by blank lines.
import { tidy, linesToParagraphs, stripMarkdown, titleFromText, rebuildPages } from './text.js';
import { recognize, imageToCanvas } from './ocr.js';

const abs = (p) => new URL(p, document.baseURI).href;
export class Cancelled extends Error { constructor() { super('Cancelled'); } }

const baseName = (name) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
const extOf = (name) => (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tif', 'tiff'];

export const ACCEPT = '.pdf,.docx,.epub,.txt,.md,.markdown,.html,.htm,.odt,.rtf,image/*,application/pdf,text/plain';

function loadScript(src, globalName) {
  return new Promise((resolve, reject) => {
    if (window[globalName]) return resolve(window[globalName]);
    const s = document.createElement('script');
    s.src = src; s.onload = () => resolve(window[globalName]); s.onerror = () => reject(new Error('Could not load ' + globalName));
    document.head.appendChild(s);
  });
}

// ----------------------------------------------------------------- HTML
const BLOCK = 'p,div,section,article,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr,dt,dd,figcaption,br,hr,header,footer,aside,main,table,ul,ol';

export function htmlToText(doc) {
  const root = doc.body || doc.documentElement;
  if (!root) return '';
  root.querySelectorAll('script,style,noscript,nav,svg,template,iframe,form,button,head').forEach((e) => e.remove());
  // Prefer the main article if the page marks one.
  const main = root.querySelector('article') || root.querySelector('main') || root;
  main.querySelectorAll(BLOCK).forEach((e) => {
    e.insertAdjacentText('beforebegin', '\n');
    if (e.tagName !== 'BR') e.insertAdjacentText('afterend', '\n');
  });
  return linesToParagraphs(main.textContent || '');
}

function parseHtml(str) { return new DOMParser().parseFromString(str, 'text/html'); }

// ----------------------------------------------------------------- PDF
let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(abs('vendor/pdfjs/pdf.min.js')).then((m) => {
      m.GlobalWorkerOptions.workerSrc = abs('vendor/pdfjs/pdf.worker.min.js');
      return m;
    });
    pdfjsP.catch(() => { pdfjsP = null; });
  }
  return pdfjsP;
}

/** pdf.js text items → Lines (fractions of the page, origin top-left). */
function itemsToLines(items, vw, vh) {
  const raw = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, , d, e, f] = it.transform;
    const fontH = Math.hypot(b, d) || Math.abs(d) || it.height || 10;
    if (Math.abs(b) > Math.abs(a) * 0.5) continue; // skip rotated text (margins, stamps)
    raw.push({ text: it.str, x: e / vw, y: (vh - f - fontH * 0.8) / vh, w: (it.width || it.str.length * fontH * 0.5) / vw, h: fontH / vh });
  }
  raw.sort((p, q) => (p.y - q.y) || (p.x - q.x));
  // join pieces that sit on the same baseline and touch
  const lines = [];
  for (const r of raw) {
    const l = lines.find((L) => Math.abs(L.y - r.y) < Math.min(L.h, r.h) * 0.35 && r.x - (L.x + L.w) > -0.01 && r.x - (L.x + L.w) < 0.02);
    if (l) {
      const gap = r.x - (l.x + l.w);
      const glue = gap > l.h * 0.12 && !l.text.endsWith(' ') && !r.text.startsWith(' ') ? ' ' : '';
      l.text += glue + r.text; l.w = r.x + r.w - l.x; l.h = Math.max(l.h, r.h);
    } else lines.push({ ...r });
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
}

async function importPdf(file, report, isCancelled) {
  const lib = await pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await lib.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  let title = '';
  try { const meta = await pdf.getMetadata(); title = (meta.info && meta.info.Title || '').trim(); } catch {}
  const pages = [];
  const scanned = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    if (isCancelled()) throw new Cancelled();
    report(`Reading page ${i} of ${pdf.numPages}…`, i / pdf.numPages);
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = itemsToLines(tc.items, vp.width, vp.height);
    const chars = lines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0);
    if (chars < 25) scanned.push(i);
    pages.push(lines);
    page.cleanup();
  }
  for (let k = 0; k < scanned.length; k++) {
    if (isCancelled()) throw new Cancelled();
    const i = scanned[k];
    const label = `Reading scanned page ${k + 1} of ${scanned.length}…`;
    report(label, k / scanned.length);
    const page = await pdf.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 2200 / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    pages[i - 1] = await recognize(canvas, (p) => report(label, (k + p) / scanned.length));
    canvas.width = canvas.height = 0; // free memory on iPhone
    page.cleanup();
  }
  await pdf.destroy();
  const text = rebuildPages(pages).filter(Boolean).join('\n\n');
  if (!text.trim()) throw new Error('No readable text was found in this PDF.');
  if (!title || /^(untitled|microsoft word|document\d*)/i.test(title)) title = baseName(file.name);
  return { title, text, kind: 'pdf', ocrPages: scanned.length };
}

// ----------------------------------------------------------------- Word / EPUB / ODT
async function zip(file) {
  const JSZip = await loadScript(abs('vendor/jszip.min.js'), 'JSZip');
  return JSZip.loadAsync(await file.arrayBuffer());
}
const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');

async function importDocx(file) {
  const z = await zip(file);
  const f = z.file('word/document.xml');
  if (!f) throw new Error('This doesn’t look like a Word document.');
  const doc = xml(await f.async('string'));
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = [];
  for (const p of doc.getElementsByTagNameNS(W, 'p')) {
    let t = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.namespaceURI !== W) { if (c.childNodes) walk(c); continue; }
        if (c.localName === 't') t += c.textContent;
        else if (c.localName === 'tab') t += ' ';
        else if (c.localName === 'br' || c.localName === 'cr') t += '\n';
        else if (c.localName === 'p') continue; // nested (text boxes) handled on their own
        else if (c.localName !== 'instrText' && c.localName !== 'delText') walk(c);
      }
    };
    walk(p);
    if (t.trim()) paras.push(t.trim());
  }
  let title = '';
  try {
    const core = z.file('docProps/core.xml');
    if (core) title = (xml(await core.async('string')).getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0] || {}).textContent || '';
  } catch {}
  return { title: title.trim() || baseName(file.name), text: linesToParagraphs(paras.join('\n')), kind: 'docx' };
}

async function importOdt(file) {
  const z = await zip(file);
  const doc = xml(await z.file('content.xml').async('string'));
  const T = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
  const out = [];
  for (const el of doc.getElementsByTagNameNS(T, '*')) {
    if (el.localName === 'p' || el.localName === 'h') out.push(el.textContent);
  }
  return { title: baseName(file.name), text: linesToParagraphs(out.join('\n')), kind: 'odt' };
}

async function importEpub(file, report, isCancelled) {
  const z = await zip(file);
  const container = xml(await z.file('META-INF/container.xml').async('string'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = xml(await z.file(opfPath).async('string'));
  const manifest = {};
  for (const it of opf.getElementsByTagName('item')) manifest[it.getAttribute('id')] = it.getAttribute('href');
  const titleEl = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
  const spine = [...opf.getElementsByTagName('itemref')].map((r) => manifest[r.getAttribute('idref')]).filter(Boolean);
  const parts = [];
  for (let i = 0; i < spine.length; i++) {
    if (isCancelled()) throw new Cancelled();
    report(`Reading chapter ${i + 1} of ${spine.length}…`, i / spine.length);
    const path = decodeURIComponent(new URL(spine[i], 'http://x/' + dir).pathname.slice(1));
    const f = z.file(path);
    if (!f) continue;
    const t = htmlToText(parseHtml(await f.async('string')));
    if (t) parts.push(t);
  }
  return { title: (titleEl && titleEl.textContent.trim()) || baseName(file.name), text: parts.join('\n\n'), kind: 'epub' };
}

function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?/g, '\n').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((+n + 65536) % 65536))
    .replace(/\{\\\*[^{}]*\}/g, '').replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\s*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
}

// ----------------------------------------------------------------- entry points
export async function importFile(file, report = () => {}, isCancelled = () => false) {
  const ext = extOf(file.name);
  const type = file.type || '';
  let r;
  if (ext === 'pdf' || type === 'application/pdf') r = await importPdf(file, report, isCancelled);
  else if (ext === 'docx') r = await importDocx(file);
  else if (ext === 'epub') r = await importEpub(file, report, isCancelled);
  else if (ext === 'odt') r = await importOdt(file);
  else if (IMAGE_EXT.includes(ext) || type.startsWith('image/')) r = await importImage(file, report);
  else if (ext === 'doc') throw new Error('Old .doc files aren’t supported on iPhone. Save it as .docx or PDF first.');
  else {
    const raw = await file.text();
    if (ext === 'html' || ext === 'htm' || /^\s*<(!doctype|html)/i.test(raw)) {
      const d = parseHtml(raw);
      r = { title: (d.title || '').trim() || baseName(file.name), text: htmlToText(d), kind: 'html' };
    } else if (ext === 'rtf' || raw.startsWith('{\\rtf')) r = { title: baseName(file.name), text: linesToParagraphs(rtfToText(raw)), kind: 'rtf' };
    else if (ext === 'md' || ext === 'markdown') r = { title: baseName(file.name), text: tidy(stripMarkdown(raw)), kind: 'md' };
    else r = { title: baseName(file.name), text: tidy(raw), kind: 'txt' };
  }
  if (!r.text || !r.text.trim()) throw new Error('No readable text was found in this file.');
  return r;
}

export async function importImage(file, report = () => {}) {
  report('Reading text in the picture…', 0);
  const canvas = await imageToCanvas(file);
  const lines = await recognize(canvas, (p) => report('Reading text in the picture…', p));
  canvas.width = canvas.height = 0;
  const text = rebuildPages([lines]).join('\n\n');
  if (!text.trim()) throw new Error('No text was found in this picture. Try a sharper, well-lit photo.');
  const name = file.name && !/^image\.\w+$/i.test(file.name) ? baseName(file.name) : '';
  return { title: name || titleFromText(text, 'Photo'), text, kind: 'image' };
}

export function importText(raw, title = '') {
  const text = tidy(raw);
  if (!text) throw new Error('There’s no text to read.');
  return { title: title || titleFromText(text, 'Pasted text'), text, kind: 'text' };
}

function normalizeUrl(u) {
  u = (u || '').trim();
  const m = u.match(/https?:\/\/\S+/);
  if (m) u = m[0];
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { throw new Error('That doesn’t look like a web address.'); }
}

/** Web pages are fetched through r.jina.ai (free reader service) because
 *  most sites don't allow other websites to read them directly. */
export async function importUrl(input, report = () => {}) {
  const url = normalizeUrl(input);
  report('Fetching the page…', 0.2);
  let lastErr = null;
  try {
    const res = await fetch('https://r.jina.ai/' + url, { headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.text();
    const title = ((body.match(/^Title:\s*(.+)$/m) || [])[1] || '').trim();
    const i = body.indexOf('Markdown Content:');
    const md = i >= 0 ? body.slice(i + 17) : body;
    const text = tidy(stripMarkdown(md).replace(/^\s*[=-]{3,}\s*$/gm, ''));
    if (text.length > 40) return { title: title || new URL(url).hostname, text, kind: 'web', source: url };
  } catch (e) { lastErr = e; }
  try { // some sites allow direct reading
    const res = await fetch(url);
    if (res.ok) {
      const d = parseHtml(await res.text());
      const text = htmlToText(d);
      if (text.length > 40) return { title: (d.title || '').trim() || new URL(url).hostname, text, kind: 'web', source: url };
    }
  } catch (e) { lastErr = lastErr || e; }
  if (!navigator.onLine) throw new Error('You’re offline. Connect to the internet to open links.');
  throw new Error('Couldn’t get that page. In Safari, select the article text, tap Copy, then use “Paste text”.');
}
