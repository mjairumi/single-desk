"""Pydantic request/response schemas."""
from __future__ import annotations

import datetime as dt
import uuid

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from . import preview


# ---- auth ----
class SignupIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)
    display_name: str | None = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class RefreshIn(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: EmailStr
    display_name: str | None = None

    class Config:
        from_attributes = True


# ---- syncable entities ----
# Clients send the FULL entity (including its own updated_at, which drives LWW).
# `rev` is server-authoritative: ignored on input, always set on output.
class ItemIn(BaseModel):
    id: uuid.UUID
    url: str | None = None
    title: str = ""
    note: str = ""
    tags: list[str] = []
    bucket: str = "inbox"
    cadence_days: int | None = None
    last_visited: dt.datetime | None = None
    shelf_days: int | None = None
    added_at: dt.datetime | None = None
    archived_at: dt.datetime | None = None
    snoozed_until: dt.datetime | None = None
    deleted: bool = False
    updated_at: dt.datetime


class ItemOut(ItemIn):
    model_config = ConfigDict(from_attributes=True)
    rev: int


class TabSessionIn(BaseModel):
    id: uuid.UUID
    name: str = ""
    tabs: list[dict] = []
    deleted: bool = False
    updated_at: dt.datetime


class TabSessionOut(TabSessionIn):
    model_config = ConfigDict(from_attributes=True)
    rev: int


class SyncPushIn(BaseModel):
    items: list[ItemIn] = []
    sessions: list[TabSessionIn] = []


class SyncOut(BaseModel):
    items: list[ItemOut] = []
    sessions: list[TabSessionOut] = []
    server_rev: int


# ---- link previews (derived, not synced) ----
# The client sends the URLs it is about to paint and gets one result per URL,
# echoed back under `requested_url` so it can match results to cards without
# reimplementing the server's normalization.
class PreviewIn(BaseModel):
    urls: list[str] = Field(default_factory=list, max_length=preview.MAX_URLS_PER_REQUEST)


class LinkPreviewOut(BaseModel):
    requested_url: str
    url: str
    status: str                      # ok | error
    title: str | None = None
    description: str | None = None
    image_url: str | None = None
    icon_url: str | None = None
    site_name: str | None = None
    embeddable: bool = False        # may this page be shown in an <iframe>?
    error: str | None = None


class PreviewOut(BaseModel):
    previews: list[LinkPreviewOut] = []
