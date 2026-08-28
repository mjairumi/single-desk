# Web app

The web app is the Signal Desk UI you already have, wired to the API instead of `localStorage`, behind a login gate, with a **Sessions** ("Groups") view added.

## Files
- `legacy-localstorage-ui.html` — the current single-file UI (buckets, review, playbook, Explore). **This is your UI starting point.** It stores everything in `localStorage`.
- `api-client.js` — drop-in data layer: `Auth`, `Store` (IndexedDB), `upsertItem/deleteItem/upsertSession`, `syncNow()`, `liveItems()/liveSessions()`, `isLoggedIn()`.

## Adaptation steps (milestone M3)
1. **Serve it from the API.** Put the built web app in `backend/app/static/` (FastAPI already mounts that dir at `/`). Then the API base is same-origin — `api-client.js` defaults to `window.location.origin`.
2. **Add an auth gate.** Before rendering the app, `if (!isLoggedIn())` show a small login/signup screen that calls `Auth.login()/Auth.signup()`, then boot the app.
3. **Swap the data layer.** In the legacy UI, the state lives in `state.items` and is persisted by `load()`/`save()` against `localStorage`. Replace:
   - `load()` → read from the cache: `state.items = await liveItems()` (and `sessions = await liveSessions()`), after a `syncNow()`.
   - every mutation (`addItem`, `moveTo`, `snooze`, `remove`, edits) → call `upsertItem({...})` / `deleteItem(id)` from `api-client.js` instead of mutating the array + `save()`. Keep the same field names — they already match the API (bucket, tags, cadence_days→note the legacy UI uses `cadenceDays`; **rename to snake_case** or map in a thin adapter).
   - after each mutation, re-render from the store and let the periodic `syncNow()` push it.
4. **Periodic + reconnect sync.** `setInterval(syncNow, 60_000)`, plus `window.addEventListener("online", syncNow)` and a `syncNow()` on load.
5. **Sessions view.** Add a nav item "Groups". Render `liveSessions()` — each session shows its name + tab count and a list of links. "Restore":
   - if the extension is installed, message it (`chrome.runtime.sendMessage` to your extension id) to `restore-session`;
   - otherwise just render the links for the user to open. (A plain web page can't open a whole window of tabs.)

## Field mapping note
The legacy UI uses camelCase (`cadenceDays`, `lastVisited`, `shelfDays`, `addedAt`, `archivedAt`, `snoozedUntil`). The API/`api-client.js` use snake_case. Do the rename once (cleanest), or add a tiny `toApi()/fromApi()` adapter. Don't ship both spellings.

## Offline
`api-client.js` caches in IndexedDB and marks local edits `_dirty`; the app renders from the cache, so it works offline and syncs when back online. (The legacy localStorage file also still works fully offline as a no-account fallback if you ever want that mode.)
