import unittest

from app.wecom_client import WeComClient, WeComSendError, split_text


class WeComClientTests(unittest.TestCase):
    def test_split_text_keeps_chunks_under_limit(self):
        chunks = split_text("a" * 5 + "\n" + "b" * 5 + "\n" + "c" * 5, max_chars=8)

        self.assertTrue(all(len(chunk) <= 8 for chunk in chunks))
        self.assertGreater(len(chunks), 1)

    def test_send_text_posts_wecom_payloads(self):
        calls = []

        def transport(url, payload, timeout):
            calls.append((url, payload, timeout))
            return {"errcode": 0, "errmsg": "ok"}

        client = WeComClient(max_text_chars=5, transport=transport, timeout=3)
        result = client.send_text("https://example.test/webhook", "hello world")

        self.assertEqual(result.chunks, 3)
        self.assertEqual(calls[0][1]["msgtype"], "text")
        self.assertEqual(calls[0][1]["text"]["content"], "hello")

    def test_send_text_raises_on_wecom_error(self):
        def transport(url, payload, timeout):
            return {"errcode": 93000, "errmsg": "invalid webhook"}

        client = WeComClient(transport=transport)

        with self.assertRaises(WeComSendError):
            client.send_text("https://example.test/webhook", "hello")

    def test_chunk_failure_reports_completed_and_total_chunks(self):
        calls = 0

        def transport(url, payload, timeout):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise WeComSendError("timeout")
            return {"errcode": 0, "errmsg": "ok"}

        client = WeComClient(max_text_chars=5, transport=transport)
        with self.assertRaises(WeComSendError) as caught:
            client.send_text("https://example.test/webhook", "hello world")

        self.assertEqual(caught.exception.completed_chunks, 1)
        self.assertEqual(caught.exception.total_chunks, 3)


if __name__ == "__main__":
    unittest.main()
