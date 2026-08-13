import tempfile
import unittest
from pathlib import Path

from PIL import Image

from app.media_cache import (
    MediaCache,
    MediaURLRejectedError,
    media_cache_items_for_message,
    is_cacheable_media_url,
    media_cache_urls_for_message,
)
from app.storage import media_items_from_raw_json, media_urls_from_raw_json
from app.storage import StoredMessage


class MediaCacheTests(unittest.TestCase):
    def _message(self, *, media_type="photo", url="https://cdn1.telesco.pe/file/a.jpg"):
        return StoredMessage(
            id=99,
            chat_id=-1,
            chat_title="test",
            message_id=20,
            sender_name="test",
            message_time="2024-06-01T00:00:00+00:00",
            content="media",
            media_type=media_type,
            raw_json=f'{{"media_urls":["{url}"]}}',
            forwarded_at=None,
        )

    def test_thumbnail_preserves_aspect_ratio_and_limits_longest_edge(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cache = MediaCache(tmpdir)
            message = self._message()
            cache_base = cache._cache_base(message, 0, "https://cdn1.telesco.pe/file/a.jpg")
            cache_base.parent.mkdir(parents=True, exist_ok=True)
            original_path = Path(f"{cache_base}.jpg")
            Image.new("RGB", (2400, 800), color=(30, 80, 120)).save(original_path)

            original = cache.get(message, 0, variant="original")
            thumbnail = cache.get(message, 0, variant="thumbnail")

            with Image.open(original.path) as source, Image.open(thumbnail.path) as thumb:
                self.assertAlmostEqual(source.width / source.height, thumb.width / thumb.height, places=2)
                self.assertLessEqual(max(thumb.size), 1200)
                self.assertEqual(thumb.size, (1200, 400))
            self.assertEqual(thumbnail.media_type, "image/webp")
            self.assertNotEqual(original.path, thumbnail.path)

    def test_non_image_thumbnail_returns_original(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cache = MediaCache(tmpdir)
            url = "https://cdn1.telesco.pe/file/a.mp4"
            message = self._message(media_type="video", url=url)
            cache_base = cache._cache_base(message, 0, url)
            cache_base.parent.mkdir(parents=True, exist_ok=True)
            original_path = Path(f"{cache_base}.mp4")
            original_path.write_bytes(b"video")

            original = cache.get(message, 0, variant="original")
            thumbnail = cache.get(message, 0, variant="thumbnail")

            self.assertEqual(thumbnail, original)

    def test_allows_only_telegram_media_hosts(self):
        self.assertTrue(is_cacheable_media_url("https://cdn1.telesco.pe/file/a.jpg"))
        self.assertTrue(is_cacheable_media_url("https://telesco.pe/file/a.jpg"))
        self.assertFalse(is_cacheable_media_url("http://cdn1.telesco.pe/file/a.jpg"))
        self.assertFalse(is_cacheable_media_url("https://example.com/file/a.jpg"))
        self.assertFalse(is_cacheable_media_url("https://telesco.pe.example.com/file/a.jpg"))

    def test_rejects_non_telegram_url_before_fetching(self):
        message = StoredMessage(
            id=10,
            chat_id=-1,
            chat_title="test",
            message_id=20,
            sender_name="test",
            message_time="2024-06-01T00:00:00+00:00",
            content="[photo] test",
            media_type="photo",
            raw_json='{"media_urls":["https://example.com/a.jpg"]}',
            forwarded_at=None,
        )

        with self.assertRaises(MediaURLRejectedError):
            MediaCache("/tmp/media-cache-test").get(message, 0)

    def test_message_media_urls_use_cache_paths(self):
        message = StoredMessage(
            id=10,
            chat_id=-1,
            chat_title="test",
            message_id=20,
            sender_name="test",
            message_time="2024-06-01T00:00:00+00:00",
            content="[photo] test",
            media_type="photo",
            raw_json='{"media_urls":["https://cdn1.telesco.pe/file/a.jpg"]}',
            forwarded_at=None,
        )

        self.assertEqual(media_cache_urls_for_message(message), ["/api/media/10/0"])
        self.assertEqual(media_cache_items_for_message(message), [{"url": "/api/media/10/0", "kind": "image", "role": "media"}])
        self.assertEqual(
            media_cache_items_for_message(
                message,
                base_path="/api/public/media",
                variant="thumbnail",
                include_original=True,
            ),
            [{
                "url": "/api/public/media/10/0?variant=thumbnail",
                "original_url": "/api/public/media/10/0?variant=original",
                "kind": "image",
                "role": "media",
            }],
        )
        self.assertEqual(media_urls_from_raw_json(message.raw_json), ["https://cdn1.telesco.pe/file/a.jpg"])

    def test_video_without_real_file_uses_poster_item(self):
        message = StoredMessage(
            id=11,
            chat_id=-1,
            chat_title="test",
            message_id=21,
            sender_name="test",
            message_time="2024-06-01T00:00:00+00:00",
            content="[video] test",
            media_type="video",
            raw_json='{"media_urls":["https://cdn5.telesco.pe/file/poster.jpg"]}',
            forwarded_at=None,
        )

        self.assertEqual(media_cache_items_for_message(message), [{"url": "/api/media/11/0", "kind": "image", "role": "poster"}])
        self.assertEqual(
            media_items_from_raw_json(message.raw_json, message.media_type),
            [{"url": "https://cdn5.telesco.pe/file/poster.jpg", "kind": "image", "role": "poster"}],
        )

    def test_real_video_item_keeps_video_kind(self):
        message = StoredMessage(
            id=12,
            chat_id=-1,
            chat_title="test",
            message_id=22,
            sender_name="test",
            message_time="2024-06-01T00:00:00+00:00",
            content="[video] test",
            media_type="video",
            raw_json='{"media_items":[{"url":"https://cdn5.telesco.pe/file/video.mp4","kind":"video","role":"media"}]}',
            forwarded_at=None,
        )

        self.assertEqual(media_cache_items_for_message(message), [{"url": "/api/media/12/0", "kind": "video", "role": "media"}])


if __name__ == "__main__":
    unittest.main()
