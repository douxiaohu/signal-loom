from __future__ import annotations

import asyncio
import sqlite3
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status as http_status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator

from .api_common import message_to_api_dict
from .media_cache import MediaCache, MediaCacheError, MediaNotFoundError, MediaURLRejectedError
from .domain.feed.service import FeedService
from .http.errors import sanitize_error_fields
from .security import require_same_origin, require_session
from .storage import SQLiteStorage, StoredSource


router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(require_session)],
)


class SourceCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    source_url: str = Field(min_length=1, max_length=300)
    adapter: str = Field(default="telegram_public", max_length=40)


class SourcePatchPayload(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    enabled: Optional[bool] = None
    public_visible: Optional[bool] = None


AlertMediaType = Literal["text", "photo", "video", "document", "animation", "audio", "voice", "sticker"]


class RuleCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    keyword: str = Field(min_length=1, max_length=200)
    media_type: Optional[AlertMediaType] = None
    quiet_start: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quiet_end: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    cooldown_minutes: int = Field(default=0, ge=0, le=1440)
    enabled: bool = False
    source_ids: list[int] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_quiet_hours(self):
        if bool(self.quiet_start) != bool(self.quiet_end):
            raise ValueError("quiet_start and quiet_end must be provided together")
        return self


class RulePatchPayload(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    keyword: Optional[str] = Field(default=None, min_length=1, max_length=200)
    media_type: Optional[AlertMediaType] = None
    quiet_start: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quiet_end: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    cooldown_minutes: Optional[int] = Field(default=None, ge=0, le=1440)
    enabled: Optional[bool] = None
    source_ids: Optional[list[int]] = Field(default=None, max_length=100)


def source_to_dict(storage: SQLiteStorage, source: StoredSource, *, stale_after_seconds: int):
    health = storage.get_source_health(source.chat_id, stale_after_seconds=stale_after_seconds)
    chat_stats = next((item for item in storage.get_chats() if int(item["chat_id"]) == source.chat_id), None)
    return sanitize_error_fields(
        {
            "chat_id": source.chat_id,
            "name": source.name,
            "source_url": source.source_url,
            "source_type": source.adapter or source.source_type,
            "adapter": source.adapter or source.source_type,
            "enabled": source.enabled,
            "public_visible": source.public_visible,
            "created_at": source.created_at,
            "updated_at": source.updated_at,
            "message_count": int(chat_stats["message_count"]) if chat_stats else 0,
            "last_message_time": chat_stats["last_message_time"] if chat_stats else None,
            **health,
        }
    )


@router.get("/sources")
async def list_sources(request: Request):
    storage: SQLiteStorage = request.app.state.storage
    stale = request.app.state.config.source_stale_after_seconds
    return {"items": [source_to_dict(storage, source, stale_after_seconds=stale) for source in storage.list_sources()]}


@router.post(
    "/sources",
    status_code=http_status.HTTP_201_CREATED,
    dependencies=[Depends(require_same_origin)],
)
async def create_source(request: Request, payload: SourceCreatePayload):
    storage: SQLiteStorage = request.app.state.storage
    source_service = getattr(request.app.state, "source_service", None)
    try:
        if source_service is not None:
            source = source_service.create(
                name=payload.name,
                locator=payload.source_url,
                adapter=payload.adapter or "telegram_public",
            )
        else:
            source = storage.create_source(
                name=payload.name,
                source_url=payload.source_url,
                adapter=payload.adapter or "telegram_public",
            )
    except KeyError as exc:
        raise HTTPException(status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=http_status.HTTP_409_CONFLICT, detail="Source already exists") from exc
    return source_to_dict(storage, source, stale_after_seconds=request.app.state.config.source_stale_after_seconds)


@router.patch("/sources/{chat_id}", dependencies=[Depends(require_same_origin)])
async def patch_source(request: Request, chat_id: int, payload: SourcePatchPayload):
    storage: SQLiteStorage = request.app.state.storage
    try:
        source = storage.update_source(chat_id, **payload.model_dump(exclude_unset=True))
    except KeyError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    return source_to_dict(storage, source, stale_after_seconds=request.app.state.config.source_stale_after_seconds)


@router.post("/sources/{chat_id}/crawl-now", dependencies=[Depends(require_same_origin)])
async def crawl_source_now(request: Request, chat_id: int):
    try:
        return sanitize_error_fields(await request.app.state.collector.crawl_source(chat_id))
    except KeyError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get("/messages")
async def list_admin_messages(
    request: Request,
    chat_id: Optional[int] = Query(default=None),
    limit: int = Query(default=30, ge=1, le=200),
    cursor: str = Query(default="", max_length=500),
    query: str = Query(default="", max_length=200),
    media: str = Query(default="all"),
):
    storage: SQLiteStorage = request.app.state.storage
    page = FeedService(storage).admin_page(
        source_id=chat_id,
        query=query,
        media=media,
        cursor=cursor,
        limit=limit,
    )
    return {
        "items": [message_to_api_dict(message, media_base_path="/api/admin/media") for message in page.items],
        "has_more": page.has_more,
        "next_cursor": page.next_cursor,
        "total": None,
    }


@router.get("/media/{message_id}/{index}")
async def admin_media(
    request: Request,
    message_id: int,
    index: int,
    variant: Literal["thumbnail", "original"] = "thumbnail",
):
    storage: SQLiteStorage = request.app.state.storage
    message = storage.get_message(message_id)
    if message is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Media not found")
    media_cache: MediaCache = request.app.state.media_cache
    try:
        cached = await asyncio.to_thread(media_cache.get, message, index, variant=variant)
    except MediaNotFoundError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except MediaURLRejectedError as exc:
        raise HTTPException(status_code=http_status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except MediaCacheError as exc:
        raise HTTPException(status_code=http_status.HTTP_502_BAD_GATEWAY, detail="Failed to fetch media") from exc
    return FileResponse(cached.path, media_type=cached.media_type, headers={"Cache-Control": "private, no-store"})


@router.get("/operations/summary")
async def operations_summary(request: Request):
    storage: SQLiteStorage = request.app.state.storage
    stale = request.app.state.config.source_stale_after_seconds
    sources = [source_to_dict(storage, source, stale_after_seconds=stale) for source in storage.list_sources()]
    return {
        "sources": sources,
        "unhealthy_sources": [source for source in sources if source["health_status"] in {"unknown", "stale", "error"}],
        "public_source_count": sum(1 for source in sources if source["public_visible"] and source["enabled"]),
        "source_count": len(sources),
    }


@router.get("/rules")
async def list_rules(request: Request):
    return {"items": request.app.state.storage.list_alert_rules()}


@router.post("/rules", status_code=http_status.HTTP_201_CREATED, dependencies=[Depends(require_same_origin)])
async def create_rule(request: Request, payload: RuleCreatePayload):
    return request.app.state.storage.create_alert_rule(**payload.model_dump())


@router.patch("/rules/{rule_id}", dependencies=[Depends(require_same_origin)])
async def patch_rule(request: Request, rule_id: int, payload: RulePatchPayload):
    try:
        return request.app.state.storage.update_alert_rule(rule_id, **payload.model_dump(exclude_unset=True))
    except KeyError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get("/matches")
async def list_matches(request: Request, status: str = Query(default="", pattern="^(|new|acknowledged|resolved)$")):
    return {"items": request.app.state.storage.list_alert_matches(status=status)}


def _set_match_status(request: Request, match_id: int, status: str):
    try:
        return request.app.state.storage.set_alert_match_status(match_id, status)
    except KeyError as exc:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post("/matches/{match_id}/acknowledge", dependencies=[Depends(require_same_origin)])
async def acknowledge_match(request: Request, match_id: int):
    return _set_match_status(request, match_id, "acknowledged")


@router.post("/matches/{match_id}/resolve", dependencies=[Depends(require_same_origin)])
async def resolve_match(request: Request, match_id: int):
    return _set_match_status(request, match_id, "resolved")
