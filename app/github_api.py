from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query, Request

from .api_common import etag_json_response
from .domain.insights.ports import RankQuery
from .github_service import PERIOD_DAYS, build_github_ranking
from .security import require_same_origin, require_session
from .storage import SQLiteStorage


public_router = APIRouter(prefix="/api/public/github", tags=["github"])
admin_router = APIRouter(prefix="/api/admin/github", tags=["github-admin"])


@public_router.get("/rankings")
async def github_rankings(
    request: Request,
    period: str = Query(default="daily", pattern="^(daily|weekly|monthly)$"),
    language: str = Query(default="", max_length=80),
    query: str = Query(default="", max_length=200),
    sort: str = Query(
        default="activity", pattern="^(activity|stars|star_growth|forks|recent)$"
    ),
    page: int = Query(default=1, ge=1, le=1000),
    per_page: int = Query(default=24, ge=1, le=50),
):
    storage: SQLiteStorage = request.app.state.storage
    product = getattr(request.app.state, "github_product", None)
    rank_query = RankQuery(
        period=period,  # type: ignore[arg-type]
        language=language,
        query=query,
        sort=sort,  # type: ignore[arg-type]
        page=page,
        per_page=per_page,
    )
    if product is not None:
        payload = product.rank(rank_query)
        run = product.latest_run()
        languages = product.languages()
    else:
        payload = build_github_ranking(
            storage,
            period=period,
            language=language,
            query=query,
            sort=sort,
            page=page,
            per_page=per_page,
        )
        run = storage.get_latest_github_collection_run()
        languages = storage.list_github_languages()
    collector = getattr(request.app.state, "github_collector", None)
    last_updated = str(run.get("finished_at") or "") if run else None
    next_refresh = None
    if last_updated:
        try:
            next_refresh = (
                datetime.fromisoformat(last_updated)
                + timedelta(seconds=request.app.state.config.github_refresh_interval_seconds)
            ).isoformat()
        except ValueError:
            next_refresh = None
    payload.update(
        {
            "languages": languages,
            "collection": {
                "status": str(run.get("status") or "never") if run else "never",
                "last_updated": last_updated,
                "next_refresh": next_refresh,
                "repository_count": int(payload["total"]),
                "refreshing": bool(collector and collector.is_running),
                "history_days": PERIOD_DAYS[period],
            },
        }
    )
    return etag_json_response(request, payload)


@admin_router.post(
    "/refresh",
    dependencies=[Depends(require_session), Depends(require_same_origin)],
)
async def refresh_github_repositories(request: Request):
    product = getattr(request.app.state, "github_product", None)
    if product is not None:
        return await product.refresh()
    collector = request.app.state.github_collector
    return await collector.refresh()
