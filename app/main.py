from __future__ import annotations

import asyncio
import hmac
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict

from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request, Response, status as http_status
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .api_common import message_to_api_dict
from .config import load_config, validate_security_config
from .context import AppContext
from .domain.feed.service import FeedService
from .domain.insights.github.product import GitHubInsightProduct
from .domain.sources.service import SourceService
from .github_ai import RepositoryAiExplainer
from .github_client import GitHubClient
from .github_service import GitHubCollector
from .ingest.registry import build_default_registry
from .media_cache import MediaCache
from .notifications.ports import NotificationService
from .persistence.sqlite.connection import ConnectionFactory
from .public_telegram import PublicTelegramCrawler
from .scheduler import SourceCollector, create_collection_scheduler
from .security import (
    SESSION_COOKIE_NAME,
    LoginAttemptLimiter,
    SessionSigner,
    require_same_origin,
    session_expiry,
)
from .source_service import seed_sources_from_groups
from .storage import SQLiteStorage
from .telegram_client import TelegramBotClient, TelegramPoller


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
LOGGER = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = load_config(require_token=False)
    validate_security_config(config)
    storage = SQLiteStorage(config.database_url, timezone_name=config.timezone)
    storage.init_db()
    seed_sources_from_groups(storage, config.groups.values())

    media_cache = MediaCache(config.media_cache_dir)
    adapters = build_default_registry()
    source_service = SourceService(storage, adapters)
    feed_service = FeedService(storage)
    public_crawler = PublicTelegramCrawler(
        storage,
        media_cache=media_cache,
        feed_service=feed_service,
    )
    collector = SourceCollector(
        storage=storage,
        crawler=public_crawler,
    )
    github_collector = GitHubCollector(
        storage=storage,
        client=GitHubClient(config.github_token),
        config=config,
        ai_explainer=RepositoryAiExplainer(
            api_key=config.github_ai_api_key,
            base_url=config.github_ai_base_url,
            model=config.github_ai_model,
            timeout_seconds=config.github_ai_timeout_seconds,
        ),
    )
    github_product = GitHubInsightProduct(
        storage=storage,
        collector=github_collector,
        config=config,
    )
    session_signer = SessionSigner(
        config.session_secret,
        ttl_seconds=config.session_ttl_hours * 3600,
    )
    ctx = AppContext(
        config=config,
        storage=storage,
        db=ConnectionFactory(config.database_url),
        adapters=adapters,
        source_service=source_service,
        feed_service=feed_service,
        notifications=NotificationService(),
        media=media_cache,
        sessions=session_signer,
        github_product=github_product,
    )

    stop_event = asyncio.Event()
    poller = None
    poll_task = None
    if config.telegram_bot_token:
        telegram_client = TelegramBotClient(config.telegram_bot_token)
        poller = TelegramPoller(
            client=telegram_client,
            storage=storage,
            feed_service=feed_service,
            resolve_chat_ids=source_service.enabled_bot_chat_ids,
        )
        poll_task = asyncio.create_task(poller.run(stop_event))
    else:
        LOGGER.warning("TELEGRAM_BOT_TOKEN unset; telegram_bot sources will not be polled")
    scheduler = create_collection_scheduler(config, collector, github_collector)
    scheduler.start()

    app.state.ctx = ctx
    app.state.config = config
    app.state.session_signer = session_signer
    app.state.login_limiter = LoginAttemptLimiter(
        max_attempts=config.login_max_attempts,
        window_seconds=config.login_window_seconds,
    )
    app.state.storage = storage
    app.state.collector = collector
    app.state.github_collector = github_collector
    app.state.github_product = github_product
    app.state.source_service = source_service
    app.state.feed_service = feed_service
    app.state.media_cache = media_cache
    app.state.poller = poller
    app.state.scheduler = scheduler
    app.state.poll_task = poll_task
    app.state.stop_event = stop_event

    LOGGER.info(
        "Service started with %d stored Telegram sources",
        len(storage.list_sources()),
    )
    try:
        yield
    finally:
        stop_event.set()
        if poll_task:
            poll_task.cancel()
            try:
                await poll_task
            except asyncio.CancelledError:
                pass
        scheduler.shutdown(wait=False)
        LOGGER.info("Service stopped")


app = FastAPI(
    title="Telegram Channel Monitoring Platform",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api/public/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    elif request.url.path.startswith(("/api/", "/status", "/jobs/", "/telegram/", "/screenshots")):
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["Vary"] = "Cookie"
    return response


class LoginPayload(BaseModel):
    api_key: str = Field(min_length=1, max_length=256)


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
async def login(payload: LoginPayload, request: Request, response: Response) -> Dict[str, object]:
    await require_same_origin(request)
    config = request.app.state.config
    client_key = request.client.host if request.client else "unknown"
    limiter = getattr(request.app.state, "login_limiter", None)
    if limiter is None:
        limiter = LoginAttemptLimiter(
            max_attempts=config.login_max_attempts,
            window_seconds=config.login_window_seconds,
        )
        request.app.state.login_limiter = limiter
    if not limiter.is_allowed(client_key):
        raise HTTPException(
            status_code=http_status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts",
            headers={"Retry-After": str(config.login_window_seconds)},
        )
    if not config.admin_api_key or not hmac.compare_digest(payload.api_key, config.admin_api_key):
        limiter.record_failure(client_key)
        raise HTTPException(status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    limiter.reset(client_key)
    signer: SessionSigner = request.app.state.session_signer
    token, expires_at = signer.issue()
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=signer.ttl_seconds,
        httponly=True,
        secure=config.session_cookie_secure,
        samesite="strict",
        path="/",
    )
    return {
        "authenticated": True,
        "expires_at": datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat(),
    }


@app.get("/api/session")
async def get_session(request: Request) -> Dict[str, object]:
    expires_at = session_expiry(request)
    return {
        "authenticated": expires_at is not None,
        "expires_at": datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat()
        if expires_at is not None
        else None,
    }


@app.post("/api/auth/logout", status_code=http_status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response) -> Response:
    await require_same_origin(request)
    token = request.cookies.get(SESSION_COOKIE_NAME, "")
    if token:
        request.app.state.session_signer.revoke(token)
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    response.status_code = http_status.HTTP_204_NO_CONTENT
    return response



frontend_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
from .admin_api import router as admin_router
from .github_api import admin_router as github_admin_router
from .github_api import public_router as github_public_router
from .public_api import router as public_router

app.include_router(public_router)
app.include_router(admin_router)
app.include_router(github_public_router)
app.include_router(github_admin_router)

if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
