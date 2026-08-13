from __future__ import annotations

from typing import Iterable

from app.config import GroupConfig
from app.storage import SQLiteStorage


def seed_sources_from_groups(storage: SQLiteStorage, groups: Iterable[GroupConfig]) -> int:
    """Seed the database once from the legacy YAML configuration."""
    if storage.list_sources():
        return 0
    created = 0
    for group in groups:
        source_type = group.source_type or ("telegram_public" if group.source else "telegram_bot")
        if source_type == "telegram_public":
            if not group.source:
                continue
            storage.create_source(
                name=group.name,
                source_url=group.source,
                public_visible=True,
                adapter="telegram_public",
            )
            created += 1
            continue
        if source_type == "telegram_bot":
            storage.create_source(
                name=group.name,
                source_url=str(group.chat_id),
                public_visible=False,
                adapter="telegram_bot",
            )
            created += 1
    return created
