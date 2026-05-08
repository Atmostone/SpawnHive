from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# 256 KB cap per chunk — agent splits longer outputs into N consecutive chunks.
MAX_CHUNK_BYTES = 256 * 1024


class AgentLogChunkIn(BaseModel):
    chunk_seq: int = Field(..., ge=0)
    content: str = Field(..., max_length=MAX_CHUNK_BYTES)
    tool_name: Optional[str] = Field(None, max_length=255)
    idempotency_key: str = Field(..., min_length=1, max_length=64)


class AgentLogChunkOut(BaseModel):
    id: str
    chunk_seq: int
    content: str
    tool_name: Optional[str] = None
    created_at: datetime
