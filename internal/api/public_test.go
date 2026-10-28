package api

import (
	"bytes"
	"fmt"
	"image/jpeg"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPublicEndpointsOnAnEmptyDatabase(t *testing.T) {
	h := newHarness(t)

	rec := h.do("GET", "/api/public/sources", nil)
	expectStatus(t, rec, 200)
	if got := items(t, rec); len(got) != 0 {
		t.Fatalf("sources = %v", got)
	}

	rec = h.do("GET", "/api/public/messages?query=nothing-matches-this", nil)
	expectStatus(t, rec, 200)
	body := decodeMap(t, rec)
	if list, ok := body["items"].([]any); !ok || len(list) != 0 {
		t.Fatalf("\"items\" must be [] (the UI calls .length on it), got %#v", body["items"])
	}
	if body["has_more"] != false || body["next_cursor"] != nil {
		t.Fatalf("paging fields: %v", body)
	}

	for _, method := range []string{"GET", "HEAD"} {
		rec = h.do(method, "/health", nil)
		expectStatus(t, rec, 200)
	}
}

func TestPublicListsAreCacheableWithETags(t *testing.T) {
	h := newHarness(t)
	src := h.addSource(-1, "Pub", true, true)
	h.addMessage(src.ChatID, 1, "hello", nil, "", "")

	first := h.do("GET", "/api/public/messages", nil)
	expectStatus(t, first, 200)
	etag := first.Header().Get("ETag")
	if etag == "" || first.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("ETag=%q Cache-Control=%q", etag, first.Header().Get("Cache-Control"))
	}
	for name, header := range map[string]string{
		"exact":    etag,
		"weak":     "W/" + etag,
		"list":     `"other", ` + etag,
		"wildcard": "*",
	} {
		rec := h.do("GET", "/api/public/messages", nil, withHeader("If-None-Match", header))
		if rec.Code != 304 || rec.Body.Len() != 0 {
			t.Errorf("%s validator: status %d, body %d bytes", name, rec.Code, rec.Body.Len())
		}
	}
	expectStatus(t, h.do("GET", "/api/public/messages", nil, withHeader("If-None-Match", `"stale"`)), 200)
}

func TestPublicFeedHidesPrivateAndDisabledSources(t *testing.T) {
	h := newHarness(t)
	pub := h.addSource(-1, "Pub", true, true)
	priv := h.addSource(-2, "Priv", true, false)
	off := h.addSource(-3, "Off", false, true)
	h.addMessage(pub.ChatID, 1, "visible post", nil, "", "")
	h.addMessage(priv.ChatID, 1, "PRIVATE post", nil, "", "")
	h.addMessage(off.ChatID, 1, "DISABLED post", nil, "", "")

	body := h.do("GET", "/api/public/messages?limit=100", nil).Body.String()
	if !strings.Contains(body, "visible post") || strings.Contains(body, "PRIVATE") || strings.Contains(body, "DISABLED") {
		t.Fatalf("public feed leaked hidden sources: %s", body)
	}
	// README visibility contract: a chat_id that is not public is a 404 (not an
	// empty page), and hidden, disabled and unknown sources are indistinguishable.
	for _, chat := range []int64{priv.ChatID, off.ChatID, -424242} {
		rec := h.do("GET", fmt.Sprintf("/api/public/messages?chat_id=%d", chat), nil)
		if rec.Code != 404 || detailOf(t, rec) != "Source not found" {
			t.Fatalf("chat_id=%d: %d %s, want 404 Source not found", chat, rec.Code, rec.Body.String())
		}
	}
	expectStatus(t, h.do("GET", fmt.Sprintf("/api/public/messages?chat_id=%d", pub.ChatID), nil), 200)
	expectStatus(t, h.do("GET", "/api/public/messages?chat_id=all", nil), 200)
	sources := h.do("GET", "/api/public/sources", nil).Body.String()
	if strings.Contains(sources, "priv") || strings.Contains(sources, "off") || !strings.Contains(sources, "pub") {
		t.Fatalf("source list: %s", sources)
	}
	// The public source list must not expose operational details.
	for _, secret := range []string{"last_error", "locator", "adapter", "enabled"} {
		if strings.Contains(sources, secret) {
			t.Errorf("public sources expose %q: %s", secret, sources)
		}
	}
}

func TestMessageFormatting(t *testing.T) {
	h := newHarness(t)
	src := h.addSource(-1, "Pub", true, true)
	text := h.addMessage(src.ChatID, 1, "plain text", nil, "", "")
	photo := h.addMessage(src.ChatID, 2, "[photo] pic", strp("photo"), h.mediaRaw("/img.png"), "")
	// Rows written by the old Python crawler only carry "media_urls".
	legacy := h.addMessage(src.ChatID, 3, "[photo] old", strp("photo"), `{"media_urls":["https://cdn1.telesco.pe/file/a.jpg"]}`, "")
	video := h.addMessage(src.ChatID, 4, "[video] clip", strp("video"), `{"media_urls":["https://cdn1.telesco.pe/file/poster.jpg"]}`, "")

	rec := h.do("GET", "/api/public/messages?limit=10", nil)
	expectStatus(t, rec, 200)
	byID := map[float64]map[string]any{}
	for _, it := range items(t, rec) {
		m := it.(map[string]any)
		byID[m["id"].(float64)] = m
	}

	tm := byID[float64(text)]
	if urls, ok := tm["media_urls"].([]any); !ok || len(urls) != 0 {
		t.Errorf("media_urls of a text post must be [], got %#v", tm["media_urls"])
	}
	if mi, ok := tm["media_items"].([]any); !ok || len(mi) != 0 {
		t.Errorf("media_items of a text post must be [], got %#v", tm["media_items"])
	}
	if tm["source_url"] != "https://t.me/chan/1" {
		t.Errorf("source_url = %v", tm["source_url"])
	}

	pm := byID[float64(photo)]
	wantURL := fmt.Sprintf("/api/public/media/%d/0?variant=thumbnail", photo)
	pItems := pm["media_items"].([]any)
	if len(pItems) != 1 || pItems[0].(map[string]any)["url"] != wantURL ||
		pItems[0].(map[string]any)["original_url"] != fmt.Sprintf("/api/public/media/%d/0?variant=original", photo) {
		t.Errorf("photo media_items = %v", pItems)
	}

	lm := byID[float64(legacy)]
	if li := lm["media_items"].([]any); len(li) != 1 || li[0].(map[string]any)["kind"] != "image" || li[0].(map[string]any)["role"] != "media" {
		t.Errorf("legacy row not expanded: %v", lm["media_items"])
	}
	vm := byID[float64(video)]
	if vi := vm["media_items"].([]any); len(vi) != 1 || vi[0].(map[string]any)["role"] != "poster" {
		t.Errorf("legacy video row should expose its poster: %v", vm["media_items"])
	}
	for _, leaked := range []string{"raw_json", "telesco.pe", "127.0.0.1"} {
		if strings.Contains(rec.Body.String(), leaked) {
			t.Errorf("response leaks upstream/internal data (%q)", leaked)
		}
	}
}

func TestPublicFeedParameterValidation(t *testing.T) {
	h := newHarness(t)
	src := h.addSource(-1, "Pub", true, true)
	for i := int64(1); i <= 130; i++ {
		h.addMessage(src.ChatID, i, fmt.Sprintf("post %d", i), nil, "", fmt.Sprintf("2026-10-28T%02d:%02d:00+00:00", i/60, i%60))
	}

	bad := map[string]string{
		"limit not a number": "limit=abc",
		"chat_id not a num":  "chat_id=abc",
		"query too long":     "query=" + strings.Repeat("a", 201),
		"cursor too long":    "cursor=" + strings.Repeat("a", 501),
		"unknown media":      "media=exe",
		"media injection":    "media=photo'%20OR%201=1--",
	}
	for name, q := range bad {
		if rec := h.do("GET", "/api/public/messages?"+q, nil); rec.Code != 400 {
			t.Errorf("%s: status %d, want 400 (%s)", name, rec.Code, truncateForLog(rec.Body.String()))
		}
	}
	for _, q := range []string{"media=all", "media=text", "media=photo", "chat_id=-1", "chat_id=all", "query=" + strings.Repeat("a", 200), "cursor=garbage"} {
		if rec := h.do("GET", "/api/public/messages?"+q, nil); rec.Code != 200 {
			t.Errorf("%s: status %d, want 200", q, rec.Code)
		}
	}

	// Page sizes are clamped, never trusted.
	for limit, want := range map[string]int{"1000000": 100, "100": 100, "0": 1, "-5": 1, "7": 7, "": 20} {
		path := "/api/public/messages"
		if limit != "" {
			path += "?limit=" + limit
		}
		if got := len(items(t, h.do("GET", path, nil))); got != want {
			t.Errorf("limit=%q returned %d items, want %d", limit, got, want)
		}
	}
	// SQL metacharacters are data, not syntax.
	for _, q := range []string{"%27%20OR%201%3D1--", "%25", "_", "%5C"} {
		if rec := h.do("GET", "/api/public/messages?query="+q, nil); rec.Code != 200 {
			t.Errorf("query=%s: status %d", q, rec.Code)
		}
	}
}

func TestPaginationWalksTheWholeFeed(t *testing.T) {
	h := newHarness(t)
	src := h.addSource(-1, "Pub", true, true)
	for i := int64(1); i <= 45; i++ {
		h.addMessage(src.ChatID, i, fmt.Sprintf("post %d", i), nil, "", fmt.Sprintf("2026-10-28T10:%02d:00+00:00", i))
	}
	seen := map[float64]bool{}
	cursor := ""
	for page := 0; page < 10; page++ {
		path := "/api/public/messages?limit=20"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		body := decodeMap(t, h.do("GET", path, nil))
		for _, it := range body["items"].([]any) {
			id := it.(map[string]any)["id"].(float64)
			if seen[id] {
				t.Fatalf("message %v delivered twice", id)
			}
			seen[id] = true
		}
		if body["has_more"] != true {
			break
		}
		cursor = body["next_cursor"].(string)
	}
	if len(seen) != 45 {
		t.Fatalf("pagination returned %d of 45 messages", len(seen))
	}
}

// ---- media access control ---------------------------------------------------------

func TestPublicMediaRespectsSourceVisibility(t *testing.T) {
	h := newHarness(t)
	pub := h.addSource(-1, "Pub", true, true)
	priv := h.addSource(-2, "Priv", true, false)
	off := h.addSource(-3, "Off", false, true)
	pubMsg := h.addMessage(pub.ChatID, 1, "[photo] a", strp("photo"), h.mediaRaw("/img.png"), "")
	privMsg := h.addMessage(priv.ChatID, 1, "[photo] b", strp("photo"), h.mediaRaw("/img.png"), "")
	offMsg := h.addMessage(off.ChatID, 1, "[photo] c", strp("photo"), h.mediaRaw("/img.png"), "")

	// Visible source: served.
	rec := h.do("GET", fmt.Sprintf("/api/public/media/%d/0?variant=original", pubMsg), nil)
	expectStatus(t, rec, 200)
	if rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("Cache-Control") != "no-cache" ||
		rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("headers: %v", rec.Header())
	}
	if !bytes.Equal(rec.Body.Bytes(), testPNG()) {
		t.Fatal("original bytes differ from upstream")
	}
	hitsAfterVisible := h.hits.Load()

	// Hidden and disabled sources: indistinguishable from "does not exist", and
	// the upstream is never contacted on their behalf.
	for name, id := range map[string]int64{"private": privMsg, "disabled": offMsg, "missing": 99999} {
		for _, variant := range []string{"original", "thumbnail"} {
			rec := h.do("GET", fmt.Sprintf("/api/public/media/%d/0?variant=%s", id, variant), nil)
			if rec.Code != 404 || detailOf(t, rec) != "Media not found" {
				t.Errorf("%s/%s: status %d %q, want 404 Media not found", name, variant, rec.Code, rec.Body.String())
			}
		}
	}
	if h.hits.Load() != hitsAfterVisible {
		t.Fatal("the server fetched media for a source the visitor may not see")
	}

	// Hiding a source revokes access even to files already in the cache.
	if _, err := h.sources.UpdateSource(pub.ChatID, repoPatchPublic(false)); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, h.do("GET", fmt.Sprintf("/api/public/media/%d/0?variant=original", pubMsg), nil), 404)
}

func TestMediaVariantsAndIndexValidation(t *testing.T) {
	h := newHarness(t)
	src := h.addSource(-1, "Pub", true, true)
	id := h.addMessage(src.ChatID, 1, "[photo] a", strp("photo"), h.mediaRaw("/img.png"), "")

	// Thumbnails are the default and come out as small JPEGs.
	rec := h.do("GET", fmt.Sprintf("/api/public/media/%d/0", id), nil)
	expectStatus(t, rec, 200)
	if rec.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("thumbnail type = %q", rec.Header().Get("Content-Type"))
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(rec.Body.Bytes()))
	if err != nil || cfg.Width > 480 || cfg.Height > 480 || cfg.Width != 480 {
		t.Fatalf("thumbnail = %dx%d, %v", cfg.Width, cfg.Height, err)
	}

	for path, want := range map[string]int{
		fmt.Sprintf("/api/public/media/%d/0?variant=bogus", id):      400,
		fmt.Sprintf("/api/public/media/%d/1", id):                    404, // index out of range
		fmt.Sprintf("/api/public/media/%d/-1", id):                   404,
		fmt.Sprintf("/api/public/media/%d/abc", id):                  404,
		"/api/public/media/abc/0":                                    404,
		"/api/public/media/0/0":                                      404,
		"/api/public/media/-5/0":                                     404,
		"/api/public/media/99999999999999999999999999999/0":          404,
		fmt.Sprintf("/api/public/media/%d/99999999999999999999", id): 404,
	} {
		if rec := h.do("GET", path, nil); rec.Code != want {
			t.Errorf("%s = %d, want %d", path, rec.Code, want)
		}
	}
}

func TestMediaUpstreamFailuresDoNotLeakInternals(t *testing.T) {
	h := newHarness(t)
	src := h.addSource(-1, "Pub", true, true)
	cases := map[string]struct {
		raw  string
		want int
	}{
		"upstream 500":        {h.mediaRaw("/boom"), 502},
		"html instead of img": {h.mediaRaw("/page.html"), 400},
		"foreign host":        {`{"media_items":[{"url":"https://example.org/a.jpg","kind":"image","role":"media"}]}`, 400},
		"plain http":          {`{"media_items":[{"url":"http://cdn1.telesco.pe/a.jpg","kind":"image","role":"media"}]}`, 400},
		"cloud metadata":      {`{"media_items":[{"url":"http://169.254.169.254/latest/meta-data/","kind":"image","role":"media"}]}`, 400},
		"file url":            {`{"media_items":[{"url":"file:///etc/passwd","kind":"image","role":"media"}]}`, 400},
		"no media at all":     {`{"source_url":"https://t.me/chan/1"}`, 404},
		"broken raw_json":     {`not json`, 404},
	}
	i := int64(10)
	for name, tc := range cases {
		i++
		id := h.addMessage(src.ChatID, i, "[photo] x", strp("photo"), tc.raw, "")
		rec := h.do("GET", fmt.Sprintf("/api/public/media/%d/0?variant=original", id), nil)
		if rec.Code != tc.want {
			t.Errorf("%s: status %d, want %d (%s)", name, rec.Code, tc.want, truncateForLog(rec.Body.String()))
			continue
		}
		for _, leak := range []string{"/secret/path", "127.0.0.1", "dial tcp", "/tmp", "/var/", "no such file", "169.254"} {
			if strings.Contains(rec.Body.String(), leak) {
				t.Errorf("%s: error response leaks %q: %s", name, leak, rec.Body.String())
			}
		}
	}
}

func TestLegacyRowsWithOnlyMediaURLsAreServed(t *testing.T) {
	h := newHarness(t)
	src := h.addSource(-1, "Pub", true, true)
	raw := fmt.Sprintf(`{"media_urls":[%q]}`, h.upstream.URL+"/img.png")
	id := h.addMessage(src.ChatID, 1, "[photo] old row", strp("photo"), raw, "")

	list := h.do("GET", "/api/public/messages", nil).Body.String()
	if !strings.Contains(list, fmt.Sprintf("/api/public/media/%d/0", id)) {
		t.Fatalf("legacy media is not advertised: %s", list)
	}
	rec := h.do("GET", fmt.Sprintf("/api/public/media/%d/0?variant=original", id), nil)
	expectStatus(t, rec, 200)
	if !bytes.Equal(rec.Body.Bytes(), testPNG()) {
		t.Fatal("legacy media served with the wrong bytes")
	}
}

func TestAdminMediaRequiresASessionAndServesHiddenSources(t *testing.T) {
	h := newHarness(t)
	priv := h.addSource(-2, "Priv", true, false)
	id := h.addMessage(priv.ChatID, 1, "[photo] b", strp("photo"), h.mediaRaw("/img.png"), "")
	path := fmt.Sprintf("/api/admin/media/%d/0?variant=original", id)

	expectStatus(t, h.do("GET", path, nil), 401)
	// The public endpoint stays closed for the same message.
	expectStatus(t, h.do("GET", fmt.Sprintf("/api/public/media/%d/0?variant=original", id), nil), 404)

	cookie := h.login()
	rec := h.do("GET", path, nil, withCookie(cookie))
	expectStatus(t, rec, 200)
	if !bytes.Equal(rec.Body.Bytes(), testPNG()) || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("admin media: cache-control %q", rec.Header().Get("Cache-Control"))
	}

	// The admin feed points at the authenticated endpoint, the public feed at the public one.
	adminList := h.do("GET", "/api/admin/messages", nil, withCookie(cookie)).Body.String()
	if !strings.Contains(adminList, "/api/admin/media/") || strings.Contains(adminList, "/api/public/media/") {
		t.Fatalf("admin feed media URLs: %s", adminList)
	}
	pub := h.addSource(-1, "Pub", true, true)
	h.addMessage(pub.ChatID, 1, "[photo] a", strp("photo"), h.mediaRaw("/img.png"), "")
	publicList := h.do("GET", "/api/public/messages", nil).Body.String()
	if !strings.Contains(publicList, "/api/public/media/") || strings.Contains(publicList, "/api/admin/media/") {
		t.Fatalf("public feed media URLs: %s", publicList)
	}
}

// ---- feedback ---------------------------------------------------------------------

func TestFeedbackSubmission(t *testing.T) {
	h := newHarness(t)

	rec := h.do("POST", "/api/public/feedback", map[string]string{"message": "  great site  "})
	expectStatus(t, rec, 201)
	body := decodeMap(t, rec)
	if body["status"] != "new" || body["id"] == nil {
		t.Fatalf("body = %v", body)
	}
	if _, leaked := body["ip"]; leaked {
		t.Error("the response should not echo the submitter's IP")
	}
	stored, _ := h.feedback.ListFeedback(10)
	if len(stored) != 1 || stored[0].Message != "great site" || stored[0].IP != "192.0.2.1" {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestFeedbackValidationAndAbuseLimits(t *testing.T) {
	h := newHarness(t, func(c *configT) { c.FeedbackRateLimit = 1000 }) // isolate validation from the rate limit
	post := func(body any, opts ...reqOpt) *httpRecorder {
		return h.do("POST", "/api/public/feedback", body, opts...)
	}

	cases := []struct {
		name string
		rec  *httpRecorder
		want int
	}{
		{"empty", post(map[string]string{"message": ""}), 422},
		{"blank", post(map[string]string{"message": "   \n\t "}), 422},
		{"missing", post(map[string]string{}), 422},
		{"2001 characters", post(map[string]string{"message": strings.Repeat("a", 2001)}), 422},
		{"2000 characters", post(map[string]string{"message": strings.Repeat("a", 2000)}), 201},
		{"2000 CJK characters", post(map[string]string{"message": strings.Repeat("中", 2000)}), 201},
		{"2001 CJK characters", post(map[string]string{"message": strings.Repeat("中", 2001)}), 422},
		{"20 MiB body", post(`{"message":"` + strings.Repeat("A", 20<<20) + `"}`), 413},
		{"just over the body cap", post(`{"message":"` + strings.Repeat("A", 33<<10) + `"}`), 413},
		{"plain text content type", post(`{"message":"x"}`, withHeader("Content-Type", "text/plain")), 415},
		{"no Origin", post(map[string]string{"message": "x"}, withoutHeader("Origin")), 403},
		{"cross-site Origin", post(map[string]string{"message": "x"}, withHeader("Origin", "https://evil.example")), 403},
		{"message is an object", post(`{"message":{"a":1}}`), 422},
	}
	for _, c := range cases {
		if c.rec.Code != c.want {
			t.Errorf("%s: status %d, want %d (%s)", c.name, c.rec.Code, c.want, truncateForLog(c.rec.Body.String()))
		}
	}
	for _, f := range mustFeedback(t, h) {
		if len(f.Message) > 8000 {
			t.Errorf("an oversized message was stored (%d bytes)", len(f.Message))
		}
	}
}

func TestFeedbackIsRateLimitedPerClient(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < 5; i++ {
		expectStatus(t, h.do("POST", "/api/public/feedback", map[string]string{"message": fmt.Sprintf("note %d", i)}), 201)
	}
	rec := h.do("POST", "/api/public/feedback", map[string]string{"message": "one too many"})
	expectStatus(t, rec, 429)
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 without Retry-After")
	}
	// Spoofed forwarding headers from a direct client change nothing...
	spoofed := h.do("POST", "/api/public/feedback", map[string]string{"message": "x"}, withHeader("X-Forwarded-For", "1.2.3.4"))
	expectStatus(t, spoofed, 429)
	// ...but another real client is served.
	expectStatus(t, h.do("POST", "/api/public/feedback", map[string]string{"message": "hi"}, withPeer("198.51.100.9:1")), 201)

	if got := len(mustFeedback(t, h)); got != 6 {
		t.Fatalf("stored %d messages, want 6", got)
	}
}

func TestFeedbackFloodCannotFillTheDatabase(t *testing.T) {
	h := newHarness(t)
	accepted := 0
	for i := 0; i < 300; i++ {
		if h.do("POST", "/api/public/feedback", map[string]string{"message": "spam"}).Code == 201 {
			accepted++
		}
	}
	if accepted != 5 {
		t.Fatalf("a single client got %d of 300 spam messages stored, want 5", accepted)
	}
}

func TestFeedbackAdministration(t *testing.T) {
	h := newHarness(t)
	h.do("POST", "/api/public/feedback", map[string]string{"message": "please add dark mode"})
	cookie := h.login()

	list := items(t, h.do("GET", "/api/admin/feedback", nil, withCookie(cookie)))
	if len(list) != 1 || list[0].(map[string]any)["message"] != "please add dark mode" {
		t.Fatalf("list = %v", list)
	}
	id := int(list[0].(map[string]any)["id"].(float64))
	path := fmt.Sprintf("/api/admin/feedback/%d", id)

	rec := h.do("PATCH", path, map[string]string{"status": "resolved"}, withCookie(cookie))
	expectStatus(t, rec, 200)
	if decodeMap(t, rec)["status"] != "resolved" {
		t.Fatalf("body = %s", rec.Body.String())
	}
	expectStatus(t, h.do("PATCH", path, map[string]string{"status": "bogus"}, withCookie(cookie)), 422)
	expectStatus(t, h.do("PATCH", "/api/admin/feedback/999", map[string]string{"status": "new"}, withCookie(cookie)), 404)
	expectStatus(t, h.do("PATCH", "/api/admin/feedback/abc", map[string]string{"status": "new"}, withCookie(cookie)), 400)
	expectStatus(t, h.do("PATCH", path, map[string]string{"status": "new"}, withCookie(cookie), withoutHeader("Origin")), 403)
}

// ---- visits -----------------------------------------------------------------------

func TestPublicTrafficIsRecordedWithTheRealClientAddress(t *testing.T) {
	h := newHarness(t)
	h.addSource(-1, "Pub", true, true)

	h.do("GET", "/", nil, withPeer("203.0.113.5:1"), withHeader("X-Forwarded-For", "1.1.1.1"), withHeader("User-Agent", "TestAgent/1.0"))
	h.do("GET", "/api/public/sources", nil, withPeer("172.18.0.1:1"), withHeader("X-Forwarded-For", "6.6.6.6, 198.51.100.7"))
	h.do("GET", "/api/public/media/1/0", nil) // media downloads are not page views
	h.do("GET", "/api/admin/sources", nil)    // neither is admin traffic
	h.do("POST", "/api/public/feedback", map[string]string{"message": "x"})

	var visits []string
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		list, _ := h.visits.ListRecentVisits(10, 0)
		if len(list) >= 2 {
			for _, v := range list {
				visits = append(visits, v.IP+" "+v.Path)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	got := strings.Join(visits, " | ")
	if len(visits) != 2 || !strings.Contains(got, "198.51.100.7 /api/public/sources") || !strings.Contains(got, "203.0.113.5 /") ||
		strings.Contains(got, "1.1.1.1") || strings.Contains(got, "6.6.6.6") {
		t.Fatalf("recorded visits: %q", got)
	}
}

var _ = http.StatusOK
