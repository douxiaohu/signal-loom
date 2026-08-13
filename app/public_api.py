from __future__ import annotations

import asyncio
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request, status as http_status
from fastapi.responses import FileResponse

from .api_common import etag_json_response, message_to_api_dict
from .media_cache import (
    MediaCache,
    MediaCacheError,
    MediaNotFoundError,
    MediaURLRejectedError,
)
from .storage import SQLiteStorage


router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/sources")
async def list_public_sources(request: Request):
    storage: SQLiteStorage = request.app.state.storage
    stats = {int(item["chat_id"]): item for item in storage.get_chats()}
    items = []
    for source in storage.list_sources(enabled_only=True, public_only=True):
        health = storage.get_source_health(
            source.chat_id,
            stale_after_seconds=request.app.state.config.source_stale_after_seconds,
        )
        item_stats = stats.get(source.chat_id, {})
        items.append(
            {
                "chat_id": source.chat_id,
                "name": source.name,
                "source_url": source.source_url,
                "message_count": int(item_stats.get("message_count") or 0),
                "last_message_time": item_stats.get("last_message_time"),
                "health_status": health["health_status"],
            }
        )
    return etag_json_response(request, {"items": items})


@router.get("/messages")
async def list_public_messages(
    request: Request,
    chat_id: Optional[int] = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str = Query(default="", max_length=500),
    query: str = Query(default="", max_length=200),
    media: str = Query(
        default="all",
        pattern="^(all|text|photo|video|document|animation|audio|voice|sticker)$",
    ),
):
    storage: SQLiteStorage = request.app.state.storage
    allowed = storage.public_chat_ids()
    if chat_id is not None and int(chat_id) not in allowed:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Source not found")
    page = storage.list_messages_page(
        chat_id=chat_id,
        limit=limit,
        cursor=cursor,
        query=query,
        media=media,
        allowed_chat_ids=allowed,
    )
    payload = {
        "items": [
            message_to_api_dict(message, media_base_path="/api/public/media")
            for message in page.items
        ],
        "has_more": page.has_more,
        "next_cursor": page.next_cursor,
        "total": None,
    }
    return etag_json_response(request, payload)


@router.get("/media/{message_id}/{index}")
async def public_media(
    request: Request,
    message_id: int,
    index: int,
    variant: Literal["thumbnail", "original"] = "thumbnail",
):
    storage: SQLiteStorage = request.app.state.storage
    message = storage.get_message(message_id)
    if message is None:
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Media not found")
    source = storage.get_source(message.chat_id)
    if source is None or not source.enabled or not source.public_visible:
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
    return FileResponse(
        cached.path,
        media_type=cached.media_type,
        headers={"Cache-Control": "no-cache"},
    )
