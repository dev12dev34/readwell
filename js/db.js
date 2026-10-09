// Tiny IndexedDB wrapper. Everything Readwell saves lives on this phone only.
const DB_NAME = 'readwell';
const STORES = ['docs', 'texts', 'words', 'notes', 'settings', 'dictcache'];
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          const st = db.createObjectStore(s, { keyPath: s === 'settings' || s === 'dictcache' ? 'key' : 'id' });
          if (s === 'notes') st.createIndex('docId', 'docId');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async get(s, key) { return wrap((await store(s)).get(key)); },
  async all(s) { return wrap((await store(s)).getAll()); },
  async put(s, value) { await wrap((await store(s, 'readwrite')).put(value)); return value; },
  async del(s, key) { return wrap((await store(s, 'readwrite')).delete(key)); },
  async clear(s) { return wrap((await store(s, 'readwrite')).clear()); },
  async byIndex(s, index, value) { return wrap((await store(s)).index(index).getAll(value)); },
  async setting(key, fallback) { const r = await this.get('settings', key); return r ? r.value : fallback; },
  async setSetting(key, value) { return this.put('settings', { key, value }); },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Ask Safari not to clear our data when space is low.
export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
