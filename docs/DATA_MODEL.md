# Data model

Postgres. Concrete SQLAlchemy in `backend/app/models.py`; the initial migration is `backend/migrations/versions/0001_init.py`.

## Tables

### `users`
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| email | varchar(320) unique | stored lowercased |
| password_hash | varchar(255) | bcrypt(sha256(pw)) |
| display_name | varchar(120) null | |
| **sync_rev** | bigint, default 0 | **per-user logical clock** — bumped once per accepted write |
| created_at | timestamptz | |

### `refresh_tokens`
Opaque refresh tokens, stored only as `token_hash` (sha256), rotated on use.
`id, user_id→users, token_hash unique, expires_at, revoked bool, created_at`.

### `items` (a saved link / idea)
| column | type | notes |
|---|---|---|
| id | uuid PK | **client-generated** |
| user_id | uuid → users | |
| url | text null | null allowed (books/ideas in Explore) |
| title, note | text | |
| tags | jsonb | array of strings |
| bucket | varchar(16) | `inbox·library·rounds·queue·explore·archive` |
| cadence_days | int null | Rounds |
| last_visited | timestamptz null | Rounds |
| shelf_days | int null | Read-later |
| added_at | timestamptz | |
| archived_at | timestamptz null | |
| snoozed_until | timestamptz null | |
| **deleted** | bool | tombstone |
| **rev** | bigint | `users.sync_rev` at last change; indexed with user_id |
| **updated_at** | timestamptz | drives last-write-wins |

Index: `(user_id, rev)` — makes "changed since rev N" a range scan.

### `tab_sessions` (a "Group" = saved set of tabs)
| column | type | notes |
|---|---|---|
| id | uuid PK | client-generated |
| user_id | uuid → users | |
| name | text | |
| tabs | jsonb | `[{url, title, groupTitle?, groupColor?}]` |
| deleted | bool | tombstone |
| rev | bigint | indexed with user_id |
| created_at, updated_at | timestamptz | |

## The three sync fields (every syncable row)
- **`rev`** — server-authoritative. The server increments `users.sync_rev` (under a row lock) once per accepted write and stamps it here. Clients pull `?since_rev=` and never set it.
- **`deleted`** — soft delete. Deletes must propagate, so they're tombstones, not row removals. (A later GC job may purge old tombstoned rows; clients that have caught up won't care.)
- **`updated_at`** — the conflict key. On push, the server keeps whichever copy has the greater `updated_at` (**last-write-wins**). Clients set it to "now" on every local edit.

## Notes for the implementer
- Add a `CHECK` or app-level validation for `bucket` values if you want; the app treats unknown buckets as non-mirrored.
- If you later add real collaboration, `items`/`tab_sessions` grow an owner/collection layer — but the current product is **per-user**, so `user_id` scoping everywhere is sufficient.
