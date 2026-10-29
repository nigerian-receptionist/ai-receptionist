"""Small asynchronous connectivity checks for the local data services."""

from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import create_async_engine


async def check_dependencies(database_url: str, valkey_url: str) -> bool:
    """Return false if either required service is unavailable."""
    engine = create_async_engine(database_url, pool_pre_ping=True)
    cache = Redis.from_url(valkey_url, socket_connect_timeout=2, socket_timeout=2)
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        await cache.ping()
        return True
    except (SQLAlchemyError, RedisError, OSError, TimeoutError):
        return False
    finally:
        await cache.aclose()
        await engine.dispose()
