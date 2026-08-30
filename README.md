# Signal Desk

A personal link + reading-list + tab-session manager that **syncs across your devices**. Three clients, one backend:

- **Web app** — open on any device, no install. Served by the backend at your domain.
- **Chrome extension** — quick-capture the current tab, save/restore **tab sessions** ("Groups"), and **two-way sync with your real Chrome bookmarks**.
- **Backend** — FastAPI + Postgres, deployed on **Render** via `render.yaml` (Blueprint).

Buckets: **Inbox · Library · Rounds · Read-later · Explore · Archive**. "Groups" = saved browser tab sessions.

---

## This repo is a build package

It's a **runnable backend**, a **working extension skeleton**, and a **precise spec**, designed to be finished by a coding agent (e.g. Claude Code) or by you. **Start with [`CLAUDE.md`](CLAUDE.md), then [`docs/ROADMAP.md`](docs/ROADMAP.md).**

### What already works (verified)
- **Backend**: signup / login / refresh (rotating tokens) + **rev-based delta sync** with **last-write-wins** and tombstones. Tested end-to-end against Postgres. `render.yaml` deploys it as-is (`alembic upgrade head` builds the schema on first boot).
- **Extension**: MV3 manifest + service worker + entity-sync engine + **two-way bookmark engine** (both directions + echo-suppression implemented; a few reconciliation edge cases are marked `TODO`) + popup + options. All JS passes `node --check`.
- **Web app**: live in `backend/app/static/`, served same-origin at `/`. Login/signup gate, IndexedDB cache for offline, a **Groups** (tab sessions) view, and every original bucket/review/playbook feature. Verified end-to-end in headless Chromium (`backend/tests/web_e2e.py`), two browser contexts on one account.
- **Link previews**: cards show the site's favicon, its description and its og:image, so you can tell what a link is at a glance and file it without opening it. The server does the scraping (`/api/preview`, SSRF-guarded, cached in Postgres) — your browser never phones the sites you saved. Fetched lazily as cards scroll into view; verified by `backend/tests/preview_e2e.py`.

### What's still to build
Wiring the extension to the deployed API (M4–M5), hardening the bookmark reconciliation edge cases (M6), a backend pytest suite, and Chrome Web Store packaging. See `docs/ROADMAP.md`.

---

## Layout
```
backend/       FastAPI app + Alembic migrations   (RUNS)
extension/     MV3 Chrome extension               (RUNS; finish bookmark edge cases)
web/           web app UI to wire to the API
docs/          architecture · data model · API · sync · auth · extension · deploy · roadmap
render.yaml    Render Blueprint (infra as code)
CLAUDE.md      instructions for the coding agent
```

## Local quickstart

Full, verified walkthrough — including creating the local database and running
the smoke test — is in [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md). The short version:

```bash
# 1. Local Postgres (one time)
sudo -u postgres psql -c "CREATE ROLE signaldesk LOGIN PASSWORD 'signaldesk';"
sudo -u postgres createdb -O signaldesk signaldesk

# 2. Backend
cd backend
cp .env.example .env          # then set SECRET_KEY
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000
# Web app + API at http://localhost:8000 ; health at /api/health
# Swagger at /docs (local only — ENABLE_DOCS defaults to off)

# 3. Verify
BASE=http://127.0.0.1:8000 python tests/manual_smoke.py   # -> SMOKE OK

# 4. Extension: chrome://extensions -> Developer mode -> Load unpacked -> extension/
#    Then open its Options, set API base = http://localhost:8000, and sign up.
```

## Deploy
Push to GitHub → Render → New + → **Blueprint** → pick the repo. Full steps, custom domain, and cost notes in [`docs/DEPLOY.md`](docs/DEPLOY.md).
