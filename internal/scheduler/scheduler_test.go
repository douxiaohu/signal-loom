package scheduler

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"telegram-radar/internal/media"
	"telegram-radar/internal/model"
	"telegram-radar/internal/repository"
)

type fakeCrawler struct {
	mu      sync.Mutex
	posts   []model.StoredMessage
	err     error
	panicAt int32 // panic on this call number (1-based); 0 = never
	calls   atomic.Int32
	running atomic.Int32
	maxSeen atomic.Int32
	delay   time.Duration
	block   bool // block until the context is cancelled
}

func (f *fakeCrawler) CrawlChannel(ctx context.Context, sourceURL string, chatID int64, title string) ([]model.StoredMessage, error) {
	n := f.calls.Add(1)
	cur := f.running.Add(1)
	defer f.running.Add(-1)
	for {
		old := f.maxSeen.Load()
		if cur <= old || f.maxSeen.CompareAndSwap(old, cur) {
			break
		}
	}
	if f.panicAt != 0 && n == f.panicAt {
		panic("crawler exploded")
	}
	if f.block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	out := make([]model.StoredMessage, len(f.posts))
	for i, p := range f.posts {
		p.ChatID = chatID
		out[i] = p
	}
	return out, nil
}

func (f *fakeCrawler) setPosts(p []model.StoredMessage) {
	f.mu.Lock()
	f.posts = p
	f.mu.Unlock()
}

type fakeMedia struct {
	mu    sync.Mutex
	calls []media.Ref
	thumb []bool
}

func (f *fakeMedia) Get(ctx context.Context, ref media.Ref, thumbnail bool) (media.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, ref)
	f.thumb = append(f.thumb, thumbnail)
	return media.Result{}, nil
}

func (f *fakeMedia) refs() []media.Ref {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]media.Ref(nil), f.calls...)
}

type env struct {
	sources  *repository.SourceRepository
	messages *repository.MessageRepository
	alerts   *repository.AlertRepository
	crawler  *fakeCrawler
	media    *fakeMedia
	col      *Collector
}

func newEnv(t *testing.T, interval time.Duration) *env {
	t.Helper()
	db, err := repository.InitDB(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	e := &env{
		sources:  repository.NewSourceRepository(db),
		messages: repository.NewMessageRepository(db),
		alerts:   repository.NewAlertRepository(db, time.UTC),
		crawler:  &fakeCrawler{},
		media:    &fakeMedia{},
	}
	e.col = NewCollector(e.sources, e.messages, e.alerts, e.crawler, e.media, interval)
	t.Cleanup(func() {
		e.col.Shutdown(2 * time.Second)
		_ = db.Close()
	})
	return e
}

func (e *env) addSource(t *testing.T, chatID int64, name string, enabled bool, adapter string) model.Source {
	t.Helper()
	src := &model.Source{
		ChatID: chatID, Name: name, SourceURL: "https://t.me/" + name, SourceType: adapter, Adapter: adapter,
		Locator: "https://t.me/" + name, Enabled: enabled,
	}
	if err := e.sources.CreateSource(src); err != nil {
		t.Fatal(err)
	}
	return *src
}

func strPtr(s string) *string { return &s }

func post(id int64, content string, mediaType *string, urls ...string) model.StoredMessage {
	items := ""
	for i, u := range urls {
		if i > 0 {
			items += ","
		}
		items += fmt.Sprintf(`{"url":%q,"kind":"image","role":"media"}`, u)
	}
	return model.StoredMessage{
		MessageID: id, ChatTitle: "Chan", SenderName: "Chan", MessageTime: "2026-10-28T00:00:00+00:00",
		Content: content, MediaType: mediaType,
		RawJSON: fmt.Sprintf(`{"source_url":"https://t.me/chan/%d","media_items":[%s]}`, id, items),
	}
}

func TestCrawlSourceStoresMatchesAndWarms(t *testing.T) {
	e := newEnv(t, time.Hour)
	src := e.addSource(t, -100, "chan", true, "telegram_public")
	rule := &model.AlertRule{Name: "btc", Keyword: "bitcoin", Enabled: true}
	if err := e.alerts.CreateRule(rule); err != nil {
		t.Fatal(err)
	}
	e.crawler.setPosts([]model.StoredMessage{
		post(1, "Bitcoin breaks out", nil),
		post(2, "[photo] chart", strPtr("photo"), "https://cdn1.telesco.pe/file/a.jpg", "https://cdn1.telesco.pe/file/b.jpg"),
		post(3, "   ", nil), // not displayable
	})

	res := e.col.CrawlSource(context.Background(), src)
	if res.Error != nil || res.Fetched != 3 || res.Saved != 2 {
		t.Fatalf("result = %+v", res)
	}

	matches, err := e.alerts.ListMatches("", 10)
	if err != nil || len(matches) != 1 || matches[0].Content != "Bitcoin breaks out" {
		t.Fatalf("matches = %+v, %v (alerts must surface with the real message id)", matches, err)
	}

	e.col.Shutdown(2 * time.Second) // waits for the background media warm-ups
	refs := e.media.refs()
	if len(refs) != 2 {
		t.Fatalf("warmed %d media items, want 2: %+v", len(refs), refs)
	}
	stored, _ := e.messages.GetMessageByID(refs[0].MessageID)
	if stored == nil || stored.MessageID != 2 {
		t.Fatalf("warm-up must use the database id, got %+v -> %+v", refs[0], stored)
	}
	for _, thumb := range e.media.thumb {
		if !thumb {
			t.Error("warm-up should request thumbnails")
		}
	}

	health := e.sources.GetSourceHealth(src.ChatID, 900)
	if health.HealthStatus != "healthy" || health.FetchedCount != 3 || health.SavedCount != 2 {
		t.Fatalf("health = %+v", health)
	}
}

func TestUnchangedRecrawlIsQuiet(t *testing.T) {
	e := newEnv(t, time.Hour)
	src := e.addSource(t, -100, "chan", true, "telegram_public")
	if err := e.alerts.CreateRule(&model.AlertRule{Name: "r", Keyword: "news", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	e.crawler.setPosts([]model.StoredMessage{
		post(1, "breaking news", nil),
		post(2, "pic", strPtr("photo"), "https://cdn1.telesco.pe/file/a.jpg"),
	})
	first := e.col.CrawlSource(context.Background(), src)
	if first.Saved != 2 {
		t.Fatalf("first crawl: %+v", first)
	}
	e.col.Shutdown(2 * time.Second)
	warmedAfterFirst := len(e.media.refs())

	// New collector for the second round (the first one is shut down).
	e.col = NewCollector(e.sources, e.messages, e.alerts, e.crawler, e.media, time.Hour)
	second := e.col.CrawlSource(context.Background(), src)
	e.col.Shutdown(2 * time.Second)

	if second.Fetched != 2 || second.Saved != 0 || second.Error != nil {
		t.Fatalf("second crawl: %+v", second)
	}
	if got := len(e.media.refs()); got != warmedAfterFirst {
		t.Fatalf("unchanged posts triggered %d extra media warm-ups", got-warmedAfterFirst)
	}
	if matches, _ := e.alerts.ListMatches("", 10); len(matches) != 1 {
		t.Fatalf("matches = %d, want 1", len(matches))
	}
	m, _ := e.messages.GetMessageByID(1)
	if m.ContentVersion != 1 {
		t.Fatalf("content_version = %d after identical re-crawls", m.ContentVersion)
	}
}

func TestEditedPostIsMatchedAgain(t *testing.T) {
	e := newEnv(t, time.Hour)
	src := e.addSource(t, -100, "chan", true, "telegram_public")
	if err := e.alerts.CreateRule(&model.AlertRule{Name: "r", Keyword: "bitcoin", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	e.crawler.setPosts([]model.StoredMessage{post(1, "hello world", nil)})
	e.col.CrawlSource(context.Background(), src)
	if matches, _ := e.alerts.ListMatches("", 10); len(matches) != 0 {
		t.Fatal("no match expected yet")
	}

	e.crawler.setPosts([]model.StoredMessage{post(1, "hello bitcoin", nil)})
	res := e.col.CrawlSource(context.Background(), src)
	if res.Saved != 0 {
		t.Fatalf("an edit is not a new post: %+v", res)
	}
	matches, _ := e.alerts.ListMatches("", 10)
	if len(matches) != 1 || matches[0].Content != "hello bitcoin" {
		t.Fatalf("matches = %+v", matches)
	}
	if m, _ := e.messages.GetMessageByID(1); m.ContentVersion != 2 {
		t.Fatalf("content_version = %d, want 2", m.ContentVersion)
	}
}

func TestCrawlErrorsAreRecordedWithoutServerPaths(t *testing.T) {
	e := newEnv(t, time.Hour)
	src := e.addSource(t, -100, "chan", true, "telegram_public")
	e.crawler.err = errors.New("open /app/data/media-cache/x.jpg: denied while fetching https://t.me/s/chan")

	res := e.col.CrawlSource(context.Background(), src)
	if res.Error == nil || strings.Contains(*res.Error, "/app/data") || !strings.Contains(*res.Error, "https://t.me/s/chan") {
		t.Fatalf("error = %v", res.Error)
	}
	h := e.sources.GetSourceHealth(src.ChatID, 900)
	if h.HealthStatus != "error" || h.LastError == nil || strings.Contains(*h.LastError, "/app/data") {
		t.Fatalf("health = %+v", h)
	}
}

func TestCrawlerPanicIsContained(t *testing.T) {
	e := newEnv(t, time.Hour)
	src := e.addSource(t, -100, "chan", true, "telegram_public")
	e.crawler.panicAt = 1
	e.crawler.setPosts([]model.StoredMessage{post(1, "fine", nil)})

	res := e.col.CrawlSource(context.Background(), src)
	if res.Error == nil || !strings.Contains(*res.Error, "internal error") {
		t.Fatalf("panic should surface as a failed crawl: %+v", res)
	}
	if h := e.sources.GetSourceHealth(src.ChatID, 900); h.HealthStatus != "error" {
		t.Fatalf("health = %+v", h)
	}
	// The source is not wedged: the next round works.
	if res = e.col.CrawlSource(context.Background(), src); res.Error != nil || res.Saved != 1 {
		t.Fatalf("after the panic: %+v", res)
	}
}

func TestCrawlsOfOneSourceNeverOverlap(t *testing.T) {
	e := newEnv(t, time.Hour)
	src := e.addSource(t, -100, "chan", true, "telegram_public")
	e.crawler.delay = 80 * time.Millisecond
	e.crawler.setPosts([]model.StoredMessage{post(1, "x", nil)})

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); e.col.CrawlSource(context.Background(), src) }()
	}
	wg.Wait()
	if got := e.crawler.maxSeen.Load(); got != 1 {
		t.Fatalf("%d crawls of the same source ran at once", got)
	}
	if e.crawler.calls.Load() != 4 {
		t.Fatalf("calls = %d", e.crawler.calls.Load())
	}
}

func TestCrawlAllRespectsEnabledAdapterAndParallelism(t *testing.T) {
	e := newEnv(t, time.Hour)
	for i := 0; i < 6; i++ {
		e.addSource(t, int64(-200-i), fmt.Sprintf("chan%d", i), true, "telegram_public")
	}
	e.addSource(t, -300, "disabled", false, "telegram_public")
	e.addSource(t, -301, "bot", true, "telegram_bot")
	e.crawler.delay = 60 * time.Millisecond
	e.crawler.setPosts([]model.StoredMessage{post(1, "x", nil)})

	results := e.col.CrawlAll(context.Background())
	if len(results) != 6 || e.crawler.calls.Load() != 6 {
		t.Fatalf("results = %d, crawler calls = %d, want 6 (disabled / bot sources skipped)", len(results), e.crawler.calls.Load())
	}
	if got := e.crawler.maxSeen.Load(); got > maxParallelCrawls || got < 2 {
		t.Fatalf("max parallel crawls = %d, want 2..%d", got, maxParallelCrawls)
	}
	if empty := newEnv(t, time.Hour).col.CrawlAll(context.Background()); empty == nil || len(empty) != 0 {
		t.Fatalf("CrawlAll without sources = %#v", empty)
	}
}

func TestStartRunsPeriodicallyAndSurvivesPanics(t *testing.T) {
	e := newEnv(t, 40*time.Millisecond)
	e.addSource(t, -100, "chan", true, "telegram_public")
	e.crawler.panicAt = 2
	e.crawler.setPosts([]model.StoredMessage{post(1, "x", nil)})

	e.col.Start()
	deadline := time.Now().Add(3 * time.Second)
	for e.crawler.calls.Load() < 4 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if e.crawler.calls.Load() < 4 {
		t.Fatalf("scheduler stalled after %d crawls", e.crawler.calls.Load())
	}
	if !e.col.Shutdown(2 * time.Second) {
		t.Fatal("Shutdown timed out")
	}
	after := e.crawler.calls.Load()
	time.Sleep(150 * time.Millisecond)
	if e.crawler.calls.Load() != after {
		t.Fatal("crawls continued after Shutdown")
	}
}

func TestShutdownInterruptsCrawlWithoutBlamingTheSource(t *testing.T) {
	e := newEnv(t, time.Hour)
	src := e.addSource(t, -100, "chan", true, "telegram_public")
	e.crawler.block = true

	e.col.CrawlSourceAsync(src)
	for e.crawler.running.Load() == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	start := time.Now()
	if !e.col.Shutdown(3 * time.Second) {
		t.Fatal("Shutdown did not finish: the crawl ignored cancellation")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("Shutdown was slow")
	}
	if h := e.sources.GetSourceHealth(src.ChatID, 900); h.HealthStatus != "unknown" || h.LastRunAt != nil {
		t.Fatalf("an interrupted crawl must not be recorded as a run: %+v", h)
	}
}
