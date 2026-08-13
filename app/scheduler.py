from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from .config import AppConfig, GroupConfig
from .image_exporter import SummaryImageExporter
from .public_telegram import PublicTelegramCrawler
from .storage import SQLiteStorage, StoredMessage
from .wecom_client import DEFAULT_MAX_TEXT_CHARS, WeComClient, WeComSendError, split_text


LOGGER = logging.getLogger(__name__)

_ERROR_FIELD_NAMES = frozenset({"error", "last_error", "latest_error"})
_URL_PATTERN = re.compile(r"\bhttps?://[^\s<>'\"]+", re.IGNORECASE)
_SERVER_PATH_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"(?:/[^\s<>'\":;,)\]}]+)+"
    r"|(?:\./)?(?:app|data|config|screenshots?|media(?:_cache)?|cache|logs?)/"
    r"[^\s<>'\":;,)\]}]+"
    r"|[A-Za-z]:\\\\[^\s<>'\":;,)\]}]+"
    r")",
    re.IGNORECASE,
)


def sanitize_error_text(error: Optional[str]) -> Optional[str]:
    """Remove server filesystem paths from an error while preserving URLs."""
    if error is None:
        return None
    text = str(error)
    pieces: List[str] = []
    cursor = 0
    for match in _URL_PATTERN.finditer(text):
        pieces.append(_SERVER_PATH_PATTERN.sub("[redacted path]", text[cursor : match.start()]))
        pieces.append(match.group(0))
        cursor = match.end()
    pieces.append(_SERVER_PATH_PATTERN.sub("[redacted path]", text[cursor:]))
    return "".join(pieces)


def sanitize_error_fields(value: Any) -> Any:
    """Recursively sanitize only fields whose names carry error text."""
    if isinstance(value, dict):
        return {
            key: (
                sanitize_error_text(item)
                if isinstance(key, str)
                and key.lower() in _ERROR_FIELD_NAMES
                and isinstance(item, str)
                else sanitize_error_fields(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_error_fields(item) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_error_fields(item) for item in value)
    return value


class SourceCollector:
    """Run dynamic public-source collection without activating legacy delivery."""

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
        return [
            self.crawl_source_sync(source.chat_id)
            for source in self.storage.list_sources(enabled_only=True)
        ]

    def crawl_source_sync(self, chat_id: int) -> Dict[str, object]:
        source = self.storage.get_source(chat_id)
        if source is None or not source.enabled:
            raise KeyError(f"enabled source not found: {chat_id}")
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


@dataclass(frozen=True)
class ForwardGroupResult:
    chat_id: int
    group_name: str
    message_count: int
    success: bool
    error: Optional[str] = None
    delivery: str = "webhook"
    screenshot_paths: Optional[List[str]] = None


@dataclass(frozen=True)
class ForwardRunResult:
    trigger: str
    groups: List[ForwardGroupResult]
    unconfigured_pending: List[Dict[str, object]]
    crawled_sources: List[Dict[str, object]]

    def as_dict(self) -> Dict[str, object]:
        groups = []
        for group in self.groups:
            payload = asdict(group)
            payload.pop("screenshot_paths", None)
            groups.append(sanitize_error_fields(payload))
        return {
            "trigger": self.trigger,
            "groups": groups,
            "unconfigured_pending": self.unconfigured_pending,
            "crawled_sources": sanitize_error_fields(self.crawled_sources),
        }


class Forwarder:
    def __init__(
        self,
        *,
        config: AppConfig,
        storage: SQLiteStorage,
        wecom_client: WeComClient,
        public_crawler: Optional[PublicTelegramCrawler] = None,
        image_exporter: Optional[SummaryImageExporter] = None,
        pending_limit: int = 1000,
    ) -> None:
        self.config = config
        self.storage = storage
        self.wecom_client = wecom_client
        self.public_crawler = public_crawler
        self.image_exporter = image_exporter
        self.pending_limit = pending_limit
        self._lock = asyncio.Lock()

    async def forward_all(self, trigger: str = "scheduled") -> ForwardRunResult:
        async with self._lock:
            return await asyncio.to_thread(self._forward_all_sync, trigger)

    async def crawl_public_sources(self) -> List[Dict[str, object]]:
        async with self._lock:
            return await asyncio.to_thread(self._crawl_public_sources)

    async def retry_delivery(self, delivery_id: int) -> Dict[str, object]:
        async with self._lock:
            return await asyncio.to_thread(self._retry_delivery_sync, int(delivery_id))

    async def retry_due_deliveries(self) -> List[int]:
        async with self._lock:
            return await asyncio.to_thread(self._retry_due_deliveries_sync)

    def _forward_all_sync(self, trigger: str) -> ForwardRunResult:
        self._retry_due_deliveries_sync()
        crawled_sources = self._crawl_public_sources()
        results: List[ForwardGroupResult] = []
        for group in self.config.groups.values():
            messages = self.storage.get_unbatched_pending_messages(group.chat_id, self.pending_limit)
            if not messages:
                continue
            results.append(self._forward_group(group, messages))

        unconfigured = self.storage.get_unconfigured_pending_counts(self.config.groups.keys())
        if unconfigured:
            LOGGER.warning("Pending messages exist for unconfigured Telegram chats: %s", unconfigured)
        return ForwardRunResult(
            trigger=trigger,
            groups=results,
            unconfigured_pending=unconfigured,
            crawled_sources=crawled_sources,
        )

    def _crawl_public_sources(self) -> List[Dict[str, object]]:
        if not self.public_crawler:
            return []
        results = []
        for group in self.config.public_source_groups():
            started_at = datetime.now(timezone.utc).isoformat()
            result = self.public_crawler.crawl_group(group)
            finished_at = datetime.now(timezone.utc).isoformat()
            safe_error = sanitize_error_text(result.error)
            self.storage.record_source_run(
                chat_id=result.chat_id,
                source=result.source,
                started_at=started_at,
                finished_at=finished_at,
                fetched_count=result.fetched,
                saved_count=result.saved,
                error=safe_error,
            )
            payload = result.as_dict()
            payload["error"] = safe_error
            results.append(payload)
            if result.error:
                LOGGER.warning(
                    "Public source crawl failed for %s: %s",
                    result.source,
                    result.error,
                )
            else:
                LOGGER.info(
                    "Public source crawled for %s: fetched=%d saved=%d",
                    result.source,
                    result.fetched,
                    result.saved,
                )
        return results

    def _forward_group(
        self,
        group: GroupConfig,
        messages: List[StoredMessage],
    ) -> ForwardGroupResult:
        summary = build_summary(group, messages, self.config.timezone)
        if not group.webhook_url and not group.screenshot_enabled:
            return ForwardGroupResult(
                chat_id=group.chat_id,
                group_name=group.name,
                message_count=len(messages),
                success=False,
                error="webhook_url is not configured and screenshot output is disabled",
                delivery="none",
            )
        channel = "webhook" if group.webhook_url else "screenshot"
        message_ids = [message.id for message in messages]
        message_versions = ",".join(
            f"{message.id}:{message.content_version}" for message in messages
        )
        fingerprint = hashlib.sha256(
            f"{channel}:{group.chat_id}:{message_versions}".encode("utf-8")
        ).hexdigest()
        batch = self.storage.create_delivery_batch(
            chat_id=group.chat_id,
            group_name=group.name,
            channel=channel,
            payload=summary,
            message_ids=message_ids,
            idempotency_key=fingerprint,
        )
        if batch["status"] == "succeeded":
            self.storage.mark_delivery_batch_forwarded(int(batch["id"]))
            return ForwardGroupResult(
                chat_id=group.chat_id,
                group_name=group.name,
                message_count=len(messages),
                success=True,
                delivery=channel,
            )
        return self._execute_delivery_batch(
            group=group,
            messages=messages,
            summary=summary,
            batch_id=int(batch["id"]),
            channel=channel,
            maybe_duplicate=int(batch["attempt_count"]) > 0,
        )

    def _execute_delivery_batch(
        self,
        *,
        group: GroupConfig,
        messages: List[StoredMessage],
        summary: str,
        batch_id: int,
        channel: str,
        maybe_duplicate: bool,
    ) -> ForwardGroupResult:
        chunk_count = (
            len(
                split_text(
                    summary,
                    int(getattr(self.wecom_client, "max_text_chars", DEFAULT_MAX_TEXT_CHARS)),
                )
            )
            if channel == "webhook"
            else 1
        )
        attempt = self.storage.begin_delivery_attempt(
            batch_id,
            maybe_duplicate=maybe_duplicate,
            chunk_count=chunk_count,
        )
        screenshot_paths: Optional[List[str]] = None
        completed_chunks = 0
        try:
            if channel == "webhook":
                if not group.webhook_url:
                    raise RuntimeError("webhook_url is not configured")
                send_result = self.wecom_client.send_text(group.webhook_url, summary)
                completed_chunks = int(getattr(send_result, "chunks", chunk_count))
            elif channel == "screenshot":
                if not self.image_exporter:
                    raise RuntimeError("screenshot exporter is not configured")
                export_result = self.image_exporter.export(
                    group_name=group.name,
                    chat_id=group.chat_id,
                    summary=summary,
                    messages=messages,
                    timezone_name=self.config.timezone,
                )
                screenshot_paths = export_result.paths
                completed_chunks = 1
            else:
                raise RuntimeError(f"unsupported delivery channel: {channel}")
            self.storage.finish_delivery_attempt(
                attempt["id"],
                success=True,
                error=None,
                completed_chunks=completed_chunks,
            )
            self.storage.mark_delivery_batch_forwarded(batch_id)
            self.storage.log_forward(
                chat_id=group.chat_id,
                group_name=group.name,
                message_count=len(messages),
                success=True,
                error=None,
                payload_preview="\n".join(screenshot_paths) if screenshot_paths else summary,
            )
            return ForwardGroupResult(
                chat_id=group.chat_id,
                group_name=group.name,
                message_count=len(messages),
                success=True,
                delivery=channel,
                screenshot_paths=screenshot_paths,
            )
        except Exception as exc:  # noqa: BLE001 - record and retry next run.
            LOGGER.exception("Delivery failed for chat_id=%s channel=%s", group.chat_id, channel)
            next_retry_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
            safe_error = sanitize_error_text(str(exc))
            self.storage.finish_delivery_attempt(
                attempt["id"],
                success=False,
                error=safe_error,
                next_retry_at=next_retry_at,
                completed_chunks=(
                    exc.completed_chunks
                    if isinstance(exc, WeComSendError)
                    else completed_chunks
                ),
            )
            self.storage.log_forward(
                chat_id=group.chat_id,
                group_name=group.name,
                message_count=len(messages),
                success=False,
                error=safe_error,
                payload_preview=summary,
            )
            return ForwardGroupResult(
                chat_id=group.chat_id,
                group_name=group.name,
                message_count=len(messages),
                success=False,
                error=safe_error,
                delivery=channel,
            )

    def _retry_due_deliveries_sync(self) -> List[int]:
        retried: List[int] = []
        for delivery_id in self.storage.list_due_delivery_ids():
            try:
                result = self._retry_delivery_sync(delivery_id)
                if result["status"] == "succeeded":
                    retried.append(delivery_id)
            except Exception:  # noqa: BLE001 - one bad batch must not block others.
                LOGGER.exception("Automatic delivery retry failed for delivery_id=%s", delivery_id)
        return retried

    def _retry_delivery_sync(self, delivery_id: int) -> Dict[str, object]:
        batch = self.storage.get_delivery_batch(delivery_id)
        if batch["status"] == "succeeded":
            return batch
        group = self.config.group_for_chat(int(batch["chat_id"]))
        if group is None:
            raise KeyError(f"configured group not found for delivery: {delivery_id}")
        messages = []
        for message_id in self.storage.get_delivery_message_ids(delivery_id):
            message = self.storage.get_message(message_id)
            if message is not None:
                messages.append(message)
        if not messages:
            raise KeyError(f"delivery has no messages: {delivery_id}")
        self._execute_delivery_batch(
            group=group,
            messages=messages,
            summary=str(batch["payload"]),
            batch_id=delivery_id,
            channel=str(batch["channel"]),
            maybe_duplicate=True,
        )
        return self.storage.get_delivery_batch(delivery_id)


def build_summary(group: GroupConfig, messages: List[StoredMessage], timezone_name: str) -> str:
    local_tz = get_timezone(timezone_name)
    local_times = [to_local_time(message.message_time, local_tz) for message in messages]
    start = min(local_times).strftime("%Y-%m-%d %H:%M")
    end = max(local_times).strftime("%Y-%m-%d %H:%M")

    lines = [
        "【Telegram 群消息汇总】",
        f"群组：{group.name}",
        f"时间：{start} ~ {end}",
        f"数量：{len(messages)}",
        "",
    ]
    for index, message in enumerate(messages, start=1):
        timestamp = to_local_time(message.message_time, local_tz).strftime("%H:%M")
        sender = message.sender_name or "Unknown"
        content = message.content.strip() or (f"[{message.media_type}]" if message.media_type else "")
        lines.append(f"{index}. [{timestamp}] {sender}")
        lines.append(content)
        lines.append("")
    return "\n".join(lines).strip()


def create_background_scheduler(config: AppConfig, forwarder: Forwarder):
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from apscheduler.triggers.cron import CronTrigger
    from apscheduler.triggers.interval import IntervalTrigger

    timezone_info = get_timezone(config.timezone)
    scheduler = AsyncIOScheduler(timezone=timezone_info)
    if config.public_source_groups():
        scheduler.add_job(
            forwarder.crawl_public_sources,
            IntervalTrigger(
                seconds=config.crawl_interval_seconds,
                timezone=timezone_info,
            ),
            id="crawl_public_telegram_sources",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
            next_run_time=datetime.now(timezone_info),
        )
    scheduler.add_job(
        forwarder.forward_all,
        CronTrigger.from_crontab(config.forward_cron, timezone=timezone_info),
        id="forward_telegram_to_wecom",
        kwargs={"trigger": "scheduled"},
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    scheduler.add_job(
        forwarder.retry_due_deliveries,
        IntervalTrigger(seconds=60, timezone=timezone_info),
        id="retry_due_deliveries",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    return scheduler


def create_collection_scheduler(config: AppConfig, collector: SourceCollector, github_collector=None):
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
    if github_collector is not None and config.github_enabled:
        scheduler.add_job(
            github_collector.refresh,
            IntervalTrigger(
                seconds=config.github_refresh_interval_seconds,
                timezone=timezone_info,
            ),
            id="refresh_github_rankings",
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


def to_local_time(value: str, timezone_info) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone_info)
