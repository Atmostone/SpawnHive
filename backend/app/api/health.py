import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.database import get_db

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health_check(
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
):
    services = {}

    # PostgreSQL
    try:
        await db.execute(text("SELECT 1"))
        services["postgres"] = "ok"
    except Exception as e:
        services["postgres"] = f"error: {e}"

    # Qdrant
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{settings.qdrant_url}/healthz")
            services["qdrant"] = "ok" if resp.status_code == 200 else f"error: {resp.status_code}"
    except Exception as e:
        services["qdrant"] = f"error: {e}"

    # MinIO
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"http://{settings.minio_endpoint}/minio/health/live")
            services["minio"] = "ok" if resp.status_code == 200 else f"error: {resp.status_code}"
    except Exception as e:
        services["minio"] = f"error: {e}"

    overall = "ok" if all(v == "ok" for v in services.values()) else "degraded"

    return {
        "status": overall,
        "version": "0.1.0",
        "services": services,
    }
