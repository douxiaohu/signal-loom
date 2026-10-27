import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import app
from app.public_telegram import CrawlResult
from app.scheduler import SourceCollector
from app.security import SessionSigner
from app.storage import SQLiteStorage


class _Crawler:
    def __init__(self, result):
        self.result = result

    def crawl_source(self, source):
        return self.result


class SourceHealthTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = SQLiteStorage(f"sqlite:///{Path(self.tmp.name) / 'app.db'}")
        self.storage.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def test_health_transitions_from_unknown_to_healthy_stale_and_error(self):
        unknown = self.storage.get_source_health(
            -1001,
            stale_after_seconds=900,
            now="2026-07-13T08:30:00+00:00",
        )
        self.assertEqual(unknown["health_status"], "unknown")

        self.storage.record_source_run(
            chat_id=-1001,
            source="https://t.me/example",
            started_at="2026-07-13T08:19:50+00:00",
            finished_at="2026-07-13T08:20:00+00:00",
            fetched_count=10,
            saved_count=3,
            error=None,
        )
        healthy = self.storage.get_source_health(
            -1001,
            stale_after_seconds=900,
            now="2026-07-13T08:30:00+00:00",
        )
        self.assertEqual(healthy["health_status"], "healthy")
        self.assertEqual(healthy["fetched_count"], 10)
        self.assertEqual(healthy["saved_count"], 3)

        stale = self.storage.get_source_health(
            -1001,
            stale_after_seconds=300,
            now="2026-07-13T08:30:00+00:00",
        )
        self.assertEqual(stale["health_status"], "stale")

        self.storage.record_source_run(
            chat_id=-1001,
            source="https://t.me/example",
            started_at="2026-07-13T08:31:00+00:00",
            finished_at="2026-07-13T08:31:05+00:00",
            fetched_count=0,
            saved_count=0,
            error="upstream unavailable",
        )
        failed = self.storage.get_source_health(
            -1001,
            stale_after_seconds=900,
            now="2026-07-13T08:31:06+00:00",
        )
        self.assertEqual(failed["health_status"], "error")
        self.assertEqual(failed["last_success_at"], "2026-07-13T08:20:00+00:00")
        self.assertEqual(failed["last_error"], "upstream unavailable")

    async def test_collector_persists_every_crawl_result(self):
        source = self.storage.create_source(name="Example", source_url="https://t.me/example")
        crawler = _Crawler(
            CrawlResult(
                source="https://t.me/example",
                chat_id=source.chat_id,
                fetched=7,
                saved=2,
                error=None,
            )
        )
        collector = SourceCollector(storage=self.storage, crawler=crawler)
        results = await collector.crawl_public_sources()
        self.assertEqual(results[0]["saved"], 2)
        health = self.storage.get_source_health(source.chat_id, stale_after_seconds=900)
        self.assertEqual(health["health_status"], "healthy")
        self.assertEqual(health["fetched_count"], 7)

    def test_admin_operations_summary_exposes_health_without_delivery_ledger(self):
        source = self.storage.create_source(name="Example", source_url="https://t.me/example")
        self.storage.record_source_run(
            chat_id=source.chat_id,
            source="https://t.me/example",
            started_at="2026-07-13T08:00:00+00:00",
            finished_at="2026-07-13T08:00:05+00:00",
            fetched_count=0,
            saved_count=0,
            error="timeout",
        )
        config = self._config()
        app.state.config = config
        app.state.storage = self.storage
        app.state.session_signer = SessionSigner(config.session_secret, ttl_seconds=3600)
        client = TestClient(app, base_url="http://testserver")
        try:
            self.assertEqual(client.post("/api/auth/login", json={"api_key": "key"}).status_code, 200)
            groups = client.get("/api/admin/sources").json()["items"]
            self.assertEqual(groups[0]["health_status"], "error")

            summary = client.get("/api/admin/operations/summary")
            self.assertEqual(summary.status_code, 200)
            body = summary.json()
            self.assertEqual(body["unhealthy_sources"][0]["chat_id"], source.chat_id)
            self.assertNotIn("recent_deliveries", body)
            self.assertNotIn("deliveries", body)
        finally:
            client.close()

    def test_operations_summary_exposes_failure_streak_volume_and_anomaly_filter(self):
        source = self.storage.create_source(name="Example", source_url="https://t.me/example")
        for index, error in enumerate(("timeout", "offline", None)):
            self.storage.record_source_run(chat_id=source.chat_id, source="x", started_at=f"2026-07-13T08:0{index}:00+00:00", finished_at=f"2026-07-13T08:0{index}:05+00:00", fetched_count=4, saved_count=2, error=error)
        config = self._config(); app.state.config = config; app.state.storage = self.storage; app.state.session_signer = SessionSigner(config.session_secret, ttl_seconds=3600)
        client = TestClient(app, base_url="http://testserver")
        try:
            client.post("/api/auth/login", json={"api_key": "key"})
            item = client.get("/api/admin/operations/summary").json()["sources"][0]
            self.assertEqual(item["consecutive_failures"], 0)
            self.assertEqual(item["new_message_volume"], 2)
            self.storage.record_source_run(chat_id=source.chat_id, source="x", started_at="2026-07-13T08:10:00+00:00", finished_at="2026-07-13T08:10:05+00:00", fetched_count=1, saved_count=0, error="offline")
            item = client.get("/api/admin/operations/summary?anomaly=failures").json()["sources"][0]
            self.assertEqual(item["consecutive_failures"], 1)
            self.assertEqual(len(client.get("/api/admin/operations/summary?anomaly=volume").json()["sources"]), 1)
        finally: client.close()

    def _config(self):
        return AppConfig(
            telegram_bot_token="",
            database_url=self.storage.database_url,
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            groups_config_path="config/groups.yaml",
            groups={},
            admin_api_key="key",
            session_secret="session-secret-at-least-32-bytes-long",
            session_cookie_secure=False,
            app_env="test",
            source_stale_after_seconds=900,
        )


if __name__ == "__main__":
    unittest.main()
