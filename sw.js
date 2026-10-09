// Readwell offline support: keeps a copy of the app on the phone so it opens
// and works without the internet. Bump VERSION when publishing an update.
const VERSION = 'readwell-1.1.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/text.js', 'js/importers.js', 'js/ocr.js', 'js/dict.js', 'js/speech.js', 'js/kokoro.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/favicon-32.png',
  'vendor/jszip.min.js', 'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
];
// Text recognition files are large (~10 MB); they are fetched in the background.
const EXTRA = [
  'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js',
  'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/lang/eng.traineddata.gz',
  // AI voice program files (the voice model itself is downloaded only when asked for)
  'js/kokoro-worker.js', 'js/kokoro-phonemes.js', 'js/kokoro-vocab.js',
  'vendor/ort/ort.wasm.min.js', 'vendor/ort/ort-wasm-simd-threaded.js', 'vendor/phonemizer.js',
];

// Cross-origin isolation lets the AI voice use several processor cores.
function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await Promise.all(EXTRA.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('readwell-') && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // dictionary & web pages go straight to the network
  // AI voice model files are big; the voice engine keeps its own copy of them.
  if (url.pathname.includes('/ai/')) return;
  event.respondWith(handle(req).then(isolate));
});

async function handle(req) {
  {
    const cache = await caches.open(VERSION);
    const isPage = req.mode === 'navigate';
    const hit = await cache.match(isPage ? 'index.html' : req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (isPage) { const shell = await cache.match('index.html'); if (shell) return shell; }
      throw e;
    }
  }
}
