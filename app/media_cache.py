from __future__ import annotations

import hashlib
import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib import error, request
from urllib.parse import urlparse

from PIL import Image

from .storage import StoredMessage, media_items_from_raw_json, media_urls_from_raw_json


ALLOWED_MEDIA_HOST_SUFFIXES = (
    "telesco.pe",
)
ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
ALLOWED_VIDEO_TYPES = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-m4v": ".m4v",
}
ALLOWED_MEDIA_TYPES = {**ALLOWED_IMAGE_TYPES, **ALLOWED_VIDEO_TYPES}
DEFAULT_MAX_BYTES = 96 * 1024 * 1024


class MediaCacheError(RuntimeError):
    pass


class MediaNotFoundError(MediaCacheError):
    pass


class MediaURLRejectedError(MediaCacheError):
    pass


@dataclass(frozen=True)
class CachedMedia:
    path: Path
    media_type: str


class MediaCache:
    def __init__(
        self,
        cache_dir: str,
        *,
        timeout: int = 25,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.timeout = int(timeout)
        self.max_bytes = int(max_bytes)

    def get(
        self,
        message: StoredMessage,
        index: int,
        *,
        variant: str = "original",
    ) -> CachedMedia:
        if variant not in {"original", "thumbnail"}:
            raise ValueError("unsupported media variant")
        urls = media_urls_from_raw_json(message.raw_json)
        if index < 0 or index >= len(urls):
            raise MediaNotFoundError("Media index not found")
        url = urls[index]
        if not is_cacheable_media_url(url):
            raise MediaURLRejectedError("Media URL is not allowed")

        cache_base = self._cache_base(message, index, url)
        original = self._find_cached_file(cache_base) or self._download(url, cache_base)
        if variant == "thumbnail" and original.media_type in ALLOWED_IMAGE_TYPES:
            return self._thumbnail(original, cache_base)
        return original

    def _cache_base(self, message: StoredMessage, index: int, url: str) -> Path:
        digest = hashlib.sha256(f"{message.id}:{index}:{url}".encode("utf-8")).hexdigest()[:32]
        safe_group = str(message.chat_id).replace("-", "n")
        return self.cache_dir / safe_group / f"{message.id}_{index}_{digest}"

    def _find_cached_file(self, cache_base: Path) -> Optional[CachedMedia]:
        parent = cache_base.parent
        if not parent.exists():
            return None
        for candidate in parent.glob(f"{cache_base.name}.*"):
            if candidate.is_file() and ".thumb." not in candidate.name and not candidate.name.endswith(".tmp"):
                return CachedMedia(path=candidate, media_type=media_type_from_path(candidate))
        return None

    def _thumbnail(self, original: CachedMedia, cache_base: Path) -> CachedMedia:
        thumbnail_path = Path(f"{cache_base}.thumb.webp")
        if thumbnail_path.exists():
            return CachedMedia(path=thumbnail_path, media_type="image/webp")
        tmp_path = Path(f"{thumbnail_path}.tmp")
        try:
            with Image.open(original.path) as opened:
                image = opened.copy()
            image.thumbnail((1200, 1200), Image.Resampling.LANCZOS)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGB")
            thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
            image.save(tmp_path, "WEBP", quality=82, method=6)
            os.replace(tmp_path, thumbnail_path)
            return CachedMedia(path=thumbnail_path, media_type="image/webp")
        except OSError:
            try:
                tmp_path.unlink()
            except OSError:
                pass
            return original

    def _download(self, url: str, cache_base: Path) -> CachedMedia:
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
            with request.urlopen(http_request, timeout=self.timeout) as response:
                content_type = normalize_content_type(response.headers.get("Content-Type", ""))
                if content_type not in ALLOWED_MEDIA_TYPES:
                    raise MediaURLRejectedError(f"Unsupported media type: {content_type or 'unknown'}")
                content_length = parse_content_length(response.headers.get("Content-Length"))
                if content_length is not None and content_length > self.max_bytes:
                    raise MediaURLRejectedError("Media file is too large")

                path = cache_base.with_suffix(ALLOWED_MEDIA_TYPES[content_type])
                tmp_path = path.with_suffix(f"{path.suffix}.tmp")
                path.parent.mkdir(parents=True, exist_ok=True)

                total = 0
                with tmp_path.open("wb") as output:
                    while True:
                        chunk = response.read(64 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > self.max_bytes:
                            raise MediaURLRejectedError("Media file is too large")
                        output.write(chunk)
                os.replace(tmp_path, path)
                return CachedMedia(path=path, media_type=content_type)
        except error.URLError as exc:
            raise MediaCacheError(f"Failed to fetch media: {exc}") from exc
        finally:
            cleanup_tmp_files(cache_base)


def media_cache_urls_for_message(
    message: StoredMessage,
    *,
    base_path: str = "/api/media",
    variant: Optional[str] = None,
) -> list[str]:
    media_urls = media_urls_from_raw_json(message.raw_json)
    query = f"?variant={variant}" if variant else ""
    return [f"{base_path}/{message.id}/{index}{query}" for index, _ in enumerate(media_urls)]


def media_cache_items_for_message(
    message: StoredMessage,
    *,
    base_path: str = "/api/media",
    variant: Optional[str] = None,
    include_original: bool = False,
) -> list[dict[str, str]]:
    media_items = media_items_from_raw_json(message.raw_json, message.media_type)
    query = f"?variant={variant}" if variant else ""
    items = []
    for index, item in enumerate(media_items):
        payload = {
            "url": f"{base_path}/{message.id}/{index}{query}",
            "kind": item["kind"],
            "role": item["role"],
        }
        if include_original:
            payload["original_url"] = f"{base_path}/{message.id}/{index}?variant=original"
        items.append(payload)
    return items


def is_cacheable_media_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False
    hostname = (parsed.hostname or "").lower()
    return any(hostname == suffix or hostname.endswith(f".{suffix}") for suffix in ALLOWED_MEDIA_HOST_SUFFIXES)


def normalize_content_type(value: str) -> str:
    return value.split(";", 1)[0].strip().lower()


def parse_content_length(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def media_type_from_path(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


def cleanup_tmp_files(cache_base: Path) -> None:
    parent = cache_base.parent
    if not parent.exists():
        return
    for candidate in parent.glob(f"{cache_base.name}.*.tmp"):
        try:
            candidate.unlink()
        except OSError:
            pass
