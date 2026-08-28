"""Password hashing + JWT / refresh-token helpers.

- Access token: short-lived JWT (HS256), carried as `Authorization: Bearer`.
- Refresh token: opaque random string; only its SHA-256 hash is stored, and it
  is rotated on every use. See docs/AUTH.md.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import secrets

import bcrypt
import jwt

from .config import get_settings


def _prehash(raw: str) -> bytes:
    """bcrypt silently truncates at 72 bytes; pre-hash so long passwords keep
    their full entropy. base64(sha256(pw)) is always 44 bytes (< 72)."""
    return base64.b64encode(hashlib.sha256(raw.encode("utf-8")).digest())


def hash_password(raw: str) -> str:
    return bcrypt.hashpw(_prehash(raw), bcrypt.gensalt()).decode("ascii")


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_prehash(raw), hashed.encode("ascii"))
    except ValueError:
        return False


def make_access_token(user_id: str) -> str:
    s = get_settings()
    now = dt.datetime.now(dt.timezone.utc)
    payload = {
        "sub": str(user_id),
        "type": "access",
        "iat": now,
        "exp": now + dt.timedelta(minutes=s.ACCESS_TOKEN_TTL_MIN),
    }
    return jwt.encode(payload, s.SECRET_KEY, algorithm="HS256")


def decode_access_token(token: str) -> dict:
    """Raises jwt.PyJWTError on invalid/expired tokens."""
    return jwt.decode(token, get_settings().SECRET_KEY, algorithms=["HS256"])


def new_refresh_token() -> tuple[str, str]:
    """Return (raw_token_to_send_client, sha256_hash_to_store)."""
    raw = secrets.token_urlsafe(48)
    return raw, hashlib.sha256(raw.encode()).hexdigest()


def hash_refresh(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
