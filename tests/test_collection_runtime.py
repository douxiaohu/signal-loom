import tempfile
import unittest
from pathlib import Path

from app.config import AppConfig
from app.public_telegram import CrawlResult
from app.scheduler import SourceCollector, create_collection_scheduler
from app.storage import SQLiteStorage


class _Crawler:
    def __init__(self):
        self.chat_ids = []

    def crawl_source(self, source):
        self.chat_ids.append(source.chat_id)
        return CrawlResult(
            source=source.source_url,
            chat_id=source.chat_id,
            fetched=4,
            saved=2,
        )


class CollectionRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = SQLiteStorage(f"sqlite:///{Path(self.tmp.name) / 'app.db'}")
        self.storage.init_db()
        self.crawler = _Crawler()
        self.collector = SourceCollector(storage=self.storage, crawler=self.crawler)
        self.config = AppConfig(
            telegram_bot_token="",
            database_url=f"sqlite:///{Path(self.tmp.name) / 'app.db'}",
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            groups_config_path="config/groups.yaml",
            groups={},
            crawl_interval_seconds=300,
            admin_api_key="long-enough-admin-key",
            session_secret="x" * 32,
            app_env="test",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_scheduler_registers_only_collection_job(self):
        scheduler = create_collection_scheduler(self.config, self.collector)

        self.assertEqual([job.id for job in scheduler.get_jobs()], ["crawl_public_sources"])

    def test_collector_reads_enabled_sources_each_run(self):
        source = self.storage.create_source(name="One", source_url="https://t.me/one")

        first = self.collector.crawl_public_sources_sync()
        self.storage.update_source(source.chat_id, enabled=False)
        second = self.collector.crawl_public_sources_sync()

        self.assertEqual(self.crawler.chat_ids, [source.chat_id])
        self.assertEqual(first[0]["fetched"], 4)
        self.assertEqual(second, [])
        health = self.storage.get_source_health(source.chat_id, stale_after_seconds=900)
        self.assertEqual(health["health_status"], "healthy")

    def test_manual_crawl_rejects_disabled_source(self):
        source = self.storage.create_source(name="One", source_url="https://t.me/one")
        self.storage.update_source(source.chat_id, enabled=False)

        with self.assertRaises(KeyError):
            self.collector.crawl_source_sync(source.chat_id)


if __name__ == "__main__":
    unittest.main()
