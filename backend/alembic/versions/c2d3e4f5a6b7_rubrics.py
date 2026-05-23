"""rubrics — Multi-dimensional Quality Rubric Engine (E-02)

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-05-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "c2d3e4f5a6b7"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "rubrics",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("workspace_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column("applies_to", sa.String(length=50), nullable=True),
        sa.Column("is_default", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("dimensions", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_rubrics_workspace", "rubrics", ["workspace_id"])

    op.add_column("templates", sa.Column("rubric_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_templates_rubric_id", "templates", "rubrics",
        ["rubric_id"], ["id"], ondelete="SET NULL",
    )

    op.add_column(
        "workspaces", sa.Column("quality_judge_model_id", sa.UUID(), nullable=True)
    )
    op.create_foreign_key(
        "fk_workspaces_quality_judge_model_id", "workspaces", "llm_models",
        ["quality_judge_model_id"], ["id"], ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint(
        "fk_workspaces_quality_judge_model_id", "workspaces", type_="foreignkey"
    )
    op.drop_column("workspaces", "quality_judge_model_id")

    op.drop_constraint("fk_templates_rubric_id", "templates", type_="foreignkey")
    op.drop_column("templates", "rubric_id")

    op.drop_index("idx_rubrics_workspace", table_name="rubrics")
    op.drop_table("rubrics")
