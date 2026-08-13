from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class RankQuery:
    period: Literal["daily", "weekly", "monthly"] = "daily"
    language: str = ""
    query: str = ""
    sort: Literal["activity", "stars", "star_growth", "forks", "recent"] = "activity"
    page: int = 1
    per_page: int = 24


class InsightProduct(Protocol):
    product_id: str

    async def refresh(self) -> dict: ...
    def rank(self, query: RankQuery) -> dict: ...
    def languages(self) -> list[dict]: ...
    def latest_run(self) -> dict | None: ...
