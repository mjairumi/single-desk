# Running Signal Desk locally

Every command below was run green on a clean Ubuntu/WSL2 box with Python 3.12 and
PostgreSQL 18. Start at step 1; the whole thing takes about five minutes.

**Environments at a glance**

| | Database | Config file | Tracked by git? |
|---|---|---|---|
| Local dev | local PostgreSQL | `backend/.env` | no |
| Production | Neon | `backend/.env.production` (+ host env vars) | no |

---

## 1. Prerequisites

```bash
python3 --version     # 3.11+
psql --version        # any modern PostgreSQL client
sudo systemctl is-active postgresql    # should print: active
```

If PostgreSQL isn't installed:

```bash
sudo apt update && sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

## 2. Create the local database

One-time. Creates a `signaldesk` role that owns a `signaldesk` database.

```bash
sudo -u postgres psql -c "CREATE ROLE signaldesk LOGIN PASSWORD 'signaldesk';"
sudo -u postgres createdb -O signaldesk signaldesk
```

Verify:

```bash
PGPASSWORD=signaldesk psql -h localhost -U signaldesk -d signaldesk -c "SELECT current_database();"
```

> The password is deliberately trivial — this database only ever listens on
> localhost and holds throwaway dev data.

## 3. Configure the environment

`backend/.env` is **not** in git (see `/.gitignore`), so it won't exist after a
fresh clone. Create it from the template and fill in a secret:

```bash
cd backend
cp .env.example .env
python3 -c "import secrets; print('SECRET_KEY=\"' + secrets.token_urlsafe(48) + '\"')"   # paste into .env
```

A working local `.env`:

```ini
DATABASE_URL="postgresql://signaldesk:signaldesk@localhost:5432/signaldesk"
SECRET_KEY="<48-byte random string>"
ACCESS_TOKEN_TTL_MIN="15"
REFRESH_TOKEN_TTL_DAYS="30"
CORS_ORIGINS="http://localhost:8000,http://127.0.0.1:8000"
```

Notes:

- **Quote the values.** `DATABASE_URL` can contain `&` (Neon does), and an
  unquoted `&` makes `set -a && . ./.env` background half the line and silently
  fall back to a different database.
- You don't need to export anything by hand — `app/config.py` reads `.env` from
  the current working directory, so run everything from `backend/`.
- The web app is served by FastAPI at the same origin, so it needs no CORS
  entry. Add `chrome-extension://<id>` once you load the extension unpacked.

## 4. Install dependencies

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 5. Build the schema

```bash
alembic upgrade head
```

Expected tail:

```
INFO  [alembic.runtime.migration] Running upgrade  -> 0001_init, initial schema
```

Confirm five tables (`users`, `refresh_tokens`, `items`, `tab_sessions`,
`alembic_version`):

```bash
PGPASSWORD=signaldesk psql -h localhost -U signaldesk -d signaldesk -c "\dt"
```

## 6. Run the API

```bash
uvicorn app.main:app --reload --port 8000
```

- Health: <http://localhost:8000/api/health> → `{"ok":true}`
- Swagger: <http://localhost:8000/docs> — only because `backend/.env` sets
  `ENABLE_DOCS="true"`. The code default is **off**, so a deployment never
  publishes `/docs`, `/redoc`, or `/openapi.json` unless someone opts in.

## 7. Verify end to end

With the server running, in a second terminal:

```bash
cd backend && source .venv/bin/activate
BASE=http://127.0.0.1:8000 python tests/manual_smoke.py
```

Prints `SMOKE OK`. It exercises the whole contract from `docs/SYNC.md`: signup,
duplicate-signup `409`, bad-password `401`, push/pull sync, last-write-wins in
both directions, tombstones, refresh-token rotation, and unauthenticated
rejection.

---

## The web app

Open <http://localhost:8000> — it's served from `backend/app/static/`, mounted
at `/` as a catch-all, same-origin with the API. Sign up on the gate and the
desk is yours; it syncs to any other browser or device signed into the same
account.

To drive the whole thing in a real browser (signup, add/edit/delete, reload
persistence, and two contexts on one account converging):

```bash
cd backend && source .venv/bin/activate
pip install playwright && playwright install chromium
python tests/web_e2e.py          # with the server running -> ALL M3 CHECKS PASSED
python tests/preview_e2e.py      # link previews -> ALL PREVIEW CHECKS PASSED
```

They sign up throwaway `web+<random>@example.com` / `pv+<random>@example.com`
accounts, so point them at a local server, never production. `preview_e2e.py`
additionally needs **outbound network access** — it previews real public pages,
because the point is scraping real-world markup.

## The extension

```
chrome://extensions → Developer mode → Load unpacked → select extension/
```

Then open its Options page:

1. Set **API base** to `http://localhost:8000`.
2. Copy the **extension id** shown there, add `chrome-extension://<id>` to
   `CORS_ORIGINS` in `backend/.env`, and restart uvicorn.
3. Sign up / log in from the Options page.

`extension/lib/config.js` defaults `apiBase` to a placeholder domain — the
Options page value overrides it, so you don't need to edit the source.

---

## Production (Neon)

The deployed service should read its configuration from the **host's**
environment (e.g. Render → Environment), not from a file in the repo.
`backend/.env.production` exists only so you can run migrations against Neon
from your laptop; like `.env` it is untracked.

Apply migrations to Neon:

```bash
cd backend && source .venv/bin/activate
set -a && . ./.env.production && set +a
alembic upgrade head
```

Sanity-check which database you're actually pointed at before migrating:

```bash
python -c "from app.config import Settings; u=Settings().database_url; print(u.split('@')[1])"
```

Two things to keep in mind:

- **`render.yaml` has no `databases:` block** — Neon is the database. Its
  `DATABASE_URL` is declared `sync: false`, so Render prompts for the value on
  first apply and stores it as a secret rather than keeping it in the repo.
- Neon's connection string carries `?sslmode=require&channel_binding=require`.
  `app/config.py` only rewrites the scheme prefix, so those query parameters
  survive into the psycopg driver untouched.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `role "signaldesk" does not exist` | Step 2 didn't run, or ran against a different cluster. |
| `password authentication failed` | Role exists without the password — re-run the `CREATE ROLE` line as `ALTER ROLE signaldesk PASSWORD 'signaldesk';`. |
| Connected to the wrong database | An unquoted `&` in `DATABASE_URL`, or a stale `DATABASE_URL` exported in your shell — real env vars win over `.env`. `unset DATABASE_URL` and retry. |
| `Target database is not up to date` | Run `alembic upgrade head`. |
| `401` on every `/api/*` call | Access tokens last 15 minutes; the clients refresh automatically, but a stale manual token won't. |
