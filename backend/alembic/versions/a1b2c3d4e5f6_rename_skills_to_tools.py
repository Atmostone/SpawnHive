"""Rename templates.skills -> templates.tools

Revision ID: a1b2c3d4e5f6
Revises: 819cd4ea6d24
Create Date: 2026-05-02
"""

from alembic import op


revision = "a1b2c3d4e5f6"
down_revision = "819cd4ea6d24"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("templates", "skills", new_column_name="tools")


def downgrade():
    op.alter_column("templates", "tools", new_column_name="skills")
