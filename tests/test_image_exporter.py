import tempfile
import unittest
import importlib.util
from pathlib import Path

from app.image_exporter import (
    SummaryImageExporter,
    clean_render_text,
    safe_filename,
    sort_messages_newest_first,
    split_summary_pages,
)


class ImageExporterTests(unittest.TestCase):
    def test_clean_render_text_removes_emoji_without_touching_chinese(self):
        self.assertEqual(clean_render_text("🔥在花频道 ✅ □\u200b Kimi"), "在花频道   Kimi")

    def test_split_summary_pages_keeps_non_empty_pages(self):
        pages = split_summary_pages("a\n\n" + "b" * 20, max_chars=10)

        self.assertEqual(pages[0], "a")
        self.assertEqual(pages[1], "b" * 20)

    def test_safe_filename(self):
        self.assertEqual(safe_filename("在花频道/zaihuapd"), "zaihuapd")

    def test_sort_messages_newest_first(self):
        older = type("Message", (), {"message_time": "2024-06-01T00:00:00+00:00", "message_id": 1})()
        newer = type("Message", (), {"message_time": "2024-06-01T01:00:00+00:00", "message_id": 2})()

        self.assertEqual(sort_messages_newest_first([older, newer]), [newer, older])

    @unittest.skipIf(importlib.util.find_spec("PIL") is None, "Pillow is not installed")
    def test_export_creates_latest_alias_for_message_cards(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            message = type(
                "Message",
                (),
                {
                    "message_time": "2024-06-01T00:00:00+00:00",
                    "message_id": 1,
                    "sender_name": "Alice",
                    "content": "hello",
                    "media_type": None,
                    "raw_json": "",
                },
            )()
            result = SummaryImageExporter(tmpdir, width=600, max_height=800, font_size=20).export(
                group_name="zaihuapd",
                chat_id=-1,
                summary="summary",
                messages=[message],
                timezone_name="Asia/Shanghai",
            )

            latest_path = Path(tmpdir) / "latest_zaihuapd_-1.png"
            self.assertEqual(result.paths[0], str(latest_path))
            self.assertTrue(latest_path.exists())


if __name__ == "__main__":
    unittest.main()
