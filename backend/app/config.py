"""Application settings, loaded from environment / .env."""
from __future__ import annotations
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql://signaldesk:signaldesk@localhost:5432/signaldesk"
    SECRET_KEY: str = "dev-insecure-change-me"
    ACCESS_TOKEN_TTL_MIN: int = 15
    REFRESH_TOKEN_TTL_DAYS: int = 30
    CORS_ORIGINS: str = "http://localhost:5173"
    # Interactive API docs (/docs, /redoc, /openapi.json). OFF by default so a
    # public deployment never exposes the API surface by accident; switch it on
    # explicitly for local development.
    ENABLE_DOCS: bool = False

    @property
    def database_url(self) -> str:
        """Normalize to the psycopg3 driver.

        Render hands out `postgres://...` or `postgresql://...`; SQLAlchemy 2.0
        with psycopg 3 wants the explicit `postgresql+psycopg://` scheme.
        """
        u = self.DATABASE_URL
        if u.startswith("postgres://"):
            u = "postgresql+psycopg://" + u[len("postgres://"):]
        elif u.startswith("postgresql://"):
            u = "postgresql+psycopg://" + u[len("postgresql://"):]
        return u

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
