"""link preview cache

Derived data, not a syncable entity: no user_id, no rev, no tombstone. Keyed by
a sha256 of the normalized URL because the URL itself is too long to index.

Revision ID: 0002_link_previews
Revises: 0001_init
Create Date: 2026-08-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_link_previews"
down_revision = "0001_init"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "link_previews",
        sa.Column("url_hash", sa.String(64), primary_key=True),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="ok"),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("image_url", sa.Text(), nullable=True),
        sa.Column("icon_url", sa.Text(), nullable=True),
        sa.Column("site_name", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("link_previews")
