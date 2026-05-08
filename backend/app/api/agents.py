import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_workspace, require_role
from app.database import get_db
from app.models.workspace import Workspace
from app.plugins.runtime import get_agent_runtime
from app.utils.events import log_event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/agents", tags=["agents"])


@router.get("")
async def get_agents(workspace: Workspace = Depends(get_current_workspace)):
    """List active agent containers in this workspace."""
    return get_agent_runtime().list_active(workspace_id=str(workspace.id))


@router.get("/{container_id}")
async def get_agent(
    container_id: str,
    workspace: Workspace = Depends(get_current_workspace),
):
    stats = get_agent_runtime().stats(container_id, workspace_id=str(workspace.id))
    if not stats:
        raise HTTPException(status_code=404, detail="Container not found")
    return stats


@router.post("/{container_id}/kill", dependencies=[Depends(require_role("owner", "admin"))])
async def kill_agent_endpoint(
    container_id: str,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    runtime = get_agent_runtime()
    stats = runtime.stats(container_id, workspace_id=str(workspace.id))
    if not stats:
        raise HTTPException(status_code=404, detail="Container not found")
    task_id = stats.get("task_id")

    success = runtime.kill(container_id, workspace_id=str(workspace.id))
    if not success:
        raise HTTPException(status_code=404, detail="Container not found")

    if task_id:
        await log_event(
            db, "agent_killed", "user",
            {"container_id": container_id},
            task_id=task_id, workspace_id=workspace.id,
        )

    return {"status": "killed"}


@router.post("/kill-all", dependencies=[Depends(require_role("owner", "admin"))])
async def kill_all_endpoint(
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    """Kill all agent containers in this workspace (kill switch)."""
    count = get_agent_runtime().kill_all(workspace_id=str(workspace.id))
    await log_event(
        db, "kill_all_agents", "user", {"count": count}, workspace_id=workspace.id
    )
    return {"status": "ok", "killed": count}


@router.get("/{container_id}/health")
async def agent_health_endpoint(
    container_id: str,
    workspace: Workspace = Depends(get_current_workspace),
):
    runtime = get_agent_runtime()
    if not runtime.stats(container_id, workspace_id=str(workspace.id)):
        raise HTTPException(status_code=404, detail="Agent not found")
    health = await runtime.health(container_id)
    if health is None:
        raise HTTPException(status_code=404, detail="Agent unreachable")
    return health


class FeedbackBody(BaseModel):
    message: str


@router.post(
    "/{container_id}/feedback",
    dependencies=[Depends(require_role("owner", "admin", "member"))],
)
async def agent_feedback(
    container_id: str,
    body: FeedbackBody,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="message is empty")
    runtime = get_agent_runtime()
    stats = runtime.stats(container_id, workspace_id=str(workspace.id))
    if not stats:
        raise HTTPException(status_code=404, detail="Agent not found")
    ok = await runtime.send_command(container_id, "feedback", {"message": body.message})
    if not ok:
        raise HTTPException(status_code=502, detail="Agent did not accept feedback")
    task_id = stats.get("task_id")
    await log_event(
        db, "agent_feedback_sent", "user",
        {"message": body.message[:500]},
        task_id=task_id,
        agent_container_id=container_id,
        workspace_id=workspace.id,
    )
    return {"status": "queued"}


class SwitchModelBody(BaseModel):
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None


@router.post(
    "/{container_id}/switch_model",
    dependencies=[Depends(require_role("owner", "admin"))],
)
async def agent_switch_model(
    container_id: str,
    body: SwitchModelBody,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    if not (body.model or body.base_url or body.api_key):
        raise HTTPException(status_code=400, detail="provide at least one of model/base_url/api_key")
    runtime = get_agent_runtime()
    stats = runtime.stats(container_id, workspace_id=str(workspace.id))
    if not stats:
        raise HTTPException(status_code=404, detail="Agent not found")
    ok = await runtime.send_command(container_id, "switch_model", body.model_dump(exclude_none=True))
    if not ok:
        raise HTTPException(status_code=502, detail="Agent did not accept switch_model")
    task_id = stats.get("task_id")
    await log_event(
        db, "agent_model_switched", "user",
        {"model": body.model, "base_url": body.base_url},
        task_id=task_id,
        agent_container_id=container_id,
        workspace_id=workspace.id,
    )
    return {"status": "queued"}


class AbortBody(BaseModel):
    reason: str = "user requested"


@router.post(
    "/{container_id}/abort",
    dependencies=[Depends(require_role("owner", "admin"))],
)
async def agent_abort(
    container_id: str,
    body: AbortBody,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    runtime = get_agent_runtime()
    stats = runtime.stats(container_id, workspace_id=str(workspace.id))
    if not stats:
        raise HTTPException(status_code=404, detail="Agent not found")
    ok = await runtime.send_command(container_id, "abort", {"reason": body.reason})
    if not ok:
        raise HTTPException(status_code=502, detail="Agent unreachable")
    task_id = stats.get("task_id")
    await log_event(
        db, "agent_abort_signaled", "user",
        {"reason": body.reason},
        task_id=task_id,
        agent_container_id=container_id,
        workspace_id=workspace.id,
    )
    return {"status": "abort_signaled"}
