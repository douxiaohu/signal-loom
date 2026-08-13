import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import app
from app.security import LoginAttemptLimiter, SessionSigner
from app.storage import SQLiteStorage


class ReverseProxySameOriginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        config = AppConfig(
            telegram_bot_token="",
            database_url=f"sqlite:///{Path(self.tmp.name) / 'app.db'}",
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            groups_config_path="config/groups.yaml",
            groups={},
            admin_api_key="correct-key",
            session_secret="session-secret-at-least-32-bytes-long",
            session_cookie_secure=False,
            app_env="test",
        )
        storage = SQLiteStorage(config.database_url)
        storage.init_db()
        app.state.config = config
        app.state.storage = storage
        app.state.session_signer = SessionSigner(config.session_secret, ttl_seconds=3600)
        app.state.login_limiter = LoginAttemptLimiter(max_attempts=5, window_seconds=900)
        self.client = TestClient(app, base_url="http://internal-container")

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_accepts_https_origin_matching_forwarded_public_host(self):
        response = self.client.post(
            "/api/auth/login",
            json={"api_key": "correct-key"},
            headers={
                "Host": "alerts.example.com",
                "Origin": "https://alerts.example.com",
            },
        )

        self.assertEqual(response.status_code, 200)

    def test_rejects_origin_with_different_public_host(self):
        response = self.client.post(
            "/api/auth/login",
            json={"api_key": "correct-key"},
            headers={
                "Host": "alerts.example.com",
                "Origin": "https://attacker.example",
            },
        )

        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
