# Roadmap / build order

Build in this order. Each milestone has an **acceptance check** — don't move on until it passes. ✅ = already done in this package.

## M0 — Deploy skeleton ✅
Backend boots on Render; `alembic upgrade head` builds schema; `/api/health` green.
**Check:** health endpoint returns `{"ok":true}` on the `onrender.com` URL.

## M1 — Auth ✅
signup / login / refresh (rotating) / logout / me.
**Check:** the auth steps in `docs/SYNC.md#verifying` pass.

## M2 — Entity sync (server) ✅
`GET/POST /api/sync`, per-user `rev`, last-write-wins, tombstones.
**Check:** the full sync flow in `docs/SYNC.md#verifying` passes. **Turn it into `backend/tests/test_sync.py` (pytest + httpx).**

## M3 — Web app on the API  ⟵ start here
Adapt `web/` from localStorage to the API: login/signup gate + `SyncClient` + IndexedDB cache (offline) + a **Sessions** ("Groups") view. Keep every existing bucket/review/playbook feature. Serve it from FastAPI (`backend/app/static/`) or as a Render Static Site.
**Check:** sign up on the web app; add/edit/delete items and a session; reload → state persists; open in a second browser signed into the same account → changes appear after sync.

## M4 — Extension: capture + auth + entity sync
Wire Options login, popup quick-capture, and the alarm sync loop (`sync.js`). No bookmarks yet.
**Check:** capture a tab in the extension → it appears in the web app (and vice-versa) within one sync interval.

## M5 — Tab sessions
Popup "Save this window as a session" + restore (`sessions.js`), list in web app.
**Check:** save a window with a couple of tab groups → restore in a fresh window recreates tabs (and groups, best-effort).

## M6 — Two-way bookmark sync (the hard one)
Build in sub-steps, testing each:
- **A** (SD → Chrome): `applyItemsToChrome` after sync creates/updates/moves/removes bookmarks in the managed subtree.
- **B** (Chrome → SD): the `on*` handlers create/update/move/tombstone items.
- **Loop prevention**: suppression + content-comparison (verify no echo storms).
- **Reconciliation**: `reconcileAll` on startup; resolve the `TODO` edge cases in `docs/EXTENSION.md`.
**Check:** create a bookmark in `Other Bookmarks/Signal Desk/Library` → item appears in web app; rename an item in the web app → the bookmark renames; move an item to Archive → its bookmark disappears; and none of this loops.

## M7 — Polish & ship
Rate-limiting + email verification (`docs/AUTH.md` backlog), backups, Chrome Web Store listing (privacy justification), custom domain, error surfaces, a settings/export screen.

---
### Suggested test scaffolding
- `backend/tests/` — pytest + httpx `TestClient`, a throwaway Postgres (or `testcontainers`), covering auth + sync + LWW + tombstones.
- `extension/` — a short manual test checklist per milestone (M4–M6) in `docs/`, since MV3 e2e is heavy; optionally Playwright with a loaded unpacked extension later.
