# Deploy on Render (Blueprint) + custom domain

The whole backend + database is declared in `render.yaml`. One repo, one click.

## 1. Push to Git
Put this repo on GitHub/GitLab/Bitbucket.

## 2. Create the Blueprint
Render Dashboard → **New +** → **Blueprint** → pick the repo → **Apply**. Render reads `render.yaml` and creates:
- **`signal-desk-api`** — the FastAPI web service. On boot it runs `alembic upgrade head` (builds the schema from `0001_init`) then starts Gunicorn/Uvicorn. `SECRET_KEY` is generated automatically.

The **database is Neon**, provisioned outside Render, so `render.yaml` has no
`databases:` block. `DATABASE_URL` is declared `sync: false`, which makes Render
prompt you for it on first apply and store it as a secret — the connection
string is never written into the repo. Paste the pooled URI from the Neon
console (**Connect → Connection string**); keep `?sslmode=require`.

Watch the deploy log; when `GET /api/health` returns `{"ok":true}` you're live at `https://signal-desk-api.onrender.com`.

## 3. Set CORS for the extension
1. Load the extension unpacked and copy its **id** (Options page shows it).
2. In Render → the web service → **Environment** → edit `CORS_ORIGINS` to include your web origin(s) and `chrome-extension://<id>`. Save (triggers a restart; no code redeploy needed).

## 4. Custom domain (your domain)
Render → the web service → **Settings → Custom Domains** → add `app.your-domain.com` (or the apex). Render shows the DNS record to create at your registrar:
- subdomain → a **CNAME** to the `onrender.com` host;
- apex/root → Render's **ANAME/ALIAS** or A records (follow what Render displays).
TLS is issued automatically once DNS resolves. Then set `CORS_ORIGINS` to include `https://app.your-domain.com`, and point the extension's **API base** (Options) at it.

## 5. Migrations later
Add a model change → `alembic revision --autogenerate -m "…"` (locally, against a dev DB) → commit the new file under `backend/migrations/versions/`. On deploy it runs automatically (start command on free; move to `preDeployCommand: alembic upgrade head` on a paid plan for cleaner startup).

## Cost & durability (read before relying on it)
- **Free Postgres on Render is deleted ~30 days after creation**, and **free web services spin down when idle** (cold starts). Fine for trying it; **not** for real use.
- For real use: set the database to a paid plan (e.g. `basic-256mb`) and the web service to at least `starter` in `render.yaml`, then re-apply. **Confirm current plan names + prices at https://render.com/pricing** — they change.
- Back up: the app has no built-in export yet; use `pg_dump` (Render gives you the external connection string) on a schedule, or add an export endpoint.

## Local dev
```bash
# Postgres via Docker (or any local instance)
docker run -d --name sd-pg -e POSTGRES_USER=signaldesk -e POSTGRES_PASSWORD=signaldesk \
  -e POSTGRES_DB=signaldesk -p 5432:5432 postgres:16

cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL="postgresql://signaldesk:signaldesk@localhost:5432/signaldesk"
export SECRET_KEY="dev-secret" CORS_ORIGINS="http://localhost:8000,chrome-extension://<id>"
alembic upgrade head
uvicorn app.main:app --reload --port 8000   # /docs for Swagger
```
