// Local cache (IndexedDB). Holds the user's items + sessions mirror, the sync
// cursor, and the per-device bookmark id ↔ item id mapping.
const DB_NAME = "signaldesk";
const DB_VER = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "k" });
      if (!db.objectStoreNames.contains("bmap")) {
        const s = db.createObjectStore("bmap", { keyPath: "itemId" });
        s.createIndex("byBookmark", "bookmarkId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}
function pr(request) {
  return new Promise((res, rej) => { request.onsuccess = () => res(request.result); request.onerror = () => rej(request.error); });
}

export async function putAll(store, rows) {
  const db = await open();
  const os = tx(db, store, "readwrite");
  await Promise.all(rows.map((r) => pr(os.put(r))));
}
export async function put(store, row) { return putAll(store, [row]); }
export async function get(store, key) { const db = await open(); return pr(tx(db, store).get(key)); }
export async function getAll(store) { const db = await open(); return pr(tx(db, store).getAll()); }
export async function del(store, key) { const db = await open(); return pr(tx(db, store, "readwrite").delete(key)); }

export async function getMeta(k, dflt = null) { const row = await get("meta", k); return row ? row.v : dflt; }
export async function setMeta(k, v) { return put("meta", { k, v }); }

// bookmark map helpers (per-device; bookmark ids differ per profile)
export async function mapSet(itemId, bookmarkId, hash) { return put("bmap", { itemId, bookmarkId, hash }); }
export async function mapByItem(itemId) { return get("bmap", itemId); }
export async function mapByBookmark(bookmarkId) {
  const db = await open();
  return pr(tx(db, "bmap").index("byBookmark").get(bookmarkId));
}
export async function mapDelete(itemId) { return del("bmap", itemId); }
export async function mapAll() { return getAll("bmap"); }
