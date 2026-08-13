from __future__ import annotations

import re
import zlib


TELEGRAM_SOURCE_RE = re.compile(
    r"^(?:https?://)?(?:www\.)?t\.me/(?:s/)?(?P<username>[A-Za-z0-9_]+)/?$"
)
TELEGRAM_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]+$")


def normalize_telegram_public_source(source: str) -> str:
    value = str(source or "").strip()
    match = TELEGRAM_SOURCE_RE.match(value)
    if match:
        return match.group("username")
    return value.lstrip("@")


def canonical_telegram_public_url(source: str) -> str:
    username = normalize_telegram_public_source(source)
    if not username or not TELEGRAM_USERNAME_RE.fullmatch(username):
        raise ValueError("invalid Telegram public source URL")
    return f"https://t.me/{username}"


def public_source_chat_id(source: str) -> int:
    username = normalize_telegram_public_source(source).lower()
    checksum = zlib.crc32(username.encode("utf-8")) & 0x7FFFFFFF
    return -900000000000 - checksum
