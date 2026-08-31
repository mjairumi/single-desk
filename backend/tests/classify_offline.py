"""Everything in tools/classify.py that isn't a Claude call.

The two model calls need an API key, so they are exercised by running the tool
for real (see its docstring). What is tested here is the part that can damage
data: building the model's input from live items + previews, and writing
proposals back through /api/sync.

    cd backend && source .venv/bin/activate
    uvicorn app.main:app --port 8000     # terminal 1
    python tests/classify_offline.py     # terminal 2
"""
import datetime as dt
import os
import sys
import uuid

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools.classify import (  # noqa: E402
    Proposal, apply_proposals, describe, fetch_items, fetch_previews,
)

BASE = os.environ.get("BASE", "http://127.0.0.1:8000")
EMAIL = f"cls+{uuid.uuid4().hex[:8]}@example.com"
fails = []


def check(label, cond, extra=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {extra}" if extra and not cond else ""))
    if not cond:
        fails.append(label)


token = httpx.post(f"{BASE}/api/auth/signup",
                   json={"email": EMAIL, "password": "supersecret1"}, timeout=30).json()["access_token"]
now = dt.datetime.now(dt.timezone.utc).isoformat()
seed = [
    {"id": str(uuid.uuid4()), "url": "https://github.com/pallets/flask",
     "title": "", "note": "", "tags": ["mine"], "bucket": "inbox", "updated_at": now},
    {"id": str(uuid.uuid4()), "url": "https://example.com",
     "title": "Plain page", "note": "keep", "tags": [], "bucket": "inbox", "updated_at": now},
]
httpx.post(f"{BASE}/api/sync", json={"items": seed, "sessions": []},
           headers={"Authorization": f"Bearer {token}"}, timeout=60).raise_for_status()

items = fetch_items(BASE, token)
check("fetch_items returns the seeded items", len(items) == 2, extra=str(len(items)))

previews = fetch_previews(BASE, token, [it["url"] for it in items])
check("fetch_previews returns page metadata", len(previews) >= 1, extra=str(list(previews)))

# ---- describe(): the model's input ----------------------------------------
by_url = {it["url"]: it for it in items}
flask = by_url["https://github.com/pallets/flask"]
row = describe(0, flask, previews.get(flask["url"]))
check("describe carries the index", row["n"] == 0)
check("an untitled item borrows the page title from the preview",
      "flask" in (row.get("title") or "").lower(), extra=str(row.get("title")))
check("describe passes the page description through", bool(row.get("description")),
      extra=str(row.keys()))
check("describe preserves the user's own tags", row.get("existing_tags") == ["mine"])
empty = describe(1, {"url": "https://x.test", "title": "", "tags": [], "note": ""}, None)
check("describe omits empty fields rather than sending nulls",
      set(empty) == {"n", "url"}, extra=str(empty))

# ---- apply_proposals(): the part that mutates data ------------------------
accepted = [
    (flask, Proposal(n=0, bucket="library", topic="Backend", tags=["Python", "web"],
                     confidence=0.95, why="framework docs")),
]
written = apply_proposals(BASE, token, items, accepted)
check("apply_proposals writes accepted rows", written == 1, extra=str(written))

after = {it["id"]: it for it in fetch_items(BASE, token)}
got = after[flask["id"]]
check("the proposed bucket is applied", got["bucket"] == "library", extra=got["bucket"])
check("the proposed topic is applied", got["topic"] == "Backend", extra=str(got["topic"]))
check("proposed tags are lowercased and unioned with the user's own",
      got["tags"] == ["mine", "python", "web"], extra=str(got["tags"]))
check("the server assigned a new rev", got["rev"] > 0)

untouched = after[by_url["https://example.com"]["id"]]
check("an item with no accepted proposal is left alone",
      untouched["bucket"] == "inbox" and untouched["topic"] is None,
      extra=f"{untouched['bucket']}/{untouched['topic']}")

check("applying nothing writes nothing", apply_proposals(BASE, token, items, []) == 0)

print()
if fails:
    print(f"FAILED ({len(fails)}): " + "; ".join(fails))
    sys.exit(1)
print("ALL CLASSIFIER CHECKS PASSED (model calls excluded — they need an API key)")
