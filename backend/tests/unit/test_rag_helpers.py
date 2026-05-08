"""Unit tests for the pure helpers in app.knowledge.rag — no Qdrant/MinIO/fastembed."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.knowledge import rag


def test_chunk_text_basic():
    text = "abc" * 200  # 600 chars
    chunks = rag.chunk_text(text)
    # CHUNK_SIZE=500, overlap=50 → at least 2 chunks; first ~500, second ~150
    assert len(chunks) >= 2
    assert all(c.strip() for c in chunks)


def test_chunk_text_short_text_one_chunk():
    chunks = rag.chunk_text("hello")
    assert chunks == ["hello"]


def test_chunk_text_skips_whitespace_only():
    chunks = rag.chunk_text("   \n   ")
    assert chunks == []


def test_extract_text_plain_utf8():
    out = rag.extract_text("notes.txt", "Hello, café".encode("utf-8"))
    assert "Hello" in out and "café" in out


def test_extract_text_falls_back_to_utf8_for_unknown_extension():
    out = rag.extract_text("notes.foo", b"raw bytes")
    assert out == "raw bytes"


def test_ensure_collection_creates_when_missing():
    qdrant = MagicMock()
    qdrant.get_collections.return_value = MagicMock(collections=[])
    rag.ensure_collection(qdrant, dim=384, name="testcoll")
    qdrant.create_collection.assert_called_once()


def test_ensure_collection_noop_if_exists_with_same_dim():
    qdrant = MagicMock()
    qdrant.get_collections.return_value = MagicMock(
        collections=[MagicMock(name="testcoll")]
    )
    qdrant.get_collections.return_value.collections[0].name = "testcoll"
    info = MagicMock()
    info.config.params.vectors.size = 384
    qdrant.get_collection.return_value = info
    rag.ensure_collection(qdrant, dim=384, name="testcoll")
    qdrant.create_collection.assert_not_called()


def test_ensure_collection_raises_on_dim_mismatch():
    qdrant = MagicMock()
    qdrant.get_collections.return_value = MagicMock(
        collections=[MagicMock(name="testcoll")]
    )
    qdrant.get_collections.return_value.collections[0].name = "testcoll"
    info = MagicMock()
    info.config.params.vectors.size = 1536
    qdrant.get_collection.return_value = info
    with pytest.raises(RuntimeError, match="dim="):
        rag.ensure_collection(qdrant, dim=384, name="testcoll")


@pytest.mark.asyncio
async def test_get_embeddings_delegates_to_provider(monkeypatch):
    """rag.get_embeddings is a thin shim over the EmbeddingProvider plugin."""
    from app.plugins import embeddings as emb

    class _Fake(emb.EmbeddingProvider):
        async def embed(self, texts):
            return [[1.0, 2.0] for _ in texts]

    emb.set_embedding_provider(_Fake())
    try:
        out = await rag.get_embeddings(["a", "b"])
        assert out == [[1.0, 2.0], [1.0, 2.0]]
    finally:
        emb.set_embedding_provider(None)
