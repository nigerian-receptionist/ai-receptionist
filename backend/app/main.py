"""Small API entry point for the platform dashboard."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.db import check_dependencies


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables."""

    allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    database_url: str = "postgresql+asyncpg://ai_receptionist:change-me-local-only@127.0.0.1:5433/ai_receptionist"
    valkey_url: str = "redis://127.0.0.1:6379/0"
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
app = FastAPI(
    title="AI Receptionist API",
    version="0.1.0",
    description="Local development API for the AI receptionist dashboard.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.allowed_origins.split(",")],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)


@app.get("/health", tags=["health"])
def health() -> dict[str, str]:
    """Report that the API process is responding; this is not a dependency check."""
    return {"status": "ok", "service": "ai-receptionist-api"}


@app.get("/v1/health", tags=["health"])
def versioned_health() -> dict[str, str]:
    """Versioned health route used by the dashboard."""
    return health()


@app.get("/v1/ready", tags=["health"])
async def readiness() -> dict[str, str]:
    """Confirm that PostgreSQL and Valkey accept connections."""
    if not await check_dependencies(settings.database_url, settings.valkey_url):
        raise HTTPException(status_code=503, detail="A required local service is unavailable")
    return {"status": "ready", "service": "ai-receptionist-api"}
