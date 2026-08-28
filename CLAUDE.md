# Signal Desk — build guide for the coding agent

You are finishing a multi-device product. A lot already works; your job is to complete the remaining pieces **in order**, testing each before moving on. Read `docs/ROADMAP.md` first — it is the authoritative milestone list.

## Read these before coding, in this order
1. `docs/ARCHITECTURE.md` — the whole system on one page.
2. `docs/DATA_MODEL.md` — schema + the meaning of `rev`, `deleted`, `updated_at`.
3. `docs/SYNC.md` — the delta-sync protocol + last-write-wins rules. **Do not change the protocol** without updating clients and this doc together.
4. `docs/API.md` — the REST contract.
5. `docs/AUTH.md` — auth flows + token storage.
6. `docs/EXTENSION.md` — the two-way bookmark sync algorithm (the hard part).
7. `docs/DEPLOY.md` — Render + custom domain.

## Non-negotiable invariants
- **Sync is last-write-wins by `updated_at`.** The server bumps a per-user `rev` on every accepted write; clients pull `?since_rev=`. Never let a client set `rev`.
- **Tombstones, never hard deletes** for synced entities (`deleted = true`). Real row deletion is a separate, later GC job.
- **Client-generated UUIDs.** Entities are created offline with their final id; the server never renumbers.
- **The extension only ever touches the managed bookmark subtree** (`Other Bookmarks → Signal Desk`). Never create/edit/delete/move a bookmark outside it.
- **Each sensitive change is one operation** and the response's canonical rows win — clients overwrite local state from them.

## Conventions
- Backend: FastAPI, **synchronous** SQLAlchemy 2.0, path ops are plain `def` (threadpooled). Migrations via Alembic. Passwords via `bcrypt` (pre-hashed with sha256 — see `app/auth.py`). Don't reintroduce passlib.
- Keep the API and the client entity shapes in the **same snake_case fields** so sync payloads are 1:1 (`docs/API.md`).
- Extension is plain ES modules (`type: module`), no build step, no framework.

## Definition of done per milestone
Each milestone in `docs/ROADMAP.md` lists its acceptance check. A milestone is done when its check passes **and** you've added a test (backend: pytest hitting the app; extension: a manual test script in `docs/`).

## How to run / verify the backend
```bash
cd backend && pip install -r requirements.txt
export DATABASE_URL=... SECRET_KEY=... CORS_ORIGINS=...
alembic upgrade head
uvicorn app.main:app --reload
```
There is a known-good manual API test flow in `docs/SYNC.md` (§ "Verifying"). Reproduce it as `backend/tests/test_sync.py` with pytest + httpx.

## First tasks (M2–M3 in the roadmap)
1. Adapt the web app (`web/`) to the API: add the login/signup gate, replace localStorage with the `Store` + `SyncClient` in `web/api-client.js`, and add a **Sessions** ("Groups") view. Keep every existing bucket/review/playbook feature.
2. Write `backend/tests/` (auth + sync + LWW + tombstones).
Then proceed to the extension milestones (M4–M6). The bookmark engine (`extension/lib/bookmarks.js`) has `TODO` markers for the reconciliation edge cases described in `docs/EXTENSION.md`.
