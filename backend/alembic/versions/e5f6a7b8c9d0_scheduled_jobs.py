"""scheduled_jobs table (P8)

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-05-03
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "scheduled_jobs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),  # cron | interval | once
        sa.Column("cron_expr", sa.String(length=200), nullable=True),
        sa.Column("interval_seconds", sa.Integer(), nullable=True),
        sa.Column("fire_at", sa.DateTime(), nullable=True),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("last_fired_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_scheduled_jobs_enabled", "scheduled_jobs", ["enabled"])


def downgrade():
    op.drop_index("idx_scheduled_jobs_enabled", table_name="scheduled_jobs")
    op.drop_table("scheduled_jobs")
