package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // embedded zone database, so TIMEZONE works on minimal images too

	"telegram-radar/internal/api"
	"telegram-radar/internal/api/middleware"
	"telegram-radar/internal/config"
	"telegram-radar/internal/crawler"
	"telegram-radar/internal/media"
	"telegram-radar/internal/repository"
	"telegram-radar/internal/safe"
	"telegram-radar/internal/scheduler"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("❌ %v", err)
	}
}

func run() error {
	log.Println("🚀 Telegram 频道资讯平台 (Go) 正在启动...")

	// 1. 加载并校验配置。校验失败时拒绝启动，而不是退化成不安全的默认值。
	cfg, err := config.LoadConfig(".env")
	if err != nil {
		return fmt.Errorf("配置加载失败: %w", err)
	}
	for _, w := range cfg.Warnings {
		log.Printf("⚠️ %s", w)
	}
	if key := cfg.FillDevelopmentDefaults(); key != "" {
		log.Printf("⚠️ [%s] 未配置 ADMIN_API_KEY，已生成仅本次运行有效的临时管理密钥: %s", cfg.AppEnv, key)
	}
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("配置校验失败: %w", err)
	}
	log.Printf("⚙️  环境=%s 时区=%s 采集间隔=%v 登录限流=%d 次/%v", cfg.AppEnv, cfg.Location, cfg.CrawlInterval, cfg.LoginMaxAttempts, cfg.LoginWindow)

	// 2. 初始化数据库 (SQLite WAL 模式)
	db, err := repository.InitDB(cfg.DatabasePath)
	if err != nil {
		return fmt.Errorf("数据库初始化失败 [%s]: %w", cfg.DatabasePath, err)
	}
	defer db.Close()
	log.Printf("✅ SQLite 数据库连接成功: %s", cfg.DatabasePath)

	// 3. 仓储与领域服务
	sourceRepo := repository.NewSourceRepository(db)
	msgRepo := repository.NewMessageRepository(db)
	visitRepo := repository.NewVisitRepository(db)
	feedbackRepo := repository.NewFeedbackRepository(db)
	alertRepo := repository.NewAlertRepository(db, cfg.Location)

	seedSources(cfg, sourceRepo)

	mediaCache := media.New(cfg.MediaCacheDir, media.Options{
		AllowedHosts: cfg.MediaAllowedHosts,
		MaxBytes:     cfg.MediaMaxBytes,
		Proxied:      proxyConfigured(),
	})
	safe.Go("media temp cleanup", func() {
		if n := mediaCache.CleanTemp(time.Hour); n > 0 {
			log.Printf("🧹 清理了 %d 个遗留的媒体临时文件", n)
		}
	})

	collector := scheduler.NewCollector(sourceRepo, msgRepo, alertRepo,
		crawler.NewTelegramCrawler(20*time.Second), mediaCache, cfg.CrawlInterval)
	collector.Start()

	// 4. HTTP 路由
	var static fs.FS
	if info, err := os.Stat("frontend/dist"); err == nil && info.IsDir() {
		log.Println("📦 检测到前端构建目录 frontend/dist，已挂载 SPA 页面托管")
		static = os.DirFS("frontend/dist")
	} else {
		log.Println("⚠️ 未检测到 frontend/dist 目录，前端页面将无法访问（API 仍可用）")
	}
	handler, closeRouter := api.NewRouter(api.Deps{
		Config:   cfg,
		Sources:  sourceRepo,
		Messages: msgRepo,
		Visits:   visitRepo,
		Feedback: feedbackRepo,
		Alerts:   alertRepo,
		Media:    mediaCache,
		Crawls:   collector,
		Sessions: middleware.NewSessionManager(cfg.SessionSecret, cfg.SessionTTL),
		Static:   static,
	})

	server := &http.Server{
		Addr:              net.JoinHostPort(cfg.Host, cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second, // media and crawl-now extend their own deadline
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		collector.Shutdown(time.Second)
		closeRouter()
		return fmt.Errorf("监听 %s 失败: %w", server.Addr, err)
	}
	log.Printf("🌐 服务已就绪，监听 %s", describeListener(listener.Addr(), cfg.Host == ""))

	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()

	// 5. 优雅停机：先停接收请求，再等采集协程，最后才关闭数据库。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	var result error
	select {
	case sig := <-stop:
		log.Printf("🛑 接收到操作系统信号 [%v]，正在平滑关闭服务...", sig)
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			result = fmt.Errorf("HTTP 服务异常退出: %w", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP 服务停机异常: %v", err)
	}
	if !collector.Shutdown(10 * time.Second) {
		log.Println("⚠️ 部分采集任务未能在 10 秒内结束")
	}
	closeRouter()

	log.Println("👋 服务已安全关闭")
	return result
}

// seedSources imports config/groups.yaml once, while the sources table is
// still empty (see README).
func seedSources(cfg *config.Config, repo *repository.SourceRepository) {
	groups, err := config.LoadGroups(cfg.GroupsConfigPath)
	if err != nil {
		log.Printf("⚠️ 读取 %s 失败: %v", cfg.GroupsConfigPath, err)
		return
	}
	if len(groups) == 0 {
		return
	}
	created, skipped, err := repository.SeedSourcesFromGroups(repo, groups)
	if err != nil {
		log.Printf("⚠️ 从 %s 导入来源失败: %v", cfg.GroupsConfigPath, err)
		return
	}
	if created > 0 {
		log.Printf("🌱 已从 %s 导入 %d 个来源", cfg.GroupsConfigPath, created)
	}
	for _, s := range skipped {
		log.Printf("⚠️ 跳过 %s 中的条目: %s", cfg.GroupsConfigPath, s)
	}
}

// proxyConfigured reports whether outgoing requests to the media CDN go through
// an HTTP proxy (HTTPS_PROXY and friends).
func proxyConfigured() bool {
	req, err := http.NewRequest(http.MethodGet, "https://cdn1.telesco.pe/", nil)
	if err != nil {
		return false
	}
	u, err := http.ProxyFromEnvironment(req)
	return err == nil && u != nil
}

func describeListener(addr net.Addr, allInterfaces bool) string {
	if allInterfaces {
		return addr.String() + "（所有网卡；仅本机访问请设置 HOST=127.0.0.1，生产环境请置于反向代理之后）"
	}
	return addr.String()
}
