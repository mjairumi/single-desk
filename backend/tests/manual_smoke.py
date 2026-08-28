"""Proven end-to-end smoke test of the running API.

This is the exact flow from docs/SYNC.md#verifying — it was run green against
Postgres while building this repo. Convert it into pytest (backend/tests/
test_sync.py) per docs/ROADMAP.md M2, or run it as-is:

    # terminal 1: a Postgres + the API
    export DATABASE_URL=postgresql://signaldesk@localhost:5432/signaldesk
    export SECRET_KEY=dev-secret CORS_ORIGINS=http://localhost:8000
    alembic upgrade head
    uvicorn app.main:app --port 8000
    # terminal 2:
    BASE=http://localhost:8000 python tests/manual_smoke.py
"""
import datetime as dt
import json
import os
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("BASE", "http://127.0.0.1:8000")


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def iso(t):
    return t.astimezone(dt.timezone.utc).isoformat()


def main():
    email = f"smoke+{uuid.uuid4().hex[:8]}@example.com"
    s, r = call("POST", "/api/auth/signup", {"email": email, "password": "supersecret1", "display_name": "Smoke"})
    assert s == 200, (s, r)
    tok, refresh = r["access_token"], r["refresh_token"]

    assert call("POST", "/api/auth/signup", {"email": email, "password": "supersecret1"})[0] == 409
    assert call("GET", "/api/auth/me", token=tok)[0] == 200
    assert call("POST", "/api/auth/login", {"email": email, "password": "nope"})[0] == 401

    now = dt.datetime.now(dt.timezone.utc)
    id1, id2, sid = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    push = {"items": [
        {"id": id1, "url": "https://a.com", "title": "A", "bucket": "library", "tags": ["x"], "added_at": iso(now), "updated_at": iso(now)},
        {"id": id2, "url": None, "title": "A book", "bucket": "explore", "tags": ["book"], "added_at": iso(now), "updated_at": iso(now)},
    ], "sessions": [
        {"id": sid, "name": "Research", "tabs": [{"url": "https://a.com", "title": "A"}], "updated_at": iso(now)},
    ]}
    s, r = call("POST", "/api/sync", push, token=tok); assert s == 200, (s, r)
    latest = r["server_rev"]

    assert len(call("GET", "/api/sync?since_rev=0", token=tok)[1]["items"]) == 2
    assert len(call("GET", f"/api/sync?since_rev={latest}", token=tok)[1]["items"]) == 0

    older = now - dt.timedelta(minutes=5)
    r = call("POST", "/api/sync", {"items": [{"id": id1, "url": "https://a.com", "title": "STALE", "bucket": "inbox", "added_at": iso(now), "updated_at": iso(older)}], "sessions": []}, token=tok)[1]
    assert r["items"][0]["title"] == "A", "LWW: server should win over older edit"

    newer = now + dt.timedelta(minutes=5)
    r = call("POST", "/api/sync", {"items": [{"id": id1, "url": "https://a.com", "title": "NEWER", "bucket": "rounds", "cadence_days": 7, "added_at": iso(now), "updated_at": iso(newer)}], "sessions": []}, token=tok)[1]
    assert r["items"][0]["title"] == "NEWER" and r["items"][0]["bucket"] == "rounds"

    call("POST", "/api/sync", {"items": [{"id": id2, "deleted": True, "title": "A book", "bucket": "explore", "added_at": iso(now), "updated_at": iso(dt.datetime.now(dt.timezone.utc))}], "sessions": []}, token=tok)
    assert any(i["id"] == id2 and i["deleted"] for i in call("GET", "/api/sync?since_rev=0", token=tok)[1]["items"])

    assert call("POST", "/api/auth/refresh", {"refresh_token": refresh})[0] == 200
    assert call("POST", "/api/auth/refresh", {"refresh_token": refresh})[0] == 401  # rotated
    assert call("GET", "/api/sync?since_rev=0")[0] in (401, 403)  # no token

    print("SMOKE OK")


if __name__ == "__main__":
    main()
