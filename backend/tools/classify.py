"""Bulk-catalogue a bookmark backlog with Claude.

Going through 150 saved links by hand is the reason backlogs stay backlogs.
This is a ONE-TIME assist: it reads your items, asks Claude to sort them, and
writes a proposal file you review. Nothing is written back without `--apply`.

The trick that makes it work well is that we are not classifying bare URLs.
The link-preview cache (app/preview.py) already holds each page's real title,
description and site name, so the model sees what a page actually IS rather
than guessing from a slug. Warm previews first and the accuracy is a different
league.

Two passes, on purpose:

  1. PROPOSE a small topic vocabulary for the whole collection at once. Asking
     per-batch invents a new vocabulary every 20 items and you end up with
     "AI", "Machine learning" and "LLMs" as three separate shelves.
  2. CLASSIFY each item into that fixed vocabulary.

Usage:

    export ANTHROPIC_API_KEY=...          # or: ant auth login
    cd backend && source .venv/bin/activate
    pip install anthropic

    # look, change nothing
    python tools/classify.py --base http://127.0.0.1:8000 --email you@example.com

    # write the confident ones back; the rest stay for hand-triage
    python tools/classify.py --base ... --email ... --apply --min-confidence 0.75

Items are addressed by a per-run index, never by UUID: a model asked to echo
150 UUIDs will eventually mistype one, and a mistyped index fails loudly
instead of silently re-cataloguing the wrong link.
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
from typing import Literal

import httpx

try:
    import anthropic
    from pydantic import BaseModel, Field
except ImportError:
    sys.exit("Needs the Anthropic SDK: pip install anthropic")

BUCKETS = ("inbox", "library", "rounds", "queue", "explore", "archive")
PREVIEW_BATCH = 24      # the API's own per-request cap
CLASSIFY_BATCH = 20     # items per Claude call
MODEL = "claude-opus-5"

# Bucket semantics come straight from the Playbook. Without them the model
# spreads everything across Library and Read-later, because it has no idea the
# buckets encode a lifecycle rather than a topic.
SYSTEM = """You are cataloguing a personal bookmark collection for Signal Desk.

Signal Desk sorts links on two independent axes.

AXIS 1 — bucket: the link's JOB, i.e. when the person deals with it.
  library — reference they return to ON DEMAND: docs, tools, API references,
      cheat sheets. No deadline. This is the default for anything useful and
      lasting.
  rounds  — something to revisit ON A SCHEDULE: a blog's index, a dashboard,
      a forum, a newsletter archive. Only if repeat visits make sense.
  queue   — a specific thing to CONSUME ONCE and then decide on: one article,
      one video, one paper. Not a whole site.
  explore — someday-for-the-joy-of-it: a book, a course, an idea to chase. No
      deadline, no guilt. Use for aspirational things, not obligations.
  archive — dead, broken, obsolete, or clearly no longer wanted.
  inbox   — ONLY when the page is too ambiguous to place. Prefer a real
      decision; the whole point is to empty the inbox.

AXIS 2 — topic: what the link is ABOUT. Exactly one per link, chosen from the
provided vocabulary. This is a shelf, not a description.

Also give 1-3 lowercase tags: specific, searchable, complementary to the topic
(a topic of "Backend" with tags "postgres", "performance" is useful; a tag
that merely restates the topic is not).

confidence is 0.0-1.0 and must reflect real uncertainty. Anything you are
guessing at belongs below 0.6 so a human reviews it. Do not inflate it."""


# ---------------------------------------------------------------------------
# Signal Desk API
# ---------------------------------------------------------------------------

def login(base: str, email: str, password: str) -> str:
    r = httpx.post(f"{base}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    if r.status_code != 200:
        sys.exit(f"Login failed ({r.status_code}): {r.text[:200]}")
    return r.json()["access_token"]


def fetch_items(base: str, token: str) -> list[dict]:
    r = httpx.get(f"{base}/api/sync", params={"since_rev": 0},
                  headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return [it for it in r.json()["items"] if not it["deleted"]]


def fetch_previews(base: str, token: str, urls: list[str]) -> dict[str, dict]:
    """Warm and collect the preview metadata — the model's real input."""
    out: dict[str, dict] = {}
    headers = {"Authorization": f"Bearer {token}"}
    for i in range(0, len(urls), PREVIEW_BATCH):
        chunk = urls[i:i + PREVIEW_BATCH]
        try:
            r = httpx.post(f"{base}/api/preview", json={"urls": chunk}, headers=headers, timeout=180)
            r.raise_for_status()
            for row in r.json().get("previews", []):
                if row.get("status") == "ok":
                    out[row["requested_url"]] = row
        except httpx.HTTPError as e:
            print(f"  ! preview batch failed ({e}); continuing without it", file=sys.stderr)
        print(f"  previews {min(i + PREVIEW_BATCH, len(urls))}/{len(urls)}", file=sys.stderr)
    return out


def describe(index: int, item: dict, preview: dict | None) -> dict:
    """The compact view of one item that the model sees."""
    row = {"n": index, "title": (item.get("title") or "").strip()[:200],
           "url": (item.get("url") or "")[:300]}
    if preview:
        if preview.get("title") and not row["title"]:
            row["title"] = preview["title"][:200]
        if preview.get("description"):
            row["description"] = preview["description"][:400]
        if preview.get("site_name"):
            row["site"] = preview["site_name"][:60]
    if item.get("note"):
        row["existing_note"] = item["note"][:200]
    if item.get("tags"):
        row["existing_tags"] = item["tags"][:6]
    # Drop empty fields so the model isn't fed nulls — but test for emptiness,
    # not falsiness: index 0 is a perfectly good index, and dropping it would
    # silently strip the first item of every batch of its only identifier.
    return {k: v for k, v in row.items() if v not in (None, "", [], {})}


# ---------------------------------------------------------------------------
# Claude
# ---------------------------------------------------------------------------

class TopicVocabulary(BaseModel):
    topics: list[str] = Field(description="8-15 topic names, Title Case, each a shelf a person would recognise")


class Proposal(BaseModel):
    n: int
    bucket: Literal["inbox", "library", "rounds", "queue", "explore", "archive"]
    topic: str
    tags: list[str]
    confidence: float
    why: str = Field(description="One short clause. Why this bucket and topic.")


class Batch(BaseModel):
    proposals: list[Proposal]


def _parse(client, *, system: str, prompt: str, schema, max_tokens: int = 16000):
    """One structured call.

    `messages.parse` guarantees the response validates against `schema`, which
    matters far more here than refusal fallbacks would — and the two cannot be
    combined, since fallbacks live on the beta endpoint. Bookmark titles do not
    realistically trip a policy decline, but guard for it rather than
    dereferencing a refusal as if it were data.
    """
    response = client.messages.parse(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": prompt}],
        output_format=schema,
    )
    if response.stop_reason == "refusal":
        raise RuntimeError(f"model declined this batch: {response.stop_details}")
    return response.parsed_output


def propose_topics(client, rows: list[dict], existing: list[str]) -> list[str]:
    reuse = (f"\nTopics already in use — REUSE these wherever they fit, rather than "
             f"coining a near-duplicate:\n{json.dumps(existing)}\n" if existing else "")
    prompt = (
        f"Here are {len(rows)} saved links.\n{reuse}\n"
        "Propose a topic vocabulary that covers this collection: 8-15 shelves, "
        "each broad enough to hold several links but narrow enough to mean "
        "something. Title Case. Avoid a catch-all like 'Misc' unless genuinely "
        "unavoidable.\n\n"
        f"{json.dumps(rows, ensure_ascii=False)}"
    )
    return _parse(client, system=SYSTEM, prompt=prompt, schema=TopicVocabulary).topics


def classify(client, rows: list[dict], topics: list[str]) -> list[Proposal]:
    prompt = (
        f"Topic vocabulary (choose exactly one per link, verbatim):\n"
        f"{json.dumps(topics, ensure_ascii=False)}\n\n"
        f"Catalogue these {len(rows)} links. Return one proposal per link, "
        f"echoing its `n` exactly.\n\n"
        f"{json.dumps(rows, ensure_ascii=False)}"
    )
    return _parse(client, system=SYSTEM, prompt=prompt, schema=Batch).proposals


# ---------------------------------------------------------------------------
# Writing back
# ---------------------------------------------------------------------------

def apply_proposals(base: str, token: str, items: list[dict],
                    accepted: list[tuple[dict, Proposal]]) -> int:
    """Push accepted proposals as ordinary sync writes.

    Full entities with a fresh `updated_at`, exactly like any client — the
    server applies last-write-wins and bumps `rev`. Nothing here is privileged.
    """
    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    payload = []
    for item, p in accepted:
        row = dict(item)
        row.pop("rev", None)
        row["bucket"] = p.bucket
        row["topic"] = p.topic
        # Union, not replace: tags you set by hand outrank a suggestion.
        row["tags"] = sorted({*(item.get("tags") or []), *[t.lower() for t in p.tags]})
        row["updated_at"] = now
        payload.append(row)
    if not payload:
        return 0
    r = httpx.post(f"{base}/api/sync", json={"items": payload, "sessions": []},
                   headers={"Authorization": f"Bearer {token}"}, timeout=120)
    r.raise_for_status()
    return len(r.json().get("items", []))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--email", required=True)
    ap.add_argument("--bucket", default="inbox",
                    help="which bucket to catalogue, or 'all' (default: inbox)")
    ap.add_argument("--out", default="catalog-proposals.json")
    ap.add_argument("--apply", action="store_true", help="write accepted proposals back")
    ap.add_argument("--min-confidence", type=float, default=0.75)
    ap.add_argument("--limit", type=int, default=0, help="only the first N items (for a trial run)")
    args = ap.parse_args()

    password = getpass.getpass(f"Password for {args.email}: ")
    token = login(args.base, args.email, password)

    items = fetch_items(args.base, token)
    if args.bucket != "all":
        items = [it for it in items if it["bucket"] == args.bucket]
    items = [it for it in items if it.get("url")]
    if args.limit:
        items = items[:args.limit]
    if not items:
        sys.exit(f"Nothing to catalogue in '{args.bucket}'.")
    print(f"{len(items)} items to catalogue.", file=sys.stderr)

    print("Warming link previews…", file=sys.stderr)
    previews = fetch_previews(args.base, token, [it["url"] for it in items])
    rows = [describe(i, it, previews.get(it["url"])) for i, it in enumerate(items)]
    print(f"  {len(previews)}/{len(items)} items have page metadata.", file=sys.stderr)

    client = anthropic.Anthropic()

    existing = sorted({(it.get("topic") or "").strip() for it in fetch_items(args.base, token)
                       if (it.get("topic") or "").strip()})
    print("Proposing a topic vocabulary…", file=sys.stderr)
    topics = propose_topics(client, rows, existing)
    print("  " + " · ".join(topics), file=sys.stderr)

    proposals: list[Proposal] = []
    for i in range(0, len(rows), CLASSIFY_BATCH):
        chunk = rows[i:i + CLASSIFY_BATCH]
        try:
            proposals.extend(classify(client, chunk, topics))
        except Exception as e:
            print(f"  ! batch at {i} failed: {e}", file=sys.stderr)
        print(f"  classified {min(i + CLASSIFY_BATCH, len(rows))}/{len(rows)}", file=sys.stderr)

    by_n = {p.n: p for p in proposals if 0 <= p.n < len(items)}
    accepted = [(items[n], p) for n, p in sorted(by_n.items()) if p.confidence >= args.min_confidence]
    unsure = [(items[n], p) for n, p in sorted(by_n.items()) if p.confidence < args.min_confidence]
    missing = [items[i] for i in range(len(items)) if i not in by_n]

    report = {
        "topics": topics,
        "accepted": [{"id": it["id"], "title": it.get("title") or it["url"], "url": it["url"],
                      **p.model_dump(exclude={"n"})} for it, p in accepted],
        "needs_review": [{"id": it["id"], "title": it.get("title") or it["url"], "url": it["url"],
                          **p.model_dump(exclude={"n"})} for it, p in unsure],
        "no_proposal": [{"id": it["id"], "url": it["url"]} for it in missing],
    }
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\n{len(accepted)} confident · {len(unsure)} need review · {len(missing)} no proposal")
    print(f"Written to {args.out}")
    for it, p in accepted[:8]:
        print(f"  [{p.confidence:.2f}] {p.bucket:8} {p.topic:22} {(it.get('title') or it['url'])[:46]}")
    if len(accepted) > 8:
        print(f"  … and {len(accepted) - 8} more")

    if args.apply:
        n = apply_proposals(args.base, token, items, accepted)
        print(f"\nApplied {n} items. The {len(unsure) + len(missing)} uncertain ones were left "
              f"alone — triage those in the app.")
    else:
        print("\nNothing written. Re-run with --apply to write the confident ones back.")


if __name__ == "__main__":
    main()
