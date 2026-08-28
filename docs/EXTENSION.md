# Chrome extension

MV3. A service worker (`background.js`) runs the sync loop on an alarm, reacts to bookmark events, and answers popup/options messages. Code lives in `extension/lib/*`.

## Three jobs
1. **Quick-capture** — popup saves the current tab into a bucket (`capture-tab` message → `upsertItem` → sync).
2. **Tab sessions ("Groups")** — `sessions.js`: `captureCurrentWindow()` snapshots the window's tabs (preserving Chrome tab-group title/color via `chrome.tabGroups`); `restoreSession()` reopens them and best-effort re-creates the tab groups. Sessions sync like any entity. **Restore needs the extension**; on a device without it, the web app shows the session as a clickable link list.
3. **Two-way bookmark sync** — the rest of this doc.

## Two-way bookmark sync

### The managed subtree
We own exactly one bookmark folder: **`Other Bookmarks → Signal Desk`**, with one child folder per **mirrored bucket** (`inbox, library, rounds, queue, explore` — **Archive is not mirrored**; it's a hospice). Every Signal Desk item with a `url` in a mirrored bucket maps to exactly one bookmark node in the matching bucket folder. **Nothing outside this subtree is ever touched.**

### The id map (per device)
Bookmark ids differ per browser profile, so the item↔bookmark mapping is stored **locally** in IndexedDB (`bmap`: `itemId → {bookmarkId, hash}`, plus a `byBookmark` index). It is not synced.

### Direction A — Signal Desk → Chrome  (`applyItemsToChrome`)
Runs after every sync, for the items that changed:
- item is **mirrorable** (has url, not deleted, mirrored bucket) → ensure a bookmark exists in the right bucket folder with the right title/url; **create / update / move** as needed; record mapping.
- item is **not** mirrorable (deleted, no url, or moved to Archive) → **remove** its mapped bookmark (if any) and drop the mapping.

### Direction B — Chrome → Signal Desk  (`onBookmark{Created,Changed,Moved,Removed}`)
Wired to `chrome.bookmarks.on*`. Only events **inside the managed subtree** matter:
- **created** in a bucket folder → new item in that bucket.
- **changed** (title/url) → update the mapped item.
- **moved** between bucket folders → change the item's bucket. Moved **out** of the managed subtree → tombstone the item but **leave the bookmark** (the user still wants it in Chrome, just not managed). Moved **in** from elsewhere → adopt as a new item.
- **removed** → tombstone the mapped item.
Each handler returns `true` when it changed local state, so the worker triggers a debounced `syncNow()`.

### Loop prevention (critical)
Writing to `chrome.bookmarks` fires `on*` events — our own **echoes**. Two defenses, both in `bookmarks.js`:
1. **Suppression set** — before we create/update/move/remove, we add the bookmark id to a short-lived `_suppressed` set; handlers ignore suppressed ids. (Covers the common case while the worker is alive.)
2. **Content comparison against the local store** — a handler recomputes the resulting item state and, if it already equals what we hold, treats the event as a no-op. This survives service-worker restarts (where the in-memory suppression set is gone), so it's the durable defense.

### Reconciliation (`reconcileAll`)
Runs on install/startup and can be triggered from Options ("Rebuild bookmark mirror"). A full two-way diff to catch anything changed while the extension/browser was off:
- **A-side**: ensure every live item has a correct bookmark.
- **B-side**: walk each bucket folder; unmapped bookmark → adopt; mapped-but-changed → patch the item.

### Conflict resolution
Bookmarks have no "edited at". The extension **stamps `updated_at = now` when it observes a change**, so bookmark edits participate in the same **last-write-wins** as web/other-device edits.

### Edge cases marked `TODO` in `bookmarks.js`
- **Item live but its mapped bookmark vanished at startup** (user deleted a bookmark while the worker was down) → decide *tombstone item* vs *recreate bookmark* by comparing the item's `updated_at` to a stored `lastReconcileAt` (in `meta`). Current default adopts/keeps data (no silent loss) — pick the rule you want and store `lastReconcileAt`.
- **Bookmark created directly in the managed root** (not in a bucket folder) → currently ignored; decide whether to treat as Inbox.
- **Duplicate URLs** across buckets — allowed (they're different items); make sure adopt/patch keys on bookmark **id**, not url (it does).
- **Burst imports** (user imports 500 bookmarks into a bucket folder) — handlers already debounce the resulting sync; consider a bulk path if it's slow.

## Permissions & Web Store review
`bookmarks`, `tabs`, `tabGroups`, `storage`, `alarms`, plus `host_permissions` for your API domain. `bookmarks` + `tabs` are "sensitive" — the Chrome Web Store listing will need a clear privacy justification ("read/write your bookmarks to sync them with your Signal Desk account"; "read tab URLs to save sessions"). You can dev-test unpacked without review.

## Getting the extension id (for CORS)
Load unpacked (`chrome://extensions` → Developer mode → Load unpacked → `extension/`). Copy the **ID** shown on the card (also displayed in Options). Add `chrome-extension://<that-id>` to the server's `CORS_ORIGINS`.
