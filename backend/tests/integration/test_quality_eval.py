"""Integration tests for the Quality Rubric Engine (E-02): CRUD, eval, scheduler."""

import json
import uuid
from unittest.mock import MagicMock

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app import database
from app.models.provider import LLMModel, Provider
from app.models.quality_record import QualityRecord
from app.models.rubric import Rubric
from app.models.scheduled_job import ScheduledJob
from app.models.setting import Setting
from app.models.task import Task, TaskStatus
from app.models.workspace import DEFAULT_WORKSPACE_ID, Workspace
from app.quality import judge as judge_mod


def _resp(score, pt=10, ct=4):
    fn = MagicMock()
    fn.arguments = json.dumps({"score": score, "reasoning": "ok"})
    tc = MagicMock()
    tc.function = fn
    resp = MagicMock()
    resp.choices = [MagicMock(message=MagicMock(tool_calls=[tc]))]
    resp.usage = {"prompt_tokens": pt, "completion_tokens": ct}
    return resp


class _FakeProvider:
    def __init__(self, score=8):
        self.score = score

    async def acompletion(self, **kwargs):
        return _resp(self.score)


class _RaisingProvider:
    """Judge LLM that always errors — to exercise the fail-closed gate (SPA-51)."""

    async def acompletion(self, **kwargs):
        raise RuntimeError("judge LLM down")


async def _seed_judge_model(s, workspace_id, *, kind="quality_judge_model_id"):
    prov = Provider(workspace_id=workspace_id, name="p", api_key="k", endpoint="http://x/v1")
    s.add(prov)
    await s.flush()
    model = LLMModel(
        provider_id=prov.id, display_name="M", api_name="m",
        input_price_per_1m_usd=1, output_price_per_1m_usd=2,
    )
    s.add(model)
    await s.flush()
    ws = await s.get(Workspace, workspace_id)
    setattr(ws, kind, model.id)
    return model


@pytest.mark.asyncio
async def test_default_rubrics_seeded_on_register(auth_client: AsyncClient):
    r = await auth_client.get("/api/quality/rubrics")
    assert r.status_code == 200
    rubrics = r.json()
    names = {x["name"] for x in rubrics}
    assert {"Analytical Report", "Code", "Content", "Design", "Data Analysis"} <= names
    assert sum(1 for x in rubrics if x["is_default"]) == 1


@pytest.mark.asyncio
async def test_rubric_crud_and_single_default(auth_client: AsyncClient):
    # create
    body = {
        "name": "My Rubric", "description": "d", "applies_to": "coding",
        "is_default": True,
        "dimensions": [
            {"key": "correctness", "name": "Correctness", "evaluator": "judge",
             "weight": 1.0, "threshold": 6, "critical": True},
        ],
    }
    r = await auth_client.post("/api/quality/rubrics", json=body)
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    assert r.json()["dimensions"][0]["key"] == "correctness"

    # setting this default cleared the seeded default → exactly one default
    r = await auth_client.get("/api/quality/rubrics")
    assert sum(1 for x in r.json() if x["is_default"]) == 1

    # update
    r = await auth_client.patch(f"/api/quality/rubrics/{rid}", json={"name": "Renamed"})
    assert r.status_code == 200 and r.json()["name"] == "Renamed"

    # delete
    r = await auth_client.delete(f"/api/quality/rubrics/{rid}")
    assert r.status_code == 200
    r = await auth_client.get(f"/api/quality/rubrics/{rid}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_rubric_workspace_isolation(auth_client: AsyncClient):
    async with database.async_session() as s:
        other = Rubric(workspace_id=DEFAULT_WORKSPACE_ID, name="Other", dimensions=[])
        s.add(other)
        await s.commit()
        rid = str(other.id)

    r = await auth_client.get(f"/api/quality/rubrics/{rid}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_on_demand_evaluate(auth_client: AsyncClient, monkeypatch):
    ws = uuid.UUID(auth_client.headers["X-Workspace-Id"])
    async with database.async_session() as s:
        await _seed_judge_model(s, ws)
        t = Task(title="x", status=TaskStatus.DONE.value, workspace_id=ws,
                 result_summary="some result", model_used="m")
        s.add(t)
        await s.commit()
        tid = str(t.id)

    monkeypatch.setattr(judge_mod, "get_llm_provider", lambda: _FakeProvider(score=8))

    r = await auth_client.post(f"/api/quality/records/{tid}/evaluate")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["skipped"] is False
    profile = body["quality_profile"]
    assert profile["judge_model"] == "m"
    assert profile["rubric_name"] == "Analytical Report"  # workspace default
    assert all(d["score"] == 8 for d in profile["dimensions"] if d["status"] == "scored")

    # readable back via GET profile
    r = await auth_client.get(f"/api/quality/records/{tid}/profile")
    assert r.status_code == 200
    assert r.json()["quality_profile"]["weighted_score"] == 8.0


@pytest.mark.asyncio
async def test_gate_fail_closed_on_critical_dimension_error(
    auth_client: AsyncClient, monkeypatch
):
    """SPA-51: a CRITICAL dimension whose evaluator errors must FAIL the gate
    (fail-closed), not silently pass it (the old fail-open bug)."""
    ws = uuid.UUID(auth_client.headers["X-Workspace-Id"])
    body = {
        "name": "Critical Only", "description": "d", "applies_to": "general",
        "is_default": True,
        "dimensions": [{"key": "correctness", "name": "Correctness", "evaluator": "judge",
                        "weight": 1.0, "threshold": 6, "critical": True}],
    }
    r = await auth_client.post("/api/quality/rubrics", json=body)
    assert r.status_code in (200, 201), r.text

    async with database.async_session() as s:
        await _seed_judge_model(s, ws)
        t = Task(title="x", status=TaskStatus.DONE.value, workspace_id=ws,
                 result_summary="r", model_used="m")
        s.add(t)
        await s.commit()
        tid = str(t.id)

    monkeypatch.setattr(judge_mod, "get_llm_provider", lambda: _RaisingProvider())
    r = await auth_client.post(f"/api/quality/records/{tid}/evaluate")
    assert r.status_code == 200, r.text
    profile = r.json()["quality_profile"]
    crit = next(d for d in profile["dimensions"] if d["key"] == "correctness")
    assert crit["status"] == "error"
    assert crit["passed"] is False                       # fail-closed
    assert profile["gate"]["passed"] is False
    assert "correctness" in profile["gate"]["failed_dimensions"]


@pytest.mark.asyncio
async def test_evaluate_skipped_without_model(auth_client: AsyncClient, monkeypatch):
    ws = uuid.UUID(auth_client.headers["X-Workspace-Id"])
    async with database.async_session() as s:
        # Clear any cloned system models so neither quality_judge nor the
        # orchestrator fallback resolves → evaluation must be skipped.
        wsrow = await s.get(Workspace, ws)
        wsrow.orchestrator_model_id = None
        wsrow.chat_model_id = None
        wsrow.memory_extractor_model_id = None
        wsrow.quality_judge_model_id = None
        t = Task(title="x", status=TaskStatus.DONE.value, workspace_id=ws, result_summary="r")
        s.add(t)
        await s.commit()
        tid = str(t.id)

    monkeypatch.setattr(judge_mod, "get_llm_provider", lambda: _FakeProvider())
    r = await auth_client.post(f"/api/quality/records/{tid}/evaluate")
    assert r.status_code == 200
    assert r.json()["skipped"] is True
    assert r.json()["quality_profile"] is None


@pytest.mark.asyncio
async def test_scheduler_respects_quality_eval_enabled(db_session, monkeypatch):
    from app.scheduler import _job_runner

    async with database.async_session() as s:
        await _seed_judge_model(s, DEFAULT_WORKSPACE_ID, kind="orchestrator_model_id")
        s.add(Rubric(
            workspace_id=DEFAULT_WORKSPACE_ID, name="R", is_default=True,
            dimensions=[{"key": "a", "name": "A", "evaluator": "judge",
                         "weight": 1, "threshold": 5, "critical": False}],
        ))
        t = Task(title="x", status=TaskStatus.DONE.value, workspace_id=DEFAULT_WORKSPACE_ID,
                 result_summary="r", model_used="m")
        s.add(t)
        await s.flush()
        s.add(QualityRecord(task_id=t.id, workspace_id=DEFAULT_WORKSPACE_ID, final_status="done"))
        existing = await s.get(Setting, "quality_eval_enabled")
        if existing:
            existing.value = False
        else:
            s.add(Setting(key="quality_eval_enabled", value=False))
        job = ScheduledJob(
            name="qje-test", kind="interval", interval_seconds=600,
            payload={"action": "quality_judge_evaluate"},
            workspace_id=DEFAULT_WORKSPACE_ID, enabled=True,
        )
        s.add(job)
        await s.commit()
        jid, tid = str(job.id), t.id

    monkeypatch.setattr(judge_mod, "get_llm_provider", lambda: _FakeProvider(score=7))

    # disabled → no profile written
    await _job_runner(jid)
    async with database.async_session() as s:
        rec = (await s.execute(select(QualityRecord).where(QualityRecord.task_id == tid))).scalar_one()
        assert rec.quality_profile is None

    # enabled → profile written
    async with database.async_session() as s:
        st = await s.get(Setting, "quality_eval_enabled")
        st.value = True
        await s.commit()

    await _job_runner(jid)
    async with database.async_session() as s:
        rec = (await s.execute(select(QualityRecord).where(QualityRecord.task_id == tid))).scalar_one()
        assert rec.quality_profile is not None
        assert rec.quality_profile["dimensions"][0]["score"] == 7
