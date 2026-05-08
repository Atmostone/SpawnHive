import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_workspace
from app.database import get_db
from app.models.task import Task, TaskPriority, TaskStatus
from app.models.workspace import Workspace
from app.utils.events import log_event

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = None
    priority: str = TaskPriority.MEDIUM.value
    parent_id: Optional[str] = None


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None


class TaskOut(BaseModel):
    id: str
    parent_id: Optional[str]
    title: str
    description: Optional[str]
    status: str
    priority: str
    template_id: Optional[str]
    agent_container_id: Optional[str]
    result_summary: Optional[str]
    result_files: list
    token_usage: dict
    retry_count: int
    max_retries: int
    user_feedback: Optional[str]
    orchestrator_feedback: Optional[str]
    created_at: str
    updated_at: str
    started_at: Optional[str]
    completed_at: Optional[str]

    class Config:
        from_attributes = True


def task_to_dict(task: Task) -> dict:
    return {
        "id": str(task.id),
        "parent_id": str(task.parent_id) if task.parent_id else None,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "template_id": str(task.template_id) if task.template_id else None,
        "agent_container_id": task.agent_container_id,
        "result_summary": task.result_summary,
        "result_files": task.result_files,
        "token_usage": task.token_usage,
        "retry_count": task.retry_count,
        "max_retries": task.max_retries,
        "user_feedback": task.user_feedback,
        "orchestrator_feedback": task.orchestrator_feedback,
        "model_used": task.model_used,
        "cost_usd": float(task.cost_usd) if task.cost_usd is not None else 0.0,
        "depends_on": [str(d) for d in (task.depends_on or [])],
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "updated_at": task.updated_at.isoformat() if task.updated_at else None,
        "started_at": task.started_at.isoformat() if task.started_at else None,
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
    }


async def _get_scoped_task(task_id: str, workspace: Workspace, db: AsyncSession) -> Task:
    task = await db.get(Task, uuid.UUID(task_id))
    if not task or task.workspace_id != workspace.id:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("")
async def list_tasks(
    status: Optional[str] = None,
    parent_id: Optional[str] = None,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    query = select(Task).where(Task.workspace_id == workspace.id)
    if status:
        query = query.where(Task.status == status)
    if parent_id:
        query = query.where(Task.parent_id == uuid.UUID(parent_id))
    query = query.order_by(Task.created_at.desc())
    result = await db.execute(query)
    tasks = result.scalars().all()
    return [task_to_dict(t) for t in tasks]


@router.post("", status_code=201)
async def create_task(
    body: TaskCreate,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    task = Task(
        title=body.title,
        description=body.description,
        priority=body.priority,
        parent_id=uuid.UUID(body.parent_id) if body.parent_id else None,
        workspace_id=workspace.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    await log_event(
        db, "task_created", "user", {"title": task.title},
        task_id=task.id, workspace_id=workspace.id,
    )
    return task_to_dict(task)


@router.get("/{task_id}")
async def get_task(
    task_id: str,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    task = await _get_scoped_task(task_id, workspace, db)

    result = task_to_dict(task)

    # Include subtasks (also workspace-scoped)
    sub_query = select(Task).where(Task.parent_id == task.id, Task.workspace_id == workspace.id)
    sub_result = await db.execute(sub_query)
    result["subtasks"] = [task_to_dict(s) for s in sub_result.scalars().all()]

    return result


@router.patch("/{task_id}")
async def update_task(
    task_id: str,
    body: TaskUpdate,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    task = await _get_scoped_task(task_id, workspace, db)

    old_status = task.status
    if body.title is not None:
        task.title = body.title
    if body.description is not None:
        task.description = body.description
    if body.priority is not None:
        task.priority = body.priority
    if body.status is not None:
        task.status = body.status
        if body.status == TaskStatus.IN_PROGRESS.value and not task.started_at:
            task.started_at = datetime.utcnow()
        if body.status in (TaskStatus.DONE.value, TaskStatus.FAILED.value):
            task.completed_at = datetime.utcnow()

    await db.commit()
    await db.refresh(task)

    if body.status and body.status != old_status:
        await log_event(
            db, "task_status_changed", "user",
            {"old_status": old_status, "new_status": body.status},
            task_id=task.id, workspace_id=workspace.id,
        )

    return task_to_dict(task)


@router.patch("/{task_id}/approve")
async def approve_task(
    task_id: str,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    task = await _get_scoped_task(task_id, workspace, db)
    if task.status != TaskStatus.AWAITING_APPROVAL.value:
        raise HTTPException(status_code=400, detail="Task not in awaiting_approval status")

    task.status = TaskStatus.DONE.value
    task.completed_at = datetime.utcnow()
    await db.commit()
    await db.refresh(task)
    await log_event(db, "user_approval", "user", {}, task_id=task.id, workspace_id=workspace.id)
    return task_to_dict(task)


@router.patch("/{task_id}/reject")
async def reject_task(
    task_id: str,
    body: dict,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    task = await _get_scoped_task(task_id, workspace, db)
    if task.status != TaskStatus.AWAITING_APPROVAL.value:
        raise HTTPException(status_code=400, detail="Task not in awaiting_approval status")

    task.user_feedback = body.get("feedback", "")
    task.status = TaskStatus.READY.value
    task.agent_container_id = None
    await db.commit()
    await db.refresh(task)
    await log_event(
        db, "user_rejection", "user",
        {"feedback": task.user_feedback, "action": "re-queued to ready"},
        task_id=task.id, workspace_id=workspace.id,
    )
    return task_to_dict(task)


@router.delete("/{task_id}")
async def delete_task(
    task_id: str,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    task = await _get_scoped_task(task_id, workspace, db)
    if task.status != TaskStatus.BACKLOG.value:
        raise HTTPException(status_code=400, detail="Can only delete tasks in backlog")
    # Delete related events and chat messages first (FK constraints)
    from app.models.event import AgentEvent
    from app.models.chat_message import ChatMessage
    from sqlalchemy import delete
    await db.execute(delete(AgentEvent).where(AgentEvent.task_id == task.id))
    await db.execute(delete(ChatMessage).where(ChatMessage.related_task_id == task.id))
    await db.delete(task)
    await db.commit()
    return {"status": "deleted"}


@router.get("/{task_id}/files/{file_name:path}")
async def download_task_file(
    task_id: str,
    file_name: str,
    workspace: Workspace = Depends(get_current_workspace),
    db: AsyncSession = Depends(get_db),
):
    """Download a result file from MinIO."""
    # Side-effect: scoping check — raises 404 if task isn't in this workspace.
    await _get_scoped_task(task_id, workspace, db)

    s3_path = f"results/{task_id}/{file_name}"

    try:
        from app.storage.minio_client import get_file_stream
        stream = get_file_stream(s3_path)
        return StreamingResponse(
            stream,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{file_name}"'},
        )
    except Exception:
        raise HTTPException(status_code=404, detail="File not found")
