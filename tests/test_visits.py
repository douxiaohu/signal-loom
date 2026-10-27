import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import app
from app.security import LoginAttemptLimiter, SessionSigner
from app.storage import SQLiteStorage


class VisitTrackingTests(unittest.TestCase):
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
        app.state.config = self.config
        app.state.storage = self.storage
        app.state.session_signer = SessionSigner(self.config.session_secret, ttl_seconds=3600)
        app.state.login_limiter = LoginAttemptLimiter()
        self.client = TestClient(app, base_url="http://testserver")

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_public_hits_are_recorded_and_hidden_from_anonymous_admin(self):
        self.assertEqual(self.client.get("/api/public/sources").status_code, 200)
        self.assertEqual(self.client.get("/health").status_code, 200)

        anonymous = self.client.get("/api/admin/visits")
        self.assertEqual(anonymous.status_code, 401)

        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)
        payload = self.client.get("/api/admin/visits").json()
        self.assertGreaterEqual(payload["stats"]["unique_ips"], 1)
        paths = [item["path"] for item in payload["items"]]
        self.assertIn("/api/public/sources", paths)
        self.assertNotIn("/health", paths)
        self.assertNotIn("/api/admin/visits", paths)

    def test_overview_requires_session_and_excludes_retired_github(self):
        self.assertEqual(self.client.get("/api/admin/overview").status_code, 401)
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)
        payload = self.client.get("/api/admin/overview").json()
        self.assertIn("visits", payload)
        self.assertIn("sources", payload)
        self.assertNotIn("github", payload)
        self.assertIn("alerts", payload)
        self.assertEqual(self.client.get("/api/admin/github/status").status_code, 404)
        self.assertEqual(self.client.get("/api/public/github/rankings").status_code, 404)
        self.assertEqual(self.client.get("/github/").status_code, 404)
