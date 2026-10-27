from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, List
from zoneinfo import ZoneInfo

from .http.errors import sanitize_error_fields, sanitize_error_text
from .public_telegram import PublicTelegramCrawler
from .storage import SQLiteStorage

LOGGER = logging.getLogger(__name__)


class SourceCollector:
    """Collect enabled fetch-based sources. telegram_bot rows are owned by the poller."""

    def __init__(
        self,
        *,
        storage: SQLiteStorage,
        crawler: PublicTelegramCrawler,
    ) -> None:
        self.storage = storage
        self.crawler = crawler
        self._lock = asyncio.Lock()

    async def crawl_public_sources(self) -> List[Dict[str, object]]:
        async with self._lock:
            return await asyncio.to_thread(self.crawl_public_sources_sync)

    async def crawl_source(self, chat_id: int) -> Dict[str, object]:
        async with self._lock:
            return await asyncio.to_thread(self.crawl_source_sync, int(chat_id))

    def crawl_public_sources_sync(self) -> List[Dict[str, object]]:
        results = []
        for source in self.storage.list_sources(enabled_only=True):
            adapter = source.adapter or source.source_type or "telegram_public"
            if adapter == "telegram_bot":
                continue
            results.append(self.crawl_source_sync(source.chat_id))
        return results

    def crawl_source_sync(self, chat_id: int) -> Dict[str, object]:
        source = self.storage.get_source(chat_id)
        if source is None or not source.enabled:
            raise KeyError(f"enabled source not found: {chat_id}")
        adapter = source.adapter or source.source_type or "telegram_public"
        if adapter == "telegram_bot":
            raise KeyError(f"telegram_bot source is polled, not crawled: {chat_id}")
        started_at = datetime.now(timezone.utc).isoformat()
        result = self.crawler.crawl_source(source)
        finished_at = datetime.now(timezone.utc).isoformat()
        safe_error = sanitize_error_text(result.error)
        self.storage.record_source_run(
            chat_id=source.chat_id,
            source=source.source_url,
            started_at=started_at,
            finished_at=finished_at,
            fetched_count=result.fetched,
            saved_count=result.saved,
            error=safe_error,
        )
        payload = result.as_dict()
        payload["error"] = safe_error
        if result.error:
            LOGGER.warning("Public source crawl failed for %s: %s", source.source_url, safe_error)
        else:
            LOGGER.info(
                "Public source crawled for %s: fetched=%d saved=%d",
                source.source_url,
                result.fetched,
                result.saved,
            )
        return payload


def create_collection_scheduler(config, collector: SourceCollector):
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.interval import IntervalTrigger

    timezone_info = get_timezone(config.timezone)
    scheduler = AsyncIOScheduler(timezone=timezone_info)
    scheduler.add_job(
        collector.crawl_public_sources,
        IntervalTrigger(
            seconds=config.crawl_interval_seconds,
            timezone=timezone_info,
        ),
        id="crawl_public_sources",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
        next_run_time=datetime.now(timezone_info),
    )
    return scheduler


def get_timezone(timezone_name: str):
    try:
        return ZoneInfo(timezone_name)
    except Exception:  # noqa: BLE001 - fallback keeps service bootable.
        LOGGER.warning("Invalid timezone %s, falling back to UTC", timezone_name)
        return timezone.utc


__all__ = [
    "SourceCollector",
    "create_collection_scheduler",
    "get_timezone",
    "sanitize_error_fields",
    "sanitize_error_text",
]
