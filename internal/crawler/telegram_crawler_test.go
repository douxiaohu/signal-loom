package crawler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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

	raw := model.ParseRawMessage(posts[1].RawJSON)
	if len(raw.MediaURLs) != 1 || raw.MediaURLs[0] != "https://cdn1.telesco.pe/file/example.jpg" {
		t.Errorf("unexpected MediaURLs: %v", raw.MediaURLs)
	}
	if raw.SourceURL != "https://t.me/zaihuapd/124" {
		t.Errorf("source_url = %q", raw.SourceURL)
	}
}

func post(inner string, id int) string {
	return `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="chan/` +
		itoa(id) + `">` + inner + `<time datetime="2026-10-28T00:00:00+00:00"></time></div></div>`
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestParseMediaVariants(t *testing.T) {
	t.Run("video keeps the poster and is typed as video", func(t *testing.T) {
		posts, _ := ParsePublicPosts(post(`
			<div class="tgme_widget_message_video_player js-message_video_player">
				<i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn5.telesco.pe/file/poster.jpg')"></i>
				<video src="https://cdn5.telesco.pe/file/clip.mp4" class="tgme_widget_message_video js-message_video"></video>
			</div>
			<div class="tgme_widget_message_text js-message_text">clip</div>`, 1), "chan", -1, "Chan")
		if len(posts) != 1 {
			t.Fatalf("got %d posts", len(posts))
		}
		if posts[0].MediaType == nil || *posts[0].MediaType != "video" || posts[0].Content != "[video] clip" {
			t.Fatalf("media type / content = %v / %q", posts[0].MediaType, posts[0].Content)
		}
		items := model.ParseRawMessage(posts[0].RawJSON).Items(posts[0].MediaType)
		if len(items) != 1 || items[0].Kind != "image" || items[0].Role != "poster" ||
			items[0].URL != "https://cdn5.telesco.pe/file/poster.jpg" {
			t.Fatalf("items = %+v", items)
		}
	})

	t.Run("documents are typed even without a preview", func(t *testing.T) {
		posts, _ := ParsePublicPosts(post(`<div class="tgme_widget_message_document_wrap"><div class="tgme_widget_message_document_title">a.pdf</div></div>`, 2), "chan", -1, "Chan")
		if len(posts) != 1 || posts[0].MediaType == nil || *posts[0].MediaType != "document" || posts[0].Content != "[document]" {
			t.Fatalf("posts = %+v", posts)
		}
	})

	t.Run("link previews and unsupported stubs contribute no media", func(t *testing.T) {
		posts, _ := ParsePublicPosts(post(`
			<div class="tgme_widget_message_text js-message_text">see this</div>
			<div class="tgme_widget_message_link_preview">
				<a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn1.telesco.pe/file/preview.jpg')"></a>
			</div>`, 3), "chan", -1, "Chan")
		if len(posts) != 1 || posts[0].MediaType != nil || strings.Contains(posts[0].RawJSON, "preview.jpg") {
			t.Fatalf("link preview media leaked into the post: %+v", posts)
		}
		posts, _ = ParsePublicPosts(post(`
			<div class="message_media_not_supported_wrap"><a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn1.telesco.pe/file/x.jpg')"></a></div>
			<div class="tgme_widget_message_text js-message_text">text only</div>`, 4), "chan", -1, "Chan")
		if len(posts) != 1 || posts[0].MediaType != nil {
			t.Fatalf("unsupported-media stub produced media: %+v", posts)
		}
	})

	t.Run("emoji sprites and non-https URLs are not media", func(t *testing.T) {
		posts, _ := ParsePublicPosts(post(`
			<a class="tgme_widget_message_photo_wrap" style="background-image:url('//telegram.org/img/emoji/40/1F600.png')"></a>
			<a class="tgme_widget_message_photo_wrap" style="background-image:url('http://cdn1.telesco.pe/file/insecure.jpg')"></a>
			<div class="tgme_widget_message_text js-message_text">hi</div>`, 5), "chan", -1, "Chan")
		if len(posts) != 1 || strings.Contains(posts[0].RawJSON, "emoji") || strings.Contains(posts[0].RawJSON, "insecure") {
			t.Fatalf("unwanted media kept: %+v", posts)
		}
	})

	t.Run("scheme-relative URLs are upgraded and duplicates removed", func(t *testing.T) {
		posts, _ := ParsePublicPosts(post(`
			<a class="tgme_widget_message_photo_wrap" style="background-image:url('//cdn1.telesco.pe/file/a.jpg')"></a>
			<a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn1.telesco.pe/file/a.jpg')"></a>
			<a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn1.telesco.pe/file/b.jpg')"></a>`, 6), "chan", -1, "Chan")
		if len(posts) != 1 {
			t.Fatal("expected one post")
		}
		raw := model.ParseRawMessage(posts[0].RawJSON)
		if len(raw.MediaURLs) != 2 || raw.MediaURLs[0] != "https://cdn1.telesco.pe/file/a.jpg" {
			t.Fatalf("media urls = %v", raw.MediaURLs)
		}
	})
}

func TestParseSkipsUnusablePosts(t *testing.T) {
	html := post(`<div class="tgme_widget_message_text js-message_text">   </div>`, 10) + // empty
		`<div class="tgme_widget_message" data-post="chan/notanumber"><div class="tgme_widget_message_text js-message_text">x</div></div>` +
		`<div class="tgme_widget_message" data-post="a/b/c"><div class="tgme_widget_message_text js-message_text">x</div></div>` +
		`<div class="tgme_widget_message" data-post="chan/0"><div class="tgme_widget_message_text js-message_text">zero id</div></div>` +
		post(`<div class="tgme_widget_message_text js-message_text">kept</div>`, 11)
	posts, err := ParsePublicPosts(html, "chan", -1, "Chan")
	if err != nil || len(posts) != 1 || posts[0].MessageID != 11 {
		t.Fatalf("posts = %+v, err = %v", posts, err)
	}
}

func TestParseProducesInertPlainText(t *testing.T) {
	posts, _ := ParsePublicPosts(post(`<div class="tgme_widget_message_text js-message_text">
		<b>bold</b>   &lt;img src=x onerror=alert(1)&gt;<br><br>
		<a href="javascript:alert(1)">link text</a>   spaced   out
	</div>`, 20), "chan", -1, "Chan")
	if len(posts) != 1 {
		t.Fatal("expected one post")
	}
	got := posts[0].Content
	if strings.Contains(got, "<b>") || strings.Contains(got, "javascript:") {
		t.Fatalf("markup / attribute values leaked into the stored text: %q", got)
	}
	if want := "bold <img src=x onerror=alert(1)>\nlink text spaced out"; got != want {
		t.Fatalf("content = %q\nwant      %q", got, want)
	}
}

func TestParseHostileSourceURLFallsBackToUsername(t *testing.T) {
	html := `<div class="tgme_widget_message" data-post="evil.example/5"><div class="tgme_widget_message_text js-message_text">x</div></div>`
	posts, _ := ParsePublicPosts(html, "chan", -1, "Chan")
	if len(posts) != 1 {
		t.Fatal("expected one post")
	}
	if got := model.ParseRawMessage(posts[0].RawJSON).SourceURL; got != "https://t.me/chan/5" {
		t.Fatalf("source_url = %q", got)
	}
}

func testCrawler(srv *httptest.Server) *TelegramCrawler {
	return &TelegramCrawler{client: srv.Client(), timeout: 5 * time.Second, templates: []string{srv.URL + "/s/%s"}}
}

func TestCrawlChannelFetchesAndParses(t *testing.T) {
	var gotPath, gotUA atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath.Store(r.URL.Path)
		gotUA.Store(r.UserAgent())
		_, _ = w.Write([]byte(post(`<div class="tgme_widget_message_text js-message_text">fresh</div>`, 7)))
	}))
	defer srv.Close()

	posts, err := testCrawler(srv).CrawlChannel(context.Background(), "https://t.me/s/chan", -42, "Chan")
	if err != nil || len(posts) != 1 || posts[0].Content != "fresh" || posts[0].ChatID != -42 {
		t.Fatalf("posts = %+v, err = %v", posts, err)
	}
	if gotPath.Load() != "/s/chan" || !strings.Contains(gotUA.Load().(string), "TelegramRadar") {
		t.Fatalf("request path/UA = %v / %v", gotPath.Load(), gotUA.Load())
	}
}

func TestCrawlChannelRefusesInvalidUsernames(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer srv.Close()
	c := testCrawler(srv)
	for _, bad := range []string{"https://evil.example/x", "chan/../../admin", "a b", "", "chan?x=1", "https://t.me/chan%2f..%2fx"} {
		if _, err := c.CrawlChannel(context.Background(), bad, 1, "x"); err == nil {
			t.Errorf("CrawlChannel(%q) should fail", bad)
		}
	}
	if hits.Load() != 0 {
		t.Fatal("a request was made for an invalid username")
	}
}

func TestCrawlChannelFallsBackToSecondHostAndReportsErrors(t *testing.T) {
	var calls atomic.Int32
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "nope", http.StatusBadGateway)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(post(`<div class="tgme_widget_message_text js-message_text">ok</div>`, 1)))
	}))
	defer good.Close()

	c := &TelegramCrawler{client: good.Client(), templates: []string{bad.URL + "/s/%s", good.URL + "/s/%s"}}
	posts, err := c.CrawlChannel(context.Background(), "chan", 1, "x")
	if err != nil || len(posts) != 1 || calls.Load() != 2 {
		t.Fatalf("fallback failed: posts=%v err=%v calls=%d", posts, err, calls.Load())
	}

	c = &TelegramCrawler{client: bad.Client(), templates: []string{bad.URL + "/s/%s"}}
	if _, err := c.CrawlChannel(context.Background(), "chan", 1, "x"); err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("expected an error naming the status, got %v", err)
	}
}

func TestCrawlChannelBoundsPageSizeAndHonoursCancellation(t *testing.T) {
	huge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		chunk := []byte(strings.Repeat("a", 1<<20))
		for i := 0; i < maxPageBytes/(1<<20)+2; i++ {
			_, _ = w.Write(chunk)
		}
	}))
	defer huge.Close()
	if _, err := testCrawler(huge).CrawlChannel(context.Background(), "chan", 1, "x"); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized page: err = %v", err)
	}

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer slow.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := testCrawler(slow).CrawlChannel(ctx, "chan", 1, "x"); err == nil {
		t.Fatal("expected an error")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("cancellation did not interrupt the request")
	}
}
