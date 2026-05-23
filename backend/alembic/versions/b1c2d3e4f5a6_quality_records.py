"""quality_records — Quality Data Lake (E-01)

Revision ID: b1c2d3e4f5a6
Revises: f7e8d9c0b1a2
Create Date: 2026-05-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "b1c2d3e4f5a6"
down_revision = "f7e8d9c0b1a2"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "quality_records",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("workspace_id", sa.UUID(), nullable=False),
        sa.Column("schema_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("template_id", sa.UUID(), nullable=True),
        sa.Column("template_name", sa.String(length=255), nullable=True),
        sa.Column("model_used", sa.String(length=255), nullable=True),
        sa.Column("final_status", sa.String(length=50), nullable=True),
        sa.Column("is_decomposition_root", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("cost_usd", sa.Numeric(10, 6), server_default="0", nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("tool_call_count", sa.Integer(), nullable=True),
        sa.Column("quality_profile", postgresql.JSONB(), nullable=True),
        sa.Column("trajectory_profile", postgresql.JSONB(), nullable=True),
        sa.Column("human_feedback", postgresql.JSONB(), nullable=True),
        sa.Column("longitudinal", postgresql.JSONB(), nullable=True),
        sa.Column("reproducibility", postgresql.JSONB(), nullable=True),
        sa.Column("record_s3_path", sa.String(length=500), nullable=True),
        sa.Column("public_dataset_opt_in", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", name="uq_quality_records_task"),
    )
    op.create_index("idx_quality_records_workspace", "quality_records", ["workspace_id"])
    op.create_index("idx_quality_records_template", "quality_records", ["template_id"])
    op.create_index("idx_quality_records_model", "quality_records", ["model_used"])
    op.create_index("idx_quality_records_status", "quality_records", ["final_status"])
    op.create_index("idx_quality_records_created", "quality_records", ["created_at"])


def downgrade():
    op.drop_index("idx_quality_records_created", table_name="quality_records")
    op.drop_index("idx_quality_records_status", table_name="quality_records")
    op.drop_index("idx_quality_records_model", table_name="quality_records")
    op.drop_index("idx_quality_records_template", table_name="quality_records")
    op.drop_index("idx_quality_records_workspace", table_name="quality_records")
    op.drop_table("quality_records")
