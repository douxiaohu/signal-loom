import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig, GroupConfig
from app.main import app
from app.security import LoginAttemptLimiter, SessionSigner
from app.storage import SQLiteStorage
from app.telegram_client import TelegramMessage


class _Forwarder:
    def __init__(self):
        self.retried = []

    async def retry_delivery(self, delivery_id):
        self.retried.append(delivery_id)
        return {"id": delivery_id, "status": "succeeded"}


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
            groups={-1001: GroupConfig(chat_id=-1001, name="Example", webhook_url="https://example.test")},
            admin_api_key="correct-key",
            session_secret="session-secret-at-least-32-bytes-long",
            session_cookie_secure=False,
            app_env="test",
        )
        app.state.config = self.config
        app.state.storage = self.storage
        app.state.session_signer = SessionSigner(self.config.session_secret, ttl_seconds=3600)
        app.state.login_limiter = LoginAttemptLimiter()
        app.state.forwarder = _Forwarder()
        self.client = TestClient(app, base_url="http://testserver")
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_rule_api_defaults_disabled_and_alert_can_be_acknowledged(self):
        created = self.client.post(
            "/api/alert-rules",
            json={"name": "Watch", "keyword": "告警", "source_ids": [-1001]},
        )
        self.assertEqual(created.status_code, 201)
        rule = created.json()
        self.assertFalse(rule["enabled"])

        patched = self.client.patch(f"/api/alert-rules/{rule['id']}", json={"enabled": True})
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
        alerts = self.client.get("/api/alerts?status=new")
        self.assertEqual(alerts.status_code, 200)
        match = alerts.json()["items"][0]
        acknowledged = self.client.post(f"/api/alerts/{match['id']}/acknowledge")
        self.assertEqual(acknowledged.status_code, 200)
        self.assertEqual(acknowledged.json()["status"], "acknowledged")

    def test_rule_validation_rejects_regex_like_empty_or_invalid_media(self):
        empty = self.client.post("/api/alert-rules", json={"name": "x", "keyword": ""})
        self.assertEqual(empty.status_code, 422)
        invalid = self.client.post(
            "/api/alert-rules",
            json={"name": "x", "keyword": "word", "media_type": "executable"},
        )
        self.assertEqual(invalid.status_code, 422)
        incomplete_quiet = self.client.post(
            "/api/alert-rules",
            json={"name": "x", "keyword": "word", "quiet_start": "23:00"},
        )
        self.assertEqual(incomplete_quiet.status_code, 422)

    def test_legacy_delivery_list_is_read_only_and_retry_is_retired(self):
        self.storage.save_message(
            TelegramMessage(
                chat_id=-1001,
                chat_title="Example",
                message_id=1,
                sender_name="Sender",
                message_time="2026-07-13T08:00:00+00:00",
                content="message",
                media_type=None,
                raw={},
            )
        )
        message_id = self.storage.get_pending_messages(-1001)[0].id
        batch = self.storage.create_delivery_batch(
            chat_id=-1001,
            group_name="Example",
            channel="webhook",
            payload="summary",
            message_ids=[message_id],
            idempotency_key="test-batch",
        )
        attempt = self.storage.begin_delivery_attempt(batch["id"], maybe_duplicate=False, chunk_count=2)
        self.storage.finish_delivery_attempt(
            attempt["id"],
            success=False,
            error="gateway timeout",
            next_retry_at="2026-07-13T09:05:00+00:00",
            completed_chunks=1,
        )
        listing = self.client.get("/api/deliveries")
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()["items"][0]["id"], batch["id"])
        self.assertNotIn("payload", listing.json()["items"][0])
        self.assertNotIn("idempotency_key", listing.json()["items"][0])
        self.assertEqual(listing.json()["items"][0]["latest_error"], "gateway timeout")
        self.assertEqual(listing.json()["items"][0]["attempts"][0]["completed_chunks"], 1)
        self.assertEqual(
            listing.json()["items"][0]["attempts"][0]["chunk_results"],
            [
                {"index": 1, "status": "succeeded", "error": None},
                {"index": 2, "status": "failed", "error": "gateway timeout"},
            ],
        )
        retry = self.client.post(f"/api/deliveries/{batch['id']}/retry")
        self.assertEqual(retry.status_code, 410)
        self.assertEqual(retry.json()["detail"], "Delivery runtime has been retired")
        self.assertEqual(app.state.forwarder.retried, [])


if __name__ == "__main__":
    unittest.main()
