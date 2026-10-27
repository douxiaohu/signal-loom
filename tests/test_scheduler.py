import tempfile
import unittest
from pathlib import Path

from app.config import AppConfig, GroupConfig
from app.public_telegram import CrawlResult
from app.scheduler import SourceCollector, create_collection_scheduler, sanitize_error_text
from app.storage import SQLiteStorage


class _Crawler:
    def __init__(self, result):
        self.result = result
        self.sources = []

    def crawl_source(self, source):
        self.sources.append(source.chat_id)
        return self.result


class SourceCollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = SQLiteStorage(f"sqlite:///{Path(self.tmp.name) / 'app.db'}")
        self.storage.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def test_sanitizes_paths_but_keeps_urls(self):
        text = sanitize_error_text("cannot read /app/private/crawler.html from https://t.me/example/tmp/x")
        self.assertNotIn("/app/private/crawler.html", text)
        self.assertIn("https://t.me/example/tmp/x", text)

    def test_crawls_enabled_public_sources_and_skips_bot_rows(self):
        public = self.storage.create_source(name="Public", source_url="https://t.me/example")
        self.storage.create_source(name="Bot", source_url="-1001234567890", adapter="telegram_bot")
        crawler = _Crawler(
            CrawlResult(source="https://t.me/example", chat_id=public.chat_id, fetched=4, saved=2)
        )
        collector = SourceCollector(storage=self.storage, crawler=crawler)
        results = collector.crawl_public_sources_sync()
        self.assertEqual(crawler.sources, [public.chat_id])
        self.assertEqual(results[0]["saved"], 2)
        health = self.storage.get_source_health(public.chat_id, stale_after_seconds=900)
        self.assertEqual(health["health_status"], "healthy")

    def test_collection_scheduler_registers_only_source_crawl(self):
        config = AppConfig(
            telegram_bot_token="",
            database_url=self.storage.database_url,
            timezone="Asia/Shanghai",
            forward_cron="0 * * * *",
            groups_config_path="config/groups.yaml",
            groups={-1: GroupConfig(chat_id=-1, name="x", source="https://t.me/x")},
            admin_api_key="long-enough-admin-key",
            session_secret="x" * 32,
            session_cookie_secure=False,
            app_env="test",
        )
        collector = SourceCollector(
            storage=self.storage,
            crawler=_Crawler(CrawlResult(source="", chat_id=0, fetched=0, saved=0)),
        )

        scheduler = create_collection_scheduler(config, collector)
        job_ids = {job.id for job in scheduler.get_jobs()}
        self.assertEqual({"crawl_public_sources"}, job_ids)
        self.assertNotIn("forward_telegram_to_wecom", job_ids)


if __name__ == "__main__":
    unittest.main()
