package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"telegram-radar/internal/api"
	"telegram-radar/internal/api/middleware"
	"telegram-radar/internal/config"
	"telegram-radar/internal/crawler"
	"telegram-radar/internal/media"
	"telegram-radar/internal/repository"
	"telegram-radar/internal/scheduler"
)

func main() {
	log.Println("==================================================")
	log.Println("🚀 Telegram 频道资讯平台 (Go 重构版本) 正在启动...")
	log.Println("==================================================")

	// 1. 加载配置
	cfg, err := config.LoadConfig(".env")
	if err != nil {
		log.Fatalf("配置加载失败: %v", err)
	}

	if cfg.AppEnv == "production" {
		if cfg.AdminAPIKey == "" {
			log.Fatal("生产环境错误: ADMIN_API_KEY 必须配置")
		}
		if len(cfg.SessionSecret) < 16 {
			log.Fatal("生产环境错误: SESSION_SECRET 长度不得小于 16 字节")
		}
	} else {
		if cfg.AdminAPIKey == "" {
			cfg.AdminAPIKey = "admin123"
			log.Println("开发环境警告: ADMIN_API_KEY 为空，已使用默认密钥: admin123")
		}
		if cfg.SessionSecret == "" {
			cfg.SessionSecret = "dev-secret-session-key-at-least-16-bytes"
		}
	}

	// 2. 初始化数据库 (SQLite WAL 模式)
	db, err := repository.InitDB(cfg.DatabasePath)
	if err != nil {
		log.Fatalf("数据库初始化失败 [%s]: %v", cfg.DatabasePath, err)
	}
	defer db.Close()
	log.Printf("✅ SQLite 数据库连接成功: %s", cfg.DatabasePath)

	// 3. 仓储与领域服务实例化
	sourceRepo := repository.NewSourceRepository(db)
	msgRepo := repository.NewMessageRepository(db)
	visitRepo := repository.NewVisitRepository(db)
	feedbackRepo := repository.NewFeedbackRepository(db)
	alertRepo := repository.NewAlertRepository(db)

	mediaCache := media.NewMediaCache(cfg.MediaCacheDir)
	telegramCrawler := crawler.NewTelegramCrawler(20 * time.Second)

	// 4. 初始化上下文与后台采集调度器
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	collector := scheduler.NewCollector(
		sourceRepo,
		msgRepo,
		alertRepo,
		telegramCrawler,
		mediaCache,
		cfg.CrawlInterval,
	)

	// 启动后台采集协程
	go collector.Start(ctx)

	// 5. 初始化 HTTP 路由与中间件
	sessionMgr := middleware.NewSessionManager(cfg.SessionSecret, cfg.SessionTTL)
	publicHandler := api.NewPublicHandler(cfg, sourceRepo, msgRepo, visitRepo, feedbackRepo, mediaCache)
	adminHandler := api.NewAdminHandler(cfg, sessionMgr, sourceRepo, msgRepo, visitRepo, alertRepo, collector)

	r := chi.NewRouter()

	// 全局中间件链
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(middleware.SecurityHeaders)
	r.Use(middleware.SiteVisitAuditor(visitRepo))

	// 注册公开接口与管理接口
	publicHandler.RegisterRoutes(r)
	adminHandler.RegisterRoutes(r)

	// 挂载前端静态文件 (SPA)
	if _, err := os.Stat("frontend/dist"); err == nil {
		log.Println("📦 检测到前端构建目录 frontend/dist，已挂载 SPA 页面托管")
		spaFS := os.DirFS("frontend/dist")
		api.MountSPA(r, spaFS.(fs.FS))
	} else {
		log.Println("⚠️ 未检测到 frontend/dist 目录，前端页面可能无法直接访问")
	}

	// 6. 启动 HTTP 服务
	addr := ":" + cfg.Port
	server := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Printf("🌐 服务已在 http://127.0.0.1%s 启动就绪", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP 服务启动失败: %v", err)
		}
	}()

	// 7. 优雅停机 (Graceful Shutdown)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	sig := <-sigChan

	log.Printf("🛑 接收到操作系统信号 [%v]，正在平滑关闭服务...", sig)

	// 通知后台采集协程停止
	cancel()

	// 限制 10 秒超时等待现有请求处理完成
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("HTTP 服务停机异常: %v", err)
	}

	log.Println("👋 服务已安全关闭")
}
