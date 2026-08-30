// Entity sync: push local dirty rows, pull changes since the cursor, converge.
// Local rows are stored in the SAME snake_case shape the API uses, plus a
// transient `_dirty` flag. See docs/SYNC.md.
import { apiFetch, isLoggedIn } from "./api.js";
import { getAll, put, get, getMeta, setMeta } from "./store.js";

const ITEM_FIELDS = ["id","url","title","note","tags","bucket","topic","cadence_days","last_visited",
  "shelf_days","added_at","archived_at","snoozed_until","deleted","updated_at"];
const SESSION_FIELDS = ["id","name","tabs","deleted","updated_at"];

const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, row[f] ?? (f === "tags" ? [] : null)]));
const at = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; };

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

/**
 * Write server rows into the local store.
 *
 * `fromPush` marks the echo of our own push. Two rules differ there:
 *  - the cursor is NOT advanced (see syncNow), and
 *  - a row edited locally *while the push was in flight* keeps its local copy
 *    and stays dirty, so the newer edit isn't clobbered by our own echo.
 */
async function applyRows(store, rows, { fromPush }) {
  const changed = [];
  for (const row of rows) {
    if (fromPush) {
      const local = await get(store, row.id);
      if (local && local._dirty && at(local.updated_at) > at(row.updated_at)) continue;
    }
    await put(store, { ...row, _dirty: false });
    changed.push(row);
  }
  return changed;
}

async function applyServer(res, { fromPush = false } = {}) {
  const changedItems = await applyRows("items", res.items || [], { fromPush });
  const changedSessions = await applyRows("sessions", res.sessions || [], { fromPush });
  // The cursor may ONLY be advanced from a pull. A push response carries just
  // the entities we sent, but its server_rev reflects every write the server has
  // accepted — including other devices'. Taking it as the cursor would skip
  // straight past those revisions and they would never be pulled again.
  if (!fromPush && typeof res.server_rev === "number") await setMeta("since_rev", res.server_rev);
  return { changedItems, changedSessions };
}

// Returns { ok, error, changedItems, changedSessions }. Never throws to the
// caller loop — the UI reads `ok` to tell "synced" from "saved locally".
export async function syncNow() {
  const out = { ok: false, error: null, changedItems: [], changedSessions: [] };
  if (!(await isLoggedIn())) { out.error = "not logged in"; return out; }
  try {
    const dirtyItems = (await getAll("items")).filter((r) => r._dirty);
    const dirtySessions = (await getAll("sessions")).filter((r) => r._dirty);
    if (dirtyItems.length || dirtySessions.length) {
      const res = await apiFetch("/api/sync", {
        method: "POST",
        body: {
          items: dirtyItems.map((r) => pick(r, ITEM_FIELDS)),
          sessions: dirtySessions.map((r) => pick(r, SESSION_FIELDS)),
        },
      });
      const c = await applyServer(res, { fromPush: true });
      out.changedItems.push(...c.changedItems);
      out.changedSessions.push(...c.changedSessions);
    }
    const since = await getMeta("since_rev", 0);
    const res = await apiFetch(`/api/sync?since_rev=${since}`);
    const c = await applyServer(res);
    out.changedItems.push(...c.changedItems);
    out.changedSessions.push(...c.changedSessions);
    out.ok = true;
    await setMeta("last_sync_at", new Date().toISOString());
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    console.warn("[signal-desk] sync failed:", out.error);
  }
  return out;
}
