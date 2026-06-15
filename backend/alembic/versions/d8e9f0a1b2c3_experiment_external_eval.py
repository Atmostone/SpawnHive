"""experiment_runs: Toolathlon executable-eval columns (preprocess/eval lifecycle)

Revision ID: d8e9f0a1b2c3
Revises: c7d8e9f0a1b2
Create Date: 2026-06-14
"""

import sqlalchemy as sa
from alembic import op

revision = "d8e9f0a1b2c3"
down_revision = "c7d8e9f0a1b2"
branch_labels = None
depends_on = None


_COLUMNS = (
    ("external_verdict", sa.Boolean()),
    ("launch_time", sa.String(length=64)),
    ("preprocess_container_id", sa.String(length=128)),
    ("eval_container_id", sa.String(length=128)),
    ("preprocess_retried", sa.Boolean()),
    ("preprocess_started_at", sa.DateTime()),
    ("preprocess_log", sa.Text()),
    ("eval_log", sa.Text()),
)


def upgrade() -> None:
    for name, type_ in _COLUMNS:
        op.add_column("experiment_runs", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        op.drop_column("experiment_runs", name)
