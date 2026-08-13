from __future__ import annotations

import re
from typing import Any, List, Optional

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
