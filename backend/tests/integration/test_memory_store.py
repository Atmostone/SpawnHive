"""Integration tests for app.memory.store with Qdrant + embeddings mocked."""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.memory import store as mstore
from app.models.memory import MemoryEntity
from app.models.workspace import DEFAULT_WORKSPACE_ID
from app.plugins import embeddings as emb


class _FakeEmbedder(emb.EmbeddingProvider):
    @property
    def dim(self):  # type: ignore[override]
        return 4

    async def embed(self, texts):
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]


@pytest.fixture
def fake_emb():
    emb.set_embedding_provider(_FakeEmbedder())
    yield
    emb.set_embedding_provider(None)


def _qdrant_with(top_hit=None):
    """Return a fake Qdrant client whose query_points returns one optional hit."""
    cli = MagicMock()
    cli.get_collections.return_value = MagicMock(
        collections=[SimpleNamespace(name="memory_entities")]
    )
    info = MagicMock()
    info.config.params.vectors.size = 4
    cli.get_collection.return_value = info
    cli.query_points.return_value = MagicMock(points=[top_hit] if top_hit else [])
    return cli


@pytest.mark.asyncio
async def test_upsert_entity_inserts_when_no_match(db_session, fake_emb):
    cli = _qdrant_with(top_hit=None)
    with patch("app.memory.store.get_qdrant_client", return_value=cli):
        ent, created = await mstore.upsert_entity(
            db_session,
            type_="person",
            name="Alice",
            workspace_id=DEFAULT_WORKSPACE_ID,
            attributes={"role": "engineer"},
        )
    assert created is True
    assert ent.name == "Alice"
    cli.upsert.assert_called_once()


@pytest.mark.asyncio
async def test_upsert_entity_merges_when_high_similarity(db_session, fake_emb):
    # Pre-insert an entity with a known UUID.
    existing = MemoryEntity(
        type="person", name="Bob",
        attributes={"role": "qa"},
        created_by="t",
        workspace_id=DEFAULT_WORKSPACE_ID,
    )
    db_session.add(existing)
    await db_session.commit()
    await db_session.refresh(existing)

    top = SimpleNamespace(
        score=0.95,
        payload={
            "entity_id": str(existing.id),
            "type": "person",
            "name": "Bob",
            "workspace_id": str(DEFAULT_WORKSPACE_ID),
        },
    )
    cli = _qdrant_with(top_hit=top)
    with patch("app.memory.store.get_qdrant_client", return_value=cli):
        ent, created = await mstore.upsert_entity(
            db_session,
            type_="person",
            name="Bob",
            workspace_id=DEFAULT_WORKSPACE_ID,
            attributes={"team": "x"},
        )
    assert created is False
    assert ent.id == existing.id
    assert ent.attributes.get("team") == "x"
    assert ent.attributes.get("role") == "qa"


@pytest.mark.asyncio
async def test_find_relevant_entities_returns_matched(db_session, fake_emb):
    e1 = MemoryEntity(type="t", name="N1", attributes={}, created_by="t",
                      workspace_id=DEFAULT_WORKSPACE_ID)
    e2 = MemoryEntity(type="t", name="N2", attributes={}, created_by="t",
                      workspace_id=DEFAULT_WORKSPACE_ID)
    db_session.add_all([e1, e2])
    await db_session.commit()
    await db_session.refresh(e1)
    await db_session.refresh(e2)

    cli = MagicMock()
    cli.get_collections.return_value = MagicMock(
        collections=[SimpleNamespace(name="memory_entities")]
    )
    info = MagicMock()
    info.config.params.vectors.size = 4
    cli.get_collection.return_value = info
    cli.query_points.return_value = MagicMock(points=[
        SimpleNamespace(score=0.9, payload={"entity_id": str(e1.id)}),
        SimpleNamespace(score=0.5, payload={"entity_id": str(e2.id)}),  # below threshold
    ])
    with patch("app.memory.store.get_qdrant_client", return_value=cli):
        out = await mstore.find_relevant_entities(
            db_session, "query", workspace_id=DEFAULT_WORKSPACE_ID, threshold=0.7,
        )
    assert [e.id for e in out] == [e1.id]


@pytest.mark.asyncio
async def test_find_relevant_entities_empty_on_embedding_failure(db_session, monkeypatch):
    """If embedding raises, search returns empty rather than blowing up."""
    class _Boom(emb.EmbeddingProvider):
        async def embed(self, texts):
            raise RuntimeError("embedder offline")
    emb.set_embedding_provider(_Boom())
    try:
        out = await mstore.find_relevant_entities(
            db_session, "q", workspace_id=DEFAULT_WORKSPACE_ID,
        )
    finally:
        emb.set_embedding_provider(None)
    assert out == []


@pytest.mark.asyncio
async def test_build_memory_context_returns_formatted_string(db_session, fake_emb):
    ent = MemoryEntity(
        type="person", name="Carol",
        attributes={"role": "lead"},
        created_by="t",
        workspace_id=DEFAULT_WORKSPACE_ID,
    )
    db_session.add(ent)
    await db_session.commit()
    await db_session.refresh(ent)

    cli = MagicMock()
    cli.get_collections.return_value = MagicMock(
        collections=[SimpleNamespace(name="memory_entities")]
    )
    info = MagicMock()
    info.config.params.vectors.size = 4
    cli.get_collection.return_value = info
    cli.query_points.return_value = MagicMock(points=[
        SimpleNamespace(score=0.95, payload={"entity_id": str(ent.id)}),
    ])
    with patch("app.memory.store.get_qdrant_client", return_value=cli):
        ctx = await mstore.build_memory_context(
            db_session, query_text="who is carol",
            workspace_id=DEFAULT_WORKSPACE_ID,
        )
    assert "Carol" in ctx
    assert "person" in ctx
