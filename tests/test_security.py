import base64
import hashlib
import hmac
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.config import AppConfig, GroupConfig, load_groups_file, validate_security_config
from app.main import app, list_screenshot_files, message_to_api_dict
from app.scheduler import Forwarder, ForwardGroupResult, ForwardRunResult
from app.security import LoginAttemptLimiter, SessionSigner
from app.storage import SQLiteStorage, StoredMessage


class _Scheduler:
    def get_jobs(self):
        return []


class _PollerStatus:
    def as_dict(self):
        return {
            "running": True,
            "last_error": (
                "cache /app/private/poller.state, /custom/runtime/poller.state, and "
                "file:///app/secrets/poller.key failed while fetching "
                "https://example.test/tmp/remote-state.json"
            ),
        }


class _Poller:
    status = _PollerStatus()


class _Forwarder:
    async def forward_all(self, trigger="scheduled"):
        return ForwardRunResult(
            trigger=trigger,
            groups=[
                ForwardGroupResult(
                    chat_id=-1001,
                    group_name="Example",
                    message_count=1,
                    success=False,
                    error=(
                        "cannot open /tmp/private-summary.png; upstream "
                        "https://example.test/data/public-summary.png"
                    ),
                )
            ],
            unconfigured_pending=[],
            crawled_sources=[
                {
                    "source": "https://t.me/example",
                    "chat_id": -1001,
                    "fetched": 0,
                    "saved": 0,
                    "error": "failed to read data/crawler/private.json",
                }
            ],
        )


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
        app.state.scheduler = _Scheduler()
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
        self.assertEqual(self.client.get("/api/groups").status_code, 401)
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "wrong"}).status_code, 401)

        login = self.client.post("/api/auth/login", json={"api_key": "correct-key"})
        self.assertEqual(login.status_code, 200)
        self.assertIn("HttpOnly", login.headers["set-cookie"])
        self.assertIn("SameSite=strict", login.headers["set-cookie"])
        self.assertTrue(self.client.get("/api/session").json()["authenticated"])
        protected = self.client.get("/api/groups")
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
        self.assertEqual(self.client.get("/api/groups").status_code, 401)
        self.assertIsNotNone(copied_cookie)
        replay_client = TestClient(app, base_url="http://testserver")
        try:
            replay_client.cookies.set("tg_session", copied_cookie or "")
            self.assertEqual(replay_client.get("/api/groups").status_code, 401)
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

    def test_api_and_screenshot_metadata_do_not_expose_internal_fields(self):
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
        payload = message_to_api_dict(message)
        self.assertNotIn("original_media_urls", payload)
        self.assertNotIn("raw_source", payload)

        image = Path(self.tmp.name) / "summary.png"
        image.write_bytes(b"png")
        entries = list_screenshot_files(self.tmp.name)
        self.assertEqual(entries[0]["filename"], "summary.png")
        self.assertNotIn("path", entries[0])

    def test_status_does_not_expose_forward_payload_or_server_paths(self):
        app.state.storage.log_forward(
            chat_id=-1001,
            group_name="Example",
            message_count=1,
            success=True,
            error=None,
            payload_preview="/tmp/private-screenshot.png",
        )
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)
        response = self.client.get("/status")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("payload_preview", response.json()["recent_forward_logs"][0])
        self.assertNotIn("/tmp/", response.text)

    def test_status_redacts_error_paths_and_forward_job_is_retired(self):
        app.state.poller = _Poller()
        app.state.forwarder = _Forwarder()
        app.state.storage.log_forward(
            chat_id=-1001,
            group_name="Example",
            message_count=1,
            success=False,
            error=(
                "write data/forward/private.log failed after calling "
                "https://hooks.example.test/tmp/remote-hook"
            ),
            payload_preview="ignored",
        )
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)

        status = self.client.get("/status")
        self.assertEqual(status.status_code, 200)
        status_body = status.json()
        self.assertNotIn("/app/private/poller.state", status_body["telegram_poller"]["last_error"])
        self.assertNotIn("/custom/runtime/poller.state", status_body["telegram_poller"]["last_error"])
        self.assertNotIn("file:///app/secrets/poller.key", status_body["telegram_poller"]["last_error"])
        self.assertIn(
            "https://example.test/tmp/remote-state.json",
            status_body["telegram_poller"]["last_error"],
        )
        self.assertNotIn(
            "data/forward/private.log",
            status_body["recent_forward_logs"][0]["error"],
        )
        self.assertIn(
            "https://hooks.example.test/tmp/remote-hook",
            status_body["recent_forward_logs"][0]["error"],
        )

        forward = self.client.post(
            "/jobs/forward-now",
            headers={"Origin": "http://testserver"},
        )
        self.assertEqual(forward.status_code, 410)
        self.assertEqual(forward.json()["detail"], "Delivery runtime has been retired")

    def test_delivery_and_operations_apis_redact_persisted_error_paths(self):
        app.state.config = replace(
            app.state.config,
            groups={
                -1001: GroupConfig(
                    chat_id=-1001,
                    name="Example",
                    source="https://t.me/example",
                    source_type="telegram_public",
                )
            },
        )
        app.state.storage.record_source_run(
            chat_id=-1001,
            source="https://t.me/example",
            started_at="2026-07-13T08:00:00+00:00",
            finished_at="2026-07-13T08:00:05+00:00",
            fetched_count=0,
            saved_count=0,
            error=(
                "cannot read /tmp/crawler/private.html from "
                "https://t.me/example/tmp/remote-post"
            ),
        )
        app.state.storage.log_forward(
            chat_id=-1001,
            group_name="Example",
            message_count=1,
            success=False,
            error="failed to open data/forward/private.log",
            payload_preview="ignored",
        )
        delivery = {
            "id": 1,
            "status": "failed",
            "payload": "sensitive summary",
            "idempotency_key": "sensitive-key",
            "latest_error": "permission denied: /app/secrets/admin.key",
            "attempts": [
                {
                    "attempt_no": 1,
                    "status": "failed",
                    "error": "permission denied: /app/secrets/admin.key",
                }
            ],
        }
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)

        with patch.object(app.state.storage, "list_deliveries", return_value=[delivery]):
            deliveries = self.client.get("/api/deliveries")
            self.assertEqual(deliveries.status_code, 200)
            delivery_body = deliveries.json()["items"][0]
            self.assertNotIn("/app/secrets/admin.key", delivery_body["latest_error"])
            self.assertNotIn("/app/secrets/admin.key", delivery_body["attempts"][0]["error"])

            operations = self.client.get("/api/operations/summary")
            self.assertEqual(operations.status_code, 200)
            body = operations.json()
        self.assertNotIn("/tmp/crawler/private.html", body["sources"][0]["last_error"])
        self.assertIn(
            "https://t.me/example/tmp/remote-post",
            body["sources"][0]["last_error"],
        )
        self.assertNotIn(
            "data/forward/private.log",
            body["recent_deliveries"][0]["error"],
        )
        self.assertNotIn("/app/secrets/admin.key", body["deliveries"][0]["latest_error"])

    async def test_forwarder_redacts_delivery_error_before_persisting_it(self):
        class CaptureStorage:
            def __init__(self):
                self.attempt_error = None
                self.log_error = None

            def begin_delivery_attempt(self, *args, **kwargs):
                return {"id": 1}

            def finish_delivery_attempt(self, *args, **kwargs):
                self.attempt_error = kwargs["error"]

            def log_forward(self, *args, **kwargs):
                self.log_error = kwargs["error"]

        class FailingWeCom:
            max_text_chars = 4096

            def send_text(self, webhook_url, content):
                raise RuntimeError(
                    "cannot read /app/private/delivery.json; upstream "
                    "https://hooks.example.test/tmp/remote-hook"
                )

        storage = CaptureStorage()
        config = replace(app.state.config, groups={})
        forwarder = Forwarder(config=config, storage=storage, wecom_client=FailingWeCom())
        result = forwarder._execute_delivery_batch(
            group=GroupConfig(
                chat_id=-1001,
                name="Example",
                webhook_url="https://hooks.example.test/send",
            ),
            messages=[],
            summary="summary",
            batch_id=1,
            channel="webhook",
            maybe_duplicate=False,
        )

        self.assertNotIn("/app/private/delivery.json", storage.attempt_error)
        self.assertNotIn("/app/private/delivery.json", storage.log_error)
        self.assertNotIn("/app/private/delivery.json", result.error)
        self.assertIn("https://hooks.example.test/tmp/remote-hook", result.error)

    async def test_forwarder_redacts_crawler_error_before_persisting_and_returning_it(self):
        class CaptureStorage:
            error = None

            def record_source_run(self, *args, **kwargs):
                self.error = kwargs["error"]

        class FailingCrawler:
            def crawl_group(self, group):
                return type(
                    "CrawlResult",
                    (),
                    {
                        "chat_id": group.chat_id,
                        "source": group.source,
                        "fetched": 0,
                        "saved": 0,
                        "error": "cannot open data/crawler/private.html",
                        "as_dict": lambda self: {
                            "chat_id": self.chat_id,
                            "source": self.source,
                            "fetched": self.fetched,
                            "saved": self.saved,
                            "error": self.error,
                        },
                    },
                )()

        storage = CaptureStorage()
        config = replace(
            app.state.config,
            groups={
                -1001: GroupConfig(
                    chat_id=-1001,
                    name="Example",
                    source="https://t.me/example/tmp/remote-post",
                    source_type="telegram_public",
                )
            },
        )
        forwarder = Forwarder(
            config=config,
            storage=storage,
            wecom_client=object(),
            public_crawler=FailingCrawler(),
        )

        result = forwarder._crawl_public_sources()

        self.assertNotIn("data/crawler/private.html", storage.error)
        self.assertNotIn("data/crawler/private.html", result[0]["error"])
        self.assertEqual(result[0]["source"], "https://t.me/example/tmp/remote-post")

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
