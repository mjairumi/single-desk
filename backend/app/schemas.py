"""Pydantic request/response schemas."""
from __future__ import annotations

import datetime as dt
import uuid

from pydantic import BaseModel, ConfigDict, EmailStr, Field


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
