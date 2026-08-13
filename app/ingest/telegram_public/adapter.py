from __future__ import annotations

import json

from app.ingest.ports import FetchResult, NormalizedItem
from app.source_utils import canonical_telegram_public_url, public_source_chat_id
from app.storage import StoredSource, source_url_from_raw_json


class TelegramPublicAdapter:
    key = "telegram_public"

    def __init__(self, *, timeout: int = 20) -> None:
        self.timeout = int(timeout)

    def validate_locator(self, locator: str) -> str:
        return canonical_telegram_public_url(locator)

    def allocate_source_id(self, locator: str) -> int:
        return public_source_chat_id(locator)

    def fetch(self, source: StoredSource) -> FetchResult:
        from app.public_telegram import fetch_public_posts

        locator = source.locator or source.source_url
        posts = fetch_public_posts(locator, source.chat_id, source.name, timeout=self.timeout)
        items = [
            NormalizedItem(
                source_id=post.chat_id,
                external_id=str(post.message_id),
                occurred_at=post.message_time,
                author=post.sender_name,
                title=post.chat_title,
                content=post.content,
                media_type=post.media_type,
                raw=dict(post.raw or {}),
                permalink=source_url_from_raw_json(json.dumps(post.raw or {})),
            )
            for post in posts
        ]
        return FetchResult(fetched=len(items), items=items)
