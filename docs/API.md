# API contract

Base: `https://<your-domain>` (web app is same-origin; extension is cross-origin, allow-listed via `CORS_ORIGINS`). All bodies are JSON. Auth is `Authorization: Bearer <access_token>`. Interactive docs (`/docs`, `/redoc`, `/openapi.json`) are **disabled unless `ENABLE_DOCS` is set** — production leaves them off so the API surface isn't published; enable them locally via `backend/.env`.

Timestamps are ISO-8601 with timezone (e.g. `2026-08-28T16:45:35.065485+00:00`).

## Health
`GET /api/health` → `{ "ok": true }`

## Auth
See `docs/AUTH.md` for the flows.

### `POST /api/auth/signup`
```json
{ "email": "you@example.com", "password": "≥8 chars", "display_name": "optional" }
```
→ `200` `{ "access_token": "...", "refresh_token": "...", "token_type": "bearer" }`
→ `409` if the email exists.

### `POST /api/auth/login`
```json
{ "email": "you@example.com", "password": "..." }
```
→ `200` token pair · `401` on bad credentials.

### `POST /api/auth/refresh`
```json
{ "refresh_token": "..." }
```
→ `200` a **new** token pair. The presented refresh token is revoked (rotation); reusing it → `401`.

### `POST /api/auth/logout`  `{ "refresh_token": "..." }` → `204`
### `GET /api/auth/me` → `{ "id", "email", "display_name" }`

## Sync
Both items and tab-sessions travel through these two calls.

### `GET /api/sync?since_rev=N`
Returns every entity for the user with `rev > N`, **including tombstones** (`deleted:true`), rev-ordered, plus the current clock.
```json
{
  "items": [ { "id":"...", "url":"https://…", "title":"…", "note":"", "tags":["x"],
    "bucket":"library", "cadence_days":null, "last_visited":null, "shelf_days":null,
    "added_at":"…", "archived_at":null, "snoozed_until":null,
    "deleted":false, "updated_at":"…", "rev": 7 } ],
  "sessions": [ { "id":"...", "name":"Research", "tabs":[{"url":"…","title":"…"}],
    "deleted":false, "updated_at":"…", "rev": 8 } ],
  "server_rev": 8
}
```
First sync uses `since_rev=0`.

### `POST /api/sync`
Push local changes. Send the **full** entity (the server reads `updated_at` for last-write-wins). `rev` is ignored on input.
```json
{
  "items": [ { "id":"<uuid>", "url":"https://…", "title":"…", "tags":[],
    "bucket":"inbox", "added_at":"…", "updated_at":"…", "deleted":false } ],
  "sessions": [ { "id":"<uuid>", "name":"…", "tabs":[…], "updated_at":"…" } ]
}
```
→ Returns the **canonical** version of every entity in the request (accepted writes get a new `rev`; conflicts come back as the server-wins row so the client can reconcile), plus the new `server_rev`:
```json
{ "items":[ {…, "rev": 9} ], "sessions":[], "server_rev": 9 }
```

### Client loop (both web + extension)
```
push dirty rows → apply returned canonical rows (clear _dirty)
pull ?since_rev=<cursor> → apply, set cursor = server_rev
```
Run on an interval, on local change (debounced), and on reconnect.

## Errors
Standard HTTP codes; body `{ "detail": "…" }`. `401` on missing/expired access token (client should refresh once and retry — the extension's `api.js` does this automatically).
