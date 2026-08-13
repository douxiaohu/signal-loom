from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.config import AppConfig
from app.domain.feed.service import FeedService
from app.domain.insights.github.product import GitHubInsightProduct
from app.domain.sources.service import SourceService
from app.ingest.registry import AdapterRegistry
from app.media_cache import MediaCache
from app.notifications.ports import NotificationService
from app.persistence.sqlite.connection import ConnectionFactory
from app.security import SessionSigner
from app.storage import SQLiteStorage


@dataclass
class AppContext:
    config: AppConfig
    storage: SQLiteStorage
    db: ConnectionFactory
    adapters: AdapterRegistry
    source_service: SourceService
    feed_service: FeedService
    notifications: NotificationService
    media: MediaCache
    sessions: SessionSigner
    github_product: Optional[GitHubInsightProduct] = None
