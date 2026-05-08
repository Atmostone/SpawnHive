import json
import time
import zipfile
from datetime import datetime
from io import BytesIO
from typing import Optional

from fastapi import APIRouter, Depends

from app.plugins.llm import get_llm_provider
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.health import health_check
from app.auth.dependencies import get_current_user, get_current_workspace, require_role
from app.config import Settings, get_settings as get_app_settings
from app.database import get_db
from app.models.event import AgentEvent
from app.models.knowledge_document import KnowledgeDocument
from app.models.setting import Setting
from app.models.task import Task
from app.models.template import Template
from app.models.workspace import Workspace

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingOut(BaseModel):
    key: str
    value: object
    updated_at: str

    class Config:
        from_attributes = True


@router.get("", dependencies=[Depends(get_current_user)])
async def get_settings(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Setting))
    settings = result.scalars().all()
    return {s.key: s.value for s in settings}


@router.patch("", dependencies=[Depends(require_role("owner", "admin"))])
async def update_settings(
    updates: dict,
    db: AsyncSession = Depends(get_db),
):
    for key, value in updates.items():
        existing = await db.get(Setting, key)
        if existing:
            existing.value = value
        else:
            db.add(Setting(key=key, value=value))
    await db.commit()
    return {"status": "ok"}


async def get_setting(db: AsyncSession, key: str, default=None):
    setting = await db.get(Setting, key)
    if setting:
        return setting.value
    return default


async def get_llm_settings(db: AsyncSession) -> dict:
    """Read LLM connection config. Secrets (api_key) go through SecretsProvider
    so a future Vault/SOPS-backed impl can take over without rewriting callers."""
    from app.plugins.secrets import get_secrets_provider

    secrets = get_secrets_provider()
    return {
        "llm_base_url": await get_setting(db, "llm_base_url"),
        "llm_api_key": await secrets.get(db, "llm_api_key"),
        "llm_model": await get_setting(db, "llm_model"),
    }


@router.get("/health")
async def settings_health(
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_app_settings),
):
    """Alias for /api/health, exposed under /api/settings per spec §4.7."""
    return await health_check(db=db, settings=settings)


class LLMTestBody(BaseModel):
    llm_base_url: Optional[str] = None
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None


@router.post("/test-llm", dependencies=[Depends(require_role("owner", "admin"))])
async def test_llm(body: LLMTestBody, db: AsyncSession = Depends(get_db)):
    """Probe configured (or supplied) LLM endpoint with a tiny completion."""
    from app.plugins.secrets import get_secrets_provider

    secrets = get_secrets_provider()
    base_url = body.llm_base_url or await get_setting(db, "llm_base_url")
    api_key = body.llm_api_key or await secrets.get(db, "llm_api_key")
    model = body.llm_model or await get_setting(db, "llm_model") or "MiniMax-M2.7"

    if not base_url or not api_key:
        return {"status": "error", "error": "llm_base_url or llm_api_key not configured"}

    started = time.perf_counter()
    try:
        resp = await get_llm_provider().acompletion(
            model=model,
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=5,
            api_base=base_url,
            api_key=api_key,
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        sample = (resp.choices[0].message.content or "")[:80]
        return {"status": "ok", "latency_ms": latency_ms, "model": model, "sample": sample}
    except Exception as e:
        return {"status": "error", "error": str(e)[:300]}


EXPORT_EVENTS_LIMIT = 10_000


def _model_dump_compat(rows: list, serializer) -> list[dict]:
    return [serializer(r) for r in rows]


@router.get("/export-all", dependencies=[Depends(require_role("owner", "admin"))])
async def export_all(
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    """Bundle this workspace's tasks/templates/events/settings/rules.md/memory.md into a ZIP."""
    import os
    from app.api.tasks import task_to_dict
    from app.api.templates import template_to_dict
    from app.api.events import event_to_dict

    ws_id = workspace.id
    tasks = (
        await db.execute(select(Task).where(Task.workspace_id == ws_id))
    ).scalars().all()
    templates = (
        await db.execute(select(Template).where(Template.workspace_id == ws_id))
    ).scalars().all()
    events = (
        await db.execute(
            select(AgentEvent)
            .where(AgentEvent.workspace_id == ws_id)
            .order_by(AgentEvent.created_at.desc())
            .limit(EXPORT_EVENTS_LIMIT)
        )
    ).scalars().all()
    settings_rows = (await db.execute(select(Setting))).scalars().all()
    docs = (
        await db.execute(
            select(KnowledgeDocument).where(KnowledgeDocument.workspace_id == ws_id)
        )
    ).scalars().all()

    app_settings = get_app_settings()
    rules = ""
    memory = ""
    base_shared = os.path.join(app_settings.data_dir, "shared", str(ws_id))
    try:
        with open(os.path.join(base_shared, "rules.md")) as f:
            rules = f.read()
    except FileNotFoundError:
        pass
    try:
        with open(os.path.join(base_shared, "memory.md")) as f:
            memory = f.read()
    except FileNotFoundError:
        pass

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("meta.json", json.dumps({
            "exported_at": datetime.utcnow().isoformat(),
            "workspace_id": str(ws_id),
            "workspace_slug": workspace.slug,
            "events_limit": EXPORT_EVENTS_LIMIT,
            "events_truncated": len(events) >= EXPORT_EVENTS_LIMIT,
        }, indent=2))
        zf.writestr("tasks.json", json.dumps(_model_dump_compat(tasks, task_to_dict), indent=2))
        zf.writestr("templates.json", json.dumps(_model_dump_compat(templates, template_to_dict), indent=2))
        zf.writestr("events.json", json.dumps(_model_dump_compat(events, event_to_dict), indent=2))
        zf.writestr("settings.json", json.dumps({s.key: s.value for s in settings_rows}, indent=2))
        zf.writestr("documents.json", json.dumps([{
            "id": str(d.id), "filename": d.filename, "s3_path": d.s3_path,
            "chunk_count": d.chunk_count,
            "created_at": d.created_at.isoformat() if d.created_at else None,
        } for d in docs], indent=2))
        zf.writestr("rules.md", rules)
        zf.writestr("memory.md", memory)

    buf.seek(0)
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="spawnhive_backup_{ws_id}_{ts}.zip"'},
    )
