package crawler

import (
	"encoding/json"
	"testing"

	"telegram-radar/internal/model"
)

func TestParsePublicPosts(t *testing.T) {
	html := `
	<div class="tgme_widget_message_wrap">
		<div class="tgme_widget_message js-widget_message" data-post="zaihuapd/123">
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
	`

	posts, err := ParsePublicPosts(html, "zaihuapd", -1, "zaihuapd")
	if err != nil {
		t.Fatalf("ParsePublicPosts failed: %v", err)
	}

	if len(posts) != 2 {
		t.Fatalf("expected 2 posts, got %d", len(posts))
	}

	// 验证第一条纯文本消息
	if posts[0].MessageID != 123 {
		t.Errorf("expected MessageID 123, got %d", posts[0].MessageID)
	}
	if posts[0].Content != "hello\nworld" {
		t.Errorf("expected 'hello\\nworld', got %q", posts[0].Content)
	}

	// 验证第二条带图消息
	if posts[1].MessageID != 124 {
		t.Errorf("expected MessageID 124, got %d", posts[1].MessageID)
	}
	if posts[1].MediaType == nil || *posts[1].MediaType != "photo" {
		t.Errorf("expected media_type photo, got %v", posts[1].MediaType)
	}
	if posts[1].Content != "[photo] caption" {
		t.Errorf("expected '[photo] caption', got %q", posts[1].Content)
	}

	var raw model.RawMessageData
	_ = json.Unmarshal([]byte(posts[1].RawJSON), &raw)
	if len(raw.MediaURLs) != 1 || raw.MediaURLs[0] != "https://cdn1.telesco.pe/file/example.jpg" {
		t.Errorf("unexpected MediaURLs: %v", raw.MediaURLs)
	}
}
