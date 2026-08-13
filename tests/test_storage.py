import tempfile
import unittest
from pathlib import Path

from app.storage import SQLiteStorage
from app.telegram_client import TelegramMessage


class SQLiteStorageTests(unittest.TestCase):
    def _message(self, *, message_id: int, content: str) -> TelegramMessage:
        return TelegramMessage(
            chat_id=-1001,
            chat_title="TG Group",
            message_id=message_id,
            sender_name="Alice",
            message_time="2026-07-13T08:00:00+00:00",
            content=content,
            media_type=None,
            raw={},
        )

    def test_reconciles_succeeded_delivery_after_restart_without_swallowing_later_edits(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            database_url = f"sqlite:///{Path(tmpdir) / 'app.db'}"
            storage = SQLiteStorage(database_url)
            storage.init_db()
            storage.save_message(self._message(message_id=1, content="original"))
            message = storage.get_pending_messages(-1001)[0]
            batch = storage.create_delivery_batch(
                chat_id=-1001,
                group_name="Example",
                channel="webhook",
                payload="summary",
                message_ids=[message.id],
                idempotency_key="recovery-batch",
            )
            attempt = storage.begin_delivery_attempt(batch["id"], maybe_duplicate=False)
            storage.finish_delivery_attempt(attempt["id"], success=True, error=None, completed_chunks=1)

            restarted = SQLiteStorage(database_url)
            restarted.init_db()
            self.assertEqual(restarted.get_pending_messages(-1001), [])

            restarted.save_message(self._message(message_id=1, content="edited"))
            pending = restarted.get_pending_messages(-1001)
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0].content, "edited")

    def test_deduplicates_and_marks_forwarded(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            message = TelegramMessage(
                chat_id=-1001,
                chat_title="TG Group",
                message_id=1,
                sender_name="Alice",
                message_time="2024-06-01T00:00:00+00:00",
                content="hello",
                media_type=None,
                raw={"update_id": 1},
            )

            self.assertTrue(storage.save_message(message))
            self.assertFalse(storage.save_message(message))

            pending = storage.get_pending_messages(-1001)
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0].content, "hello")

            marked = storage.mark_forwarded([pending[0].id])
            self.assertEqual(marked, 1)
            self.assertEqual(storage.get_pending_messages(-1001), [])

    def test_tracks_state_and_chats(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            storage.set_state("offset", 123)

            self.assertEqual(storage.get_state("offset"), "123")
            self.assertEqual(storage.get_chats(), [])

    def test_duplicate_content_change_requeues_forwarded_message(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            original = TelegramMessage(
                chat_id=-1001,
                chat_title="TG Group",
                message_id=1,
                sender_name="Alice",
                message_time="2024-06-01T00:00:00+00:00",
                content="preview",
                media_type=None,
                raw={"media_urls": ["https://cdn1.telesco.pe/file/wrong.jpg"]},
            )
            updated = TelegramMessage(
                chat_id=-1001,
                chat_title="TG Group",
                message_id=1,
                sender_name="Alice",
                message_time="2024-06-01T00:00:00+00:00",
                content="full content",
                media_type=None,
                raw={"media_urls": []},
            )

            storage.save_message(original)
            pending = storage.get_pending_messages(-1001)
            storage.mark_forwarded([pending[0].id])

            self.assertFalse(storage.save_message(updated))

            requeued = storage.get_pending_messages(-1001)
            self.assertEqual(len(requeued), 1)
            self.assertEqual(requeued[0].content, "full content")

    def test_lists_messages_with_filters(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            storage.save_message(
                TelegramMessage(
                    chat_id=-1001,
                    chat_title="TG Group",
                    message_id=1,
                    sender_name="Alice",
                    message_time="2024-06-01T00:00:00+00:00",
                    content="plain update",
                    media_type=None,
                    raw={},
                )
            )
            storage.save_message(
                TelegramMessage(
                    chat_id=-1001,
                    chat_title="TG Group",
                    message_id=2,
                    sender_name="Bob",
                    message_time="2024-06-01T01:00:00+00:00",
                    content="[photo] AI chip news",
                    media_type="photo",
                    raw={"media_urls": ["https://cdn1.telesco.pe/file/a.jpg"]},
                )
            )

            messages = storage.list_messages(chat_id=-1001, query="chip", media="photo")

            self.assertEqual(storage.count_messages(chat_id=-1001, query="chip", media="photo"), 1)
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0].message_id, 2)

            loaded = storage.get_message(messages[0].id)
            self.assertIsNotNone(loaded)
            self.assertEqual(loaded.message_id, 2)

            loaded_by_telegram_id = storage.get_message_by_telegram_id(-1001, 2)
            self.assertIsNotNone(loaded_by_telegram_id)
            self.assertEqual(loaded_by_telegram_id.id, messages[0].id)

    def test_lists_mixed_messages_with_cursor_pagination(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            for chat_id, message_id, message_time, content in [
                (-1001, 1, "2024-06-01T00:00:00+00:00", "old source one"),
                (-1002, 2, "2024-06-01T00:02:00+00:00", "new source two"),
                (-1001, 3, "2024-06-01T00:01:00+00:00", "middle source one"),
            ]:
                storage.save_message(
                    TelegramMessage(
                        chat_id=chat_id,
                        chat_title=f"Group {chat_id}",
                        message_id=message_id,
                        sender_name=f"Group {chat_id}",
                        message_time=message_time,
                        content=content,
                        media_type=None,
                        raw={},
                    )
                )

            first_page = storage.list_messages_page(limit=2)
            second_page = storage.list_messages_page(limit=2, cursor=first_page.next_cursor or "")

            self.assertTrue(first_page.has_more)
            self.assertEqual([message.message_id for message in first_page.items], [2, 3])
            self.assertFalse(second_page.has_more)
            self.assertEqual([message.message_id for message in second_page.items], [1])

            source_page = storage.list_messages_page(chat_id=-1001, limit=10)
            self.assertEqual([message.message_id for message in source_page.items], [3, 1])

    def test_skips_blank_and_poll_messages(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()

            blank = TelegramMessage(
                chat_id=-1001,
                chat_title="TG Group",
                message_id=1,
                sender_name="Alice",
                message_time="2024-06-01T00:00:00+00:00",
                content="",
                media_type=None,
                raw={},
            )
            poll = TelegramMessage(
                chat_id=-1001,
                chat_title="TG Group",
                message_id=2,
                sender_name="Alice",
                message_time="2024-06-01T00:01:00+00:00",
                content="[poll]",
                media_type="poll",
                raw={},
            )

            self.assertFalse(storage.save_message(blank))
            self.assertFalse(storage.save_message(poll))
            self.assertEqual(storage.count_messages(), 0)

    def test_filters_historical_blank_messages_from_lists_and_counts(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            with storage._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO messages (
                        chat_id, chat_title, message_id, sender_name, message_time,
                        content, media_type, raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (-1001, "TG Group", 1, "Alice", "2024-06-01T00:00:00+00:00", "", None, "{}"),
                )
                conn.execute(
                    """
                    INSERT INTO messages (
                        chat_id, chat_title, message_id, sender_name, message_time,
                        content, media_type, raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (-1001, "TG Group", 2, "Alice", "2024-06-01T00:01:00+00:00", "visible", None, "{}"),
                )

            messages = storage.list_messages()

            self.assertEqual(storage.count_messages(), 1)
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0].message_id, 2)
            self.assertEqual(storage.get_chats()[0]["message_count"], 1)


if __name__ == "__main__":
    unittest.main()
