"""FastAPI application factory.

Serves:
  • the JSON API under /api/*
  • the static web app (Signal Desk SPA) for everything else, so the web app
    and API share one origin (simplest CORS/auth story). The extension is a
    separate origin and is allowed via CORS_ORIGINS.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .routers import auth as auth_router
from .routers import sync as sync_router

settings = get_settings()
app = FastAPI(title="Signal Desk API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


app.include_router(auth_router.router, prefix="/api/auth", tags=["auth"])
app.include_router(sync_router.router, prefix="/api", tags=["sync"])

# Serve the SPA last, as a catch-all, so /api/* still resolves above.
_static_dir = Path(__file__).parent / "static"
if _static_dir.exists():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="web")
