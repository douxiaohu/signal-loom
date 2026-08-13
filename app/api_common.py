from __future__ import annotations

import hashlib
import json
from typing import Dict

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from .storage import StoredMessage, media_items_from_raw_json, source_url_from_raw_json


def message_to_api_dict(
    message: StoredMessage,
    *,
    media_base_path: str,
    include_forwarded: bool = False,
) -> Dict[str, object]:
    media_items = media_items_from_raw_json(message.raw_json, message.media_type)
    serialized_items = [
        {
            "url": f"{media_base_path}/{message.id}/{index}?variant=thumbnail",
            "original_url": f"{media_base_path}/{message.id}/{index}?variant=original",
            "kind": item["kind"],
            "role": item["role"],
        }
        for index, item in enumerate(media_items)
    ]
    payload: Dict[str, object] = {
        "id": message.id,
        "chat_id": message.chat_id,
        "chat_title": message.chat_title,
        "message_id": message.message_id,
        "sender_name": message.sender_name,
        "message_time": message.message_time,
        "content": message.content,
        "media_type": message.media_type,
        "media_urls": [item["url"] for item in serialized_items],
        "media_items": serialized_items,
        "source_url": source_url_from_raw_json(message.raw_json),
    }
    if include_forwarded:
        payload["forwarded_at"] = message.forwarded_at
    return payload


def etag_json_response(request: Request, payload: object) -> Response:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    etag = f'"{hashlib.sha256(encoded).hexdigest()}"'
    headers = {"Cache-Control": "no-cache", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(payload, headers=headers)
