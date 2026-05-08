"""tasks.cost_usd column (P5)

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-05-03
"""

from alembic import op
import sqlalchemy as sa


revision = "d4e5f6a7b8c9"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "tasks",
        sa.Column("cost_usd", sa.Numeric(10, 6), server_default="0", nullable=False),
    )


def downgrade():
    op.drop_column("tasks", "cost_usd")
