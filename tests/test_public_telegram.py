import unittest
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib import error

from app.public_telegram import PublicTelegramCrawler, fetch_public_posts, parse_public_posts
from app.source_utils import normalize_telegram_public_source, public_source_chat_id
from app.storage import SQLiteStorage
from app.telegram_client import TelegramMessage


class FakeMediaCache:
    def __init__(self):
        self.requests = []

    def get(self, message, index):
        self.requests.append((message.id, index))
        return None


class PublicTelegramTests(unittest.TestCase):
    def test_normalizes_public_source(self):
        self.assertEqual(normalize_telegram_public_source("https://t.me/zaihuapd"), "zaihuapd")
        self.assertEqual(normalize_telegram_public_source("https://t.me/s/zaihuapd"), "zaihuapd")
        self.assertEqual(normalize_telegram_public_source("@zaihuapd"), "zaihuapd")
        self.assertLess(public_source_chat_id("zaihuapd"), 0)

    def test_falls_back_to_telegram_me_when_t_me_dns_fails(self):
        html = b"""
        <div class="tgme_widget_message js-widget_message" data-post="zaihuapd/501">
          <div class="tgme_widget_message_text js-message_text">fallback works</div>
          <time datetime="2026-07-14T02:00:00+00:00"></time>
        </div>
        """
        fallback_response = MagicMock()
        fallback_response.__enter__.return_value.read.return_value = html

        with patch(
            "app.public_telegram.request.urlopen",
            side_effect=[error.URLError("Name or service not known"), fallback_response],
        ) as urlopen:
            posts = fetch_public_posts("https://t.me/zaihuapd", -1, "zaihuapd")

        self.assertEqual([call.args[0].full_url for call in urlopen.call_args_list], [
            "https://t.me/s/zaihuapd",
            "https://telegram.me/s/zaihuapd",
        ])
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0].content, "fallback works")

    def test_parses_public_channel_posts(self):
        html = """
        <i class="tgme_page_photo_image"><img src="https://cdn1.telesco.pe/file/channel-avatar.jpg"></i>
        <div class="tgme_widget_message_wrap">
          <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="zaihuapd/123">
            <div class="tgme_widget_message_text js-message_text">hello<br>world</div>
            <a class="tgme_widget_message_date"><time datetime="2024-06-01T00:00:00+00:00"></time></a>
          </div>
        </div>
        <div class="tgme_widget_message_wrap">
          <div class="tgme_widget_message js-widget_message" data-post="zaihuapd/124">
            <a class="tgme_widget_message_photo_wrap" style="width:800px;background-image:url('https://cdn1.telesco.pe/file/example.jpg')"></a>
            <div class="tgme_widget_message_text js-message_text">caption</div>
            <time datetime="2024-06-01T00:01:00+00:00"></time>
          </div>
        </div>
        """

        posts = parse_public_posts(html, username="zaihuapd", chat_id=-1, chat_title="zaihuapd")

        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0].message_id, 123)
        self.assertEqual(posts[0].content, "hello\nworld")
        self.assertEqual(posts[1].media_type, "photo")
        self.assertEqual(posts[1].content, "[photo] caption")
        self.assertEqual(posts[1].raw["media_urls"], ["https://cdn1.telesco.pe/file/example.jpg"])
        self.assertEqual(
            posts[1].raw["media_items"],
            [{"url": "https://cdn1.telesco.pe/file/example.jpg", "kind": "image", "role": "media"}],
        )

    def test_parses_video_poster_and_real_video_items(self):
        html = """
        <div class="tgme_widget_message_wrap">
          <div class="tgme_widget_message js-widget_message" data-post="zaihuapd/300">
            <a class="tgme_widget_message_video_player js-message_video_player">
              <i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn5.telesco.pe/file/poster.jpg')"></i>
              <video class="tgme_widget_message_video_player" src="https://cdn5.telesco.pe/file/video.mp4"></video>
            </a>
            <div class="tgme_widget_message_text js-message_text">clip</div>
            <time datetime="2024-06-01T00:03:00+00:00"></time>
          </div>
        </div>
        """

        posts = parse_public_posts(html, username="zaihuapd", chat_id=-1, chat_title="zaihuapd")

        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0].media_type, "video")
        self.assertEqual(
            posts[0].raw["media_items"],
            [
                {"url": "https://cdn5.telesco.pe/file/poster.jpg", "kind": "image", "role": "poster"},
                {"url": "https://cdn5.telesco.pe/file/video.mp4", "kind": "video", "role": "media"},
            ],
        )

    def test_ignores_reply_preview_and_unsupported_media_placeholder(self):
        html = """
        <div class="tgme_widget_message_wrap">
          <div class="tgme_widget_message js-widget_message" data-post="zaihuapd/200">
            <div class="tgme_widget_message_text js-message_reply_text">old preview only</div>
            <div class="media_supported_cont">
              <div class="tgme_widget_message_text js-message_text" dir="auto">
                <b>real title</b><br/><br/>real body
              </div>
            </div>
            <div class="media_not_supported_cont">
              <div class="message_media_not_supported_wrap">
                <img src="https://cdn1.telesco.pe/file/not-content.jpg">
              </div>
            </div>
            <time datetime="2024-06-01T00:02:00+00:00"></time>
          </div>
        </div>
        """

        posts = parse_public_posts(html, username="zaihuapd", chat_id=-1, chat_title="zaihuapd")

        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0].content, "real title\nreal body")
        self.assertIsNone(posts[0].media_type)
        self.assertEqual(posts[0].raw["media_urls"], [])

    def test_skips_empty_poll_or_unsupported_public_posts(self):
        html = """
        <div class="tgme_widget_message_wrap">
          <div class="tgme_widget_message js-widget_message" data-post="zaihuapd/400">
            <div class="tgme_widget_message_poll">
              <div class="tgme_widget_message_poll_question">Which one?</div>
            </div>
            <time datetime="2024-06-01T00:04:00+00:00"></time>
          </div>
        </div>
        """

        posts = parse_public_posts(html, username="zaihuapd", chat_id=-1, chat_title="zaihuapd")

        self.assertEqual(posts, [])

    def test_warms_media_cache_for_saved_public_media(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = SQLiteStorage(f"sqlite:///{Path(tmpdir) / 'app.db'}")
            storage.init_db()
            message = TelegramMessage(
                chat_id=-1,
                chat_title="zaihuapd",
                message_id=123,
                sender_name="zaihuapd",
                message_time="2024-06-01T00:00:00+00:00",
                content="[photo] caption",
                media_type="photo",
                raw={"media_urls": ["https://cdn1.telesco.pe/file/example.jpg"]},
            )
            storage.save_message(message)
            media_cache = FakeMediaCache()
            crawler = PublicTelegramCrawler(storage, media_cache=media_cache)

            crawler._warm_media_cache(message)

            stored = storage.get_message_by_telegram_id(-1, 123)
            self.assertEqual(media_cache.requests, [(stored.id, 0)])


if __name__ == "__main__":
    unittest.main()
