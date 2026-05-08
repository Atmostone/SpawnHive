"""workspace_id columns (P11)

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-05-03
"""

from alembic import op
import sqlalchemy as sa


revision = "a7b8c9d0e1f2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None

TABLES = ("tasks", "templates", "knowledge_documents", "agent_events", "chat_messages")


def upgrade():
    for t in TABLES:
        op.add_column(t, sa.Column("workspace_id", sa.UUID(), nullable=True))
        op.create_index(f"idx_{t}_workspace_id", t, ["workspace_id"])


def downgrade():
    for t in TABLES:
        op.drop_index(f"idx_{t}_workspace_id", table_name=t)
        op.drop_column(t, "workspace_id")
