import tempfile
import unittest
from pathlib import Path

from app.storage import SQLiteStorage
from app.telegram_client import TelegramMessage


class AlertAndDeliveryStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = SQLiteStorage(f"sqlite:///{Path(self.tmp.name) / 'app.db'}")
        self.storage.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def test_disabled_rule_does_not_match_then_enabled_rule_matches_once(self):
        rule = self.storage.create_alert_rule(
            name="Security",
            keyword="安全更新",
            media_type=None,
            quiet_start="23:00",
            quiet_end="07:00",
            cooldown_minutes=30,
            enabled=False,
            source_ids=[-1001],
        )
        self._save(message_id=1, content="安全更新已经发布")
        self.assertEqual(self.storage.list_alert_matches(), [])

        updated = self.storage.update_alert_rule(rule["id"], enabled=True)
        self.assertTrue(updated["enabled"])
        self._save(message_id=2, content="安全更新已经发布")
        self._save(message_id=2, content="安全更新已经发布")

        matches = self.storage.list_alert_matches()
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["rule_name"], "Security")
        self.assertEqual(matches[0]["status"], "new")
        self.assertEqual(matches[0]["content"], "安全更新已经发布")

    def test_rule_source_and_media_conditions_are_both_required(self):
        self.storage.create_alert_rule(
            name="Photo Watch",
            keyword="现场",
            media_type="photo",
            quiet_start=None,
            quiet_end=None,
            cooldown_minutes=0,
            enabled=True,
            source_ids=[-1001],
        )
        self._save(message_id=1, content="现场消息", media_type=None)
        self._save(message_id=2, content="现场图片", media_type="photo", chat_id=-1002)
        self._save(message_id=3, content="现场图片", media_type="photo", chat_id=-1001)
        self.assertEqual([row["message_id"] for row in self.storage.list_alert_matches()], [3])

    def test_text_media_rule_matches_messages_without_media(self):
        self.storage.create_alert_rule(
            name="Text Watch",
            keyword="告警",
            media_type="text",
            quiet_start=None,
            quiet_end=None,
            cooldown_minutes=0,
            enabled=True,
            source_ids=[],
        )
        self._save(message_id=1, content="文本告警", media_type=None)
        self._save(message_id=2, content="图片告警", media_type="photo")
        self.assertEqual([row["message_id"] for row in self.storage.list_alert_matches()], [1])

    def test_quiet_hours_suppress_matches_across_midnight(self):
        self.storage.create_alert_rule(
            name="Quiet Watch",
            keyword="告警",
            media_type=None,
            quiet_start="23:00",
            quiet_end="07:00",
            cooldown_minutes=0,
            enabled=True,
            source_ids=[],
        )

        self._save(message_id=1, content="告警", message_time="2026-07-13T14:59:00+00:00")
        self._save(message_id=2, content="告警", message_time="2026-07-13T15:00:00+00:00")
        self._save(message_id=3, content="告警", message_time="2026-07-13T22:59:00+00:00")
        self._save(message_id=4, content="告警", message_time="2026-07-13T23:00:00+00:00")

        self.assertEqual(
            [row["message_id"] for row in reversed(self.storage.list_alert_matches())],
            [1, 4],
        )

    def test_cooldown_suppresses_repeated_matches_until_window_expires(self):
        self.storage.create_alert_rule(
            name="Cooldown Watch",
            keyword="告警",
            media_type=None,
            quiet_start=None,
            quiet_end=None,
            cooldown_minutes=30,
            enabled=True,
            source_ids=[],
        )

        self._save(message_id=1, content="告警", message_time="2026-07-13T08:00:00+00:00")
        self._save(message_id=2, content="告警", message_time="2026-07-13T08:29:59+00:00")
        self._save(message_id=3, content="告警", message_time="2026-07-13T08:30:00+00:00")

        self.assertEqual(
            [row["message_id"] for row in reversed(self.storage.list_alert_matches())],
            [1, 3],
        )

    def test_alert_status_moves_from_new_to_acknowledged_to_resolved(self):
        self.storage.create_alert_rule(
            name="Watch",
            keyword="告警",
            media_type=None,
            quiet_start=None,
            quiet_end=None,
            cooldown_minutes=0,
            enabled=True,
            source_ids=[],
        )
        self._save(message_id=1, content="告警消息")
        match_id = self.storage.list_alert_matches()[0]["id"]

        acknowledged = self.storage.set_alert_match_status(match_id, "acknowledged")
        self.assertEqual(acknowledged["status"], "acknowledged")
        self.assertIsNotNone(acknowledged["acknowledged_at"])
        resolved = self.storage.set_alert_match_status(match_id, "resolved")
        self.assertEqual(resolved["status"], "resolved")
        self.assertIsNotNone(resolved["resolved_at"])

    def test_delivery_batch_is_idempotent_and_tracks_attempts(self):
        self._save(message_id=1, content="first")
        self._save(message_id=2, content="second")
        ids = [message.id for message in self.storage.get_pending_messages(-1001)]
        first = self.storage.create_delivery_batch(
            chat_id=-1001,
            group_name="Example",
            channel="webhook",
            payload="summary",
            message_ids=ids,
            idempotency_key="scheduled:-1001:1-2",
        )
        duplicate = self.storage.create_delivery_batch(
            chat_id=-1001,
            group_name="Example",
            channel="webhook",
            payload="summary",
            message_ids=ids,
            idempotency_key="scheduled:-1001:1-2",
        )
        self.assertEqual(first["id"], duplicate["id"])

        failed_attempt = self.storage.begin_delivery_attempt(first["id"], maybe_duplicate=False, chunk_count=3)
        self.storage.finish_delivery_attempt(
            failed_attempt["id"],
            success=False,
            error="timeout",
            next_retry_at="2026-07-13T09:05:00+00:00",
            completed_chunks=1,
        )
        failed = self.storage.get_delivery_batch(first["id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["attempt_count"], 1)
        self.assertEqual(failed["next_retry_at"], "2026-07-13T09:05:00+00:00")
        self.assertEqual(failed["latest_error"], "timeout")
        self.assertEqual(failed["attempts"][0]["chunk_count"], 3)
        self.assertEqual(failed["attempts"][0]["completed_chunks"], 1)

        retry = self.storage.begin_delivery_attempt(first["id"], maybe_duplicate=True)
        self.storage.finish_delivery_attempt(retry["id"], success=True, error=None)
        completed = self.storage.get_delivery_batch(first["id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["attempt_count"], 2)
        self.assertTrue(completed["maybe_duplicate"])
        self.assertEqual(self.storage.get_delivery_message_ids(first["id"]), ids)

    def test_delivery_attempt_initializes_pending_chunk_results(self):
        self._save(message_id=1, content="first")
        message_id = self.storage.get_pending_messages(-1001)[0].id
        batch = self.storage.create_delivery_batch(
            chat_id=-1001,
            group_name="Example",
            channel="webhook",
            payload="summary",
            message_ids=[message_id],
            idempotency_key="pending-chunks",
        )

        self.storage.begin_delivery_attempt(batch["id"], maybe_duplicate=False, chunk_count=3)

        attempt = self.storage.get_delivery_batch(batch["id"])["attempts"][0]
        self.assertEqual(
            attempt["chunk_results"],
            [
                {"index": 1, "status": "pending", "error": None},
                {"index": 2, "status": "pending", "error": None},
                {"index": 3, "status": "pending", "error": None},
            ],
        )

    def test_failed_delivery_attempt_records_each_chunk_and_sanitizes_error(self):
        self._save(message_id=1, content="first")
        message_id = self.storage.get_pending_messages(-1001)[0].id
        batch = self.storage.create_delivery_batch(
            chat_id=-1001,
            group_name="Example",
            channel="webhook",
            payload="summary",
            message_ids=[message_id],
            idempotency_key="failed-chunks",
        )
        attempt = self.storage.begin_delivery_attempt(
            batch["id"], maybe_duplicate=False, chunk_count=3
        )

        self.storage.finish_delivery_attempt(
            attempt["id"],
            success=False,
            error=(
                "timeout while writing /app/data/private.log after calling "
                "https://hooks.example.test/tmp/remote"
            ),
            next_retry_at="2026-07-13T09:05:00+00:00",
            completed_chunks=1,
        )

        delivery = self.storage.get_delivery_batch(batch["id"])
        self.assertNotIn("/app/data", delivery["latest_error"])
        self.assertEqual(
            delivery["attempts"][0]["chunk_results"],
            [
                {"index": 1, "status": "succeeded", "error": None},
                {
                    "index": 2,
                    "status": "failed",
                    "error": (
                        "timeout while writing [redacted-path] after calling "
                        "https://hooks.example.test/tmp/remote"
                    ),
                },
                {"index": 3, "status": "not_attempted", "error": None},
            ],
        )

    def test_successful_delivery_attempt_marks_every_chunk_succeeded(self):
        self._save(message_id=1, content="first")
        message_id = self.storage.get_pending_messages(-1001)[0].id
        batch = self.storage.create_delivery_batch(
            chat_id=-1001,
            group_name="Example",
            channel="webhook",
            payload="summary",
            message_ids=[message_id],
            idempotency_key="successful-chunks",
        )
        attempt = self.storage.begin_delivery_attempt(
            batch["id"], maybe_duplicate=False, chunk_count=2
        )

        self.storage.finish_delivery_attempt(attempt["id"], success=True, error=None)

        chunk_results = self.storage.get_delivery_batch(batch["id"])["attempts"][0][
            "chunk_results"
        ]
        self.assertEqual([chunk["status"] for chunk in chunk_results], ["succeeded", "succeeded"])

    def _save(self, *, message_id, content, media_type=None, chat_id=-1001, message_time=None):
        return self.storage.save_message(
            TelegramMessage(
                chat_id=chat_id,
                chat_title="Example",
                message_id=message_id,
                sender_name="Sender",
                message_time=message_time or f"2026-07-13T08:{message_id:02d}:00+00:00",
                content=content,
                media_type=media_type,
                raw={},
            )
        )


if __name__ == "__main__":
    unittest.main()
