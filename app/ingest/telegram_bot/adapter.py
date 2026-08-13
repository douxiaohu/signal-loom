from __future__ import annotations

from app.ingest.ports import FetchResult
from app.storage import StoredSource


class TelegramBotAdapter:
    key = "telegram_bot"

    def validate_locator(self, locator: str) -> str:
        value = str(locator or "").strip()
        try:
            chat_id = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("telegram_bot locator must be a numeric chat_id") from exc
        return str(chat_id)

    def allocate_source_id(self, locator: str) -> int:
        return int(self.validate_locator(locator))

    def fetch(self, source: StoredSource) -> FetchResult:
        # Long polling in TelegramPoller is the write path for this adapter.
        return FetchResult(fetched=0, items=[])
