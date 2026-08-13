import asyncio
import tempfile
import unittest
from pathlib import Path

from app.storage import SQLiteStorage
from app.telegram_client import TelegramPoller, detect_media_type, extract_telegram_message


class TelegramMessageParsingTests(unittest.TestCase):
    def test_extracts_text_message(self):
        update = {
            "update_id": 1,
            "message": {
                "message_id": 10,
                "date": 1717200000,
                "chat": {"id": -1001, "title": "TG Group"},
                "from": {"id": 7, "first_name": "Alice", "last_name": "Zhang"},
                "text": "hello",
            },
        }

        message = extract_telegram_message(update)

        self.assertIsNotNone(message)
        self.assertEqual(message.chat_id, -1001)
        self.assertEqual(message.chat_title, "TG Group")
        self.assertEqual(message.message_id, 10)
        self.assertEqual(message.sender_name, "Alice Zhang")
        self.assertEqual(message.content, "hello")
        self.assertIsNone(message.media_type)

    def test_extracts_photo_caption_with_marker(self):
        update = {
            "update_id": 2,
            "message": {
                "message_id": 11,
                "date": 1717200000,
                "chat": {"id": -1001, "title": "TG Group"},
                "from": {"id": 8, "username": "bob"},
                "photo": [{"file_id": "abc"}],
                "caption": "screen shot",
            },
        }

        message = extract_telegram_message(update)

        self.assertEqual(message.media_type, "photo")
        self.assertEqual(message.content, "[photo] screen shot")

    def test_extracts_media_without_caption(self):
        update = {
            "update_id": 3,
            "message": {
                "message_id": 12,
                "date": 1717200000,
                "chat": {"id": -1001, "title": "TG Group"},
                "document": {"file_id": "abc", "file_name": "a.pdf"},
            },
        }

        message = extract_telegram_message(update)

        self.assertEqual(message.media_type, "document")
        self.assertEqual(message.content, "[document]")

    def test_detects_known_media_types(self):
        self.assertEqual(detect_media_type({"video": {}}), "video")
        self.assertIsNone(detect_media_type({"text": "plain"}))


class TelegramPollerHealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_bot_poll_records_source_health(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            stop_event = asyncio.Event()

            class Client:
                async def get_updates(self, *, offset, timeout):
                    stop_event.set()
                    return [{
                        "update_id": 1,
                        "message": {
                            "message_id": 10,
                            "date": 1717200000,
                            "chat": {"id": -1001, "title": "TG Group"},
                            "text": "hello",
                        },
                    }]

            poller = TelegramPoller(
                client=Client(),
                storage=storage,
                source_chat_ids=[-1001],
                retry_delay=0,
            )
            await poller.run(stop_event)

            health = storage.get_source_health(-1001, stale_after_seconds=900)
            self.assertEqual(health["health_status"], "healthy")
            self.assertEqual(health["fetched_count"], 1)
            self.assertEqual(health["saved_count"], 1)


if __name__ == "__main__":
    unittest.main()
