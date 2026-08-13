from __future__ import annotations

from typing import Any

from app.ingest.registry import AdapterRegistry
from app.storage import SQLiteStorage, StoredSource


class SourceService:
    def __init__(self, storage: SQLiteStorage, adapters: AdapterRegistry) -> None:
        self.storage = storage
        self.adapters = adapters

    def list_admin(self) -> list[StoredSource]:
        return self.storage.list_sources()

    def list_public(self) -> list[StoredSource]:
        return self.storage.list_sources(enabled_only=True, public_only=True)

    def create(self, *, name: str, locator: str, adapter: str = "telegram_public") -> StoredSource:
        try:
            port = self.adapters.get(adapter)
        except KeyError as exc:
            raise ValueError(f"unknown source adapter: {adapter}") from exc
        canonical = port.validate_locator(locator)
        return self.storage.create_source(
            name=name,
            source_url=canonical,
            adapter=port.key,
            public_visible=False,
        )

    def patch(self, source_id: int, **fields: Any) -> StoredSource:
        return self.storage.update_source(source_id, **fields)

    def enabled_bot_chat_ids(self) -> list[int]:
        return [
            source.chat_id
            for source in self.storage.list_sources(enabled_only=True)
            if (source.adapter or source.source_type) == "telegram_bot"
        ]
