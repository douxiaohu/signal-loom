import base64
import hashlib
import hmac
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from app.api_common import message_to_api_dict
from app.config import AppConfig, load_groups_file, validate_security_config
from app.main import app
from app.security import LoginAttemptLimiter, SessionSigner
from app.storage import SQLiteStorage, StoredMessage


class SecurityTests(unittest.IsolatedAsyncioTestCase):
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
        app.state.scheduler = type("S", (), {"get_jobs": lambda self: []})()
        app.state.poller = None
        self.client = TestClient(app, base_url="http://testserver")

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_session_signer_rejects_tampered_and_expired_tokens(self):
        signer = SessionSigner("a-secret-long-enough-for-tests", ttl_seconds=60)
        token, expires_at = signer.issue(now=1_000)
        self.assertEqual(signer.verify(token, now=1_030), expires_at)
        self.assertIsNone(signer.verify(f"{token}x", now=1_030))
        self.assertIsNone(signer.verify(token, now=expires_at))
        self.assertIsNone(signer.verify(token, now=1_061))
        malformed_payload = "a"
        malformed_signature = base64.urlsafe_b64encode(
            hmac.new(
                b"a-secret-long-enough-for-tests",
                malformed_payload.encode("ascii"),
                hashlib.sha256,
            ).digest()
        ).rstrip(b"=").decode("ascii")
        self.assertIsNone(signer.verify(f"{malformed_payload}.{malformed_signature}", now=1_030))

    def test_production_config_requires_admin_key_and_session_secret(self):
        config = app.state.config
        with self.assertRaisesRegex(ValueError, "ADMIN_API_KEY"):
            validate_security_config(replace(config, app_env="production", admin_api_key=""))
        with self.assertRaisesRegex(ValueError, "SESSION_SECRET"):
            validate_security_config(
                replace(config, app_env="production", admin_api_key="long-enough-admin-key", session_secret="")
            )
        with self.assertRaisesRegex(ValueError, "SESSION_COOKIE_SECURE"):
            validate_security_config(
                replace(config, app_env="production", admin_api_key="long-enough-admin-key", session_cookie_secure=False)
            )
        with self.assertRaisesRegex(ValueError, "ADMIN_API_KEY must"):
            validate_security_config(replace(config, app_env="production", admin_api_key="short"))
        validate_security_config(
            replace(
                config,
                app_env="development",
                admin_api_key="long-enough-admin-key",
                session_cookie_secure=False,
            )
        )

    def test_login_session_logout_and_protected_api(self):
        self.assertEqual(self.client.get("/api/admin/sources").status_code, 401)
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "wrong"}).status_code, 401)

        login = self.client.post("/api/auth/login", json={"api_key": "correct-key"})
        self.assertEqual(login.status_code, 200)
        self.assertIn("HttpOnly", login.headers["set-cookie"])
        self.assertIn("SameSite=strict", login.headers["set-cookie"])
        self.assertIn("Path=/", login.headers["set-cookie"])
        self.assertTrue(self.client.get("/api/session").json()["authenticated"])
        protected = self.client.get("/api/admin/sources")
        self.assertEqual(protected.status_code, 200)
        self.assertEqual(protected.headers["cache-control"], "private, no-store")
        self.assertIn("Cookie", protected.headers["vary"])

        copied_cookie = self.client.cookies.get("tg_session")

        bad_origin = self.client.post(
            "/api/auth/logout",
            headers={"Origin": "https://attacker.invalid"},
        )
        self.assertEqual(bad_origin.status_code, 403)
        logout = self.client.post(
            "/api/auth/logout",
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(logout.status_code, 204)
        self.assertEqual(self.client.get("/api/admin/sources").status_code, 401)
        self.assertIsNotNone(copied_cookie)
        replay_client = TestClient(app, base_url="http://testserver")
        try:
            replay_client.cookies.set("tg_session", copied_cookie or "")
            self.assertEqual(replay_client.get("/api/admin/sources").status_code, 401)
        finally:
            replay_client.close()

    def test_login_limits_payload_length_and_repeated_failures(self):
        too_long = self.client.post("/api/auth/login", json={"api_key": "x" * 257})
        self.assertEqual(too_long.status_code, 422)
        for _ in range(5):
            self.assertEqual(
                self.client.post("/api/auth/login", json={"api_key": "wrong"}).status_code,
                401,
            )
        limited = self.client.post("/api/auth/login", json={"api_key": "wrong"})
        self.assertEqual(limited.status_code, 429)

    def test_security_headers_are_added_to_public_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertEqual(response.headers["referrer-policy"], "no-referrer")
        self.assertIn("default-src 'self'", response.headers["content-security-policy"])

    def test_api_metadata_does_not_expose_internal_fields(self):
        message = StoredMessage(
            id=1,
            chat_id=-1001,
            chat_title="Channel",
            message_id=2,
            sender_name="Sender",
            message_time="2026-07-13T08:00:00+00:00",
            content="hello",
            media_type="photo",
            raw_json='{"source":"telegram_public","media_urls":["https://cdn1.telesco.pe/file/a.jpg"]}',
            forwarded_at=None,
        )
        payload = message_to_api_dict(message, media_base_path="/api/public/media")
        self.assertNotIn("original_media_urls", payload)
        self.assertNotIn("raw_source", payload)

    def test_retired_delivery_routes_are_gone(self):
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)
        self.assertEqual(self.client.get("/status").status_code, 404)
        self.assertEqual(self.client.get("/api/groups").status_code, 404)
        self.assertEqual(self.client.get("/api/deliveries").status_code, 404)
        self.assertIn(
            self.client.post("/jobs/forward-now", headers={"Origin": "http://testserver"}).status_code,
            {404, 405},
        )

    def test_duplicate_chat_ids_are_rejected(self):
        groups_path = Path(self.tmp.name) / "groups.yaml"
        groups_path.write_text(
            "groups:\n  - chat_id: -1001\n    name: one\n  - chat_id: -1001\n    name: two\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "duplicate chat_id"):
            load_groups_file(str(groups_path))


if __name__ == "__main__":
    unittest.main()
