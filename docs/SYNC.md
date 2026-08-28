# Sync protocol

The goal: any number of devices converge to the same state, work offline, and never silently lose an edit. The mechanism is deliberately simple — a **per-user revision clock** + **last-write-wins** + **tombstones**.

## The clock
Each user row has `sync_rev` (bigint). On every accepted write the server does, inside one transaction with the user row **locked** (`SELECT … FOR UPDATE`):
```
user.sync_rev += 1
entity.rev = user.sync_rev
```
So `rev` is a strictly increasing, per-user version stamp. It is **not** a wall clock (immune to device clock skew) and gives clients a clean cursor.

## Pull
`GET /api/sync?since_rev=N` → all entities with `rev > N`, tombstones included, ordered by `rev`, plus `server_rev`. The client applies them and sets its cursor to `server_rev`. First run: `N = 0`.

## Push + conflict resolution
`POST /api/sync` with the full entities. For each incoming row the server:
1. loads the existing row by `id` (scoped to the user);
2. **last-write-wins**: if `incoming.updated_at <= existing.updated_at`, the server keeps its copy (no rev bump) and returns it — the client will overwrite its stale local copy from the response;
3. otherwise it writes the incoming fields, bumps `rev`, and returns the canonical row.

New rows (no existing) are inserted with a fresh `rev`. Deletes are just an update with `deleted = true`.

Because ids are **client-generated UUIDs**, a device can create entities offline and they keep their identity when they finally push.

## Client responsibilities
- Store rows locally (IndexedDB) in the same shape the API uses, plus a transient `_dirty` flag.
- On any local edit: set `updated_at = now`, `_dirty = true`.
- Sync loop: **push** dirty rows → apply the returned canonical rows (clearing `_dirty`) → **pull** `?since_rev=cursor` → apply → advance cursor. Run on an interval, debounced after edits, and on reconnect.
- Treat a returned row with a newer `updated_at` than your local edit as "you lost the conflict" — take the server's version. (Optionally surface a toast; conflicts are rare for a single user across their own devices.)

## Edge cases & choices
- **Equal `updated_at`** → server wins (`<=`). Ties are near-impossible across devices; deterministic tie-break avoids flapping.
- **Clock skew** between devices can misorder LWW. For a single-user product this is acceptable; if you want to harden it, add a server-side `updated_at = max(incoming, now)` clamp, or switch the conflict key to a hybrid logical clock. Documented as a known limitation.
- **Tombstone GC**: tombstones live forever today. A later job may delete tombstoned rows older than, say, 90 days; only clients that never synced in that window would miss the delete (rare; they'd re-pull from 0 after cache loss anyway).
- **Batch size**: pull returns everything changed. For a personal dataset that's fine; add keyset pagination on `rev` if a user ever has tens of thousands of changes.

## Verifying (reproduce as `backend/tests/test_sync.py`)
This exact flow was run green against Postgres:
1. `signup` → tokens; duplicate signup → `409`; `me` → `200`; wrong password → `401`.
2. `POST /api/sync` two items (one with `url:null`) + one session → `server_rev` advances, echoes canonical rows.
3. `GET /api/sync?since_rev=0` → returns all; `GET ?since_rev=<latest>` → empty.
4. Push an **older** edit to an item → server keeps the newer title (LWW, server wins).
5. Push a **newer** edit → new title/bucket win.
6. Tombstone an item (`deleted:true`) → appears in a `since_rev=0` pull.
7. `refresh` → new pair; reusing the old refresh token → `401`.
8. Any `/api/sync` without a token → rejected (401/403).
