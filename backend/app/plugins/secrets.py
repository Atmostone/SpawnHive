"""Secrets provider abstraction.

Default: read/write through the `settings` table (current behaviour). Production
can swap to env-only or to a vault-backed provider without touching call sites.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod

from sqlalchemy.ext.asyncio import AsyncSession


class SecretsProvider(ABC):
    @abstractmethod
    async def get(self, db: AsyncSession, key: str, default: str | None = None) -> str | None: ...

    @abstractmethod
    async def set(self, db: AsyncSession, key: str, value: str) -> None: ...


class DBSecretsProvider(SecretsProvider):
    async def get(self, db: AsyncSession, key: str, default: str | None = None) -> str | None:
        from app.api.settings import get_setting

        v = await get_setting(db, key, default)
        return v if v is None or isinstance(v, str) else str(v)

    async def set(self, db: AsyncSession, key: str, value: str) -> None:
        from app.models.setting import Setting

        existing = await db.get(Setting, key)
        if existing:
            existing.value = value
        else:
            db.add(Setting(key=key, value=value))
        await db.commit()


class EnvSecretsProvider(SecretsProvider):
    """Read from env, write is no-op (env is immutable at runtime)."""

    async def get(self, db: AsyncSession, key: str, default: str | None = None) -> str | None:
        return os.environ.get(key.upper(), default)

    async def set(self, db: AsyncSession, key: str, value: str) -> None:
        raise RuntimeError("EnvSecretsProvider is read-only at runtime")


_provider: SecretsProvider | None = None


def get_secrets_provider() -> SecretsProvider:
    global _provider
    if _provider is not None:
        return _provider
    name = os.environ.get("SECRETS_PROVIDER", "db")
    if name == "db":
        _provider = DBSecretsProvider()
    elif name == "env":
        _provider = EnvSecretsProvider()
    else:
        raise ValueError(f"unknown SECRETS_PROVIDER={name}")
    return _provider


def set_secrets_provider(provider: SecretsProvider | None) -> None:
    global _provider
    _provider = provider
