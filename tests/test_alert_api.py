import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import app
from app.security import LoginAttemptLimiter, SessionSigner
from app.storage import SQLiteStorage
from app.telegram_client import TelegramMessage


class AlertApiTests(unittest.TestCase):
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
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_rule_api_defaults_disabled_and_alert_can_be_acknowledged(self):
        created = self.client.post(
            "/api/admin/rules",
            json={"name": "Watch", "keyword": "告警", "source_ids": [-1001]},
        )
        self.assertEqual(created.status_code, 201)
        rule = created.json()
        self.assertFalse(rule["enabled"])

        patched = self.client.patch(f"/api/admin/rules/{rule['id']}", json={"enabled": True})
        self.assertEqual(patched.status_code, 200)
        self.assertTrue(patched.json()["enabled"])

        self.storage.save_message(
            TelegramMessage(
                chat_id=-1001,
                chat_title="Example",
                message_id=1,
                sender_name="Sender",
                message_time="2026-07-13T08:00:00+00:00",
                content="告警消息",
                media_type=None,
                raw={},
            )
        )
        alerts = self.client.get("/api/admin/matches?status=new")
        self.assertEqual(alerts.status_code, 200)
        match = alerts.json()["items"][0]
        acknowledged = self.client.post(f"/api/admin/matches/{match['id']}/acknowledge")
        self.assertEqual(acknowledged.status_code, 200)
        self.assertEqual(acknowledged.json()["status"], "acknowledged")

    def test_rule_validation_rejects_regex_like_empty_or_invalid_media(self):
        empty = self.client.post("/api/admin/rules", json={"name": "x", "keyword": ""})
        self.assertEqual(empty.status_code, 422)
        invalid = self.client.post(
            "/api/admin/rules",
            json={"name": "x", "keyword": "word", "media_type": "executable"},
        )
        self.assertEqual(invalid.status_code, 422)
        incomplete_quiet = self.client.post(
            "/api/admin/rules",
            json={"name": "x", "keyword": "word", "quiet_start": "23:00"},
        )
        self.assertEqual(incomplete_quiet.status_code, 422)


if __name__ == "__main__":
    unittest.main()
