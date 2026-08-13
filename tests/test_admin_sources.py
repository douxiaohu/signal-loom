import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import app
from app.security import LoginAttemptLimiter, SessionSigner
from app.storage import SQLiteStorage


class _Collector:
    def __init__(self):
        self.crawled = []

    async def crawl_source(self, chat_id: int):
        self.crawled.append(chat_id)
        return {"chat_id": chat_id, "fetched": 3, "saved": 1, "error": None}


class AdminSourceApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = SQLiteStorage(f"sqlite:///{Path(self.tmp.name) / 'app.db'}")
        self.storage.init_db()
        self.config = AppConfig(
            telegram_bot_token="",
            database_url=self.storage.database_url,
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            groups_config_path="config/groups.yaml",
            groups={},
            admin_api_key="correct-key",
            session_secret="session-secret-at-least-32-bytes-long",
            session_cookie_secure=False,
            app_env="test",
        )
        self.collector = _Collector()
        app.state.config = self.config
        app.state.storage = self.storage
        app.state.collector = self.collector
        app.state.session_signer = SessionSigner(self.config.session_secret, ttl_seconds=3600)
        app.state.login_limiter = LoginAttemptLimiter()
        self.client = TestClient(app, base_url="http://testserver")

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def _login(self):
        response = self.client.post("/api/auth/login", json={"api_key": "correct-key"})
        self.assertEqual(response.status_code, 200)

    def test_admin_source_endpoints_require_login(self):
        self.assertEqual(self.client.get("/api/admin/sources").status_code, 401)

    def test_admin_can_create_publish_disable_and_crawl_source(self):
        self._login()
        created = self.client.post(
            "/api/admin/sources",
            headers={"Origin": "http://testserver"},
            json={"name": "Example", "source_url": "https://t.me/example"},
        )
        self.assertEqual(created.status_code, 201)
        self.assertFalse(created.json()["public_visible"])
        chat_id = created.json()["chat_id"]

        published = self.client.patch(
            f"/api/admin/sources/{chat_id}",
            headers={"Origin": "http://testserver"},
            json={"name": "Example Renamed", "public_visible": True, "enabled": True},
        )
        self.assertEqual(published.status_code, 200)
        self.assertEqual(published.json()["name"], "Example Renamed")
        self.assertTrue(published.json()["public_visible"])

        crawled = self.client.post(
            f"/api/admin/sources/{chat_id}/crawl-now",
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(crawled.status_code, 200)
        self.assertEqual(crawled.json()["saved"], 1)
        self.assertEqual(self.collector.crawled, [chat_id])

        listed = self.client.get("/api/admin/sources")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.headers["cache-control"], "private, no-store")
        self.assertEqual(listed.json()["items"][0]["name"], "Example Renamed")

    def test_admin_mutations_reject_cross_origin_requests(self):
        self._login()
        response = self.client.post(
            "/api/admin/sources",
            headers={"Origin": "https://attacker.invalid"},
            json={"name": "Example", "source_url": "https://t.me/example"},
        )
        self.assertEqual(response.status_code, 403)

    def test_admin_can_create_telegram_bot_source_and_rejects_unknown_adapter(self):
        self._login()
        created = self.client.post(
            "/api/admin/sources",
            headers={"Origin": "http://testserver"},
            json={"name": "Ops", "source_url": "-1001234567890", "adapter": "telegram_bot"},
        )
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["adapter"], "telegram_bot")
        self.assertEqual(created.json()["chat_id"], -1001234567890)

        unknown = self.client.post(
            "/api/admin/sources",
            headers={"Origin": "http://testserver"},
            json={"name": "RSS", "source_url": "https://example.com/feed", "adapter": "rss"},
        )
        self.assertEqual(unknown.status_code, 422)


if __name__ == "__main__":
    unittest.main()
