"""providers and llm_models tables, FK on workspaces/templates, price denorm on tasks

Revision ID: f7e8d9c0b1a2
Revises: e1f2a3b4c5d6
Create Date: 2026-05-23
"""

import uuid

from alembic import op
import sqlalchemy as sa


revision = "f7e8d9c0b1a2"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None


def upgrade():
    # 1. Create providers table
    op.create_table(
        "providers",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("workspace_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("api_key", sa.String(length=500), nullable=False),
        sa.Column("endpoint", sa.String(length=500), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "name", name="uq_providers_workspace_name"),
    )
    op.create_index("idx_providers_workspace", "providers", ["workspace_id"])

    # 2. Create llm_models table
    op.create_table(
        "llm_models",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("provider_id", sa.UUID(), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("api_name", sa.String(length=255), nullable=False),
        sa.Column(
            "input_price_per_1m_usd",
            sa.Numeric(12, 6),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "output_price_per_1m_usd",
            sa.Numeric(12, 6),
            server_default="0",
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["provider_id"], ["providers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("provider_id", "api_name", name="uq_llm_models_provider_api_name"),
    )
    op.create_index("idx_llm_models_provider", "llm_models", ["provider_id"])

    # 3. Add system model FKs to workspaces
    for col in ("orchestrator_model_id", "chat_model_id", "memory_extractor_model_id"):
        op.add_column("workspaces", sa.Column(col, sa.UUID(), nullable=True))
        op.create_foreign_key(
            f"fk_workspaces_{col}",
            "workspaces",
            "llm_models",
            [col],
            ["id"],
            ondelete="SET NULL",
        )

    # 4. Add model_id to templates
    op.add_column("templates", sa.Column("model_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_templates_model_id",
        "templates",
        "llm_models",
        ["model_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # 5. Add price denormalization columns to tasks
    op.add_column("tasks", sa.Column("input_price_per_1m_usd", sa.Numeric(12, 6), nullable=True))
    op.add_column("tasks", sa.Column("output_price_per_1m_usd", sa.Numeric(12, 6), nullable=True))

    # 6. Data migration: seed Provider+Model per workspace from existing settings.
    bind = op.get_bind()

    # Read global llm_* settings
    def _read_setting(key):
        row = bind.execute(
            sa.text("SELECT value FROM settings WHERE key = :k"),
            {"k": key},
        ).fetchone()
        if row is None:
            return None
        val = row[0]
        # JSONB returns python types directly through SQLAlchemy
        return val

    llm_base_url = _read_setting("llm_base_url")
    llm_api_key = _read_setting("llm_api_key")
    llm_model = _read_setting("llm_model")
    model_pricing = _read_setting("model_pricing") or {}

    # Coerce JSON-stored scalars to strings
    if isinstance(llm_base_url, dict):
        llm_base_url = None
    if isinstance(llm_api_key, dict):
        llm_api_key = None
    if isinstance(llm_model, dict):
        llm_model = None

    if llm_model and (llm_base_url or llm_api_key):
        # For each workspace, create a default provider + model and link templates + system FKs
        ws_rows = bind.execute(sa.text("SELECT id FROM workspaces")).fetchall()
        prices = model_pricing.get(llm_model, {}) if isinstance(model_pricing, dict) else {}
        try:
            input_price = float(prices.get("input_per_1m_usd", 0) or 0)
        except (TypeError, ValueError):
            input_price = 0.0
        try:
            output_price = float(prices.get("output_per_1m_usd", 0) or 0)
        except (TypeError, ValueError):
            output_price = 0.0

        for (workspace_id,) in ws_rows:
            provider_id = str(uuid.uuid4())
            model_id = str(uuid.uuid4())

            bind.execute(
                sa.text(
                    """
                    INSERT INTO providers (id, workspace_id, name, api_key, endpoint)
                    VALUES (:id, :ws, :name, :key, :endpoint)
                    """
                ),
                {
                    "id": provider_id,
                    "ws": str(workspace_id),
                    "name": "default",
                    "key": llm_api_key or "",
                    "endpoint": llm_base_url or "",
                },
            )
            bind.execute(
                sa.text(
                    """
                    INSERT INTO llm_models (
                        id, provider_id, display_name, api_name,
                        input_price_per_1m_usd, output_price_per_1m_usd
                    ) VALUES (:id, :provider, :display, :api, :ip, :op)
                    """
                ),
                {
                    "id": model_id,
                    "provider": provider_id,
                    "display": llm_model,
                    "api": llm_model,
                    "ip": input_price,
                    "op": output_price,
                },
            )
            bind.execute(
                sa.text(
                    """
                    UPDATE workspaces
                    SET orchestrator_model_id = :m,
                        chat_model_id = :m,
                        memory_extractor_model_id = :m
                    WHERE id = :ws
                    """
                ),
                {"m": model_id, "ws": str(workspace_id)},
            )
            bind.execute(
                sa.text("UPDATE templates SET model_id = :m WHERE workspace_id = :ws"),
                {"m": model_id, "ws": str(workspace_id)},
            )

    # 7. Drop legacy template columns
    op.drop_column("templates", "model")
    op.drop_column("templates", "provider_url")
    op.drop_column("templates", "provider_api_key")

    # 8. Delete legacy settings rows
    bind.execute(
        sa.text(
            "DELETE FROM settings WHERE key IN "
            "('llm_base_url', 'llm_api_key', 'llm_model', 'model_pricing')"
        )
    )


def downgrade():
    # Restore legacy template columns
    op.add_column("templates", sa.Column("model", sa.String(length=255), nullable=True))
    op.add_column("templates", sa.Column("provider_url", sa.String(length=500), nullable=True))
    op.add_column("templates", sa.Column("provider_api_key", sa.String(length=500), nullable=True))

    # Best-effort backfill: copy api_name from llm_models row referenced by templates.model_id
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE templates t
            SET model = m.api_name
            FROM llm_models m
            WHERE t.model_id = m.id
            """
        )
    )

    # Drop FKs and columns
    op.drop_constraint("fk_templates_model_id", "templates", type_="foreignkey")
    op.drop_column("templates", "model_id")

    op.drop_column("tasks", "output_price_per_1m_usd")
    op.drop_column("tasks", "input_price_per_1m_usd")

    for col in ("orchestrator_model_id", "chat_model_id", "memory_extractor_model_id"):
        op.drop_constraint(f"fk_workspaces_{col}", "workspaces", type_="foreignkey")
        op.drop_column("workspaces", col)

    op.drop_index("idx_llm_models_provider", table_name="llm_models")
    op.drop_table("llm_models")
    op.drop_index("idx_providers_workspace", table_name="providers")
    op.drop_table("providers")
