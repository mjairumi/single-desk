"""SQLAlchemy engine + session factory.

We use *synchronous* SQLAlchemy and declare path operations as plain `def`
(FastAPI runs those in a threadpool). This keeps the code simple and is more
than fast enough for a personal sync backend. If you later need higher
concurrency, switch to async SQLAlchemy + asyncpg.
"""
from __future__ import annotations
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

engine = create_engine(
    get_settings().database_url,
    pool_pre_ping=True,   # survive Render Postgres idle disconnects
    pool_size=5,
    max_overflow=5,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
