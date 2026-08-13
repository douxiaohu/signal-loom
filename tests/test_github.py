import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.github_service import GitHubCollector, build_github_ranking
from app.github_ai import RepositoryAiError, RepositoryAiExplainer, language_breakdown
from app.main import app
from app.scheduler import create_collection_scheduler
from app.storage import SQLiteStorage


def repository_payload(
    repository_id=1,
    full_name="acme/rocket",
    *,
    language="Python",
    stars=100,
    forks=20,
    issues=5,
):
    return {
        "id": repository_id,
        "full_name": full_name,
        "description": "Fast API agent toolkit",
        "language": language,
        "topics": ["fastapi", "agents"],
        "license": {"spdx_id": "MIT"},
        "stargazers_count": stars,
        "forks_count": forks,
        "open_issues_count": issues,
        "watchers_count": stars,
        "created_at": "2025-01-01T00:00:00Z",
        "updated_at": "2026-08-06T00:00:00Z",
        "pushed_at": "2026-08-06T00:00:00Z",
        "default_branch": "main",
        "has_discussions": True,
    }


class _CollectorState:
    is_running = False


class GitHubRankingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = SQLiteStorage(f"sqlite:///{Path(self.tmp.name) / 'app.db'}")
        self.storage.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def test_period_ranking_uses_snapshots_and_feature_search(self):
        now = datetime(2026, 8, 6, 12, tzinfo=timezone.utc)
        self.storage.upsert_github_repositories(
            [repository_payload(stars=100, forks=20, issues=5)],
            captured_at=(now - timedelta(days=2)).isoformat(),
        )
        self.storage.upsert_github_repositories(
            [repository_payload(stars=125, forks=24, issues=8)],
            captured_at=now.isoformat(),
        )

        result = build_github_ranking(
            self.storage,
            period="daily",
            language="python",
            query="FastAPI agents MIT",
            now=now,
        )

        self.assertEqual(result["total"], 1)
        item = result["items"][0]
        self.assertEqual(item["stars_delta"], 25)
        self.assertEqual(item["forks_delta"], 4)
        self.assertTrue(item["history_complete"])
        self.assertGreater(item["activity_score"], 100)

    def test_public_api_filters_languages_and_does_not_expose_search_text(self):
        self.storage.upsert_github_repositories(
            [
                repository_payload(),
                repository_payload(2, "acme/console", language="TypeScript", stars=80),
            ]
        )
        self.storage.record_github_collection_run(
            started_at="2026-08-06T00:00:00+00:00",
            finished_at="2026-08-06T00:01:00+00:00",
            status="succeeded",
            fetched_count=2,
            saved_count=2,
        )
        app.state.storage = self.storage
        app.state.config = AppConfig(
            telegram_bot_token="",
            database_url=self.storage.database_url,
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            groups_config_path="config/groups.yaml",
            groups={},
            app_env="test",
        )
        app.state.github_collector = _CollectorState()
        client = TestClient(app, base_url="http://testserver")
        try:
            response = client.get(
                "/api/public/github/rankings?period=weekly&language=Python&query=agent"
            )
        finally:
            client.close()

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual([item["full_name"] for item in payload["items"]], ["acme/rocket"])
        self.assertEqual(
            {item["language"] for item in payload["languages"]}, {"Python", "TypeScript"}
        )
        self.assertNotIn("search_text", response.text)
        self.assertEqual(response.headers["cache-control"], "no-cache")
        self.assertIn("etag", response.headers)


class _FakeGitHubClient:
    token = "test-token"
    rate_limit_remaining = 4999
    rate_limit_reset = "2026-08-06T01:00:00+00:00"

    def __init__(self):
        self.searches = []

    def search_repositories(self, query, *, sort="stars", order="desc", per_page=30):
        self.searches.append((query, sort, per_page))
        return [repository_payload()]

    def get_repository(self, full_name):
        return repository_payload()

    def get_repository_languages(self, full_name):
        return {"Python": 8000, "TypeScript": 2000}

    def get_repository_readme(self, full_name, *, max_chars=12000):
        return "A FastAPI toolkit for reusable AI agents."


class _FakeAiExplainer:
    enabled = True
    model = "test-model"

    def __init__(self):
        self.calls = []

    def explain(self, repository):
        self.calls.append(repository)
        return {
            "summary_zh": "用于构建 FastAPI 智能体服务的工具包。",
            "significance_zh": "降低智能体后端的工程化门槛。",
            "problem_zh": "解决智能体 API 编排和复用成本高的问题。",
        }


class _MultipleRepositoryGitHubClient(_FakeGitHubClient):
    def __init__(self):
        super().__init__()
        self.repositories = [
            repository_payload(1, "acme/first", stars=300),
            repository_payload(2, "acme/second", stars=200),
            repository_payload(3, "acme/third", stars=100),
        ]

    def search_repositories(self, query, *, sort="stars", order="desc", per_page=30):
        self.searches.append((query, sort, per_page))
        return self.repositories

    def get_repository(self, full_name):
        return next(item for item in self.repositories if item["full_name"] == full_name)


class GitHubCollectorTests(unittest.TestCase):
    def test_collector_discovers_languages_and_records_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            config = AppConfig(
                telegram_bot_token="",
                database_url=storage.database_url,
                timezone="Asia/Shanghai",
                forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={},
                app_env="test",
                github_languages=("Python", "Rust"),
            )
            client = _FakeGitHubClient()
            collector = GitHubCollector(storage=storage, client=client, config=config)

            result = collector.refresh_sync()

            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["saved_count"], 1)
            self.assertEqual(len(client.searches), 3)
            self.assertEqual(storage.get_latest_github_collection_run()["status"], "succeeded")

    def test_collection_scheduler_registers_github_refresh(self):
        class _SourceCollector:
            async def crawl_public_sources(self):
                return []

        class _GitHubCollector:
            async def refresh(self):
                return {"status": "succeeded"}

        config = AppConfig(
            telegram_bot_token="",
            database_url="sqlite:///:memory:",
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            groups_config_path="config/groups.yaml",
            groups={},
            app_env="test",
            github_enabled=True,
            github_refresh_interval_seconds=900,
        )
        scheduler = create_collection_scheduler(config, _SourceCollector(), _GitHubCollector())
        try:
            self.assertEqual(
                {job.id for job in scheduler.get_jobs()},
                {"crawl_public_sources", "refresh_github_rankings"},
            )
            self.assertIsNotNone(scheduler.get_job("refresh_github_rankings").next_run_time)
        finally:
            if scheduler.running:
                scheduler.shutdown(wait=False)

    def test_ai_enrichment_collects_language_composition_and_uses_cache(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            config = AppConfig(
                telegram_bot_token="", database_url=storage.database_url,
                timezone="Asia/Shanghai", forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml", groups={}, app_env="test",
                github_languages=("Python",), github_ai_enabled=True,
                github_ai_api_key="test-key", github_ai_model="test-model",
                github_ai_repositories_per_refresh=1,
            )
            client = _FakeGitHubClient()
            explainer = _FakeAiExplainer()
            collector = GitHubCollector(
                storage=storage, client=client, config=config, ai_explainer=explainer
            )

            first = collector.refresh_sync()
            second = collector.refresh_sync()
            item = build_github_ranking(storage, period="daily")["items"][0]

            self.assertEqual(first["ai_enriched_count"], 1)
            self.assertEqual(second["ai_enriched_count"], 0)
            self.assertEqual(len(explainer.calls), 1)
            self.assertEqual(item["ai_summary_zh"], "用于构建 FastAPI 智能体服务的工具包。")
            self.assertEqual(
                item["language_breakdown"],
                [
                    {"language": "Python", "bytes": 8000, "percentage": 80.0},
                    {"language": "TypeScript", "bytes": 2000, "percentage": 20.0},
                ],
            )

    def test_ai_enrichment_skips_cached_daily_items_and_continues_down_ranking(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            config = AppConfig(
                telegram_bot_token="", database_url=storage.database_url,
                timezone="Asia/Shanghai", forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml", groups={}, app_env="test",
                github_languages=("Python",), github_ai_enabled=True,
                github_ai_api_key="test-key", github_ai_model="test-model",
                github_ai_repositories_per_refresh=1,
            )
            client = _MultipleRepositoryGitHubClient()
            explainer = _FakeAiExplainer()
            collector = GitHubCollector(
                storage=storage, client=client, config=config, ai_explainer=explainer
            )

            first = collector.refresh_sync()
            second = collector.refresh_sync()

            self.assertEqual(first["ai_attempted_count"], 1)
            self.assertEqual(first["ai_enriched_count"], 1)
            self.assertEqual(second["ai_attempted_count"], 1)
            self.assertEqual(second["ai_enriched_count"], 1)
            self.assertEqual(
                [item["full_name"] for item in explainer.calls],
                ["acme/first", "acme/second"],
            )


class GitHubAiTests(unittest.TestCase):
    def test_language_breakdown_keeps_percentages_and_groups_tail(self):
        result = language_breakdown({"Python": 70, "TypeScript": 20, "Shell": 10}, limit=2)
        self.assertEqual(
            result,
            [
                {"language": "Python", "bytes": 70, "percentage": 70.0},
                {"language": "TypeScript", "bytes": 20, "percentage": 20.0},
                {"language": "其他", "bytes": 10, "percentage": 10.0},
            ],
        )

    def test_ai_explainer_rejects_incomplete_json(self):
        with self.assertRaisesRegex(RepositoryAiError, "required explanation fields"):
            RepositoryAiExplainer._parse_explanation('{"summary_zh":"只有摘要"}')

    def test_ai_explainer_accepts_fenced_json(self):
        result = RepositoryAiExplainer._parse_explanation(
            "模型分析如下：\n```json\n"
            '{"summary_zh":"项目简述","significance_zh":"项目意义",'
            '"problem_zh":"解决的问题"}\n```'
        )

        self.assertEqual(
            result,
            {
                "summary_zh": "项目简述",
                "significance_zh": "项目意义",
                "problem_zh": "解决的问题",
            },
        )


if __name__ == "__main__":
    unittest.main()
