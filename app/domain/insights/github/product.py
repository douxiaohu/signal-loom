from __future__ import annotations

from typing import Optional

from app.config import AppConfig
from app.domain.insights.ports import RankQuery
from app.github_service import GitHubCollector, build_github_ranking
from app.storage import SQLiteStorage


class GitHubInsightProduct:
    product_id = "github"

    def __init__(
        self,
        *,
        storage: SQLiteStorage,
        collector: GitHubCollector,
        config: AppConfig,
    ) -> None:
        self.storage = storage
        self.collector = collector
        self.config = config

    async def refresh(self) -> dict:
        return await self.collector.refresh()

    def rank(self, query: RankQuery) -> dict:
        return build_github_ranking(
            self.storage,
            period=query.period,
            language=query.language,
            query=query.query,
            sort=query.sort,
            page=query.page,
            per_page=query.per_page,
        )

    def languages(self) -> list[dict]:
        return self.storage.list_github_languages()

    def latest_run(self) -> Optional[dict]:
        return self.storage.get_latest_github_collection_run()
