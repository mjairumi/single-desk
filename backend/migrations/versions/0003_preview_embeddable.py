"""record whether a previewed page can be framed

Split from 0002 rather than folded into it: 0002 has already left this machine,
and rewriting a migration other people may have run is how you get a broken
`alembic_version`.

Revision ID: 0003_preview_embeddable
Revises: 0002_link_previews
Create Date: 2026-08-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_preview_embeddable"
down_revision = "0002_link_previews"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # NULLABLE on purpose. A row cached before this column existed carries no
    # answer, and back-filling it with `false` would be a lie that outlives the
    # 30-day TTL. NULL means "unknown", which the reader treats as stale, so
    # those rows re-fetch once on next sight and heal themselves.
    op.add_column("link_previews", sa.Column("embeddable", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("link_previews", "embeddable")
