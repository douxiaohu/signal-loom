from __future__ import annotations

from typing import Iterable

from .config import GroupConfig
from .storage import SQLiteStorage


def seed_sources_from_groups(storage: SQLiteStorage, groups: Iterable[GroupConfig]) -> int:
    """Seed the database once from the legacy YAML configuration."""
    if storage.list_sources():
        return 0
    created = 0
    for group in groups:
        if group.source_type != "telegram_public" or not group.source:
            continue
        storage.create_source(
            name=group.name,
            source_url=group.source,
            public_visible=True,
        )
        created += 1
    return created
