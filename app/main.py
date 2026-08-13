from __future__ import annotations

import asyncio
import heapq
import hmac
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status as http_status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from .config import load_config, validate_security_config
from .github_client import GitHubClient
from .github_ai import RepositoryAiExplainer
from .github_service import GitHubCollector
from .media_cache import (
    MediaCache,
    MediaCacheError,
    MediaNotFoundError,
    MediaURLRejectedError,
    media_cache_items_for_message,
    media_cache_urls_for_message,
)
from .public_telegram import PublicTelegramCrawler
from .scheduler import SourceCollector, create_collection_scheduler, sanitize_error_fields
from .security import (
    SESSION_COOKIE_NAME,
    LoginAttemptLimiter,
    SessionSigner,
    require_same_origin,
    require_session,
    session_expiry,
)
from .source_service import seed_sources_from_groups
from .storage import SQLiteStorage, StoredMessage, source_url_from_raw_json
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
    public_crawler = PublicTelegramCrawler(storage, media_cache=media_cache)
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

    stop_event = asyncio.Event()
    poller = None
    poll_task = None
    if config.telegram_bot_token:
        telegram_client = TelegramBotClient(config.telegram_bot_token)
        poller = TelegramPoller(
            client=telegram_client,
            storage=storage,
            source_chat_ids=[
                group.chat_id
                for group in config.groups.values()
                if group.source_type == "telegram_bot"
            ],
        )
        poll_task = asyncio.create_task(poller.run(stop_event))
    scheduler = create_collection_scheduler(config, collector, github_collector)
    scheduler.start()

    app.state.config = config
    app.state.session_signer = SessionSigner(
        config.session_secret,
        ttl_seconds=config.session_ttl_hours * 3600,
    )
    app.state.login_limiter = LoginAttemptLimiter(
        max_attempts=config.login_max_attempts,
        window_seconds=config.login_window_seconds,
    )
    app.state.storage = storage
    app.state.collector = collector
    app.state.github_collector = github_collector
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
    version="0.1.0",
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


AlertMediaType = Literal["text", "photo", "video", "document", "animation", "audio", "voice", "sticker"]


class AlertRuleCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    keyword: str = Field(min_length=1, max_length=200)
    media_type: Optional[AlertMediaType] = None
    quiet_start: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quiet_end: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    cooldown_minutes: int = Field(default=0, ge=0, le=1440)
    enabled: bool = False
    source_ids: List[int] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_quiet_hours(self):
        if bool(self.quiet_start) != bool(self.quiet_end):
            raise ValueError("quiet_start and quiet_end must be provided together")
        return self


class AlertRulePatchPayload(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    keyword: Optional[str] = Field(default=None, min_length=1, max_length=200)
    media_type: Optional[AlertMediaType] = None
    quiet_start: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quiet_end: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    cooldown_minutes: Optional[int] = Field(default=None, ge=0, le=1440)
    enabled: Optional[bool] = None
    source_ids: Optional[List[int]] = Field(default=None, max_length=100)


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


@app.get("/status", dependencies=[Depends(require_session)])
async def get_status() -> Dict[str, Any]:
    storage: SQLiteStorage = app.state.storage
    config = app.state.config
    poller: TelegramPoller | None = app.state.poller
    scheduler = app.state.scheduler
    jobs = [
        {
            "id": job.id,
            "next_run_time": job.next_run_time.isoformat() if job.next_run_time else None,
        }
        for job in scheduler.get_jobs()
    ]
    return sanitize_error_fields({
        "telegram_poller": poller.status.as_dict() if poller else {"enabled": False, "running": False},
        "configured_groups": [
            {
                "chat_id": group.chat_id,
                "name": group.name,
                "source": group.source,
                "source_type": group.source_type,
                "forward_enabled": group.forward_enabled,
                "screenshot_enabled": group.screenshot_enabled,
            }
            for group in config.groups.values()
        ],
        "screenshots": list_screenshot_files(config.screenshot_output_dir),
        "pending_by_chat": storage.count_pending_by_chat(),
        "unconfigured_pending": storage.get_unconfigured_pending_counts(config.groups.keys()),
        "recent_forward_logs": [
            {key: value for key, value in row.items() if key != "payload_preview"}
            for row in storage.get_recent_forward_logs()
        ],
        "scheduler_jobs": jobs,
    })


@app.post("/jobs/forward-now", dependencies=[Depends(require_session), Depends(require_same_origin)])
async def forward_now() -> Dict[str, Any]:
    raise HTTPException(
        status_code=http_status.HTTP_410_GONE,
        detail="Delivery runtime has been retired",
    )


@app.get("/telegram/chats", dependencies=[Depends(require_session)])
async def telegram_chats() -> Dict[str, Any]:
    storage: SQLiteStorage = app.state.storage
    return {"chats": storage.get_chats()}


@app.get("/api/groups", dependencies=[Depends(require_session)])
async def api_groups() -> Dict[str, Any]:
    storage: SQLiteStorage = app.state.storage
    config = app.state.config
    chat_stats = {int(chat["chat_id"]): chat for chat in storage.get_chats()}
    groups = []
    for group in config.groups.values():
        stats = chat_stats.get(group.chat_id, {})
        health = storage.get_source_health(
            group.chat_id,
            stale_after_seconds=config.source_stale_after_seconds,
        )
        groups.append(
            {
                "chat_id": group.chat_id,
                "name": group.name,
                "source": group.source,
                "source_type": group.source_type,
                "message_count": int(stats.get("message_count") or 0),
                "pending_count": int(stats.get("pending_count") or 0),
                "last_message_time": stats.get("last_message_time"),
                **health,
            }
        )
    return sanitize_error_fields({"groups": groups})


@app.get("/api/operations/summary", dependencies=[Depends(require_session)])
async def operations_summary() -> Dict[str, Any]:
    storage: SQLiteStorage = app.state.storage
    config = app.state.config
    sources = []
    for group in config.groups.values():
        health = storage.get_source_health(
            group.chat_id,
            stale_after_seconds=config.source_stale_after_seconds,
        )
        sources.append({"name": group.name, **health})
    recent_deliveries = []
    for row in storage.get_recent_forward_logs(limit=12):
        recent_deliveries.append(
            {
                key: value
                for key, value in row.items()
                if key != "payload_preview"
            }
        )
    pending_by_chat = storage.count_pending_by_chat()
    return sanitize_error_fields({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sources": sources,
        "unhealthy_sources": [
            source for source in sources if source["health_status"] in {"unknown", "stale", "error"}
        ],
        "pending_total": sum(int(row.get("pending_count") or 0) for row in pending_by_chat),
        "recent_deliveries": recent_deliveries,
        "deliveries": [delivery_to_api_dict(item) for item in storage.list_deliveries(limit=12)],
    })


@app.get("/api/alert-rules", dependencies=[Depends(require_session)])
async def list_alert_rules() -> Dict[str, Any]:
    storage: SQLiteStorage = app.state.storage
    return {"items": storage.list_alert_rules()}


@app.post(
    "/api/alert-rules",
    status_code=http_status.HTTP_201_CREATED,
    dependencies=[Depends(require_session), Depends(require_same_origin)],
)
async def create_alert_rule(payload: AlertRuleCreatePayload) -> Dict[str, object]:
    storage: SQLiteStorage = app.state.storage
    return storage.create_alert_rule(**payload.model_dump())


@app.patch(
    "/api/alert-rules/{rule_id}",
    dependencies=[Depends(require_session), Depends(require_same_origin)],
)
async def update_alert_rule(rule_id: int, payload: AlertRulePatchPayload) -> Dict[str, object]:
    storage: SQLiteStorage = app.state.storage
    try:
        changes = payload.model_dump(exclude_unset=True)
        if {"quiet_start", "quiet_end"} & changes.keys():
            current = storage.get_alert_rule(rule_id)
            quiet_start = changes.get("quiet_start", current["quiet_start"])
            quiet_end = changes.get("quiet_end", current["quiet_end"])
            if bool(quiet_start) != bool(quiet_end):
                raise HTTPException(
                    status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="quiet_start and quiet_end must be provided together",
                )
        return storage.update_alert_rule(rule_id, **changes)
    except KeyError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@app.get("/api/alerts", dependencies=[Depends(require_session)])
async def list_alerts(
    status: str = Query(default="", pattern="^(|new|acknowledged|resolved)$"),
) -> Dict[str, Any]:
    storage: SQLiteStorage = app.state.storage
    return {"items": storage.list_alert_matches(status=status)}


@app.post(
    "/api/alerts/{match_id}/acknowledge",
    dependencies=[Depends(require_session), Depends(require_same_origin)],
)
async def acknowledge_alert(match_id: int) -> Dict[str, object]:
    return _set_alert_status(match_id, "acknowledged")


@app.post(
    "/api/alerts/{match_id}/resolve",
    dependencies=[Depends(require_session), Depends(require_same_origin)],
)
async def resolve_alert(match_id: int) -> Dict[str, object]:
    return _set_alert_status(match_id, "resolved")


def _set_alert_status(match_id: int, next_status: str) -> Dict[str, object]:
    storage: SQLiteStorage = app.state.storage
    try:
        return storage.set_alert_match_status(match_id, next_status)
    except KeyError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@app.get("/api/deliveries", dependencies=[Depends(require_session)])
async def list_deliveries(limit: int = Query(default=50, ge=1, le=200)) -> Dict[str, Any]:
    storage: SQLiteStorage = app.state.storage
    return {"items": [delivery_to_api_dict(item) for item in storage.list_deliveries(limit=limit)]}


@app.post(
    "/api/deliveries/{delivery_id}/retry",
    dependencies=[Depends(require_session), Depends(require_same_origin)],
)
async def retry_delivery(delivery_id: int) -> Dict[str, object]:
    raise HTTPException(
        status_code=http_status.HTTP_410_GONE,
        detail="Delivery runtime has been retired",
    )


@app.get("/api/messages", dependencies=[Depends(require_session)])
async def api_messages(
    chat_id: Optional[int] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    cursor: str = Query(default="", max_length=500),
    query: str = Query(default="", max_length=200),
    media: str = Query(default="all", pattern="^(all|text|photo|video|document|animation|audio|voice|sticker)$"),
    include_total: bool = Query(default=False),
) -> Dict[str, Any]:
    storage: SQLiteStorage = app.state.storage
    if offset > 0 and not cursor:
        messages = storage.list_messages(
            chat_id=chat_id,
            limit=limit,
            offset=offset,
            query=query,
            media=media,
        )
        total = storage.count_messages(chat_id=chat_id, query=query, media=media)
        return {
            "items": [message_to_api_dict(message) for message in messages],
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(messages) < total,
            "next_cursor": None,
        }

    page = storage.list_messages_page(
        chat_id=chat_id,
        limit=limit,
        cursor=cursor,
        query=query,
        media=media,
    )
    total = storage.count_messages(chat_id=chat_id, query=query, media=media) if include_total else None
    return {
        "items": [message_to_api_dict(message) for message in page.items],
        "total": total,
        "limit": limit,
        "offset": 0,
        "has_more": page.has_more,
        "next_cursor": page.next_cursor,
    }


@app.get("/api/media/{message_id}/{index}", dependencies=[Depends(require_session)])
async def cached_media(message_id: int, index: int):
    storage: SQLiteStorage = app.state.storage
    message = storage.get_message(message_id)
    if message is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Message not found")

    media_cache: MediaCache = app.state.media_cache
    try:
        cached = await asyncio.to_thread(media_cache.get, message, index)
    except MediaNotFoundError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except MediaURLRejectedError as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except MediaCacheError as exc:
        LOGGER.warning("Media cache fetch failed for message_id=%s index=%s: %s", message_id, index, exc)
        raise HTTPException(status_code=http_status.HTTP_502_BAD_GATEWAY, detail="Failed to fetch media") from exc

    return FileResponse(
        cached.path,
        media_type=cached.media_type,
        headers={"Cache-Control": "private, no-store"},
    )


@app.get("/screenshots", dependencies=[Depends(require_session)])
async def screenshots() -> Dict[str, Any]:
    config = app.state.config
    return {"files": list_screenshot_files(config.screenshot_output_dir)}


@app.get("/screenshots/{filename}", dependencies=[Depends(require_session)])
async def download_screenshot(filename: str):
    config = app.state.config
    output_dir = Path(config.screenshot_output_dir).resolve()
    path = (output_dir / filename).resolve()
    if output_dir not in path.parents or path.suffix.lower() != ".png" or not path.exists():
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Screenshot not found")
    return FileResponse(
        path,
        media_type="image/png",
        filename=path.name,
        headers={"Cache-Control": "private, no-store"},
    )


def message_to_api_dict(message: StoredMessage) -> Dict[str, object]:
    return {
        "id": message.id,
        "chat_id": message.chat_id,
        "chat_title": message.chat_title,
        "message_id": message.message_id,
        "sender_name": message.sender_name,
        "message_time": message.message_time,
        "content": message.content,
        "media_type": message.media_type,
        "media_urls": media_cache_urls_for_message(message),
        "media_items": media_cache_items_for_message(message),
        "source_url": source_url_from_raw_json(message.raw_json),
        "forwarded_at": message.forwarded_at,
    }


def delivery_to_api_dict(delivery: Dict[str, object]) -> Dict[str, object]:
    return sanitize_error_fields({
        key: value
        for key, value in delivery.items()
        if key not in {"payload", "idempotency_key"}
    })


def list_screenshot_files(output_dir: str, *, limit: int = 50) -> list[Dict[str, object]]:
    directory = Path(output_dir)
    if not directory.exists():
        return []

    entries = []
    try:
        with os.scandir(directory) as iterator:
            for entry in iterator:
                if not entry.is_file() or not entry.name.lower().endswith(".png"):
                    continue
                try:
                    stat = entry.stat()
                except OSError:
                    continue
                entries.append((stat.st_mtime, entry.name, stat.st_size))
    except OSError:
        return []

    files = []
    for modified_at, filename, size in heapq.nlargest(limit, entries):
        files.append(
            {
                "filename": filename,
                "size": size,
                "modified_at": int(modified_at),
            }
        )
    return files


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
