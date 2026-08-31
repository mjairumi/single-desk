"""add the catalog axis: items.topic

`bucket` answers "when do I deal with this"; `topic` answers "what is it
about". Single-valued on purpose — tags are many-valued, which is exactly why
a tag cannot be grouped on without duplicating items across groups.

Revision ID: 0004_item_topic
Revises: 0003_preview_embeddable
Create Date: 2026-08-30
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_item_topic"
down_revision = "0003_preview_embeddable"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable with no default: NULL means "not catalogued yet", which is a
    # real state the UI surfaces (an "Uncatalogued" group) rather than hiding
    # behind an invented value.
    op.add_column("items", sa.Column("topic", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("items", "topic")
