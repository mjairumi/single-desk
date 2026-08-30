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

### `link_previews` (derived — NOT a syncable entity)
Cached Open Graph / favicon metadata so cards can show what a link is. No
`user_id`, no `rev`, no tombstone: page metadata is public, so one fetch serves
every user and every device, and the table can be dropped at any time at the
cost of a re-fetch.

| column | type | notes |
|---|---|---|
| url_hash | varchar(64) PK | sha256 of the normalized URL (a URL is too long to index) |
| url | text | the normalized URL |
| status | varchar(16) | `ok` or `error` |
| title, description, image_url, icon_url, site_name | text | scraped; all nullable |
| embeddable | bool NULL | may the page be framed on another origin? **NULL = never determined** (a row cached before the column existed), which counts as stale so the row re-fetches rather than serving a guess |
| error | text | why the fetch failed, when `status='error'` |
| fetched_at | timestamptz | drives the refresh TTL (30 d ok / 1 d error) |

Written only by `POST /api/preview` (`app/routers/preview.py`); fetched by
`app/preview.py`. Never appears in a sync payload.

## The three sync fields (every syncable row)
- **`rev`** — server-authoritative. The server increments `users.sync_rev` (under a row lock) once per accepted write and stamps it here. Clients pull `?since_rev=` and never set it.
- **`deleted`** — soft delete. Deletes must propagate, so they're tombstones, not row removals. (A later GC job may purge old tombstoned rows; clients that have caught up won't care.)
- **`updated_at`** — the conflict key. On push, the server keeps whichever copy has the greater `updated_at` (**last-write-wins**). Clients set it to "now" on every local edit.

## Notes for the implementer
- Add a `CHECK` or app-level validation for `bucket` values if you want; the app treats unknown buckets as non-mirrored.
- If you later add real collaboration, `items`/`tab_sessions` grow an owner/collection layer — but the current product is **per-user**, so `user_id` scoping everywhere is sufficient.
