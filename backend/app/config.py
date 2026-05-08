from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

    database_url: str = "postgresql+asyncpg://spawnhive:password@postgres:5432/spawnhive"
    qdrant_url: str = "http://qdrant:6333"
    minio_endpoint: str = "minio:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"

    # LLM settings (from .env, seeded into DB on startup)
    llm_base_url: str = "https://api.minimax.io/v1"
    llm_api_key: str = ""
    llm_model: str = "MiniMax-M2.7"

    # Paths
    data_dir: str = "/data"  # inside api container
    host_data_dir: str = "./data"  # host path for agent container volume mounts

    # Auth
    jwt_secret: str = ""  # MUST be set in .env for production
    jwt_algorithm: str = "HS256"
    jwt_expires_minutes: int = 60 * 24  # 24h


@lru_cache
def get_settings() -> Settings:
    return Settings()
