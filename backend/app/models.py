"""Database models.

Sync design in one line: every syncable row carries a per-user monotonic
`rev` (assigned from `users.sync_rev`) and a `deleted` tombstone, so clients
can pull "everything changed since rev N" and converge with last-write-wins.
See docs/SYNC.md.
"""
from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import (
    BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Per-user logical clock. Bumped once per accepted write; clients pull ?since_rev=.
    sync_rev: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(255), unique=True, index=True)  # sha256 of the opaque token
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


# ---- Syncable entities -----------------------------------------------------
# `id` is CLIENT-generated (a UUID) so a device can create offline and the id
# survives the eventual push. Server never renumbers ids.

class Item(Base):
    """A saved link / idea. Mirrors the Signal Desk buckets."""
    __tablename__ = "items"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

    url: Mapped[str | None] = mapped_column(Text, nullable=True)   # optional (books/ideas in Explore)
    title: Mapped[str] = mapped_column(Text, default="")
    note: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list] = mapped_column(JSONB, default=list)
    # inbox | library | rounds | queue | explore | archive
    bucket: Mapped[str] = mapped_column(String(16), default="inbox")
    # The catalog axis. `bucket` says WHEN you deal with a link; `topic` says
    # what it is ABOUT, and unlike `tags` it is single-valued on purpose — one
    # decision per item, so a view can group by it with no duplicates and no
    # ambiguity about where something lives. User-defined, free text, NULL
    # until catalogued. Not to be confused with `shelf_days` below.
    topic: Mapped[str | None] = mapped_column(Text, nullable=True)

    cadence_days: Mapped[int | None] = mapped_column(Integer, nullable=True)      # rounds
    last_visited: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    shelf_days: Mapped[int | None] = mapped_column(Integer, nullable=True)        # read-later
    added_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    archived_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    snoozed_until: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    deleted: Mapped[bool] = mapped_column(Boolean, default=False)                 # tombstone
    rev: Mapped[int] = mapped_column(BigInteger, nullable=False)                  # user.sync_rev at last change
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class TabSession(Base):
    """A "Group" = a saved set of browser tabs (session manager)."""
    __tablename__ = "tab_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

    name: Mapped[str] = mapped_column(Text, default="")
    # [{ "url": str, "title": str, "groupTitle": str|None, "groupColor": str|None }]
    tabs: Mapped[list] = mapped_column(JSONB, default=list)

    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    rev: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


# ---- Derived data (NOT syncable) -------------------------------------------

class LinkPreview(Base):
    """Cached Open Graph / favicon metadata for a URL, so cards can show what a
    link actually is without opening it.

    Deliberately outside the sync model: no `user_id`, no `rev`, no tombstone.
    Page metadata is public information, so one fetch serves every user and
    every device, and dropping the table costs nothing but a re-fetch. See
    app/preview.py for the fetcher and its SSRF guard.
    """
    __tablename__ = "link_previews"

    # sha256 of the normalized URL — a URL is too long to index directly.
    url_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    url: Mapped[str] = mapped_column(Text)

    status: Mapped[str] = mapped_column(String(16), default="ok")   # ok | error
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    icon_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    site_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Whether the page allows being framed on another origin. Recorded because
    # the answer is free at fetch time and unknowable in the browser later.
    # NULL = never determined (a row cached before this column existed), which
    # counts as stale so it is re-fetched rather than assumed.
    embeddable: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=None)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    fetched_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


# Composite indexes to make "changed since rev N for this user" a fast range scan.
Index("ix_items_user_rev", Item.user_id, Item.rev)
Index("ix_tab_sessions_user_rev", TabSession.user_id, TabSession.rev)
