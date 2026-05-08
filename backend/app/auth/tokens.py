"""Service token issuance/verification (per-task agent tokens, etc.)."""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.service_token import ServiceToken


def hash_token(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def _utcnow_naive() -> datetime:
    """Tz-naive UTC datetime (DB columns are TIMESTAMP WITHOUT TIME ZONE)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def issue_agent_token(
    db: AsyncSession,
    *,
    task_id: uuid.UUID,
    workspace_id: uuid.UUID,
    ttl_hours: int = 24,
) -> str:
    """Create a per-task agent token and return the plain value (single-use disclosure)."""
    plain = secrets.token_urlsafe(48)
    db.add(
        ServiceToken(
            kind="agent",
            token_hash=hash_token(plain),
            task_id=task_id,
            workspace_id=workspace_id,
            expires_at=_utcnow_naive() + timedelta(hours=ttl_hours),
        )
    )
    await db.flush()
    return plain


async def verify_agent_token(
    db: AsyncSession, *, plain: str, task_id: uuid.UUID
) -> ServiceToken | None:
    result = await db.execute(
        select(ServiceToken).where(
            ServiceToken.token_hash == hash_token(plain),
            ServiceToken.kind == "agent",
            ServiceToken.task_id == task_id,
        )
    )
    token = result.scalar_one_or_none()
    if not token:
        return None
    if token.expires_at and token.expires_at < _utcnow_naive():
        return None
    return token
