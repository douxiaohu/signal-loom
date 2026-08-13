from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional
from urllib import error, request

from .ingest.ports import NormalizedItem
from .storage import SQLiteStorage, utc_now_iso


LOGGER = logging.getLogger(__name__)
OFFSET_STATE_KEY = "telegram_update_offset"
TELEGRAM_API_BASE = "https://api.telegram.org"
MEDIA_KEYS = (
    "photo",
    "document",
    "video",
    "animation",
    "audio",
    "voice",
    "video_note",
    "sticker",
    "location",
    "contact",
    "poll",
)


@dataclass(frozen=True)
class TelegramMessage:
    chat_id: int
    chat_title: str
    message_id: int
    sender_name: str
    message_time: str
    content: str
    media_type: Optional[str]
    raw: Dict[str, Any]


@dataclass
class PollerStatus:
    running: bool = False
    last_update_id: Optional[int] = None
    last_poll_at: Optional[str] = None
    last_saved_at: Optional[str] = None
    saved_messages: int = 0
    last_error: Optional[str] = None
    configured_offset: Optional[int] = None
    extra: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "running": self.running,
            "last_update_id": self.last_update_id,
            "last_poll_at": self.last_poll_at,
            "last_saved_at": self.last_saved_at,
            "saved_messages": self.saved_messages,
            "last_error": self.last_error,
            "configured_offset": self.configured_offset,
            **self.extra,
        }


class TelegramAPIError(RuntimeError):
    pass


class TelegramBotClient:
    def __init__(self, token: str, *, api_base: str = TELEGRAM_API_BASE) -> None:
        if not token:
            raise ValueError("Telegram bot token is required")
        self.token = token
        self.api_base = api_base.rstrip("/")

    async def get_updates(self, *, offset: Optional[int], timeout: int = 50) -> Iterable[Dict[str, Any]]:
        payload = {
            "timeout": int(timeout),
            "allowed_updates": ["message", "channel_post", "edited_message", "edited_channel_post"],
        }
        if offset is not None:
            payload["offset"] = int(offset)

        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(
            None,
            lambda: self._post_json("getUpdates", payload, timeout + 10),
        )
        if not response.get("ok"):
            raise TelegramAPIError(str(response))
        updates = response.get("result", [])
        if not isinstance(updates, list):
            raise TelegramAPIError("Telegram getUpdates result is not a list")
        return updates

    def _post_json(self, method: str, payload: Dict[str, Any], timeout: int) -> Dict[str, Any]:
        url = f"{self.api_base}/bot{self.token}/{method}"
        request_body = json.dumps(payload).encode("utf-8")
        http_request = request.Request(
            url,
            data=request_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with request.urlopen(http_request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
        except error.URLError as exc:
            raise TelegramAPIError(str(exc)) from exc
        return json.loads(body)


class TelegramPoller:
    def __init__(
        self,
        *,
        client: TelegramBotClient,
        storage: SQLiteStorage,
        source_chat_ids: Iterable[int] = (),
        poll_timeout: int = 50,
        retry_delay: float = 5.0,
        feed_service=None,
        resolve_chat_ids=None,
    ) -> None:
        from .domain.feed.service import FeedService

        self.client = client
        self.storage = storage
        self.poll_timeout = poll_timeout
        self.retry_delay = retry_delay
        self._static_chat_ids = tuple(dict.fromkeys(int(chat_id) for chat_id in source_chat_ids))
        self.feed_service = feed_service or FeedService(storage)
        self._resolve_chat_ids = resolve_chat_ids
        self.status = PollerStatus()

    @property
    def source_chat_ids(self) -> tuple[int, ...]:
        if self._resolve_chat_ids is not None:
            return tuple(dict.fromkeys(int(chat_id) for chat_id in self._resolve_chat_ids()))
        return self._static_chat_ids

    @source_chat_ids.setter
    def source_chat_ids(self, value: Iterable[int]) -> None:
        self._static_chat_ids = tuple(dict.fromkeys(int(chat_id) for chat_id in value))

    async def run(self, stop_event: asyncio.Event) -> None:
        raw_offset = self.storage.get_state(OFFSET_STATE_KEY)
        offset = int(raw_offset) if raw_offset not in {None, ""} else None
        self.status.configured_offset = offset
        self.status.running = True
        LOGGER.info("Telegram poller started with offset=%s", offset)

        try:
            while not stop_event.is_set():
                started_at = utc_now_iso()
                watched = self.source_chat_ids
                fetched_counts = {chat_id: 0 for chat_id in watched}
                saved_counts = {chat_id: 0 for chat_id in watched}
                try:
                    self.status.last_poll_at = utc_now_iso()
                    updates = await self.client.get_updates(offset=offset, timeout=self.poll_timeout)
                    for update in updates:
                        next_offset = int(update["update_id"]) + 1
                        message = extract_telegram_message(update)
                        if message is not None:
                            if message.chat_id in fetched_counts:
                                fetched_counts[message.chat_id] += 1
                            result = self.feed_service.ingest(_message_to_item(message))
                            if result.inserted:
                                self.status.saved_messages += 1
                                self.status.last_saved_at = utc_now_iso()
                                if message.chat_id in saved_counts:
                                    saved_counts[message.chat_id] += 1
                        offset = next_offset
                        self.storage.set_state(OFFSET_STATE_KEY, offset)
                        self.status.last_update_id = int(update["update_id"])
                        self.status.configured_offset = offset
                    self.status.last_error = None
                    finished_at = utc_now_iso()
                    for chat_id in watched:
                        self.storage.record_source_run(
                            chat_id=chat_id,
                            source="telegram_bot",
                            started_at=started_at,
                            finished_at=finished_at,
                            fetched_count=fetched_counts[chat_id],
                            saved_count=saved_counts[chat_id],
                            error=None,
                        )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - poller must keep running.
                    LOGGER.exception("Telegram polling failed")
                    self.status.last_error = str(exc)
                    finished_at = utc_now_iso()
                    for chat_id in watched:
                        self.storage.record_source_run(
                            chat_id=chat_id,
                            source="telegram_bot",
                            started_at=started_at,
                            finished_at=finished_at,
                            fetched_count=fetched_counts[chat_id],
                            saved_count=saved_counts[chat_id],
                            error=str(exc),
                        )
                    await asyncio.sleep(self.retry_delay)
        finally:
            self.status.running = False
            LOGGER.info("Telegram poller stopped")


def _message_to_item(message: TelegramMessage) -> NormalizedItem:
    raw = dict(message.raw or {})
    return NormalizedItem(
        source_id=message.chat_id,
        external_id=str(message.message_id),
        occurred_at=message.message_time,
        author=message.sender_name,
        title=message.chat_title,
        content=message.content,
        media_type=message.media_type,
        raw=raw,
        permalink=raw.get("source_url") if isinstance(raw.get("source_url"), str) else None,
    )


def extract_telegram_message(update: Dict[str, Any]) -> Optional[TelegramMessage]:
    message = _first_present(
        update,
        ("message", "channel_post", "edited_message", "edited_channel_post"),
    )
    if not isinstance(message, dict):
        return None

    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    message_id = message.get("message_id")
    if chat_id is None or message_id is None:
        return None

    media_type = detect_media_type(message)
    text = message.get("text")
    caption = message.get("caption")
    content = text if isinstance(text, str) else caption if isinstance(caption, str) else ""
    if not content and media_type:
        content = f"[{media_type}]"

    if media_type and content and not content.startswith(f"[{media_type}]") and not text:
        content = f"[{media_type}] {content}"

    return TelegramMessage(
        chat_id=int(chat_id),
        chat_title=chat_display_name(chat),
        message_id=int(message_id),
        sender_name=sender_display_name(message),
        message_time=telegram_date_to_iso(message.get("date")),
        content=content,
        media_type=media_type,
        raw=update,
    )


def detect_media_type(message: Dict[str, Any]) -> Optional[str]:
    for key in MEDIA_KEYS:
        if key in message:
            return key
    return None


def telegram_date_to_iso(value: Any) -> str:
    try:
        timestamp = int(value)
    except (TypeError, ValueError):
        return utc_now_iso()
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).replace(microsecond=0).isoformat()


def chat_display_name(chat: Dict[str, Any]) -> str:
    for key in ("title", "username", "first_name"):
        value = chat.get(key)
        if value:
            return str(value)
    return str(chat.get("id", ""))


def sender_display_name(message: Dict[str, Any]) -> str:
    sender_chat = message.get("sender_chat")
    if isinstance(sender_chat, dict):
        return chat_display_name(sender_chat)

    sender = message.get("from")
    if not isinstance(sender, dict):
        return ""
    full_name = " ".join(
        part for part in (sender.get("first_name"), sender.get("last_name")) if part
    ).strip()
    return full_name or str(sender.get("username") or sender.get("id") or "")


def _first_present(mapping: Dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None
