import tempfile
import unittest
from pathlib import Path

from app.config import AppConfig, GroupConfig
from app.scheduler import Forwarder, build_summary, create_background_scheduler
from app.storage import SQLiteStorage
from app.telegram_client import TelegramMessage


class FakeWeComClient:
    def __init__(self, fail=False):
        self.fail = fail
        self.sent = []

    def send_text(self, webhook_url, content):
        self.sent.append((webhook_url, content))
        if self.fail:
            raise RuntimeError("send failed")
        return None


class FakeImageExporter:
    def __init__(self):
        self.exported = []

    def export(self, *, group_name, chat_id, summary, messages=None, timezone_name="UTC"):
        self.exported.append((group_name, chat_id, summary, messages, timezone_name))
        return type("ImageResult", (), {"paths": [f"/tmp/{chat_id}.png"]})()


class ForwarderTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_webhook_delivery_is_recorded_and_can_be_retried(self):
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
                    content="hello",
                    media_type=None,
                    raw={"update_id": 1},
                )
            )
            config = AppConfig(
                telegram_bot_token="",
                database_url=storage.database_url,
                timezone="Asia/Shanghai",
                forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={
                    -1001: GroupConfig(
                        chat_id=-1001,
                        name="TG Group",
                        webhook_url="https://example.test/one",
                    )
                },
            )
            wecom = FakeWeComClient(fail=True)
            forwarder = Forwarder(config=config, storage=storage, wecom_client=wecom)

            with self.assertLogs("app.scheduler", level="ERROR"):
                failed = await forwarder.forward_all(trigger="manual")

            self.assertFalse(failed.groups[0].success)
            delivery = storage.list_deliveries()[0]
            self.assertEqual(delivery["status"], "failed")
            self.assertEqual(delivery["attempt_count"], 1)
            self.assertEqual(len(storage.get_pending_messages(-1001)), 1)

            wecom.fail = False
            retried = await forwarder.retry_delivery(delivery["id"])

            self.assertEqual(retried["status"], "succeeded")
            completed = storage.get_delivery_batch(delivery["id"])
            self.assertEqual(completed["attempt_count"], 2)
            self.assertTrue(completed["maybe_duplicate"])
            self.assertEqual(storage.get_pending_messages(-1001), [])

    async def test_failed_messages_are_not_rebatched_with_new_arrivals(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            config = AppConfig(
                telegram_bot_token="",
                database_url=storage.database_url,
                timezone="Asia/Shanghai",
                forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={-1001: GroupConfig(chat_id=-1001, name="TG Group", webhook_url="https://example.test/one")},
            )
            for message_id, content in [(1, "old failed message")]:
                storage.save_message(
                    TelegramMessage(
                        chat_id=-1001, chat_title="TG Group", message_id=message_id,
                        sender_name="Alice", message_time=f"2026-07-13T08:0{message_id}:00+00:00",
                        content=content, media_type=None, raw={},
                    )
                )
            wecom = FakeWeComClient(fail=True)
            forwarder = Forwarder(config=config, storage=storage, wecom_client=wecom)
            with self.assertLogs("app.scheduler", level="ERROR"):
                await forwarder.forward_all(trigger="manual")

            storage.save_message(
                TelegramMessage(
                    chat_id=-1001, chat_title="TG Group", message_id=2,
                    sender_name="Bob", message_time="2026-07-13T08:02:00+00:00",
                    content="new independent message", media_type=None, raw={},
                )
            )
            wecom.fail = False
            result = await forwarder.forward_all(trigger="manual")

            self.assertTrue(result.groups[0].success)
            self.assertIn("new independent message", wecom.sent[-1][1])
            self.assertNotIn("old failed message", wecom.sent[-1][1])
            deliveries = storage.list_deliveries()
            self.assertEqual([item["status"] for item in deliveries], ["succeeded", "failed"])
            self.assertEqual([item.message_id for item in storage.get_pending_messages(-1001)], [1])

    async def test_edited_delivered_message_creates_a_new_versioned_batch(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            config = AppConfig(
                telegram_bot_token="", database_url=storage.database_url,
                timezone="Asia/Shanghai", forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={-1001: GroupConfig(chat_id=-1001, name="TG Group", webhook_url="https://example.test/one")},
            )
            original = TelegramMessage(
                chat_id=-1001, chat_title="TG Group", message_id=1,
                sender_name="Alice", message_time="2026-07-13T08:00:00+00:00",
                content="original content", media_type=None, raw={},
            )
            storage.save_message(original)
            wecom = FakeWeComClient()
            forwarder = Forwarder(config=config, storage=storage, wecom_client=wecom)
            await forwarder.forward_all(trigger="manual")

            storage.save_message(
                TelegramMessage(
                    chat_id=-1001, chat_title="TG Group", message_id=1,
                    sender_name="Alice", message_time="2026-07-13T08:00:00+00:00",
                    content="edited security content", media_type=None, raw={},
                )
            )
            await forwarder.forward_all(trigger="manual")

            self.assertEqual(len(wecom.sent), 2)
            self.assertIn("edited security content", wecom.sent[1][1])
            self.assertEqual(len(storage.list_deliveries()), 2)

    async def test_edit_during_failed_delivery_is_not_marked_forwarded_by_old_retry(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            config = AppConfig(
                telegram_bot_token="", database_url=storage.database_url,
                timezone="Asia/Shanghai", forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={-1001: GroupConfig(chat_id=-1001, name="TG Group", webhook_url="https://example.test/one")},
            )
            storage.save_message(
                TelegramMessage(
                    chat_id=-1001, chat_title="TG Group", message_id=1,
                    sender_name="Alice", message_time="2026-07-13T08:00:00+00:00",
                    content="old version", media_type=None, raw={},
                )
            )
            wecom = FakeWeComClient(fail=True)
            forwarder = Forwarder(config=config, storage=storage, wecom_client=wecom)
            with self.assertLogs("app.scheduler", level="ERROR"):
                await forwarder.forward_all(trigger="manual")
            failed_batch = storage.list_deliveries()[0]
            storage.save_message(
                TelegramMessage(
                    chat_id=-1001, chat_title="TG Group", message_id=1,
                    sender_name="Alice", message_time="2026-07-13T08:00:00+00:00",
                    content="edited version", media_type=None, raw={},
                )
            )

            wecom.fail = False
            await forwarder.retry_delivery(failed_batch["id"])
            pending = storage.get_pending_messages(-1001)
            self.assertEqual([item.content for item in pending], ["edited version"])

            await forwarder.forward_all(trigger="manual")
            self.assertIn("edited version", wecom.sent[-1][1])
            self.assertEqual(storage.get_pending_messages(-1001), [])

    async def test_due_delivery_is_retried_automatically(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            storage.save_message(
                TelegramMessage(
                    chat_id=-1001, chat_title="TG Group", message_id=1,
                    sender_name="Alice", message_time="2026-07-13T08:00:00+00:00",
                    content="retry me", media_type=None, raw={},
                )
            )
            config = AppConfig(
                telegram_bot_token="", database_url=storage.database_url,
                timezone="Asia/Shanghai", forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={-1001: GroupConfig(chat_id=-1001, name="TG Group", webhook_url="https://example.test/one")},
            )
            wecom = FakeWeComClient(fail=True)
            forwarder = Forwarder(config=config, storage=storage, wecom_client=wecom)
            with self.assertLogs("app.scheduler", level="ERROR"):
                await forwarder.forward_all(trigger="manual")
            delivery = storage.list_deliveries()[0]
            with storage._connect() as conn:
                conn.execute(
                    "UPDATE delivery_batches SET next_retry_at = ? WHERE id = ?",
                    ("2020-01-01T00:00:00+00:00", delivery["id"]),
                )

            wecom.fail = False
            retried = await forwarder.retry_due_deliveries()

            self.assertEqual(retried, [delivery["id"]])
            self.assertEqual(storage.get_delivery_batch(delivery["id"])["status"], "succeeded")
            self.assertEqual(storage.get_pending_messages(-1001), [])

    async def test_forward_all_marks_only_successful_messages(self):
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
                    content="hello",
                    media_type=None,
                    raw={"update_id": 1},
                )
            )
            storage.save_message(
                TelegramMessage(
                    chat_id=-1002,
                    chat_title="Other Group",
                    message_id=2,
                    sender_name="Bob",
                    message_time="2024-06-01T00:01:00+00:00",
                    content="ignored",
                    media_type=None,
                    raw={"update_id": 2},
                )
            )
            config = AppConfig(
                telegram_bot_token="token",
                database_url=storage.database_url,
                timezone="Asia/Shanghai",
                forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={
                    -1001: GroupConfig(
                        chat_id=-1001,
                        name="TG Group",
                        webhook_url="https://example.test/one",
                    )
                },
            )
            wecom = FakeWeComClient()
            forwarder = Forwarder(config=config, storage=storage, wecom_client=wecom)

            with self.assertLogs("app.scheduler", level="WARNING"):
                result = await forwarder.forward_all(trigger="manual")

            self.assertEqual(len(result.groups), 1)
            self.assertTrue(result.groups[0].success)
            self.assertEqual(storage.get_pending_messages(-1001), [])
            self.assertEqual(len(storage.get_pending_messages(-1002)), 1)
            self.assertEqual(result.unconfigured_pending[0]["chat_id"], -1002)
            self.assertIn("hello", wecom.sent[0][1])

    async def test_failed_send_does_not_mark_forwarded(self):
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
                    content="hello",
                    media_type=None,
                    raw={"update_id": 1},
                )
            )
            config = AppConfig(
                telegram_bot_token="token",
                database_url=storage.database_url,
                timezone="Asia/Shanghai",
                forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={
                    -1001: GroupConfig(
                        chat_id=-1001,
                        name="TG Group",
                        webhook_url="https://example.test/one",
                    )
                },
            )
            forwarder = Forwarder(
                config=config,
                storage=storage,
                wecom_client=FakeWeComClient(fail=True),
            )

            with self.assertLogs("app.scheduler", level="ERROR"):
                result = await forwarder.forward_all(trigger="manual")

            self.assertFalse(result.groups[0].success)
            self.assertEqual(len(storage.get_pending_messages(-1001)), 1)

    async def test_missing_webhook_generates_screenshot_and_marks_forwarded(self):
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
                    content="hello",
                    media_type=None,
                    raw={"update_id": 1},
                )
            )
            config = AppConfig(
                telegram_bot_token="",
                database_url=storage.database_url,
                timezone="Asia/Shanghai",
                forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={
                    -1001: GroupConfig(
                        chat_id=-1001,
                        name="TG Group",
                        webhook_url="",
                    )
                },
            )
            image_exporter = FakeImageExporter()
            forwarder = Forwarder(
                config=config,
                storage=storage,
                wecom_client=FakeWeComClient(),
                image_exporter=image_exporter,
            )

            result = await forwarder.forward_all(trigger="manual")

            self.assertTrue(result.groups[0].success)
            self.assertEqual(result.groups[0].delivery, "screenshot")
            self.assertEqual(result.groups[0].screenshot_paths, ["/tmp/-1001.png"])
            self.assertNotIn("screenshot_paths", result.as_dict()["groups"][0])
            self.assertEqual(len(storage.get_pending_messages(-1001)), 0)
            self.assertIn("hello", image_exporter.exported[0][2])
            self.assertEqual(len(image_exporter.exported[0][3]), 1)

    async def test_screenshot_disabled_without_webhook_does_not_mark_forwarded(self):
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
                    content="hello",
                    media_type=None,
                    raw={"update_id": 1},
                )
            )
            config = AppConfig(
                telegram_bot_token="",
                database_url=storage.database_url,
                timezone="Asia/Shanghai",
                forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={
                    -1001: GroupConfig(
                        chat_id=-1001,
                        name="TG Group",
                        webhook_url="",
                        screenshot_enabled=False,
                    )
                },
            )
            forwarder = Forwarder(
                config=config,
                storage=storage,
                wecom_client=FakeWeComClient(),
                image_exporter=FakeImageExporter(),
            )

            result = await forwarder.forward_all(trigger="manual")

            self.assertFalse(result.groups[0].success)
            self.assertEqual(result.groups[0].delivery, "none")
            self.assertEqual(len(storage.get_pending_messages(-1001)), 1)

    async def test_crawl_public_sources_runs_without_forwarding_pending_messages(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            config = AppConfig(
                telegram_bot_token="",
                database_url=storage.database_url,
                timezone="Asia/Shanghai",
                forward_cron="0 * * * *",
                groups_config_path="config/groups.yaml",
                groups={
                    -1001: GroupConfig(
                        chat_id=-1001,
                        name="Public Group",
                        source="https://t.me/example",
                        source_type="telegram_public",
                        webhook_url="",
                    )
                },
            )
            message = TelegramMessage(
                chat_id=-1001,
                chat_title="Public Group",
                message_id=10,
                sender_name="Public Group",
                message_time="2024-06-01T00:00:00+00:00",
                content="new public post",
                media_type=None,
                raw={"source": "example"},
            )

            class SavingPublicCrawler:
                def crawl_group(self, group):
                    saved = 1 if storage.save_message(message) else 0
                    return type(
                        "CrawlResult",
                        (),
                        {
                            "source": group.source,
                            "chat_id": group.chat_id,
                            "fetched": 1,
                            "saved": saved,
                            "error": None,
                            "as_dict": lambda self: {
                                "source": self.source,
                                "chat_id": self.chat_id,
                                "fetched": self.fetched,
                                "saved": self.saved,
                                "error": self.error,
                            },
                        },
                    )()

            image_exporter = FakeImageExporter()
            forwarder = Forwarder(
                config=config,
                storage=storage,
                wecom_client=FakeWeComClient(),
                public_crawler=SavingPublicCrawler(),
                image_exporter=image_exporter,
            )

            result = await forwarder.crawl_public_sources()

            self.assertEqual(result[0]["saved"], 1)
            self.assertEqual(len(storage.get_pending_messages(-1001)), 1)
            self.assertEqual(image_exporter.exported, [])

    def test_scheduler_registers_immediate_crawl_job_for_public_sources(self):
        try:
            import apscheduler  # noqa: F401
        except ModuleNotFoundError:
            self.skipTest("apscheduler is not installed in this local Python environment")

        config = AppConfig(
            telegram_bot_token="",
            database_url="sqlite:///:memory:",
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            crawl_interval_seconds=300,
            groups_config_path="config/groups.yaml",
            groups={
                -1001: GroupConfig(
                    chat_id=-1001,
                    name="Public Group",
                    source="https://t.me/example",
                    source_type="telegram_public",
                    webhook_url="",
                )
            },
        )
        storage = SQLiteStorage(":memory:")
        storage.init_db()
        forwarder = Forwarder(config=config, storage=storage, wecom_client=FakeWeComClient())
        scheduler = create_background_scheduler(config, forwarder)

        try:
            job_ids = {job.id for job in scheduler.get_jobs()}
            self.assertIn("crawl_public_telegram_sources", job_ids)
            self.assertIn("forward_telegram_to_wecom", job_ids)
            self.assertIn("retry_due_deliveries", job_ids)
            self.assertIsNotNone(scheduler.get_job("crawl_public_telegram_sources").next_run_time)
        finally:
            if scheduler.running:
                scheduler.shutdown(wait=False)

    def test_build_summary_contains_group_range_and_messages(self):
        group = GroupConfig(chat_id=-1001, name="TG Group", webhook_url="url")
        messages = [
            type(
                "Message",
                (),
                {
                    "message_time": "2024-06-01T00:00:00+00:00",
                    "sender_name": "Alice",
                    "content": "hello",
                    "media_type": None,
                },
            )()
        ]

        summary = build_summary(group, messages, "Asia/Shanghai")

        self.assertIn("Telegram 群消息汇总", summary)
        self.assertIn("TG Group", summary)
        self.assertIn("Alice", summary)
        self.assertIn("hello", summary)


if __name__ == "__main__":
    unittest.main()
