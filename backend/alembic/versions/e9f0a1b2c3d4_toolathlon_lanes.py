"""experiments.n_toolathlon_lanes + experiment_runs.lane_index (SPA-69 per-lane parallelism)

Revision ID: e9f0a1b2c3d4
Revises: d8e9f0a1b2c3
Create Date: 2026-06-19
"""

import sqlalchemy as sa
from alembic import op

revision = "e9f0a1b2c3d4"
down_revision = "d8e9f0a1b2c3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # None/0 == serial (current behaviour); >1 enables per-lane parallel Toolathlon.
    op.add_column(
        "experiments",
        sa.Column("n_toolathlon_lanes", sa.Integer(), nullable=True),
    )
    # Lane a Toolathlon run is pinned to while in flight; NULL for plain runs.
    op.add_column(
        "experiment_runs",
        sa.Column("lane_index", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("experiment_runs", "lane_index")
    op.drop_column("experiments", "n_toolathlon_lanes")
