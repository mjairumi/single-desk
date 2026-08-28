// Entity sync: push local dirty rows, pull changes since the cursor, converge.
// Local rows are stored in the SAME snake_case shape the API uses, plus a
// transient `_dirty` flag. See docs/SYNC.md.
import { apiFetch, isLoggedIn } from "./api.js";
import { getAll, put, get, getMeta, setMeta } from "./store.js";

const ITEM_FIELDS = ["id","url","title","note","tags","bucket","cadence_days","last_visited",
  "shelf_days","added_at","archived_at","snoozed_until","deleted","updated_at"];
const SESSION_FIELDS = ["id","name","tabs","deleted","updated_at"];

const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, row[f] ?? (f === "tags" ? [] : null)]));

export async function upsertItem(partial) {
  const now = new Date().toISOString();
  const existing = partial.id ? await get("items", partial.id) : null;
  const row = {
    id: partial.id || crypto.randomUUID(),
    added_at: now, tags: [], note: "", title: "", url: null, bucket: "inbox", deleted: false,
    ...(existing || {}), ...partial,
    updated_at: now, _dirty: true,
  };
  await put("items", row);
  return row;
}
export async function deleteItem(id) { return upsertItem({ id, deleted: true }); }

export async function upsertSession(partial) {
  const now = new Date().toISOString();
  const existing = partial.id ? await get("sessions", partial.id) : null;
  const row = { id: partial.id || crypto.randomUUID(), name: "", tabs: [], deleted: false,
    ...(existing || {}), ...partial, updated_at: now, _dirty: true };
  await put("sessions", row);
  return row;
}

async function applyServer(res) {
  const changedItems = [], changedSessions = [];
  for (const it of res.items || []) { await put("items", { ...it, _dirty: false }); changedItems.push(it); }
  for (const s of res.sessions || []) { await put("sessions", { ...s, _dirty: false }); changedSessions.push(s); }
  if (typeof res.server_rev === "number") await setMeta("since_rev", res.server_rev);
  return { changedItems, changedSessions };
}

// Returns the items/sessions that changed as a result of this sync (from the
// server), so the caller can reconcile Chrome bookmarks. Never throws to the
// caller loop — logs and moves on.
export async function syncNow() {
  if (!(await isLoggedIn())) return { changedItems: [], changedSessions: [] };
  let changed = { changedItems: [], changedSessions: [] };
  try {
    const dirtyItems = (await getAll("items")).filter((r) => r._dirty);
    const dirtySessions = (await getAll("sessions")).filter((r) => r._dirty);
    if (dirtyItems.length || dirtySessions.length) {
      const res = await apiFetch("/api/sync", {
        method: "POST",
        body: { items: dirtyItems.map((r) => pick(r, ITEM_FIELDS)), sessions: dirtySessions.map((r) => pick(r, SESSION_FIELDS)) },
      });
      const c = await applyServer(res);
      changed.changedItems.push(...c.changedItems);
      changed.changedSessions.push(...c.changedSessions);
    }
    const since = await getMeta("since_rev", 0);
    const res = await apiFetch(`/api/sync?since_rev=${since}`);
    const c = await applyServer(res);
    changed.changedItems.push(...c.changedItems);
    changed.changedSessions.push(...c.changedSessions);
  } catch (e) {
    console.warn("[signal-desk] sync failed:", e.message);
  }
  return changed;
}
