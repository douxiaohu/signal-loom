import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig, GroupConfig
from app.main import app
from app.public_telegram import CrawlResult
from app.scheduler import Forwarder
from app.security import SessionSigner
from app.storage import SQLiteStorage


class _WeCom:
    def send_text(self, webhook_url, content):
        return None


class _Crawler:
    def __init__(self, result):
        self.result = result

    def crawl_group(self, group):
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

    async def test_forwarder_persists_every_crawl_result(self):
        config = self._config()
        crawler = _Crawler(
            CrawlResult(
                source="https://t.me/example",
                chat_id=-1001,
                fetched=7,
                saved=2,
                error=None,
            )
        )
        forwarder = Forwarder(
            config=config,
            storage=self.storage,
            wecom_client=_WeCom(),
            public_crawler=crawler,
        )

        results = await forwarder.crawl_public_sources()

        self.assertEqual(results[0]["saved"], 2)
        health = self.storage.get_source_health(-1001, stale_after_seconds=900)
        self.assertEqual(health["health_status"], "healthy")
        self.assertEqual(health["fetched_count"], 7)

    def test_groups_and_operations_summary_expose_health_without_payload_preview(self):
        config = self._config()
        self.storage.record_source_run(
            chat_id=-1001,
            source="https://t.me/example",
            started_at="2026-07-13T08:00:00+00:00",
            finished_at="2026-07-13T08:00:05+00:00",
            fetched_count=0,
            saved_count=0,
            error="timeout",
        )
        self.storage.log_forward(
            chat_id=-1001,
            group_name="Example",
            message_count=4,
            success=False,
            error="send failed",
            payload_preview="sensitive message body",
        )
        app.state.config = config
        app.state.storage = self.storage
        app.state.session_signer = SessionSigner(config.session_secret, ttl_seconds=3600)
        client = TestClient(app, base_url="http://testserver")
        try:
            self.assertEqual(client.post("/api/auth/login", json={"api_key": "key"}).status_code, 200)
            groups = client.get("/api/groups").json()["groups"]
            self.assertEqual(groups[0]["health_status"], "error")

            summary = client.get("/api/operations/summary")
            self.assertEqual(summary.status_code, 200)
            body = summary.json()
            self.assertEqual(body["unhealthy_sources"][0]["chat_id"], -1001)
            self.assertNotIn("payload_preview", body["recent_deliveries"][0])
        finally:
            client.close()

    def _config(self):
        return AppConfig(
            telegram_bot_token="",
            database_url=self.storage.database_url,
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            groups_config_path="config/groups.yaml",
            groups={
                -1001: GroupConfig(
                    chat_id=-1001,
                    name="Example",
                    source="https://t.me/example",
                    source_type="telegram_public",
                )
            },
            admin_api_key="key",
            session_secret="session-secret-at-least-32-bytes-long",
            session_cookie_secure=False,
            app_env="test",
            source_stale_after_seconds=900,
        )


if __name__ == "__main__":
    unittest.main()
