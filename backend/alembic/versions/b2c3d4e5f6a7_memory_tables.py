"""memory_entities and memory_relations tables (P0)

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-03
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "b2c3d4e5f6a7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "memory_entities",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("type", sa.String(length=50), nullable=False),
        sa.Column("name", sa.String(length=500), nullable=False),
        sa.Column("attributes", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False),
        sa.Column("embedding_id", sa.UUID(), nullable=True),
        sa.Column("created_by", sa.String(length=50), server_default="orchestrator", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_memory_entities_type", "memory_entities", ["type"])
    op.create_index("idx_memory_entities_name", "memory_entities", ["name"])

    op.create_table(
        "memory_relations",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("from_id", sa.UUID(), nullable=False),
        sa.Column("to_id", sa.UUID(), nullable=False),
        sa.Column("relation_type", sa.String(length=100), nullable=False),
        sa.Column("attributes", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["from_id"], ["memory_entities.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["to_id"], ["memory_entities.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_memory_relations_from", "memory_relations", ["from_id"])
    op.create_index("idx_memory_relations_to", "memory_relations", ["to_id"])


def downgrade():
    op.drop_index("idx_memory_relations_to", table_name="memory_relations")
    op.drop_index("idx_memory_relations_from", table_name="memory_relations")
    op.drop_table("memory_relations")
    op.drop_index("idx_memory_entities_name", table_name="memory_entities")
    op.drop_index("idx_memory_entities_type", table_name="memory_entities")
    op.drop_table("memory_entities")
