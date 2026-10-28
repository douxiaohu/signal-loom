// Package scheduler runs the periodic collection of public channels.
package scheduler

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"telegram-radar/internal/media"
	"telegram-radar/internal/model"
	"telegram-radar/internal/repository"
	"telegram-radar/internal/safe"
)

const (
	maxParallelCrawls = 3
	crawlTimeout      = 90 * time.Second
)

// Crawler fetches the latest posts of one channel.
type Crawler interface {
	CrawlChannel(ctx context.Context, sourceURL string, chatID int64, channelTitle string) ([]model.StoredMessage, error)
}

// MediaWarmer pre-downloads media so the first visitor does not have to wait.
// *media.Cache satisfies it.
type MediaWarmer interface {
	Get(ctx context.Context, ref media.Ref, thumbnail bool) (media.Result, error)
}

// CrawlResult is what one crawl of one source produced. The JSON shape is the
// one the Python service returned from crawl-now.
type CrawlResult struct {
	Source  string  `json:"source"`
	ChatID  int64   `json:"chat_id"`
	Fetched int     `json:"fetched"`
	Saved   int     `json:"saved"`
	Error   *string `json:"error"`
}

// Collector 调度器核心：调度所有启用的公开来源进行定时抓取
type Collector struct {
	sources  *repository.SourceRepository
	messages *repository.MessageRepository
	alerts   *repository.AlertRepository
	crawler  Crawler
	media    MediaWarmer
	interval time.Duration

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	locks  sync.Map // chat id -> *sync.Mutex; one crawl per source at a time
}

func NewCollector(
	sources *repository.SourceRepository,
	messages *repository.MessageRepository,
	alerts *repository.AlertRepository,
	crawler Crawler,
	mediaWarmer MediaWarmer,
	interval time.Duration,
) *Collector {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Collector{
		sources:  sources,
		messages: messages,
		alerts:   alerts,
		crawler:  crawler,
		media:    mediaWarmer,
		interval: interval,
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Start launches the background loop: one crawl right away, then one per
// interval. A panic during a round is logged and the loop carries on.
func (c *Collector) Start() {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		log.Printf("[Scheduler] 启动采集调度器，轮询间隔: %v", c.interval)
		safe.Run("scheduled crawl", func() { c.CrawlAll(c.ctx) })

		ticker := time.NewTicker(c.interval)
		defer ticker.Stop()
		for {
			select {
			case <-c.ctx.Done():
				log.Println("[Scheduler] 收到停止信号，采集调度器平滑退出")
				return
			case <-ticker.C:
				safe.Run("scheduled crawl", func() { c.CrawlAll(c.ctx) })
			}
		}
	}()
}

// Shutdown stops the loop, cancels running crawls and waits for them. It
// reports whether everything finished within the timeout.
func (c *Collector) Shutdown(timeout time.Duration) bool {
	c.cancel()
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// CrawlAll 抓取所有已启用的来源，最多同时抓取 maxParallelCrawls 个。
func (c *Collector) CrawlAll(ctx context.Context) []CrawlResult {
	results := make([]CrawlResult, 0)
	sources, err := c.sources.ListSources()
	if err != nil {
		log.Printf("[Scheduler] 查询来源列表失败: %v", err)
		return results
	}

	var enabled []model.Source
	for _, s := range sources {
		if s.Enabled && s.Adapter == "telegram_public" {
			enabled = append(enabled, s)
		}
	}
	if len(enabled) == 0 {
		return results
	}
	log.Printf("[Scheduler] 开始一轮采集，活跃来源数: %d", len(enabled))

	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		sem = make(chan struct{}, maxParallelCrawls)
	)
	for _, s := range enabled {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(src model.Source) {
			defer wg.Done()
			defer func() { <-sem }()
			safe.Run("crawl "+src.SourceURL, func() {
				r := c.CrawlSource(ctx, src)
				mu.Lock()
				results = append(results, r)
				mu.Unlock()
			})
		}(s)
	}
	wg.Wait()
	log.Printf("[Scheduler] 本轮采集执行完毕")
	return results
}

// CrawlSourceAsync crawls one source in the background (used right after a
// source is added). It is tied to the collector's lifetime.
func (c *Collector) CrawlSourceAsync(src model.Source) {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		safe.Run("async crawl "+src.SourceURL, func() { c.CrawlSource(c.ctx, src) })
	}()
}

func (c *Collector) lockFor(chatID int64) *sync.Mutex {
	v, _ := c.locks.LoadOrStore(chatID, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// CrawlSource 抓取单个频道：保存新消息、匹配告警规则、预热媒体并记录运行结果。
// Crawls of the same source never overlap.
func (c *Collector) CrawlSource(parent context.Context, src model.Source) CrawlResult {
	lock := c.lockFor(src.ChatID)
	lock.Lock()
	defer lock.Unlock()

	ctx, cancel := context.WithTimeout(parent, crawlTimeout)
	defer cancel()

	startedAt := time.Now().UTC().Format(time.RFC3339)
	result := CrawlResult{Source: src.SourceURL, ChatID: src.ChatID}

	var posts []model.StoredMessage
	var crawlErr error
	if safe.Run("fetch "+src.SourceURL, func() {
		posts, crawlErr = c.crawler.CrawlChannel(ctx, src.SourceURL, src.ChatID, src.Name)
	}) {
		crawlErr = errors.New("internal error while crawling")
	}

	if crawlErr != nil {
		msg := safe.ErrorText(crawlErr.Error())
		result.Error = &msg
		log.Printf("[Scheduler] 抓取来源 %s(%s) 失败: %s", src.Name, src.SourceURL, msg)
	} else {
		result.Fetched = len(posts)
		result.Saved = c.ingest(posts)
	}

	if parent.Err() != nil {
		return result // shutting down: an interrupted crawl is not a source failure
	}
	finishedAt := time.Now().UTC().Format(time.RFC3339)
	if err := c.sources.RecordSourceRun(src.ChatID, src.SourceURL, startedAt, finishedAt,
		result.Fetched, result.Saved, result.Error); err != nil {
		log.Printf("[Scheduler] 记录采集结果失败 [%s]: %v", src.Name, err)
	}
	return result
}

// ingest stores the posts and returns how many were new. Only new or edited
// posts are matched against alert rules and have their media warmed; a post
// the page shows unchanged for the hundredth time costs one cheap upsert.
func (c *Collector) ingest(posts []model.StoredMessage) (saved int) {
	for i := range posts {
		post := &posts[i]
		if !post.Displayable() {
			continue
		}
		res, err := c.messages.SaveMessage(post)
		if err != nil {
			log.Printf("[Scheduler] 保存消息失败 [%d/%d]: %v", post.ChatID, post.MessageID, err)
			continue
		}
		if !res.Inserted && !res.Changed {
			continue
		}
		if res.Inserted {
			saved++
		}
		if _, err := c.alerts.MatchAndRecord(post); err != nil {
			log.Printf("[Scheduler] 告警匹配失败 [%d/%d]: %v", post.ChatID, post.MessageID, err)
		}
		c.warmMedia(post)
	}
	return saved
}

// warmMedia pre-fetches thumbnails of a post's images in the background. It
// goes through the same cache entry point as visitor requests, so a warm-up
// and a visitor asking for the same file share one download.
func (c *Collector) warmMedia(post *model.StoredMessage) {
	if c.media == nil || post.RawJSON == "" {
		return
	}
	items := model.ParseRawMessage(post.RawJSON).Items(post.MediaType)
	for idx, item := range items {
		if item.Kind != "image" || item.URL == "" {
			continue
		}
		ref := media.Ref{ChatID: post.ChatID, MessageID: post.ID, Index: idx, URL: item.URL}
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			safe.Run("warm media", func() { _, _ = c.media.Get(c.ctx, ref, true) })
		}()
	}
}
