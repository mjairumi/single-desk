"""Auth: signup / login / refresh / logout / me.

Refresh tokens are opaque + rotated: every /refresh revokes the presented token
and issues a new one. Only SHA-256 hashes are stored server-side.
"""
from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import auth, models, schemas
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user

router = APIRouter()


def _issue_tokens(db: Session, user: models.User) -> schemas.TokenOut:
    access = auth.make_access_token(str(user.id))
    raw, token_hash = auth.new_refresh_token()
    s = get_settings()
    db.add(models.RefreshToken(
        user_id=user.id,
        token_hash=token_hash,
        expires_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=s.REFRESH_TOKEN_TTL_DAYS),
    ))
    db.commit()
    return schemas.TokenOut(access_token=access, refresh_token=raw)


@router.post("/signup", response_model=schemas.TokenOut)
def signup(body: schemas.SignupIn, db: Session = Depends(get_db)):
    email = body.email.lower()
    if db.execute(select(models.User).where(models.User.email == email)).scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    user = models.User(
        email=email,
        password_hash=auth.hash_password(body.password),
        display_name=body.display_name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _issue_tokens(db, user)


@router.post("/login", response_model=schemas.TokenOut)
def login(body: schemas.LoginIn, db: Session = Depends(get_db)):
    user = db.execute(
        select(models.User).where(models.User.email == body.email.lower())
    ).scalar_one_or_none()
    if not user or not auth.verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    return _issue_tokens(db, user)


@router.post("/refresh", response_model=schemas.TokenOut)
def refresh(body: schemas.RefreshIn, db: Session = Depends(get_db)):
    token_hash = auth.hash_refresh(body.refresh_token)
    rt = db.execute(
        select(models.RefreshToken).where(models.RefreshToken.token_hash == token_hash)
    ).scalar_one_or_none()
    now = dt.datetime.now(dt.timezone.utc)
    if not rt or rt.revoked or rt.expires_at < now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")
    rt.revoked = True  # rotate: this token can never be reused
    user = db.get(models.User, rt.user_id)
    db.commit()
    return _issue_tokens(db, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(body: schemas.RefreshIn, db: Session = Depends(get_db)):
    token_hash = auth.hash_refresh(body.refresh_token)
    rt = db.execute(
        select(models.RefreshToken).where(models.RefreshToken.token_hash == token_hash)
    ).scalar_one_or_none()
    if rt:
        rt.revoked = True
        db.commit()


@router.get("/me", response_model=schemas.UserOut)
def me(user: models.User = Depends(get_current_user)):
    return user
