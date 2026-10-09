// Text recognition with tesseract.js, loaded from this app's own files so it
// works offline once the app has been opened. Returns Lines for rebuildPages.
const abs = (p) => new URL(p, document.baseURI).href;
let workerP = null;
let progressCb = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load text recognition'));
    document.head.appendChild(s);
  });
}

async function worker() {
  if (!workerP) {
    workerP = (async () => {
      await loadScript(abs('vendor/tesseract/tesseract.min.js'));
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core'),
        langPath: abs('vendor/tesseract/lang'),
        gzip: true,
        workerBlobURL: false,
        cacheMethod: 'none', // the service worker already caches the language file
        logger: (m) => { if (progressCb && m.status === 'recognizing text') progressCb(m.progress); },
      });
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

/** Recognize a canvas (or image). Returns [{text,x,y,w,h}] as page fractions. */
export async function recognize(canvas, onProgress) {
  const w = await worker();
  progressCb = onProgress || null;
  try {
    const { data } = await w.recognize(canvas);
    const W = canvas.width, H = canvas.height;
    const out = [];
    const push = (words) => {
      const text = words.map((w) => w.text).join(' ').trim();
      if (!text) return;
      const x0 = Math.min(...words.map((w) => w.bbox.x0)), x1 = Math.max(...words.map((w) => w.bbox.x1));
      const y0 = Math.min(...words.map((w) => w.bbox.y0)), y1 = Math.max(...words.map((w) => w.bbox.y1));
      out.push({ text, x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H });
    };
    for (const l of data.lines || []) {
      if (!l.text.trim() || l.confidence < 30) continue;
      const words = (l.words || []).filter((w) => w.text.trim());
      if (!words.length) { push([{ text: l.text.trim(), bbox: l.bbox }]); continue; }
      // Tesseract sometimes runs a line across a narrow column gutter; split at wide gaps.
      const lh = l.bbox.y1 - l.bbox.y0;
      let seg = [words[0]];
      for (let k = 1; k < words.length; k++) {
        const gap = words[k].bbox.x0 - words[k - 1].bbox.x1;
        if (gap > Math.max(lh * 1.1, W * 0.02)) { push(seg); seg = []; }
        seg.push(words[k]);
      }
      push(seg);
    }
    return out;
  } finally {
    progressCb = null;
  }
}

/** Draw a photo onto a canvas at a size that is good for recognition. */
export async function imageToCanvas(file, maxSide = 2600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img); img.onerror = () => reject(new Error('This image format isn’t supported'));
      img.src = URL.createObjectURL(file);
    });
  }
  const iw = bmp.width, ih = bmp.height;
  let scale = Math.min(1, maxSide / Math.max(iw, ih));
  if (Math.max(iw, ih) < 1200) scale = Math.min(2, 1600 / Math.max(iw, ih)); // upscale small screenshots
  const c = document.createElement('canvas');
  c.width = Math.round(iw * scale); c.height = Math.round(ih * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

export async function terminate() {
  if (workerP) { try { (await workerP).terminate(); } catch {} workerP = null; }
}
