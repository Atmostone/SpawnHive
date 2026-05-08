"""Embedding provider abstraction.

Three implementations live here:
  - FastembedProvider: local CPU model (default).
  - OpenAIEmbeddingProvider: remote OpenAI-compatible /embeddings endpoint.
  - SettingsDispatchProvider: reads `embedding_provider` from the DB settings
    table and routes to one of the above. This is the registered default,
    matching the legacy behavior of `rag.get_embeddings`.

Tests can swap any of these via `set_embedding_provider(impl)`.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Any

import httpx


class EmbeddingProvider(ABC):
    """Abstract embedding provider.

    Implementations may declare a static dimension via `.dim`; if unknown
    (e.g. dispatch provider that doesn't pre-load), `.dim` returns None and
    callers should peek at the first embed() result.
    """

    @property
    def dim(self) -> int | None:  # pragma: no cover — overridable
        return None

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class FastembedProvider(EmbeddingProvider):
    """Local CPU embeddings via fastembed. Cached per-process by model name."""

    _model_cache: dict[str, Any] = {}

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5", dim: int = 384):
        self.model_name = model_name
        self._dim = dim

    @property
    def dim(self) -> int:
        return self._dim

    def _get_model(self):
        if self.model_name not in self._model_cache:
            from fastembed import TextEmbedding

            self._model_cache[self.model_name] = TextEmbedding(self.model_name)
        return self._model_cache[self.model_name]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        model = self._get_model()
        embeddings = list(model.embed(texts))
        return [e.tolist() for e in embeddings]


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """OpenAI-compatible embeddings API."""

    def __init__(self, url: str, api_key: str, model: str, dim: int | None = None):
        self.url = url
        self.api_key = api_key
        self.model = model
        self._dim = dim

    @property
    def dim(self) -> int | None:
        return self._dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.url or not self.model:
            raise RuntimeError(
                "embedding_api_url and embedding_model_api must be set when provider=api"
            )
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                self.url, headers=headers,
                json={"input": texts, "model": self.model},
            )
            resp.raise_for_status()
            data = resp.json()
        return [item["embedding"] for item in data["data"]]


class SettingsDispatchProvider(EmbeddingProvider):
    """Read `embedding_provider` from the DB and route to fastembed or OpenAI per call.

    This preserves runtime switchability — admins can flip between local and
    remote providers without restarting. The trade-off: `.dim` is None until
    a concrete provider is selected at first call.
    """

    async def embed(self, texts: list[str]) -> list[list[float]]:
        provider = await self._resolve()
        return await provider.embed(texts)

    async def _resolve(self) -> EmbeddingProvider:
        from app.api.settings import get_setting
        from app.database import async_session

        async with async_session() as db:
            kind = await get_setting(db, "embedding_provider", "fastembed")
            if kind == "api":
                return OpenAIEmbeddingProvider(
                    url=await get_setting(db, "embedding_api_url", ""),
                    api_key=await get_setting(db, "embedding_api_key", ""),
                    model=await get_setting(db, "embedding_model_api", ""),
                )
            model_name = await get_setting(
                db, "embedding_model_local", "BAAI/bge-small-en-v1.5"
            )
            return FastembedProvider(model_name=model_name)


_provider: EmbeddingProvider | None = None


def get_embedding_provider() -> EmbeddingProvider:
    global _provider
    if _provider is not None:
        return _provider
    name = os.environ.get("EMBEDDING_PROVIDER", "settings")
    if name == "settings":
        _provider = SettingsDispatchProvider()
    elif name == "fastembed":
        _provider = FastembedProvider()
    else:
        raise ValueError(f"unknown EMBEDDING_PROVIDER={name}")
    return _provider


def set_embedding_provider(provider: EmbeddingProvider | None) -> None:
    global _provider
    _provider = provider
