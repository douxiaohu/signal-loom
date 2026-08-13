from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib import error, request

from .config import GroupConfig
from .domain.feed.service import FeedService
from .ingest.ports import NormalizedItem
from .media_cache import MediaCache, MediaCacheError
from .source_utils import normalize_telegram_public_source
from .storage import SQLiteStorage, StoredSource, media_urls_from_raw_json, utc_now_iso
from .telegram_client import TelegramMessage


LOGGER = logging.getLogger(__name__)
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


@dataclass(frozen=True)
class CrawlResult:
    source: str
    chat_id: int
    fetched: int
    saved: int
    error: Optional[str] = None

    def as_dict(self) -> Dict[str, object]:
        return {
            "source": self.source,
            "chat_id": self.chat_id,
            "fetched": self.fetched,
            "saved": self.saved,
            "error": self.error,
        }


class PublicTelegramCrawler:
    def __init__(
        self,
        storage: SQLiteStorage,
        *,
        media_cache: Optional[MediaCache] = None,
        timeout: int = 20,
        feed_service: Optional[FeedService] = None,
    ) -> None:
        self.storage = storage
        self.media_cache = media_cache
        self.timeout = int(timeout)
        self.feed_service = feed_service or FeedService(storage)

    def crawl_group(self, group: GroupConfig) -> CrawlResult:
        if not group.source:
            return CrawlResult(source="", chat_id=group.chat_id, fetched=0, saved=0, error="missing source")
        return self._crawl(
            source=group.source,
            chat_id=group.chat_id,
            name=group.name,
        )

    def crawl_source(self, source: StoredSource) -> CrawlResult:
        return self._crawl(
            source=source.source_url,
            chat_id=source.chat_id,
            name=source.name,
        )

    def _crawl(self, *, source: str, chat_id: int, name: str) -> CrawlResult:
        try:
            posts = fetch_public_posts(source, chat_id, name, timeout=self.timeout)
            saved = 0
            for post in posts:
                result = self.feed_service.ingest(_message_to_item(post))
                if result.inserted:
                    saved += 1
                if result.persisted and result.item_id is not None:
                    stored = self.feed_service.get(result.item_id)
                    if stored is not None:
                        self._warm_media_cache(stored, post)
            return CrawlResult(source=source, chat_id=chat_id, fetched=len(posts), saved=saved)
        except Exception as exc:  # noqa: BLE001 - source failures should not stop forwarding other groups.
            LOGGER.exception("Failed to crawl Telegram public source %s", source)
            return CrawlResult(
                source=source,
                chat_id=chat_id,
                fetched=0,
                saved=0,
                error=str(exc),
            )

    def _warm_media_cache(self, message, post: TelegramMessage | None = None) -> None:
        if not self.media_cache:
            return
        if post is None and not hasattr(message, "raw_json"):
            stored = self.storage.get_message_by_telegram_id(message.chat_id, message.message_id)
            if stored is None:
                return
            post = message
            message = stored
        media_type = post.media_type if post is not None else getattr(message, "media_type", None)
        if not media_type:
            return
        media_urls = media_urls_from_raw_json(message.raw_json)
        for index, _ in enumerate(media_urls):
            try:
                self.media_cache.get(message, index)
            except MediaCacheError as exc:
                LOGGER.warning(
                    "Failed to warm media cache for chat_id=%s message_id=%s index=%s: %s",
                    getattr(message, "chat_id", None),
                    getattr(message, "message_id", None),
                    index,
                    exc,
                )


def _message_to_item(post: TelegramMessage) -> NormalizedItem:
    raw = dict(post.raw or {})
    return NormalizedItem(
        source_id=post.chat_id,
        external_id=str(post.message_id),
        occurred_at=post.message_time,
        author=post.sender_name,
        title=post.chat_title,
        content=post.content,
        media_type=post.media_type,
        raw=raw,
        permalink=raw.get("source_url") if isinstance(raw.get("source_url"), str) else None,
    )


def fetch_public_posts(
    source: str,
    chat_id: int,
    chat_title: str,
    *,
    timeout: int = 20,
) -> List[TelegramMessage]:
    username = normalize_telegram_public_source(source)
    urls = [
        f"https://t.me/s/{username}",
        f"https://telegram.me/s/{username}",
    ]
    last_error: Exception | None = None
    html = ""
    for url in urls:
        http_request = request.Request(
            url,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (compatible; TelegramForwarder/0.1; "
                    "+https://example.invalid/telegram-forwarder)"
                )
            },
            method="GET",
        )
        try:
            with request.urlopen(http_request, timeout=timeout) as response:
                html = response.read().decode("utf-8", errors="replace")
            break
        except (error.URLError, TimeoutError) as exc:
            last_error = exc
    else:
        raise RuntimeError(f"Cannot fetch Telegram public source {username}: {last_error}") from last_error
    return parse_public_posts(html, username=username, chat_id=chat_id, chat_title=chat_title)


def parse_public_posts(
    html: str,
    *,
    username: str,
    chat_id: int,
    chat_title: str,
) -> List[TelegramMessage]:
    parser = TelegramPublicHTMLParser(username=username, chat_id=chat_id, chat_title=chat_title)
    parser.feed(html)
    parser.close()
    return parser.posts


class TelegramPublicHTMLParser(HTMLParser):
    def __init__(self, *, username: str, chat_id: int, chat_title: str) -> None:
        super().__init__(convert_charrefs=True)
        self.username = username
        self.chat_id = int(chat_id)
        self.chat_title = chat_title or username
        self.posts: List[TelegramMessage] = []
        self.current: Optional[Dict[str, Any]] = None
        self.depth = 0
        self.text_depth = 0
        self.ignored_media_depth = 0

    def handle_starttag(self, tag: str, attrs: List[tuple[str, Optional[str]]]) -> None:
        attr = {key: value or "" for key, value in attrs}
        classes = set(attr.get("class", "").split())

        if self.current is None and tag == "div" and attr.get("data-post"):
            self.current = {
                "data_post": attr.get("data-post", ""),
                "message_time": None,
                "text": [],
                "media_type": None,
                "media_urls": [],
                "media_items": [],
            }
            self.depth = 1
            return

        if self.current is None:
            return

        if tag not in VOID_TAGS:
            self.depth += 1

        if should_ignore_media_container(classes):
            self.ignored_media_depth = 1
        elif self.ignored_media_depth and tag not in VOID_TAGS:
            self.ignored_media_depth += 1

        if is_main_message_text(classes):
            self.text_depth = 1
        elif self.text_depth and tag not in VOID_TAGS:
            self.text_depth += 1

        if tag == "br" and self.text_depth:
            self.current["text"].append("\n")

        if not self.ignored_media_depth:
            media_items = extract_media_items(attr, classes)
            if media_items:
                self.current["media_items"].extend(media_items)
                self.current["media_urls"].extend(item["url"] for item in media_items)

        if tag == "time" and attr.get("datetime"):
            self.current["message_time"] = attr["datetime"]

        if not self.ignored_media_depth:
            media_type = detect_public_media_type(classes)
            if media_type and not self.current.get("media_type"):
                self.current["media_type"] = media_type

    def handle_startendtag(self, tag: str, attrs: List[tuple[str, Optional[str]]]) -> None:
        attr = {key: value or "" for key, value in attrs}
        classes = set(attr.get("class", "").split())

        if self.current is None:
            return

        if tag == "br" and self.text_depth:
            self.current["text"].append("\n")

        if not self.ignored_media_depth:
            media_items = extract_media_items(attr, classes)
            if media_items:
                self.current["media_items"].extend(media_items)
                self.current["media_urls"].extend(item["url"] for item in media_items)

            media_type = detect_public_media_type(classes)
            if media_type and not self.current.get("media_type"):
                self.current["media_type"] = media_type

    def handle_endtag(self, tag: str) -> None:
        if self.current is None:
            return

        if self.text_depth:
            self.text_depth -= 1
        if self.ignored_media_depth:
            self.ignored_media_depth -= 1
        if tag not in VOID_TAGS:
            self.depth -= 1
        if self.depth <= 0:
            self._finish_current()

    def handle_data(self, data: str) -> None:
        if self.current is not None and self.text_depth:
            self.current["text"].append(data)

    def _finish_current(self) -> None:
        if not self.current:
            return
        data_post = str(self.current.get("data_post") or "")
        message_id = parse_public_message_id(data_post)
        if message_id is None:
            self._reset_current()
            return
        media_type = self.current.get("media_type")
        media_items = unique_media_items(self.current.get("media_items", []))
        media_urls = [item["url"] for item in media_items]
        content = normalize_post_text("".join(self.current.get("text", [])))
        if not content and not media_type and not media_urls:
            self._reset_current()
            return
        if media_type and content:
            content = f"[{media_type}] {content}"
        elif media_type:
            content = f"[{media_type}]"

        self.posts.append(
            TelegramMessage(
                chat_id=self.chat_id,
                chat_title=self.chat_title,
                message_id=message_id,
                sender_name=self.chat_title,
                message_time=str(self.current.get("message_time") or utc_now_iso()),
                content=content,
                media_type=media_type,
                raw={
                    "source": self.username,
                    "data_post": data_post,
                    "source_url": f"https://t.me/{data_post}",
                    "media_urls": media_urls,
                    "media_items": media_items,
                },
            )
        )
        self._reset_current()

    def _reset_current(self) -> None:
        self.current = None
        self.depth = 0
        self.text_depth = 0
        self.ignored_media_depth = 0


def detect_public_media_type(classes: set[str]) -> Optional[str]:
    joined = " ".join(classes)
    if "tgme_widget_message_photo_wrap" in classes:
        return "photo"
    if any("message_video" in class_name for class_name in classes):
        return "video"
    if "message_document" in joined or "message_file" in joined:
        return "document"
    return None


def is_main_message_text(classes: set[str]) -> bool:
    return "js-message_text" in classes and "js-message_reply_text" not in classes


def should_ignore_media_container(classes: set[str]) -> bool:
    return bool(
        {
            "media_not_supported_cont",
            "message_media_not_supported_wrap",
            "tgme_widget_message_link_preview",
        }
        & classes
    )


def parse_public_message_id(data_post: str) -> Optional[int]:
    if "/" not in data_post:
        return None
    _, raw_id = data_post.rsplit("/", 1)
    try:
        return int(raw_id)
    except ValueError:
        return None


def normalize_post_text(value: str) -> str:
    lines = []
    for line in value.splitlines():
        normalized = " ".join(line.split())
        if normalized:
            lines.append(normalized)
    return "\n".join(lines)


def extract_media_items(attrs: Dict[str, str], classes: set[str]) -> List[Dict[str, str]]:
    if "tgme_widget_message_photo_wrap" in classes:
        return media_items_from_attrs(attrs, kind="image", role="media", include_style=True, include_src=True)
    if "tgme_widget_message_video_thumb" in classes:
        return media_items_from_attrs(attrs, kind="image", role="poster", include_style=True, include_src=True)
    if "tgme_widget_message_video_player" in classes:
        return media_items_from_attrs(attrs, kind="video", role="media", include_style=False, include_src=True)
    return []


def media_items_from_attrs(
    attrs: Dict[str, str],
    *,
    kind: str,
    role: str,
    include_style: bool,
    include_src: bool,
) -> List[Dict[str, str]]:
    urls: List[str] = []
    style = attrs.get("style", "")
    if include_style:
        urls.extend(re.findall(r"background-image:url\('([^']+)'\)", style))
    src = attrs.get("src") if include_src else ""
    if src:
        urls.append(src)
    return [
        {"url": normalize_media_url(url), "kind": kind, "role": role}
        for url in urls
        if is_content_media_url(url)
    ]


def is_content_media_element(classes: set[str]) -> bool:
    return bool(
        {
            "tgme_widget_message_photo_wrap",
            "tgme_widget_message_video_thumb",
            "tgme_widget_message_video_player",
        }
        & classes
    )


def normalize_media_url(url: str) -> str:
    if url.startswith("//"):
        return f"https:{url}"
    return url


def is_content_media_url(url: str) -> bool:
    normalized = normalize_media_url(url)
    if "telegram.org/img/emoji" in normalized:
        return False
    return normalized.startswith("https://") and (
        "telesco.pe/" in normalized
        or "cdn" in normalized
        or normalized.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
    )


def unique_strings(values: List[str]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def unique_media_items(values: List[Dict[str, str]]) -> List[Dict[str, str]]:
    seen = set()
    result: List[Dict[str, str]] = []
    for item in values:
        url = item.get("url")
        if not url or url in seen:
            continue
        seen.add(url)
        result.append(
            {
                "url": url,
                "kind": item.get("kind", "file"),
                "role": item.get("role", "media"),
            }
        )
    return result
