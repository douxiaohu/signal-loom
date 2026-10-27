package config

import (
	"testing"
)

// TestPublicSourceChatID 验证生成的 ChatID 与 Python 原逻辑 100% 吻合
func TestPublicSourceChatID(t *testing.T) {
	// Python: zlib.crc32(b"tnews365") & 0x7FFFFFFF -> 91411552
	// 结果应为 -900091411552
	source := "https://t.me/s/tnews365"
	expected := int64(-900091411552)

	got := PublicSourceChatID(source)
	if got != expected {
		t.Errorf("PublicSourceChatID(%q) = %d; want %d", source, got, expected)
	}
}

func TestNormalizeTelegramPublicSource(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"https://t.me/s/channel_a", "channel_a"},
		{"https://t.me/channel_b", "channel_b"},
		{"@channel_c", "channel_c"},
		{"channel_d", "channel_d"},
	}

	for _, c := range cases {
		got := NormalizeTelegramPublicSource(c.input)
		if got != c.expected {
			t.Errorf("NormalizeTelegramPublicSource(%q) = %q; want %q", c.input, got, c.expected)
		}
	}
}
