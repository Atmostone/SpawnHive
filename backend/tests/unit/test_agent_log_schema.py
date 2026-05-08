"""Unit tests for agent_log schemas and helpers (no HTTP / no DB)."""

from datetime import datetime

import pytest
from pydantic import ValidationError

from app.schemas.agent_log import MAX_CHUNK_BYTES, AgentLogChunkIn, AgentLogChunkOut


def test_chunk_in_accepts_valid():
    body = AgentLogChunkIn(chunk_seq=0, content="hello", idempotency_key="k1")
    assert body.chunk_seq == 0
    assert body.content == "hello"
    assert body.tool_name is None


def test_chunk_in_rejects_negative_seq():
    with pytest.raises(ValidationError):
        AgentLogChunkIn(chunk_seq=-1, content="x", idempotency_key="k1")


def test_chunk_in_rejects_oversized_content():
    with pytest.raises(ValidationError):
        AgentLogChunkIn(
            chunk_seq=0, content="x" * (MAX_CHUNK_BYTES + 1), idempotency_key="k1"
        )


def test_chunk_in_rejects_missing_idempotency_key():
    with pytest.raises(ValidationError):
        AgentLogChunkIn(chunk_seq=0, content="x")


def test_chunk_out_serializes_minimal():
    out = AgentLogChunkOut(
        id="11111111-1111-1111-1111-111111111111",
        chunk_seq=3,
        content="abc",
        created_at=datetime(2026, 5, 8, 12, 0, 0),
    )
    dumped = out.model_dump()
    assert dumped["chunk_seq"] == 3
    assert dumped["tool_name"] is None
