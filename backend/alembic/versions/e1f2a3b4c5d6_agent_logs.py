"""agent_log_chunks + agent_log_deliveries + tasks.log_archive_s3_path

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-05-08
"""

from alembic import op
import sqlalchemy as sa


revision = "e1f2a3b4c5d6"
down_revision = "d0e1f2a3b4c5"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_log_chunks",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("workspace_id", sa.UUID(), nullable=False),
        sa.Column("chunk_seq", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("tool_name", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", "chunk_seq", name="uq_agent_log_chunk_seq"),
    )
    op.create_index("idx_agent_log_chunks_task_seq", "agent_log_chunks", ["task_id", "chunk_seq"])
    op.create_index("idx_agent_log_chunks_workspace", "agent_log_chunks", ["workspace_id"])

    op.create_table(
        "agent_log_deliveries",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=64), nullable=False),
        sa.Column("received_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", "idempotency_key", name="uq_agent_log_delivery"),
    )

    op.add_column(
        "tasks",
        sa.Column("log_archive_s3_path", sa.String(length=500), nullable=True),
    )


def downgrade():
    op.drop_column("tasks", "log_archive_s3_path")
    op.drop_table("agent_log_deliveries")
    op.drop_index("idx_agent_log_chunks_workspace", table_name="agent_log_chunks")
    op.drop_index("idx_agent_log_chunks_task_seq", table_name="agent_log_chunks")
    op.drop_table("agent_log_chunks")
