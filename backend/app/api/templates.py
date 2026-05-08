import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_workspace, require_role
from app.database import get_db
from app.models.template import Template
from app.models.template_version import TemplateVersion
from app.models.workspace import Workspace

router = APIRouter(prefix="/api/templates", tags=["templates"])


class TemplateCreate(BaseModel):
    name: str
    description: str
    soul_md: str
    model: Optional[str] = None
    provider_url: Optional[str] = None
    provider_api_key: Optional[str] = None
    tools: list = []
    mcp_servers: list = []
    max_ram: str = "2g"
    max_cpu: int = 100000
    timeout_minutes: int = 60
    tags: list = []


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    soul_md: Optional[str] = None
    model: Optional[str] = None
    provider_url: Optional[str] = None
    provider_api_key: Optional[str] = None
    tools: Optional[list] = None
    mcp_servers: Optional[list] = None
    max_ram: Optional[str] = None
    max_cpu: Optional[int] = None
    timeout_minutes: Optional[int] = None
    tags: Optional[list] = None


def template_to_dict(t: Template) -> dict:
    return {
        "id": str(t.id),
        "name": t.name,
        "description": t.description,
        "soul_md": t.soul_md,
        "model": t.model,
        "provider_url": t.provider_url,
        "provider_api_key": "***" if t.provider_api_key else None,
        "tools": t.tools,
        "mcp_servers": t.mcp_servers,
        "max_ram": t.max_ram,
        "max_cpu": t.max_cpu,
        "timeout_minutes": t.timeout_minutes,
        "tags": t.tags,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


async def _get_scoped_template(
    template_id: str, workspace: Workspace, db: AsyncSession
) -> Template:
    template = await db.get(Template, uuid.UUID(template_id))
    if not template or template.workspace_id != workspace.id:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


@router.get("")
async def list_templates(
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Template).where(Template.workspace_id == workspace.id).order_by(Template.name)
    )
    templates = result.scalars().all()
    return [template_to_dict(t) for t in templates]


@router.post(
    "",
    status_code=201,
    dependencies=[Depends(require_role("owner", "admin", "member"))],
)
async def create_template(
    body: TemplateCreate,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    template = Template(
        name=body.name,
        description=body.description,
        soul_md=body.soul_md,
        model=body.model,
        provider_url=body.provider_url,
        provider_api_key=body.provider_api_key,
        tools=body.tools,
        mcp_servers=body.mcp_servers,
        max_ram=body.max_ram,
        max_cpu=body.max_cpu,
        timeout_minutes=body.timeout_minutes,
        tags=body.tags,
        workspace_id=workspace.id,
    )
    db.add(template)
    await db.commit()
    await db.refresh(template)
    return template_to_dict(template)


@router.get("/{template_id}")
async def get_template(
    template_id: str,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    return template_to_dict(await _get_scoped_template(template_id, workspace, db))


def _full_template_snapshot(t: Template) -> dict:
    """Snapshot used for versioning — includes secret to allow exact rollback."""
    return {
        "name": t.name,
        "description": t.description,
        "soul_md": t.soul_md,
        "model": t.model,
        "provider_url": t.provider_url,
        "provider_api_key": t.provider_api_key,
        "tools": t.tools,
        "mcp_servers": t.mcp_servers,
        "max_ram": t.max_ram,
        "max_cpu": t.max_cpu,
        "timeout_minutes": t.timeout_minutes,
        "tags": t.tags,
    }


async def _next_version(db: AsyncSession, template_id: uuid.UUID) -> int:
    cur = await db.scalar(
        select(func.max(TemplateVersion.version)).where(
            TemplateVersion.template_id == template_id
        )
    )
    return int(cur or 0) + 1


@router.put(
    "/{template_id}",
    dependencies=[Depends(require_role("owner", "admin", "member"))],
)
async def update_template(
    template_id: str,
    body: TemplateUpdate,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    template = await _get_scoped_template(template_id, workspace, db)

    db.add(TemplateVersion(
        template_id=template.id,
        version=await _next_version(db, template.id),
        snapshot=_full_template_snapshot(template),
        commit_message="auto: pre-update snapshot",
        workspace_id=workspace.id,
    ))

    payload = body.model_dump(exclude_unset=True)
    if "provider_api_key" in payload and payload["provider_api_key"] in (None, "", "***"):
        payload.pop("provider_api_key")
    for field, value in payload.items():
        setattr(template, field, value)

    await db.commit()
    await db.refresh(template)
    return template_to_dict(template)


@router.get("/{template_id}/versions")
async def list_versions(
    template_id: str,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    await _get_scoped_template(template_id, workspace, db)
    rows = (
        await db.execute(
            select(TemplateVersion)
            .where(TemplateVersion.template_id == uuid.UUID(template_id))
            .order_by(TemplateVersion.version.desc())
        )
    ).scalars().all()
    return [
        {
            "id": str(v.id),
            "version": v.version,
            "commit_message": v.commit_message,
            "created_at": v.created_at.isoformat() if v.created_at else None,
            "created_by": v.created_by,
        }
        for v in rows
    ]


@router.get("/{template_id}/versions/{version}")
async def get_version(
    template_id: str,
    version: int,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    await _get_scoped_template(template_id, workspace, db)
    row = (
        await db.execute(
            select(TemplateVersion).where(
                TemplateVersion.template_id == uuid.UUID(template_id),
                TemplateVersion.version == version,
            )
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Version not found")
    return {
        "id": str(row.id),
        "version": row.version,
        "snapshot": row.snapshot,
        "commit_message": row.commit_message,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@router.post(
    "/{template_id}/rollback/{version}",
    dependencies=[Depends(require_role("owner", "admin"))],
)
async def rollback_template(
    template_id: str,
    version: int,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    template = await _get_scoped_template(template_id, workspace, db)
    src = (
        await db.execute(
            select(TemplateVersion).where(
                TemplateVersion.template_id == template.id,
                TemplateVersion.version == version,
            )
        )
    ).scalar_one_or_none()
    if not src:
        raise HTTPException(status_code=404, detail="Version not found")

    # Snapshot current before rollback so we can roll back the rollback.
    db.add(TemplateVersion(
        template_id=template.id,
        version=await _next_version(db, template.id),
        snapshot=_full_template_snapshot(template),
        commit_message=f"auto: pre-rollback to v{version}",
        workspace_id=workspace.id,
    ))

    snap = src.snapshot or {}
    for field, value in snap.items():
        setattr(template, field, value)

    db.add(TemplateVersion(
        template_id=template.id,
        version=await _next_version(db, template.id),
        snapshot=_full_template_snapshot(template),
        commit_message=f"rollback to v{version}",
        workspace_id=workspace.id,
    ))

    await db.commit()
    await db.refresh(template)
    return template_to_dict(template)


@router.delete(
    "/{template_id}",
    dependencies=[Depends(require_role("owner", "admin"))],
)
async def delete_template(
    template_id: str,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    template = await _get_scoped_template(template_id, workspace, db)
    await db.delete(template)
    await db.commit()
    return {"status": "deleted"}
