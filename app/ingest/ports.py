from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

from app.storage import StoredSource


@dataclass(frozen=True)
class NormalizedItem:
    source_id: int
    external_id: str
    occurred_at: str
    author: str
    title: str
    content: str
    media_type: str | None
    raw: dict
    permalink: str | None = None


@dataclass(frozen=True)
class FetchResult:
    fetched: int
    items: Sequence[NormalizedItem]
    error: str | None = None


class SourceAdapter(Protocol):
    key: str

    def validate_locator(self, locator: str) -> str:
        """Return a canonical locator or raise ValueError."""

    def allocate_source_id(self, locator: str) -> int:
        """Allocate the physical chat_id / source_id for this locator."""

    def fetch(self, source: StoredSource) -> FetchResult:
        """Pull remote items. Must not persist, ingest, or warm media."""
