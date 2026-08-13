import tempfile
import unittest
from pathlib import Path

from app.config import GroupConfig
from app.source_service import seed_sources_from_groups
from app.source_utils import canonical_telegram_public_url, public_source_chat_id
from app.storage import SQLiteStorage


class SourceStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = SQLiteStorage(f"sqlite:///{Path(self.tmp.name) / 'app.db'}")
        self.storage.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def test_seed_sources_is_idempotent_and_existing_sources_are_public(self):
        groups = [
            GroupConfig(
                chat_id=public_source_chat_id("one"),
                name="One",
                source="https://t.me/one",
                source_type="telegram_public",
            )
        ]

        self.assertEqual(seed_sources_from_groups(self.storage, groups), 1)
        self.assertEqual(seed_sources_from_groups(self.storage, groups), 0)

        sources = self.storage.list_sources()
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0].source_url, "https://t.me/one")
        self.assertTrue(sources[0].enabled)
        self.assertTrue(sources[0].public_visible)

    def test_new_source_defaults_private_and_source_url_is_immutable(self):
        source = self.storage.create_source(name="Two", source_url="https://t.me/s/two")

        self.assertEqual(source.chat_id, public_source_chat_id("two"))
        self.assertEqual(source.source_url, "https://t.me/two")
        self.assertFalse(source.public_visible)
        with self.assertRaises(TypeError):
            self.storage.update_source(source.chat_id, source_url="https://t.me/other")

    def test_source_filters_and_mutable_fields(self):
        public = self.storage.create_source(
            name="Public",
            source_url="https://t.me/public_source",
            public_visible=True,
        )
        private = self.storage.create_source(name="Private", source_url="@private_source")
        self.storage.update_source(private.chat_id, enabled=False)

        self.assertEqual([item.chat_id for item in self.storage.list_sources(public_only=True)], [public.chat_id])
        self.assertEqual([item.chat_id for item in self.storage.list_sources(enabled_only=True)], [public.chat_id])

        updated = self.storage.update_source(
            public.chat_id,
            name="Renamed",
            enabled=False,
            public_visible=False,
        )
        self.assertEqual(updated.name, "Renamed")
        self.assertFalse(updated.enabled)
        self.assertFalse(updated.public_visible)

    def test_seed_includes_telegram_bot_groups(self):
        groups = [
            GroupConfig(
                chat_id=-1001234567890,
                name="Ops",
                source_type="telegram_bot",
            )
        ]
        self.assertEqual(seed_sources_from_groups(self.storage, groups), 1)
        source = self.storage.get_source(-1001234567890)
        self.assertIsNotNone(source)
        self.assertEqual(source.adapter, "telegram_bot")
        self.assertEqual(source.locator, "-1001234567890")
        self.assertFalse(source.public_visible)

    def test_rejects_non_telegram_public_source(self):
        for value in ("", "https://example.com/channel", "https://t.me/bad-name", "../private"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    canonical_telegram_public_url(value)


if __name__ == "__main__":
    unittest.main()
