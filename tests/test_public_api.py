import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import app
from app.security import LoginAttemptLimiter, SessionSigner
from app.storage import SQLiteStorage
from app.telegram_client import TelegramMessage


class _MediaCache:
    def get(self, message, index, *, variant="original"):
        raise AssertionError("private media must be rejected before cache access")


class PublicApiTests(unittest.TestCase):
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
        app.state.media_cache = _MediaCache()
        app.state.session_signer = SessionSigner(self.config.session_secret, ttl_seconds=3600)
        app.state.login_limiter = LoginAttemptLimiter()
        self.client = TestClient(app, base_url="http://testserver")

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def _save_message(self, chat_id: int, content: str, *, media: bool = False):
        self.storage.save_message(
            TelegramMessage(
                chat_id=chat_id,
                chat_title=content,
                message_id=1,
                sender_name="Sender",
                message_time="2026-07-14T08:00:00+00:00",
                content=content,
                media_type="photo" if media else None,
                raw={
                    "source_url": "https://t.me/example/1",
                    "media_urls": ["https://cdn1.telesco.pe/file/a.jpg"] if media else [],
                    "media_items": [
                        {"url": "https://cdn1.telesco.pe/file/a.jpg", "kind": "image", "role": "media"}
                    ] if media else [],
                },
            )
        )
        return self.storage.get_message_by_telegram_id(chat_id, 1)

    def test_public_api_only_returns_public_sources_and_messages(self):
        public = self.storage.create_source(
            name="Public",
            source_url="https://t.me/public_source",
            public_visible=True,
        )
        private = self.storage.create_source(
            name="Private",
            source_url="https://t.me/private_source",
            public_visible=False,
        )
        self._save_message(public.chat_id, "visible")
        self._save_message(private.chat_id, "secret")

        sources = self.client.get("/api/public/sources")
        messages = self.client.get("/api/public/messages?limit=20")

        self.assertEqual(sources.status_code, 200)
        self.assertEqual([item["name"] for item in sources.json()["items"]], ["Public"])
        self.assertEqual([item["content"] for item in messages.json()["items"]], ["visible"])
        self.assertNotIn("last_error", sources.text)
        self.assertNotIn("forwarded_at", messages.text)
        self.assertEqual(sources.headers["cache-control"], "no-cache")
        self.assertIn("etag", sources.headers)

    def test_private_source_cannot_be_selected_or_read_through_media(self):
        private = self.storage.create_source(
            name="Private",
            source_url="https://t.me/private_source",
            public_visible=False,
        )
        message = self._save_message(private.chat_id, "secret", media=True)
        self.assertIsNotNone(message)

        selected = self.client.get(f"/api/public/messages?chat_id={private.chat_id}")
        media = self.client.get(f"/api/public/media/{message.id}/0?variant=thumbnail")

        self.assertEqual(selected.status_code, 404)
        self.assertEqual(media.status_code, 404)

    def test_orphan_chat_id_is_admin_visible_and_public_hidden(self):
        self._save_message(-999001, "orphan-row")
        self.assertEqual(self.client.post("/api/auth/login", json={"api_key": "correct-key"}).status_code, 200)

        admin = self.client.get("/api/admin/messages?chat_id=-999001")
        public = self.client.get("/api/public/messages?chat_id=-999001")
        public_all = self.client.get("/api/public/messages")

        self.assertEqual(admin.status_code, 200)
        self.assertEqual([item["content"] for item in admin.json()["items"]], ["orphan-row"])
        self.assertEqual(public.status_code, 404)
        self.assertNotIn("orphan-row", public_all.text)


if __name__ == "__main__":
    unittest.main()
