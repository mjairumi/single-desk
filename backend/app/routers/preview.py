"""Link previews — what a saved URL actually is, so triage can go fast.

    POST /api/preview   { "urls": [...] }
        -> { "previews": [ { requested_url, url, status, title, description,
                             image_url, icon_url, site_name, error }, ... ] }

Cache-first: rows already in `link_previews` come straight back, and only the
misses (and stale rows) are fetched, in parallel, with the SSRF-guarded fetcher
in app/preview.py. The client asks for the URLs it is about to paint, so the
fetch load is bounded by what you actually look at.

Authentication is required. Not because previews are private — the cache is
global, since page metadata is public — but because an unauthenticated
"fetch this URL for me" endpoint is an open proxy.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from .. import models, preview as preview_lib, schemas
from ..database import get_db
from ..deps import get_current_user

router = APIRouter()

_CACHED_FIELDS = ("url", "status", "title", "description", "image_url",
                  "icon_url", "site_name", "error", "fetched_at")


def _out(requested_url: str, row: dict) -> schemas.LinkPreviewOut:
    return schemas.LinkPreviewOut(
        requested_url=requested_url,
        url=row["url"],
        status=row["status"],
        title=row.get("title"),
        description=row.get("description"),
        image_url=row.get("image_url"),
        icon_url=row.get("icon_url"),
        site_name=row.get("site_name"),
        error=row.get("error"),
    )


def _error_out(requested_url: str, message: str) -> schemas.LinkPreviewOut:
    return schemas.LinkPreviewOut(
        requested_url=requested_url, url=requested_url, status="error", error=message
    )


@router.post("/preview", response_model=schemas.PreviewOut)
def previews(
    body: schemas.PreviewIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    # Normalize up front: several cards can point at the same page (or at
    # spellings of it that differ only by fragment), and that should be one
    # fetch. `wanted` maps cache key -> the request spellings waiting on it.
    wanted: dict[str, list[str]] = {}
    normalized_by_key: dict[str, str] = {}
    failures: list[schemas.LinkPreviewOut] = []

    for requested in body.urls:
        try:
            normalized = preview_lib.normalize_url(requested)
        except preview_lib.PreviewError as e:
            failures.append(_error_out(requested, str(e)))
            continue
        key = preview_lib.url_key(normalized)
        normalized_by_key[key] = normalized
        wanted.setdefault(key, []).append(requested)

    cached: dict[str, dict] = {}
    if wanted:
        rows = db.execute(
            select(models.LinkPreview).where(models.LinkPreview.url_hash.in_(list(wanted)))
        ).scalars().all()
        for row in rows:
            if preview_lib.is_stale(row.status, row.fetched_at):
                continue  # let it fall through to a re-fetch
            cached[row.url_hash] = {f: getattr(row, f) for f in _CACHED_FIELDS}

    misses = [k for k in wanted if k not in cached]
    if misses:
        # Fan out: these are network-bound, and this path op already runs in
        # FastAPI's threadpool (plain `def`), so a small pool here is safe.
        with ThreadPoolExecutor(max_workers=preview_lib.FETCH_CONCURRENCY) as pool:
            fetched = list(pool.map(
                preview_lib.fetch_preview, [normalized_by_key[k] for k in misses]
            ))
        for row in fetched:
            cached[row["url_hash"]] = row
        _store(db, fetched)

    out = list(failures)
    for key, requested_urls in wanted.items():
        row = cached.get(key)
        for requested in requested_urls:
            out.append(_out(requested, row) if row else _error_out(requested, "unavailable"))
    return schemas.PreviewOut(previews=out)


def _store(db: Session, rows: list[dict]) -> None:
    """Upsert freshly fetched rows.

    ON CONFLICT rather than get-then-write: two devices opening the same Inbox
    at once would otherwise race on the primary key. A preview write is never
    worth failing the request over, so a broken insert is rolled back and
    swallowed — the caller still gets the metadata, it just isn't cached yet.
    """
    if not rows:
        return
    try:
        stmt = insert(models.LinkPreview).values(rows)
        db.execute(stmt.on_conflict_do_update(
            index_elements=[models.LinkPreview.url_hash],
            set_={c: stmt.excluded[c] for c in _CACHED_FIELDS},
        ))
        db.commit()
    except Exception:
        db.rollback()
