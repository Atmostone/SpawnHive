"""Orchestrator engine: polls for Ready tasks and manages agent lifecycle."""

import asyncio
import logging
import uuid
from datetime import datetime

from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import issue_agent_token
from app.database import async_session
from app.models.task import Task, TaskStatus
from app.models.template import Template
from app.api.settings import get_llm_settings, get_setting
from app.api.templates import template_to_dict
from app.orchestrator.docker_manager import effective_llm_config
from app.orchestrator.llm import (
    decide_decomposition,
    select_template_for_task,
)
from app.plugins.runtime import AgentSpec, get_agent_runtime
from app.utils.events import log_event

logger = logging.getLogger(__name__)

POLL_INTERVAL = 5  # seconds


async def process_ready_task(db: AsyncSession, task: Task):
    """Process a single Ready task: decompose or select template + spawn agent."""
    logger.info(f"Processing task {task.id}: {task.title}")

    # Mark as decomposing while we decide
    task.status = TaskStatus.DECOMPOSING.value
    await db.commit()

    await log_event(
        db, "orchestrator_decision", "orchestrator",
        {"action": "processing_task", "title": task.title},
        task_id=task.id,
    )

    # Get LLM settings and templates (scoped to task's workspace)
    llm_settings = await get_llm_settings(db)
    result = await db.execute(
        select(Template).where(Template.workspace_id == task.workspace_id)
    )
    templates = result.scalars().all()

    if not templates:
        logger.error("No templates available, cannot process task")
        task.status = TaskStatus.FAILED.value
        await db.commit()
        await log_event(
            db, "orchestrator_decision", "orchestrator",
            {"action": "failed", "reason": "No templates available"},
            task_id=task.id,
        )
        return

    templates_list = [template_to_dict(t) for t in templates]

    # Step 1: Decide whether to decompose (only if task has no parent — avoid nested decomposition)
    decomposition_enabled = bool(await get_setting(db, "decomposition_enabled", True))
    if decomposition_enabled and not task.parent_id and len(templates_list) > 1:
        subtasks = await decide_decomposition(
            task.title, task.description or "", templates_list, llm_settings,
            db=db, task_id=task.id,
        )
        if subtasks:
            # Validate dependency indices are acyclic (forward-only references)
            for i, st in enumerate(subtasks):
                deps = st.get("depends_on_indices") or []
                for d in deps:
                    if not isinstance(d, int) or d < 0 or d >= i:
                        await log_event(
                            db, "decomposition_failed_cycle", "orchestrator",
                            {"subtask_index": i, "bad_index": d, "subtask_count": len(subtasks)},
                            task_id=task.id,
                        )
                        task.status = TaskStatus.FAILED.value
                        await db.commit()
                        return

            created_subs: list[Task] = []
            for st in subtasks:
                sub = Task(
                    parent_id=task.id,
                    title=st["title"],
                    description=st.get("description", ""),
                    priority=task.priority,
                    status=TaskStatus.READY.value,
                    workspace_id=task.workspace_id,
                )
                db.add(sub)
                created_subs.append(sub)

            await db.flush()
            for st, sub in zip(subtasks, created_subs):
                deps = [
                    created_subs[i].id
                    for i in (st.get("depends_on_indices") or [])
                    if 0 <= i < len(created_subs)
                ]
                sub.depends_on = deps

            task.status = TaskStatus.IN_PROGRESS.value
            task.started_at = datetime.utcnow()
            await db.commit()

            await log_event(
                db, "orchestrator_decision", "orchestrator",
                {"action": "decomposed", "subtask_count": len(subtasks),
                 "subtasks": [s["title"] for s in subtasks]},
                task_id=task.id,
            )
            logger.info(f"Decomposed task {task.id} into {len(subtasks)} subtasks")
            return

    # Step 2: Select template
    selection = await select_template_for_task(
        task.title, task.description or "", templates_list, llm_settings,
        db=db, task_id=task.id,
    )
    if not selection:
        task.status = TaskStatus.FAILED.value
        await db.commit()
        await log_event(
            db, "orchestrator_decision", "orchestrator",
            {"action": "failed", "reason": "Template selection failed"},
            task_id=task.id,
        )
        return

    template_id = selection["template_id"]
    template = await db.get(Template, uuid.UUID(template_id))
    if not template:
        logger.error(f"Selected template {template_id} not found")
        task.status = TaskStatus.FAILED.value
        await db.commit()
        return

    task.template_id = template.id

    await log_event(
        db, "orchestrator_decision", "orchestrator",
        {"action": "template_selected", "template_id": str(template.id),
         "template_name": template.name, "reasoning": selection.get("reasoning", "")},
        task_id=task.id,
    )

    # Step 3: Spawn agent
    try:
        # Build description with feedback if this is a retry after rejection
        desc_parts = [task.title, "", task.description or ""]
        if task.user_feedback:
            desc_parts.append(f"\n\n--- USER FEEDBACK (from rejection) ---\n{task.user_feedback}\nPlease address this feedback. Previous workspace files are available.")
        if task.orchestrator_feedback:
            desc_parts.append(f"\n\n--- ORCHESTRATOR FEEDBACK ---\n{task.orchestrator_feedback}")

        if task.depends_on:
            dep_rows = (
                await db.execute(select(Task).where(Task.id.in_(task.depends_on)))
            ).scalars().all()
            for dep in dep_rows:
                if dep.status == TaskStatus.DONE.value and (dep.result_summary or dep.result_files):
                    short_id = str(dep.id)[:8]
                    files_line = f"Files: {', '.join(dep.result_files or []) or 'none'}"
                    desc_parts.append(
                        f"\n\n## Dependency: {dep.title} (#{short_id})\n"
                        f"{dep.result_summary or '(no summary)'}\n\n{files_line}"
                    )

        memory_context = ""

        if (await get_setting(db, "memory_mode", "flat")) == "structured":
            from app.memory.store import build_memory_context

            try:
                memory_context = await build_memory_context(
                    db,
                    query_text=f"{task.title}\n{task.description or ''}",
                    workspace_id=task.workspace_id,
                )
            except Exception as e:
                logger.warning(f"Memory context build failed for task {task.id}: {e}")

        agent_llm = effective_llm_config(template, llm_settings)
        agent_token = await issue_agent_token(
            db, task_id=task.id, workspace_id=task.workspace_id
        )
        await db.commit()
        runtime = get_agent_runtime()
        spec = AgentSpec(
            task_id=str(task.id),
            task_description="\n".join(desc_parts),
            template_name=template.name,
            template_id=str(template.id),
            soul_md=template.soul_md or "",
            tools=list(template.tools or []),
            mcp_servers=list(template.mcp_servers or []),
            env={
                "OPENAI_API_KEY": agent_llm.get("llm_api_key", ""),
                "OPENAI_BASE_URL": agent_llm.get("llm_base_url", ""),
                "LLM_MODEL": agent_llm.get("llm_model", ""),
            },
            resource_limits={
                "max_ram": template.max_ram,
                "max_cpu": template.max_cpu,
            },
            workspace_id=str(task.workspace_id),
            agent_token=agent_token,
            memory_context=memory_context,
        )
        container_id = runtime.spawn(spec)
        task.agent_container_id = container_id
        task.model_used = agent_llm.get("llm_model")
        task.status = TaskStatus.IN_PROGRESS.value
        task.started_at = datetime.utcnow()
        await db.commit()

        await log_event(
            db, "agent_spawned", "orchestrator",
            {"container_id": container_id, "template_name": template.name},
            task_id=task.id, agent_container_id=container_id,
        )
        logger.info(f"Spawned agent {container_id[:12]} for task {task.id}")

    except Exception as e:
        logger.error(f"Failed to spawn agent: {e}", exc_info=True)
        task.status = TaskStatus.FAILED.value
        await db.commit()
        await log_event(
            db, "orchestrator_decision", "orchestrator",
            {"action": "spawn_failed", "error": str(e)},
            task_id=task.id,
        )


async def check_parent_task_completion(db: AsyncSession, task: Task):
    """Check if all subtasks of a parent are done, and update parent accordingly."""
    if not task.parent_id:
        return

    parent = await db.get(Task, task.parent_id)
    if not parent:
        return

    # Get all sibling subtasks
    result = await db.execute(
        select(Task).where(Task.parent_id == parent.id)
    )
    subtasks = result.scalars().all()

    all_done = all(s.status in (TaskStatus.DONE.value, TaskStatus.FAILED.value) for s in subtasks)
    if not all_done:
        return

    any_failed = any(s.status == TaskStatus.FAILED.value for s in subtasks)
    if any_failed:
        parent.status = TaskStatus.FAILED.value
    else:
        parent.status = TaskStatus.DONE.value
    parent.completed_at = datetime.utcnow()
    await db.commit()

    await log_event(
        db, "task_status_changed", "system",
        {"new_status": parent.status, "reason": "all subtasks completed"},
        task_id=parent.id,
    )


async def check_timed_out_tasks():
    """Kill containers for tasks that exceeded their timeout."""
    from app.api.settings import get_setting

    try:
        async with async_session() as db:
            timeout_minutes = await get_setting(db, "task_timeout_minutes", 60)

            result = await db.execute(
                select(Task).where(
                    Task.status == TaskStatus.IN_PROGRESS.value,
                    Task.started_at.isnot(None),
                )
            )
            tasks = result.scalars().all()

            for task in tasks:
                if not task.started_at:
                    continue
                elapsed = (datetime.utcnow() - task.started_at).total_seconds() / 60
                if elapsed > timeout_minutes:
                    logger.warning(f"Task {task.id} timed out ({elapsed:.0f}m > {timeout_minutes}m)")

                    if task.agent_container_id:
                        get_agent_runtime().kill(task.agent_container_id)

                    task.status = TaskStatus.FAILED.value
                    task.completed_at = datetime.utcnow()
                    await db.commit()

                    await log_event(
                        db, "task_timeout", "system",
                        {"elapsed_minutes": round(elapsed), "timeout": timeout_minutes},
                        task_id=task.id,
                        agent_container_id=task.agent_container_id,
                    )
    except Exception as e:
        logger.error(f"Timeout check error: {e}")


async def orchestrator_loop():
    """Main polling loop: check for Ready tasks every POLL_INTERVAL seconds.

    Uses SELECT ... FOR UPDATE SKIP LOCKED on the chosen row to make this safe
    against accidental concurrent runs (e.g. dev hot-reload, replicas).
    """
    logger.info("Orchestrator engine started")
    timeout_check_counter = 0

    while True:
        try:
            async with async_session() as db:
                # Find tasks with status=ready, prioritized, deps satisfied
                priority_order = case(
                    (Task.priority == "urgent", 1),
                    (Task.priority == "high", 2),
                    (Task.priority == "medium", 3),
                    (Task.priority == "low", 4),
                    else_=5,
                )
                result = await db.execute(
                    select(Task.id, Task.depends_on)
                    .where(Task.status == TaskStatus.READY.value)
                    .order_by(priority_order, Task.created_at)
                )
                candidates = result.all()
                picked_id = None
                for cand_id, deps in candidates:
                    deps = deps or []
                    if not deps:
                        picked_id = cand_id
                        break
                    dep_rows = (
                        await db.execute(
                            select(Task.status).where(Task.id.in_(deps))
                        )
                    ).all()
                    if (
                        len(dep_rows) == len(deps)
                        and all((row[0] == TaskStatus.DONE.value) for row in dep_rows)
                    ):
                        picked_id = cand_id
                        break

                if picked_id is not None:
                    # Re-fetch with row lock; SKIP LOCKED so concurrent orchestrators
                    # never pick the same row.
                    locked = (
                        await db.execute(
                            select(Task)
                            .where(
                                Task.id == picked_id,
                                Task.status == TaskStatus.READY.value,
                            )
                            .with_for_update(skip_locked=True)
                        )
                    ).scalar_one_or_none()
                    if locked is not None:
                        from app.api.settings import get_setting
                        max_agents = await get_setting(db, "max_concurrent_agents", 3)
                        active = len(get_agent_runtime().list_active())
                        if active < int(max_agents):
                            await process_ready_task(db, locked)
                        else:
                            logger.debug(
                                f"concurrency limit reached: {active}/{max_agents}, "
                                f"task {locked.id} stays in READY"
                            )

            # Check for timed out tasks every ~60 seconds (12 * 5s)
            timeout_check_counter += 1
            if timeout_check_counter >= 12:
                timeout_check_counter = 0
                await check_timed_out_tasks()

        except Exception as e:
            logger.error(f"Orchestrator loop error: {e}", exc_info=True)

        await asyncio.sleep(POLL_INTERVAL)
