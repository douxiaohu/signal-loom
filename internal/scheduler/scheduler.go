package scheduler

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"telegram-radar/internal/crawler"
	"telegram-radar/internal/media"
	"telegram-radar/internal/model"
	"telegram-radar/internal/repository"
)

// Collector 调度器核心：调度所有启用的公开来源进行定时抓取
type Collector struct {
	sourceRepo *repository.SourceRepository
	msgRepo    *repository.MessageRepository
	alertRepo  *repository.AlertRepository
	crawler    *crawler.TelegramCrawler
	mediaCache *media.MediaCache
	interval   time.Duration
}

func NewCollector(
	sourceRepo *repository.SourceRepository,
	msgRepo *repository.MessageRepository,
	alertRepo *repository.AlertRepository,
	crawler *crawler.TelegramCrawler,
	mediaCache *media.MediaCache,
	interval time.Duration,
) *Collector {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	return &Collector{
		sourceRepo: sourceRepo,
		msgRepo:    msgRepo,
		alertRepo:  alertRepo,
		crawler:    crawler,
		mediaCache: mediaCache,
		interval:   interval,
	}
}

// Start 启动后台采集定时循环（基于 context.Context 支持优雅停机）
func (c *Collector) Start(ctx context.Context) {
	log.Printf("[Scheduler] 启动采集调度器，轮询间隔: %v", c.interval)

	// 启动后立即异步触发一次首轮采集
	go c.CrawlAll(ctx)

	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("[Scheduler] 收到停止信号，采集调度器平滑退出")
			return
		case <-ticker.C:
			c.CrawlAll(ctx)
		}
	}
}

// CrawlAll 抓取所有已启用的来源
func (c *Collector) CrawlAll(ctx context.Context) {
	sources, err := c.sourceRepo.ListSources()
	if err != nil {
		log.Printf("[Scheduler] 查询来源列表失败: %v", err)
		return
	}

	var enabledSources []model.Source
	for _, s := range sources {
		if s.Enabled && s.Adapter == "telegram_public" {
			enabledSources = append(enabledSources, s)
		}
	}

	if len(enabledSources) == 0 {
		return
	}

	log.Printf("[Scheduler] 开始一轮采集，活跃来源数: %d", len(enabledSources))

	// 使用容量为 3 的信号量 channel 限制并发度，避免瞬间打爆网络或触发限流
	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup

	for _, s := range enabledSources {
		// 检查是否已收到终止信号
		if ctx.Err() != nil {
			break
		}

		wg.Add(1)
		sem <- struct{}{} // 占用一个并发槽位

		go func(src model.Source) {
			defer wg.Done()
			defer func() { <-sem }() // 释放槽位

			c.CrawlSingle(src)
		}(s)
	}

	wg.Wait()
	log.Printf("[Scheduler] 本轮采集执行完毕")
}

// CrawlSingle 抓取单个频道
func (c *Collector) CrawlSingle(src model.Source) {
	startedAt := time.Now().UTC().Format(time.RFC3339)
	posts, err := c.crawler.CrawlChannel(src.SourceURL, src.ChatID, src.Name)
	finishedAt := time.Now().UTC().Format(time.RFC3339)

	var runErr *string
	if err != nil {
		errStr := err.Error()
		runErr = &errStr
		log.Printf("[Scheduler] 抓取来源 %s(%s) 失败: %v", src.Name, src.SourceURL, err)
	}

	savedCount := 0
	if err == nil {
		for _, post := range posts {
			inserted, saveErr := c.msgRepo.SaveMessage(&post)
			if saveErr != nil {
				log.Printf("[Scheduler] 保存消息失败 [%s/%d]: %v", src.Name, post.MessageID, saveErr)
				continue
			}
			if inserted {
				savedCount++
				// 匹配监控规则
				_ = c.alertRepo.MatchAndRecord(&post)

				// 预热媒体缓存
				c.warmMediaCache(&post)
			}
		}
	}

	_ = c.sourceRepo.RecordSourceRun(
		src.ChatID,
		src.SourceURL,
		startedAt,
		finishedAt,
		len(posts),
		savedCount,
		runErr,
	)
}

func (c *Collector) warmMediaCache(msg *model.StoredMessage) {
	if c.mediaCache == nil || msg.RawJSON == "" {
		return
	}
	var raw model.RawMessageData
	if err := json.Unmarshal([]byte(msg.RawJSON), &raw); err != nil {
		return
	}
	for idx, item := range raw.MediaItems {
		if item.Kind == "image" && item.URL != "" {
			go func(i int, u string) {
				_, _ = c.mediaCache.GetPath(msg.ChatID, msg.MessageID, i, u, true)
			}(idx, item.URL)
		}
	}
}
