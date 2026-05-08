"""users/workspaces/service_tokens + scoping (R1)

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-05-03
"""

from alembic import op
import sqlalchemy as sa


revision = "c9d0e1f2a3b4"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None


# Existing tables that already have nullable workspace_id (from P11)
EXISTING_WS_TABLES = (
    "tasks",
    "templates",
    "knowledge_documents",
    "agent_events",
    "chat_messages",
)

# Tables that need workspace_id added in this revision
NEW_WS_TABLES = (
    "memory_entities",
    "memory_relations",
    "scheduled_jobs",
    "template_versions",
)


def upgrade():
    # 1. users
    op.create_table(
        "users",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("display_name", sa.String(length=200), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )

    # 2. workspaces
    op.create_table(
        "workspaces",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("slug", sa.String(length=100), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug", name="uq_workspaces_slug"),
    )

    # 3. workspace_members
    op.create_table(
        "workspace_members",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("workspace_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "workspace_id", name="uq_workspace_member"),
    )

    # 4. service_tokens
    op.create_table(
        "service_tokens",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("token_hash", sa.String(length=255), nullable=False),
        sa.Column("task_id", sa.UUID(), nullable=True),
        sa.Column("workspace_id", sa.UUID(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_service_tokens_hash_kind", "service_tokens", ["token_hash", "kind"]
    )
    op.create_index("idx_service_tokens_task", "service_tokens", ["task_id"])

    # 5. Backfill: admin user + default workspace + owner membership
    op.execute(
        """
        INSERT INTO users (id, email, password_hash, display_name, is_active)
        VALUES ('00000000-0000-0000-0000-000000000001', 'admin@local', NULL, 'Admin', true)
        ON CONFLICT (email) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO workspaces (id, name, slug, created_by)
        VALUES ('00000000-0000-0000-0000-000000000002', 'Default', 'default',
                '00000000-0000-0000-0000-000000000001')
        ON CONFLICT (slug) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO workspace_members (id, user_id, workspace_id, role)
        VALUES ('00000000-0000-0000-0000-000000000003',
                '00000000-0000-0000-0000-000000000001',
                '00000000-0000-0000-0000-000000000002',
                'owner')
        ON CONFLICT (user_id, workspace_id) DO NOTHING
        """
    )

    # 6. Backfill workspace_id on existing tables (NULL → default)
    for t in EXISTING_WS_TABLES:
        op.execute(
            f"UPDATE {t} SET workspace_id = '00000000-0000-0000-0000-000000000002' "
            "WHERE workspace_id IS NULL"
        )

    # 7. Add workspace_id to new tables (with default value to satisfy NOT NULL)
    for t in NEW_WS_TABLES:
        op.add_column(
            t,
            sa.Column(
                "workspace_id",
                sa.UUID(),
                nullable=False,
                server_default="00000000-0000-0000-0000-000000000002",
            ),
        )
        # Drop the server_default — application provides workspace_id explicitly going forward
        op.alter_column(t, "workspace_id", server_default=None)
        op.create_index(f"idx_{t}_workspace_id", t, ["workspace_id"])
        op.create_foreign_key(
            f"fk_{t}_workspace",
            t,
            "workspaces",
            ["workspace_id"],
            ["id"],
            ondelete="CASCADE",
        )

    # 8. ALTER COLUMN ... SET NOT NULL on existing 5 tables + add FK
    for t in EXISTING_WS_TABLES:
        op.alter_column(t, "workspace_id", nullable=False)
        op.create_foreign_key(
            f"fk_{t}_workspace",
            t,
            "workspaces",
            ["workspace_id"],
            ["id"],
            ondelete="CASCADE",
        )


def downgrade():
    # Drop FKs and revert to nullable on existing tables
    for t in EXISTING_WS_TABLES:
        op.drop_constraint(f"fk_{t}_workspace", t, type_="foreignkey")
        op.alter_column(t, "workspace_id", nullable=True)

    # Drop workspace_id columns from new tables
    for t in NEW_WS_TABLES:
        op.drop_constraint(f"fk_{t}_workspace", t, type_="foreignkey")
        op.drop_index(f"idx_{t}_workspace_id", table_name=t)
        op.drop_column(t, "workspace_id")

    op.drop_index("idx_service_tokens_task", table_name="service_tokens")
    op.drop_index("idx_service_tokens_hash_kind", table_name="service_tokens")
    op.drop_table("service_tokens")
    op.drop_table("workspace_members")
    op.drop_table("workspaces")
    op.drop_table("users")
