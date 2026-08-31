// Signal Desk web client: Auth + IndexedDB cache + SyncClient.
// Import as an ES module from the web app. The legacy UI's load()/save() get
// replaced by Store + SyncClient (see web/README.md). No framework required.
//
// API base: when the web app is served by the FastAPI service it's same-origin,
// so default to window.location.origin.

const API_BASE = (window.SIGNALDESK_API || window.location.origin).replace(/\/$/, "");

// ---------- tokens ----------
let accessToken = null; // kept in memory
let refreshing = null;  // in-flight token refresh, shared by concurrent callers
const REFRESH_KEY = "signaldesk.refresh";
function getRefresh() { try { return localStorage.getItem(REFRESH_KEY); } catch { return null; } }
function setTokens(t) { accessToken = t.access_token; try { localStorage.setItem(REFRESH_KEY, t.refresh_token); } catch {} }
function clearTokens() { accessToken = null; try { localStorage.removeItem(REFRESH_KEY); } catch {} }
export function isLoggedIn() { return !!getRefresh(); }

async function raw(path, { method = "GET", body, token } = {}) {
  return fetch(API_BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

export const Auth = {
  async signup(email, password, displayName) {
    const r = await raw("/api/auth/signup", { method: "POST", body: { email, password, display_name: displayName } });
    if (!r.ok) throw new Error((await r.json()).detail || "Signup failed");
    setTokens(await r.json());
  },
  async login(email, password) {
    const r = await raw("/api/auth/login", { method: "POST", body: { email, password } });
    if (!r.ok) throw new Error((await r.json()).detail || "Login failed");
    setTokens(await r.json());
  },
  async logout() {
    const rt = getRefresh();
    if (rt) await raw("/api/auth/logout", { method: "POST", body: { refresh_token: rt } });
    clearTokens();
  },
  // Refresh tokens ROTATE: the presented one is revoked as it is exchanged, so
  // two concurrent refreshes would race and the loser would kill a good session.
  // Collapse them onto a single in-flight promise.
  async ensureAccess() {
    if (accessToken) return accessToken;
    if (refreshing) return refreshing;
    const rt = getRefresh();
    if (!rt) throw new Error("not logged in");
    refreshing = (async () => {
      const r = await raw("/api/auth/refresh", { method: "POST", body: { refresh_token: rt } });
      if (!r.ok) { clearTokens(); throw new Error("session expired"); }
      setTokens(await r.json());
      return accessToken;
    })().finally(() => { refreshing = null; });
    return refreshing;
  },
};

async function apiFetch(path, opts = {}) {
  let token = await Auth.ensureAccess();
  let r = await raw(path, { ...opts, token });
  if (r.status === 401) { token = await Auth.ensureAccess(); r = await raw(path, { ...opts, token }); }
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

// ---------- IndexedDB cache ----------
const DB = "signaldesk-web", VER = 2;
function open() {
  return new Promise((res, rej) => {
    const q = indexedDB.open(DB, VER);
    q.onupgradeneeded = () => { const db = q.result;
      for (const s of ["items", "sessions"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "k" });
      // v2: cached link previews, keyed by the URL as the card holds it.
      if (!db.objectStoreNames.contains("previews")) db.createObjectStore("previews", { keyPath: "key" });
    };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
function done(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }

export const Store = {
  async all(store) { const db = await open(); return done(db.transaction(store).objectStore(store).getAll()); },
  async put(store, row) { const db = await open(); return done(db.transaction(store, "readwrite").objectStore(store).put(row)); },
  async get(store, id) { const db = await open(); return done(db.transaction(store).objectStore(store).get(id)); },
  async meta(k, d = null) { const db = await open(); const r = await done(db.transaction("meta").objectStore("meta").get(k)); return r ? r.v : d; },
  async setMeta(k, v) { const db = await open(); return done(db.transaction("meta", "readwrite").objectStore("meta").put({ k, v })); },
};

const ITEM_FIELDS = ["id","url","title","note","tags","bucket","topic","cadence_days","last_visited","shelf_days","added_at","archived_at","snoozed_until","deleted","updated_at"];
const SESSION_FIELDS = ["id","name","tabs","deleted","updated_at"];
const pick = (r, f) => Object.fromEntries(f.map((k) => [k, r[k] ?? (k === "tags" ? [] : null)]));

// ---------- local mutations (call these from the UI) ----------
export async function upsertItem(partial) {
  const now = new Date().toISOString();
  const existing = partial.id ? await Store.get("items", partial.id) : null;
  const row = { id: partial.id || crypto.randomUUID(), added_at: now, tags: [], note: "", title: "", url: null, bucket: "inbox", deleted: false,
    ...(existing || {}), ...partial, updated_at: now, _dirty: true };
  await Store.put("items", row); return row;
}
export const deleteItem = (id) => upsertItem({ id, deleted: true });
export async function upsertSession(partial) {
  const now = new Date().toISOString();
  const existing = partial.id ? await Store.get("sessions", partial.id) : null;
  const row = { id: partial.id || crypto.randomUUID(), name: "", tabs: [], deleted: false, ...(existing || {}), ...partial, updated_at: now, _dirty: true };
  await Store.put("sessions", row); return row;
}

// ---------- sync ----------
const at = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; };

async function applyRows(store, rows, fromPush) {
  for (const row of rows) {
    if (fromPush) {
      // Edited again locally while the push was in flight? Keep the newer local
      // copy dirty rather than clobbering it with our own echo.
      const local = await Store.get(store, row.id);
      if (local && local._dirty && at(local.updated_at) > at(row.updated_at)) continue;
    }
    await Store.put(store, { ...row, _dirty: false });
  }
}

async function applyServer(res, { fromPush = false } = {}) {
  await applyRows("items", res.items || [], fromPush);
  await applyRows("sessions", res.sessions || [], fromPush);
  // The cursor may ONLY advance from a pull. A push response contains just the
  // entities we sent, but its server_rev counts every write the server has
  // accepted — including other devices'. Adopting it as the cursor would skip
  // those revisions permanently: they would never be pulled again.
  if (!fromPush && typeof res.server_rev === "number") await Store.setMeta("since_rev", res.server_rev);
}

export async function syncNow() {
  if (!isLoggedIn()) return;
  const dirtyItems = (await Store.all("items")).filter((r) => r._dirty);
  const dirtySessions = (await Store.all("sessions")).filter((r) => r._dirty);
  if (dirtyItems.length || dirtySessions.length) {
    const res = await apiFetch("/api/sync", { method: "POST", body: { items: dirtyItems.map((r) => pick(r, ITEM_FIELDS)), sessions: dirtySessions.map((r) => pick(r, SESSION_FIELDS)) } });
    await applyServer(res, { fromPush: true });
  }
  const since = await Store.meta("since_rev", 0);
  await applyServer(await apiFetch(`/api/sync?since_rev=${since}`));
}

// Convenience for the UI: the non-deleted items/sessions to render.
export async function liveItems() { return (await Store.all("items")).filter((r) => !r.deleted); }
export async function liveSessions() { return (await Store.all("sessions")).filter((r) => !r.deleted); }

// ---------- link previews ----------
// Derived data, not entities: no id, no rev, no tombstone, never pushed. The
// server owns the fetching (app/preview.py) and its own long-lived cache; the
// browser just remembers what it has already been told so a re-render is free.
//
// Rows are keyed by the URL exactly as the item holds it, because that is what
// a card has in hand. The server echoes it back as `requested_url` alongside
// the normalized `url`, so two spellings of one page share a server fetch while
// each keeps its own local entry.
const PREVIEW_TTL = { ok: 7 * 86400000, error: 86400000 };

function previewFresh(row) {
  return row && Date.now() - (row._at || 0) < (PREVIEW_TTL[row.status] || PREVIEW_TTL.error);
}

// Everything still fresh, as a Map the UI can consult synchronously while it
// builds HTML. Stale rows are simply left out — they get re-asked on sight.
export async function loadPreviews() {
  const out = new Map();
  for (const row of await Store.all("previews")) if (previewFresh(row)) out.set(row.key, row);
  return out;
}

export async function fetchPreviews(urls) {
  if (!urls.length) return [];
  const res = await apiFetch("/api/preview", { method: "POST", body: { urls } });
  const rows = (res.previews || []).map((p) => ({ ...p, key: p.requested_url, _at: Date.now() }));
  for (const row of rows) await Store.put("previews", row);
  return rows;
}
