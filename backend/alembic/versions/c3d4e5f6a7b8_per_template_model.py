"""Per-template model routing (P4)

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-05-03
"""

from alembic import op
import sqlalchemy as sa


revision = "c3d4e5f6a7b8"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("templates", "model", existing_type=sa.String(length=255), nullable=True)
    op.add_column("templates", sa.Column("provider_url", sa.String(length=500), nullable=True))
    op.add_column("templates", sa.Column("provider_api_key", sa.String(length=500), nullable=True))
    op.add_column("tasks", sa.Column("model_used", sa.String(length=255), nullable=True))


def downgrade():
    op.drop_column("tasks", "model_used")
    op.drop_column("templates", "provider_api_key")
    op.drop_column("templates", "provider_url")
    op.alter_column("templates", "model", existing_type=sa.String(length=255), nullable=False)
