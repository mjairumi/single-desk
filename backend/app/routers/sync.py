"""Delta sync — the heart of multi-device convergence.

Protocol (see docs/SYNC.md for the full narrative):

  GET  /api/sync?since_rev=N
       → every item/session for this user with rev > N (INCLUDING tombstones),
         plus the current server_rev. First sync uses since_rev=0.

  POST /api/sync   { items: [...], sessions: [...] }
       → applies each incoming entity with LAST-WRITE-WINS by updated_at, then
         returns the CANONICAL version of every entity in the request (so the
         client can overwrite its local copy and resolve conflicts) plus the
         new server_rev.

`rev` is a per-user monotonic counter (users.sync_rev), bumped once per accepted
write. It is server-authoritative; clients never set it.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..models import now_utc

router = APIRouter()

_ITEM_FIELDS = (
    "url", "title", "note", "tags", "bucket", "cadence_days", "last_visited",
    "shelf_days", "added_at", "archived_at", "snoozed_until", "deleted",
)
_SESSION_FIELDS = ("name", "tabs", "deleted")


def _bump_rev(db: Session, user_id) -> int:
    """Atomically increment and return the user's sync clock.

    We lock the user row (SELECT ... FOR UPDATE) so two devices syncing at the
    same instant can't be assigned the same rev.
    """
    locked = db.execute(
        select(models.User).where(models.User.id == user_id).with_for_update()
    ).scalar_one()
    locked.sync_rev += 1
    db.flush()
    return locked.sync_rev


def _apply_item(db: Session, user_id, incoming: schemas.ItemIn) -> models.Item:
    row = db.get(models.Item, incoming.id)
    if row is not None and row.user_id != user_id:
        return row  # defensive: never touch another user's row
    if row is not None and incoming.updated_at <= row.updated_at:
        return row  # server copy is newer or equal → server wins (client reconciles)
    # Assign the new rev BEFORE the row is added/flushed so the INSERT already
    # carries a non-null rev (the flush inside _bump_rev would otherwise persist
    # a half-built row).
    new_rev = _bump_rev(db, user_id)
    if row is None:
        row = models.Item(id=incoming.id, user_id=user_id)
        db.add(row)
    for f in _ITEM_FIELDS:
        setattr(row, f, getattr(incoming, f))
    if row.added_at is None:
        row.added_at = incoming.updated_at
    row.updated_at = incoming.updated_at
    row.rev = new_rev
    return row


def _apply_session(db: Session, user_id, incoming: schemas.TabSessionIn) -> models.TabSession:
    row = db.get(models.TabSession, incoming.id)
    if row is not None and row.user_id != user_id:
        return row
    if row is not None and incoming.updated_at <= row.updated_at:
        return row
    new_rev = _bump_rev(db, user_id)
    if row is None:
        row = models.TabSession(id=incoming.id, user_id=user_id)
        db.add(row)
    for f in _SESSION_FIELDS:
        setattr(row, f, getattr(incoming, f))
    row.updated_at = incoming.updated_at
    row.rev = new_rev
    return row


@router.get("/sync", response_model=schemas.SyncOut)
def pull(
    since_rev: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    items = db.execute(
        select(models.Item)
        .where(models.Item.user_id == user.id, models.Item.rev > since_rev)
        .order_by(models.Item.rev)
    ).scalars().all()
    sessions = db.execute(
        select(models.TabSession)
        .where(models.TabSession.user_id == user.id, models.TabSession.rev > since_rev)
        .order_by(models.TabSession.rev)
    ).scalars().all()
    return schemas.SyncOut(items=items, sessions=sessions, server_rev=user.sync_rev)


@router.post("/sync", response_model=schemas.SyncOut)
def push(
    body: schemas.SyncPushIn,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    out_items = [_apply_item(db, user.id, it) for it in body.items]
    out_sessions = [_apply_session(db, user.id, s) for s in body.sessions]
    db.commit()
    # Re-read the user's clock after commit for the authoritative server_rev.
    server_rev = db.get(models.User, user.id).sync_rev
    return schemas.SyncOut(items=out_items, sessions=out_sessions, server_rev=server_rev)
