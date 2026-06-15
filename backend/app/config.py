from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)

    database_url: str = "postgresql+asyncpg://spawnhive:password@postgres:5432/spawnhive"
    qdrant_url: str = "http://qdrant:6333"
    minio_endpoint: str = "minio:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"

    # Optional bootstrap LLM env vars. If all three are set, an initial
    # Provider+Model row is seeded into the default workspace on first boot
    # (see app.main.seed_default_provider). Otherwise the admin must add
    # a provider via UI → Settings → Providers & Models.
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""

    # Paths
    data_dir: str = "/data"  # inside api container
    host_data_dir: str = "./data"  # host path for agent container volume mounts
    # Absolute HOST path of the toolathlon_gym clone, used by the Experiment
    # Runner to bind-mount the gym into preprocess/eval containers (docker-py
    # talks to the host daemon). Empty unless running Toolathlon experiments.
    toolathlon_gym_path: str = ""

    # Auth
    jwt_secret: str = ""  # MUST be set in .env for production
    jwt_algorithm: str = "HS256"
    jwt_expires_minutes: int = 60 * 24  # 24h


@lru_cache
def get_settings() -> Settings:
    return Settings()
