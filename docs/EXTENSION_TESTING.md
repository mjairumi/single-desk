# Extension — manual test checklist

MV3 end-to-end automation is heavy (a real browser profile, an unpacked
extension, a service worker), so each extension milestone gets a scripted manual
pass instead. Work top to bottom; every step states what you should see.

Entity sync itself is covered automatically — `backend/tests/web_e2e.py`
exercises the same `applyServer` / cursor logic through the web client.

---

## Setup (once)

1. **Run a server.** Local (`docs/LOCAL_SETUP.md`) or your deployed URL.
2. **Load the extension.** `chrome://extensions` → **Developer mode** →
   **Load unpacked** → select `extension/`.
3. **Copy the extension id** from the card (also shown in Options).
4. **Allow it through CORS.** Add `chrome-extension://<id>` to `CORS_ORIGINS`
   on the server and restart it.
   - Locally: edit `backend/.env`, restart uvicorn.
   - Render: **Environment** → edit `CORS_ORIGINS` → Save (auto-restarts).
5. **Point the extension at the server.** Extension **Options** → *API base* →
   e.g. `http://localhost:8000` or `https://signal-desk.darkrumi.in` → **Save**.

> Skipping step 4 is the single most common failure. The extension now reports it
> in plain language — "Can't reach … CORS_ORIGINS … chrome-extension://\<id\>" —
> rather than a bare `Failed to fetch`.

---

## M4 — capture + auth + entity sync

### 4.1 Sign up / log in
- Options → **Sign up** tab → email + password (≥ 8 chars) → **Create account**.
- ✅ Status reads `Signed in ✓` and the card switches to *Signed in as \<email\>*.
- ❌ If you get the "Can't reach …" message, revisit setup steps 4 and 5.

### 4.2 Wrong password is reported honestly
- Log out, then log in with a deliberately wrong password.
- ✅ Status shows **Invalid email or password** (the server's message), not a
  generic failure.

### 4.3 Quick-capture a tab
- Navigate to any page → click the toolbar icon → pick a bucket → **Save**.
- ✅ Status reads `Saved ✓ synced`.
- ✅ Open the web app, sign in with the **same account** → the link is in that
  bucket (within one sync interval; hit **Sync now** to skip the wait).

### 4.4 Capture while offline degrades honestly
- Stop the server (or go offline) → capture another tab.
- ✅ Status reads `Saved ✓ saved locally — …`, **not** a plain tick. The item is
  in IndexedDB, unsent.
- Start the server → popup → **Sync now**.
- ✅ `Synced ✓ …`, and the item appears in the web app.

### 4.5 Web → extension direction
- In the web app, add a link and change another item's title.
- Extension popup → **Sync now**.
- ✅ Status reports the number of changes pulled.
- Capture one more tab, then check the web app.
- ✅ Both devices agree — no item lost in either direction.

### 4.6 The push+pull cursor case (this used to lose data)
This is the regression that `backend/tests/web_e2e.py` also guards.
- In the **web app**, add two items and let them sync.
- Do **not** sync the extension yet.
- In the **extension**, capture a tab (this creates a local dirty row) and let
  its sync run — one cycle that both pushes and pulls.
- ✅ The extension's next sync shows the web app's two items as well; the web app
  shows the captured tab. Nothing is stranded on either side.

### 4.7 Session survives a service-worker restart
- `chrome://extensions` → the card → **service worker** → *Terminate*.
- Click the toolbar icon and capture a tab.
- ✅ Still signed in, capture succeeds (tokens live in `chrome.storage.local`,
  not in worker memory).

### 4.8 The alarm loop runs unattended
- Add an item in the web app. Don't touch the extension.
- Wait one sync interval (default 2 minutes).
- ✅ Open the popup → **Sync now** reports *up to date*, because the alarm
  already pulled it.

---

## M5 — tab sessions

### 5.1 Save a window
- Open a window with several tabs; put two of them in a Chrome tab group with a
  title and colour.
- Popup → **Save this window as a session**.
- ✅ Status reads `Saved N tabs ✓ synced`.
- ✅ Web app → **Groups** → the session is listed with its tab count and links.

### 5.2 Restore
- Popup/extension restore path → the session reopens in a new window.
- ✅ Tabs return in order; the grouped ones are regrouped with their title and
  colour (best effort — Chrome may not restore colours exactly).

### 5.3 Rename / delete propagates
- Web app → **Groups** → rename a session, then reload another signed-in browser.
- ✅ The new name appears. Delete it → it disappears on both.

---

## M6 — two-way bookmark sync

> **Bookmark mirroring ships OFF.** Options → *Mirror items to Chrome bookmarks*.
> The engine's create path can still race its own `onCreated` echo and adopt a
> bookmark it just made as a second item, so it stays opt-in until the
> reconciliation `TODO`s in `extension/lib/bookmarks.js` are resolved. Capture,
> sessions and sync do not depend on it.

Once you enable it, reload the extension and work through:

### 6.1 Signal Desk → Chrome
- Add an item to Library in the web app → sync the extension.
- ✅ A bookmark appears in `Other Bookmarks → Signal Desk → Library`.
- Rename the item in the web app → sync.
- ✅ The bookmark is renamed, not duplicated.
- Move the item to Archive → sync.
- ✅ The bookmark disappears (Archive is deliberately not mirrored).

### 6.2 Chrome → Signal Desk
- Create a bookmark by hand in `Signal Desk → Library`.
- ✅ Within one sync interval the item shows up in the web app's Library.
- Rename that bookmark → ✅ the item's title follows.
- Move it to `Signal Desk → Rounds` → ✅ the item's bucket becomes Rounds.
- Delete it → ✅ the item is tombstoned and vanishes from the web app.

### 6.3 No echo storms
- With the service worker console open, make one change on each side.
- ✅ Each produces **one** sync, not a repeating cycle. A loop here means the
  suppression window or the content comparison is not catching our own echo.

### 6.4 Moved out of the managed subtree
- Drag a managed bookmark to a folder outside `Signal Desk`.
- ✅ The item is tombstoned, and **the bookmark itself is left alone** — the user
  still wants it in Chrome, just not managed.

### 6.5 Offline reconciliation
- Quit Chrome. Nothing to do here but confirm the next launch behaves: on
  startup `reconcileAll()` runs.
- ✅ Items and bookmarks match again, with no duplicates.

---

## Reporting a failure

Include: which step, what the popup/Options status said, and the service-worker
console output (`chrome://extensions` → the card → **service worker**). The
worker logs sync failures as `[signal-desk] sync failed: …`.
