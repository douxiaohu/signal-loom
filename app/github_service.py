from __future__ import annotations

import asyncio
import hashlib
import json
import math
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from .config import AppConfig
from .github_client import GitHubApiError, GitHubClient
from .github_ai import RepositoryAiError, RepositoryAiExplainer, language_breakdown
from .storage import SQLiteStorage, utc_now_iso


PERIOD_DAYS = {"daily": 1, "weekly": 7, "monthly": 30}
LOGGER = logging.getLogger(__name__)


class GitHubCollector:
    def __init__(
        self,
        *,
        storage: SQLiteStorage,
        client: GitHubClient,
        config: AppConfig,
        ai_explainer: Optional[RepositoryAiExplainer] = None,
    ) -> None:
        self.storage = storage
        self.client = client
        self.config = config
        self.ai_explainer = ai_explainer
        self._lock = asyncio.Lock()
        self.is_running = False

    async def refresh(self) -> Dict[str, object]:
        async with self._lock:
            self.is_running = True
            try:
                return await asyncio.to_thread(self.refresh_sync)
            finally:
                self.is_running = False

    def refresh_sync(self) -> Dict[str, object]:
        started_at = utc_now_iso()
        captured_at = started_at
        repositories: Dict[int, Dict[str, object]] = {}
        errors: List[str] = []
        pushed_cutoff = (datetime.now(timezone.utc) - timedelta(days=35)).date().isoformat()
        common = (
            f"stars:>={self.config.github_min_stars} fork:false "
            f"archived:false pushed:>={pushed_cutoff}"
        )
        searches = [(common, "updated", min(100, self.config.github_candidates_per_language * 2))]
        languages = self.config.github_languages
        if not self.client.token:
            languages = languages[:8]
        for language in languages:
            safe_language = language.replace('"', "")
            searches.append(
                (
                    f'{common} language:"{safe_language}"',
                    "stars",
                    self.config.github_candidates_per_language,
                )
            )
        for query, sort, per_page in searches:
            try:
                for repository in self.client.search_repositories(
                    query, sort=sort, per_page=per_page
                ):
                    try:
                        repositories[int(repository["id"])] = repository
                    except (KeyError, TypeError, ValueError):
                        continue
            except GitHubApiError as exc:
                errors.append(str(exc))

        discovered_names = {
            str(item.get("full_name") or "") for item in repositories.values()
        }
        refresh_limit = 80 if self.client.token else 10
        for full_name in self.storage.list_github_repository_names(limit=refresh_limit):
            if full_name in discovered_names:
                continue
            try:
                repository = self.client.get_repository(full_name)
                repositories[int(repository["id"])] = repository
            except (GitHubApiError, KeyError, TypeError, ValueError) as exc:
                errors.append(str(exc))

        saved_count = self.storage.upsert_github_repositories(
            repositories.values(), captured_at=captured_at
        )
        ai_enriched_count = 0
        ai_attempted_count = 0
        ai_errors: List[str] = []
        if self._ai_enabled():
            repositories_by_name = {
                str(item.get("full_name") or ""): item
                for item in repositories.values()
                if item.get("full_name")
            }
            daily_items = build_github_ranking(
                self.storage,
                period="daily",
                per_page=24,
            )["items"]
            for item in daily_items:
                if ai_attempted_count >= self.config.github_ai_repositories_per_refresh:
                    break
                full_name = str(item.get("full_name") or "")
                if not full_name or self._analysis_is_complete(full_name):
                    continue
                ai_attempted_count += 1
                try:
                    repository = repositories_by_name.get(full_name)
                    if repository is None:
                        repository = self.client.get_repository(full_name)
                    if self._enrich_repository(repository):
                        ai_enriched_count += 1
                except (GitHubApiError, RepositoryAiError, ValueError, TypeError) as exc:
                    ai_errors.append(str(exc))
                    LOGGER.warning("GitHub AI enrichment failed for %s: %s", full_name, exc)
        finished_at = utc_now_iso()
        if errors and not repositories:
            status = "failed"
        elif errors:
            status = "partial"
        else:
            status = "succeeded"
        error_text = "; ".join(dict.fromkeys(errors))[:1000] or None
        self.storage.record_github_collection_run(
            started_at=started_at,
            finished_at=finished_at,
            status=status,
            fetched_count=len(repositories),
            saved_count=saved_count,
            error=error_text,
            rate_limit_remaining=self.client.rate_limit_remaining,
            rate_limit_reset=self.client.rate_limit_reset,
        )
        return {
            "status": status,
            "fetched_count": len(repositories),
            "saved_count": saved_count,
            "ai_attempted_count": ai_attempted_count,
            "ai_enriched_count": ai_enriched_count,
            "ai_error": "; ".join(dict.fromkeys(ai_errors))[:1000] or None,
            "error": error_text,
            "finished_at": finished_at,
        }

    def _ai_enabled(self) -> bool:
        return bool(
            self.config.github_ai_enabled
            and self.ai_explainer
            and self.ai_explainer.enabled
        )

    def _analysis_is_complete(self, full_name: str) -> bool:
        if self.ai_explainer is None:
            return False
        cached = self.storage.get_github_repository_analysis(full_name)
        return bool(
            cached
            and cached.get("ai_model") == self.ai_explainer.model
            and all(
                cached.get(key)
                for key in ("ai_summary_zh", "ai_significance_zh", "ai_problem_zh")
            )
        )

    def _enrich_repository(self, repository: Dict[str, object]) -> bool:
        full_name = str(repository.get("full_name") or "")
        if not full_name or self.ai_explainer is None:
            return False
        languages = language_breakdown(self.client.get_repository_languages(full_name))
        readme_excerpt = self.client.get_repository_readme(full_name)
        analysis_payload = {
            "full_name": full_name,
            "description": str(repository.get("description") or ""),
            "topics": list(repository.get("topics") or []),
            "license_name": _license_name(repository.get("license")),
            "language_breakdown": languages,
            "readme_excerpt": readme_excerpt,
        }
        source_hash = hashlib.sha256(
            json.dumps(analysis_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        cached = self.storage.get_github_repository_analysis(full_name)
        if (
            cached
            and cached.get("analysis_source_hash") == source_hash
            and cached.get("ai_model") == self.ai_explainer.model
            and all(cached.get(key) for key in ("ai_summary_zh", "ai_significance_zh", "ai_problem_zh"))
        ):
            return False
        explanation = self.ai_explainer.explain(analysis_payload)
        return self.storage.save_github_repository_analysis(
            full_name,
            language_breakdown=languages,
            source_hash=source_hash,
            explanation=explanation,
            model=self.ai_explainer.model,
        )


def build_github_ranking(
    storage: SQLiteStorage,
    *,
    period: str,
    language: str = "",
    query: str = "",
    sort: str = "activity",
    page: int = 1,
    per_page: int = 24,
    now: Optional[datetime] = None,
) -> Dict[str, object]:
    days = PERIOD_DAYS[period]
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff_time = current_time - timedelta(days=days)
    cutoff = cutoff_time.replace(microsecond=0).isoformat()
    records = storage.list_github_rank_candidates(
        cutoff=cutoff, language=language, query=query
    )
    items = [
        _ranked_repository(record, cutoff_time=cutoff_time, current_time=current_time, days=days)
        for record in records
    ]
    sorters = {
        "activity": lambda item: (item["activity_score"], item["stars"], item["full_name"]),
        "stars": lambda item: (item["stars"], item["activity_score"], item["full_name"]),
        "star_growth": lambda item: (item["stars_delta"], item["activity_score"], item["stars"]),
        "forks": lambda item: (item["forks"], item["activity_score"], item["full_name"]),
        "recent": lambda item: (item["pushed_at"] or "", item["activity_score"], item["full_name"]),
    }
    items.sort(key=sorters[sort], reverse=True)
    total = len(items)
    start = (page - 1) * per_page
    paged = items[start : start + per_page]
    for index, item in enumerate(paged, start=start + 1):
        item["rank"] = index
    return {
        "items": paged,
        "total": total,
        "page": page,
        "per_page": per_page,
        "has_more": start + per_page < total,
        "period": period,
        "cutoff": cutoff,
    }


def _ranked_repository(
    record: Dict[str, object],
    *,
    cutoff_time: datetime,
    current_time: datetime,
    days: int,
) -> Dict[str, object]:
    stars = int(record.get("stars") or 0)
    forks = int(record.get("forks") or 0)
    open_issues = int(record.get("open_issues") or 0)
    stars_delta = max(0, stars - int(record.get("baseline_stars") or 0))
    forks_delta = max(0, forks - int(record.get("baseline_forks") or 0))
    issues_delta = abs(open_issues - int(record.get("baseline_open_issues") or 0))
    pushed_at = _parse_github_datetime(record.get("pushed_at"))
    period_seconds = max(1.0, float(days * 86400))
    if pushed_at is None or pushed_at < cutoff_time:
        freshness = 0.0
    else:
        age_seconds = max(0.0, (current_time - pushed_at).total_seconds())
        freshness = max(0.0, 1.0 - age_seconds / period_seconds)
    history_complete = bool(record.get("history_complete"))
    measured_score = stars_delta * 5 + forks_delta * 3 + issues_delta * 0.25 + freshness * 12
    if history_complete:
        activity_score = measured_score
    else:
        cold_start_score = min(35.0, math.log10(stars + 1) * 8) + freshness * 12
        activity_score = max(measured_score, cold_start_score)
    features = record.get("features") if isinstance(record.get("features"), dict) else {}
    return {
        "id": int(record["github_id"]),
        "full_name": str(record["full_name"]),
        "owner": str(record["owner"]),
        "name": str(record["name"]),
        "description": str(record.get("description") or ""),
        "html_url": str(record["html_url"]),
        "homepage": str(record.get("homepage") or ""),
        "language": str(record.get("language") or ""),
        "language_breakdown": list(record.get("language_breakdown") or []),
        "topics": list(record.get("topics") or []),
        "license": str(record.get("license_name") or ""),
        "features": features,
        "ai_summary_zh": str(record.get("ai_summary_zh") or ""),
        "ai_significance_zh": str(record.get("ai_significance_zh") or ""),
        "ai_problem_zh": str(record.get("ai_problem_zh") or ""),
        "ai_generated_at": str(record.get("ai_generated_at") or "") or None,
        "stars": stars,
        "forks": forks,
        "open_issues": open_issues,
        "watchers": int(record.get("watchers") or 0),
        "stars_delta": stars_delta,
        "forks_delta": forks_delta,
        "issues_delta": issues_delta,
        "activity_score": round(activity_score, 1),
        "history_complete": history_complete,
        "baseline_at": str(record.get("baseline_captured_at") or ""),
        "created_at": str(record.get("created_at") or ""),
        "updated_at": str(record.get("updated_at") or ""),
        "pushed_at": str(record.get("pushed_at") or "") or None,
        "collected_at": str(record.get("last_seen_at") or ""),
    }


def _parse_github_datetime(value: object) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _license_name(value: object) -> str:
    if not isinstance(value, dict):
        return ""
    return str(value.get("spdx_id") or value.get("name") or "")[:120]
