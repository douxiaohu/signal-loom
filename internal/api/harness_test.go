package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"telegram-radar/internal/api/middleware"
	"telegram-radar/internal/config"
	"telegram-radar/internal/media"
	"telegram-radar/internal/model"
	"telegram-radar/internal/repository"
	"telegram-radar/internal/scheduler"
)

const (
	testAdminKey = "test-admin-key-0123456789"
	testSecret   = "test-session-secret-0123456789abcdef"
)

type fakeCrawls struct {
	mu      sync.Mutex
	crawled []model.Source
	async   []model.Source
	result  func(model.Source) scheduler.CrawlResult
}

func (f *fakeCrawls) CrawlSource(_ context.Context, src model.Source) scheduler.CrawlResult {
	f.mu.Lock()
	f.crawled = append(f.crawled, src)
	f.mu.Unlock()
	if f.result != nil {
		return f.result(src)
	}
	return scheduler.CrawlResult{Source: src.SourceURL, ChatID: src.ChatID, Fetched: 20, Saved: 2}
}

func (f *fakeCrawls) CrawlSourceAsync(src model.Source) {
	f.mu.Lock()
	f.async = append(f.async, src)
	f.mu.Unlock()
}

func (f *fakeCrawls) asyncCalls() []model.Source {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]model.Source(nil), f.async...)
}

type harness struct {
	t        *testing.T
	cfg      *config.Config
	handler  http.Handler
	db       *sql.DB
	sources  *repository.SourceRepository
	messages *repository.MessageRepository
	visits   *repository.VisitRepository
	feedback *repository.FeedbackRepository
	alerts   *repository.AlertRepository
	sessions *middleware.SessionManager
	crawls   *fakeCrawls
	upstream *httptest.Server
	hits     atomic.Int32 // requests that reached the media upstream
}

func testConfig() *config.Config {
	trusted, _ := config.ParseTrustedProxies("private")
	return &config.Config{
		AppEnv:                  config.EnvProduction,
		AdminAPIKey:             testAdminKey,
		SessionSecret:           testSecret,
		SessionTTL:              12 * time.Hour,
		SessionCookieSecure:     true,
		LoginMaxAttempts:        5,
		LoginWindow:             15 * time.Minute,
		FeedbackRateLimit:       5,
		FeedbackRateWindow:      time.Minute,
		SourceStaleAfterSeconds: 900,
		Location:                time.UTC,
		TrustedProxies:          trusted,
	}
}

func testPNG() []byte {
	img := image.NewNRGBA(image.Rect(0, 0, 900, 600))
	for y := 0; y < 600; y++ {
		for x := 0; x < 900; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func newHarness(t *testing.T, mutate ...func(*config.Config)) *harness {
	t.Helper()
	return newHarnessWithStatic(t, nil, mutate...)
}

// newHarnessWithStatic is newHarness with a built frontend mounted.
func newHarnessWithStatic(t *testing.T, static fs.FS, mutate ...func(*config.Config)) *harness {
	t.Helper()
	cfg := testConfig()
	for _, m := range mutate {
		m(cfg)
	}

	db, err := repository.InitDB(filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		t:        t,
		cfg:      cfg,
		db:       db,
		sources:  repository.NewSourceRepository(db),
		messages: repository.NewMessageRepository(db),
		visits:   repository.NewVisitRepository(db),
		feedback: repository.NewFeedbackRepository(db),
		alerts:   repository.NewAlertRepository(db, time.UTC),
		sessions: middleware.NewSessionManager(cfg.SessionSecret, cfg.SessionTTL),
		crawls:   &fakeCrawls{},
	}

	pngData := testPNG()
	h.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.hits.Add(1)
		switch r.URL.Path {
		case "/img.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngData)
		case "/clip.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write([]byte("not-really-a-video"))
		case "/page.html":
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<script>alert(1)</script>"))
		default:
			http.Error(w, "upstream exploded at /secret/path/inside/server", http.StatusInternalServerError)
		}
	}))
	t.Cleanup(h.upstream.Close)

	upstreamHost := mustURL(t, h.upstream.URL).Host
	cache := media.New(t.TempDir(), media.Options{
		Client:   h.upstream.Client(),
		AllowURL: func(u *url.URL) bool { return u.Host == upstreamHost },
	})

	handler, closeRouter := NewRouter(Deps{
		Config:   cfg,
		Sources:  h.sources,
		Messages: h.messages,
		Visits:   h.visits,
		Feedback: h.feedback,
		Alerts:   h.alerts,
		Media:    cache,
		Crawls:   h.crawls,
		Sessions: h.sessions,
		Static:   static,
	})
	h.handler = handler
	t.Cleanup(func() {
		closeRouter()
		_ = db.Close()
	})
	return h
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

type reqOpt func(*http.Request)

func withHeader(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }
func withoutHeader(k string) reqOpt { return func(r *http.Request) { r.Header.Del(k) } }
func withPeer(addr string) reqOpt   { return func(r *http.Request) { r.RemoteAddr = addr } }
func withCookie(c *http.Cookie) reqOpt {
	return func(r *http.Request) { r.AddCookie(c) }
}

// do sends a request through the full router. Unsafe methods carry a matching
// Origin, as a browser would add; body may be nil, a string, bytes or any value
// (marshalled as JSON).
func (h *harness) do(method, path string, body any, opts ...reqOpt) *httptest.ResponseRecorder {
	h.t.Helper()
	var reader io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case string:
		reader = strings.NewReader(b)
		contentType = "application/json"
	case []byte:
		reader = bytes.NewReader(b)
		contentType = "application/json"
	default:
		data, err := json.Marshal(b)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(data)
		contentType = "application/json"
	}
	req := httptest.NewRequest(method, "http://example.com"+path, reader)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	switch method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
		req.Header.Set("Origin", "http://example.com")
	}
	for _, o := range opts {
		o(req)
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec
}

func (h *harness) login() *http.Cookie {
	h.t.Helper()
	rec := h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey})
	if rec.Code != 200 {
		h.t.Fatalf("login failed: %d %s", rec.Code, rec.Body.String())
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == middleware.SessionCookieName {
			return c
		}
	}
	h.t.Fatal("login did not set a session cookie")
	return nil
}

func (h *harness) addSource(chatID int64, name string, enabled, public bool) model.Source {
	h.t.Helper()
	src := model.Source{
		ChatID: chatID, Name: name, SourceURL: "https://t.me/" + strings.ToLower(name),
		SourceType: "telegram_public", Adapter: "telegram_public", Locator: "https://t.me/" + strings.ToLower(name),
		Enabled: enabled, PublicVisible: public,
	}
	if err := h.sources.CreateSource(&src); err != nil {
		h.t.Fatal(err)
	}
	return src
}

func strp(s string) *string { return &s }

// addMessage stores a message and returns its database id.
func (h *harness) addMessage(chatID, messageID int64, content string, mediaType *string, raw string, at string) int64 {
	h.t.Helper()
	if raw == "" {
		raw = fmt.Sprintf(`{"source_url":"https://t.me/chan/%d"}`, messageID)
	}
	if at == "" {
		at = fmt.Sprintf("2026-10-28T00:%02d:00+00:00", messageID%60)
	}
	m := &model.StoredMessage{
		ChatID: chatID, ChatTitle: "Chan", MessageID: messageID, SenderName: "Chan",
		MessageTime: at, Content: content, MediaType: mediaType, RawJSON: raw,
	}
	if _, err := h.messages.SaveMessage(m); err != nil {
		h.t.Fatal(err)
	}
	return m.ID
}

func (h *harness) mediaRaw(path string) string {
	return fmt.Sprintf(`{"source_url":"https://t.me/chan/1","media_items":[{"url":%q,"kind":"image","role":"media"}]}`, h.upstream.URL+path)
}

func decodeMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("response is not a JSON object (%d): %q", rec.Code, rec.Body.String())
	}
	return m
}

func items(t *testing.T, rec *httptest.ResponseRecorder) []any {
	t.Helper()
	m := decodeMap(t, rec)
	list, ok := m["items"].([]any)
	if !ok {
		t.Fatalf("\"items\" must be a JSON array, got %#v in %s", m["items"], rec.Body.String())
	}
	return list
}

func keysOf(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func expectStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, want, truncateForLog(rec.Body.String()))
	}
}

func truncateForLog(s string) string {
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}

func detailOf(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	d, _ := decodeMap(t, rec)["detail"].(string)
	return d
}

// Short aliases used by the test files.
type (
	configT      = config.Config
	httpRecorder = httptest.ResponseRecorder
)

func repoPatchPublic(v bool) repository.SourcePatch { return repository.SourcePatch{PublicVisible: &v} }

func mustFeedback(t *testing.T, h *harness) []model.Feedback {
	t.Helper()
	list, err := h.feedback.ListFeedback(1000)
	if err != nil {
		t.Fatal(err)
	}
	return list
}
