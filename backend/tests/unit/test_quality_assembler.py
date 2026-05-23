"""Unit tests for the Quality Data Lake assembler (E-01)."""

import uuid

import pytest

from app.models.agent_log import AgentLogChunk
from app.models.event import AgentEvent
from app.models.task import Task, TaskStatus
from app.models.workspace import DEFAULT_WORKSPACE_ID
from app.quality.data_lake import SCHEMA_VERSION, assemble_record

WS = DEFAULT_WORKSPACE_ID


@pytest.mark.asyncio
async def test_assemble_record_shape(db_session):
    task = Task(
        title="Build a Python CLI",
        description="d",
        status=TaskStatus.AWAITING_APPROVAL.value,
        workspace_id=WS,
        model_used="gpt-x",
        token_usage={"input_tokens": 100, "output_tokens": 50},
    )
    db_session.add(task)
    await db_session.flush()

    db_session.add(AgentEvent(
        task_id=task.id,
        event_type="agent_spawned",
        source="orchestrator",
        data={
            "template_id": str(uuid.uuid4()),
            "template_name": "Coder",
            "soul_md": "BE A CODER",
            "tools": ["bash"],
            "mcp_servers": [],
            "model_api_name": "gpt-x",
            "memory_context": "ctx",
            "flat_memory": {"rules_md": "r", "memory_md": "m"},
            "resource_limits": {"max_ram": "2g"},
        },
        workspace_id=WS,
    ))
    for i, tool in enumerate(["bash", "file_write", None]):
        db_session.add(AgentLogChunk(
            task_id=task.id, workspace_id=WS, chunk_seq=i, content="x", tool_name=tool
        ))
    await db_session.flush()

    blob = await assemble_record(db_session, task)

    assert blob["schema_version"] == SCHEMA_VERSION
    assert blob["execution"]["soul_md"] == "BE A CODER"
    assert blob["execution"]["memory_context"] == "ctx"
    assert blob["execution"]["flat_memory"]["rules_md"] == "r"
    # only chunks with a tool_name become tool calls, in order
    assert [t["tool_name"] for t in blob["execution"]["tool_calls"]] == ["bash", "file_write"]
    assert blob["decomposition"]["is_root"] is False
    assert blob["task"]["input_tokens"] == 100
    # downstream slots are present but empty
    assert set(blob["slots"]) == {
        "quality_profile", "trajectory_profile", "human_feedback",
        "longitudinal", "reproducibility",
    }
    assert all(v is None for v in blob["slots"].values())


@pytest.mark.asyncio
async def test_assemble_decomposition_root(db_session):
    parent = Task(title="parent", status=TaskStatus.DONE.value, workspace_id=WS)
    db_session.add(parent)
    await db_session.flush()
    child = Task(
        title="child", status=TaskStatus.DONE.value, workspace_id=WS,
        parent_id=parent.id, model_used="m",
    )
    db_session.add(child)
    await db_session.flush()

    blob = await assemble_record(db_session, parent)
    assert blob["decomposition"]["is_root"] is True
    assert len(blob["decomposition"]["subtasks"]) == 1
    assert blob["decomposition"]["subtasks"][0]["title"] == "child"
