from __future__ import annotations

import logging
from dataclasses import dataclass

from app.ingest.ports import NormalizedItem
from app.storage import MessagePage, SQLiteStorage, StoredMessage
from app.telegram_client import TelegramMessage

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class SaveItemResult:
    item_id: int | None
    inserted: bool
    persisted: bool


class FeedService:
    def __init__(self, storage: SQLiteStorage) -> None:
        self.storage = storage

    def ingest(self, item: NormalizedItem) -> SaveItemResult:
        try:
            message_id = int(item.external_id)
        except (TypeError, ValueError):
            LOGGER.warning("dropping item with non-integer external_id=%s", item.external_id)
            return SaveItemResult(item_id=None, inserted=False, persisted=False)
        raw = dict(item.raw or {})
        if item.permalink:
            raw.setdefault("source_url", item.permalink)
        message = TelegramMessage(
            chat_id=int(item.source_id),
            chat_title=item.title,
            message_id=message_id,
            sender_name=item.author,
            message_time=item.occurred_at,
            content=item.content,
            media_type=item.media_type,
            raw=raw,
        )
        inserted = self.storage.save_message(message)
        stored = self.storage.get_message_by_telegram_id(int(item.source_id), message_id)
        if stored is None:
            return SaveItemResult(item_id=None, inserted=False, persisted=False)
        return SaveItemResult(item_id=stored.id, inserted=inserted, persisted=True)

    def public_page(
        self,
        *,
        source_id: int | None,
        query: str,
        media: str,
        cursor: str,
        limit: int,
    ) -> MessagePage:
        allowed = self.storage.public_chat_ids()
        if source_id is not None and int(source_id) not in allowed:
            raise KeyError("Source not found")
        return self.storage.list_messages_page(
            chat_id=source_id,
            limit=limit,
            cursor=cursor,
            query=query,
            media=media,
            allowed_chat_ids=allowed,
        )

    def admin_page(
        self,
        *,
        source_id: int | None,
        query: str,
        media: str,
        cursor: str,
        limit: int,
    ) -> MessagePage:
        return self.storage.list_messages_page(
            chat_id=source_id,
            limit=limit,
            cursor=cursor,
            query=query,
            media=media,
        )

    def get(self, item_id: int) -> StoredMessage | None:
        return self.storage.get_message(item_id)
