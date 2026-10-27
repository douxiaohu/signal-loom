package api

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"telegram-radar/internal/api/middleware"
	"telegram-radar/internal/config"
	"telegram-radar/internal/model"
	"telegram-radar/internal/repository"
	"telegram-radar/internal/scheduler"
)

type AdminHandler struct {
	cfg        *config.Config
	sessionMgr *middleware.SessionManager
	sourceRepo *repository.SourceRepository
	msgRepo    *repository.MessageRepository
	visitRepo  *repository.VisitRepository
	alertRepo  *repository.AlertRepository
	collector  *scheduler.Collector
}

func NewAdminHandler(
	cfg *config.Config,
	sessionMgr *middleware.SessionManager,
	sourceRepo *repository.SourceRepository,
	msgRepo *repository.MessageRepository,
	visitRepo *repository.VisitRepository,
	alertRepo *repository.AlertRepository,
	collector *scheduler.Collector,
) *AdminHandler {
	return &AdminHandler{
		cfg:        cfg,
		sessionMgr: sessionMgr,
		sourceRepo: sourceRepo,
		msgRepo:    msgRepo,
		visitRepo:  visitRepo,
		alertRepo:  alertRepo,
		collector:  collector,
	}
}

func (h *AdminHandler) RegisterRoutes(r chi.Router) {
	// 公开认证接口
	r.Post("/api/auth/login", h.Login)
	r.Post("/api/auth/logout", h.Logout)
	r.Get("/api/session", h.GetSession)

	// 受保护的管理端接口
	r.Group(func(protected chi.Router) {
		protected.Use(middleware.RequireAuth(h.sessionMgr))

		protected.Get("/api/admin/sources", h.ListSources)
		protected.Post("/api/admin/sources", h.CreateSource)
		protected.Patch("/api/admin/sources/{chatId}", h.PatchSource)
		protected.Post("/api/admin/sources/{chatId}/crawl-now", h.CrawlSourceNow)

		protected.Get("/api/admin/messages", h.ListMessages)
		protected.Get("/api/admin/operations/summary", h.OperationsSummary)
		protected.Get("/api/admin/overview", h.Overview)
		protected.Get("/api/admin/visits", h.ListVisits)

		// 监控告警
		protected.Get("/api/admin/rules", h.ListRules)
		protected.Post("/api/admin/rules", h.CreateRule)
		protected.Patch("/api/admin/rules/{id}", h.PatchRule)
		protected.Get("/api/admin/matches", h.ListMatches)
		protected.Post("/api/admin/matches/{id}/acknowledge", h.AcknowledgeMatch)
		protected.Post("/api/admin/matches/{id}/resolve", h.ResolveMatch)
	})
}

type LoginRequest struct {
	APIKey string `json:"api_key"`
}

func (h *AdminHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.APIKey == "" {
		RespondError(w, http.StatusBadRequest, "api_key is required")
		return
	}

	// 常量时间比较防止时序嗅探攻击 (相当于 hmac.compare_digest)
	if h.cfg.AdminAPIKey == "" || subtle.ConstantTimeCompare([]byte(req.APIKey), []byte(h.cfg.AdminAPIKey)) != 1 {
		RespondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}

	token, expiresAt, err := h.sessionMgr.Issue()
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to issue session")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     middleware.SessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(h.cfg.SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   h.cfg.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode,
	})

	RespondJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"expires_at":    time.Unix(expiresAt, 0).UTC().Format(time.RFC3339),
	})
}

func (h *AdminHandler) Logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(middleware.SessionCookieName); err == nil && cookie.Value != "" {
		h.sessionMgr.Revoke(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     middleware.SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.cfg.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *AdminHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(middleware.SessionCookieName)
	if err != nil || cookie.Value == "" {
		RespondJSON(w, http.StatusOK, map[string]any{
			"authenticated": false,
			"expires_at":    nil,
		})
		return
	}

	expiresAt := h.sessionMgr.Verify(cookie.Value)
	if expiresAt == 0 {
		RespondJSON(w, http.StatusOK, map[string]any{
			"authenticated": false,
			"expires_at":    nil,
		})
		return
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"expires_at":    time.Unix(expiresAt, 0).UTC().Format(time.RFC3339),
	})
}

func (h *AdminHandler) ListSources(w http.ResponseWriter, r *http.Request) {
	sources, err := h.sourceRepo.ListSources()
	if err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	var items []model.SourceWithHealth
	for _, s := range sources {
		health := h.sourceRepo.GetSourceHealth(s.ChatID, h.cfg.SourceStaleAfterSeconds)
		items = append(items, model.SourceWithHealth{
			ChatID:        s.ChatID,
			Name:          s.Name,
			Source:        &s.SourceURL,
			SourceURL:     s.SourceURL,
			SourceType:    s.SourceType,
			Adapter:       s.Adapter,
			Enabled:       s.Enabled,
			PublicVisible: s.PublicVisible,
			HealthStatus:  health.HealthStatus,
			LastRunAt:     health.LastRunAt,
			LastSuccessAt: health.LastSuccessAt,
			LastError:     health.LastError,
			FetchedCount:  health.FetchedCount,
			SavedCount:    health.SavedCount,
		})
	}
	RespondJSON(w, http.StatusOK, map[string]any{"items": items})
}

type CreateSourceRequest struct {
	Name      string `json:"name"`
	SourceURL string `json:"source_url"`
}

func (h *AdminHandler) CreateSource(w http.ResponseWriter, r *http.Request) {
	var req CreateSourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SourceURL == "" {
		RespondError(w, http.StatusBadRequest, "Invalid payload")
		return
	}

	canonicalURL, err := config.CanonicalTelegramPublicURL(req.SourceURL)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid Telegram public channel URL")
		return
	}

	chatID := config.PublicSourceChatID(req.SourceURL)
	name := req.Name
	if name == "" {
		name = config.NormalizeTelegramPublicSource(req.SourceURL)
	}

	src := &model.Source{
		ChatID:        chatID,
		Name:          name,
		SourceURL:     canonicalURL,
		SourceType:    "telegram_public",
		Adapter:       "telegram_public",
		Locator:       canonicalURL,
		Enabled:       true,
		PublicVisible: false,
	}

	if err := h.sourceRepo.SaveSource(src); err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 异步触发一次初始采集
	go h.collector.CrawlSingle(*src)

	RespondJSON(w, http.StatusOK, src)
}

type PatchSourceRequest struct {
	Name          *string `json:"name"`
	Enabled       *bool   `json:"enabled"`
	PublicVisible *bool   `json:"public_visible"`
}

func (h *AdminHandler) PatchSource(w http.ResponseWriter, r *http.Request) {
	chatID, err := strconv.ParseInt(chi.URLParam(r, "chatId"), 10, 64)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid chatId")
		return
	}

	src, err := h.sourceRepo.GetSource(chatID)
	if err != nil || src == nil {
		RespondError(w, http.StatusNotFound, "Source not found")
		return
	}

	var req PatchSourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid JSON payload")
		return
	}

	if req.Name != nil {
		src.Name = *req.Name
	}
	if req.Enabled != nil {
		src.Enabled = *req.Enabled
	}
	if req.PublicVisible != nil {
		src.PublicVisible = *req.PublicVisible
	}

	if err := h.sourceRepo.SaveSource(src); err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	RespondJSON(w, http.StatusOK, src)
}

func (h *AdminHandler) CrawlSourceNow(w http.ResponseWriter, r *http.Request) {
	chatID, err := strconv.ParseInt(chi.URLParam(r, "chatId"), 10, 64)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid chatId")
		return
	}

	src, err := h.sourceRepo.GetSource(chatID)
	if err != nil || src == nil {
		RespondError(w, http.StatusNotFound, "Source not found")
		return
	}

	go h.collector.CrawlSingle(*src)

	RespondJSON(w, http.StatusOK, map[string]string{"status": "crawling_started"})
}

func (h *AdminHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 50
	}

	var chatID *int64
	if cidStr := q.Get("chat_id"); cidStr != "" && cidStr != "all" {
		if cid, err := strconv.ParseInt(cidStr, 10, 64); err == nil {
			chatID = &cid
		}
	}

	filter := repository.QueryFilter{
		ChatID:     chatID,
		Query:      q.Get("query"),
		MediaType:  q.Get("media"),
		Cursor:     q.Get("cursor"),
		Limit:      limit,
		OnlyPublic: false,
	}

	messages, hasMore, nextCursor, err := h.msgRepo.ListMessagesPage(filter)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	var items []model.APIMessage
	for _, m := range messages {
		items = append(items, FormatAPIMessage(&m, "/api/public/media"))
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"items":       items,
		"has_more":    hasMore,
		"next_cursor": nextCursor,
		"total":       nil,
	})
}

func (h *AdminHandler) OperationsSummary(w http.ResponseWriter, r *http.Request) {
	sources, _ := h.sourceRepo.ListSources()
	var allHealth []model.SourceHealth
	var unhealthy []model.SourceHealth
	publicCount := 0

	for _, s := range sources {
		if s.PublicVisible {
			publicCount++
		}
		sh := h.sourceRepo.GetSourceHealth(s.ChatID, h.cfg.SourceStaleAfterSeconds)
		allHealth = append(allHealth, sh)
		if sh.HealthStatus == "error" || sh.HealthStatus == "stale" {
			unhealthy = append(unhealthy, sh)
		}
	}

	RespondJSON(w, http.StatusOK, map[string]any{
		"sources":             allHealth,
		"unhealthy_sources":   unhealthy,
		"public_source_count": publicCount,
		"source_count":        len(sources),
	})
}

func (h *AdminHandler) Overview(w http.ResponseWriter, r *http.Request) {
	h.OperationsSummary(w, r)
}

func (h *AdminHandler) ListVisits(w http.ResponseWriter, r *http.Request) {
	visits, err := h.visitRepo.ListRecentVisits(100)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	stats, _ := h.visitRepo.GetStats()

	RespondJSON(w, http.StatusOK, map[string]any{
		"items": visits,
		"stats": stats,
	})
}

func (h *AdminHandler) ListRules(w http.ResponseWriter, r *http.Request) {
	rules, err := h.alertRepo.ListRules()
	if err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{"items": rules})
}

func (h *AdminHandler) CreateRule(w http.ResponseWriter, r *http.Request) {
	var rule model.AlertRule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid payload")
		return
	}
	if err := h.alertRepo.SaveRule(&rule); err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	RespondJSON(w, http.StatusOK, rule)
}

func (h *AdminHandler) PatchRule(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid id")
		return
	}
	var rule model.AlertRule
	if err := json.NewDecoder(r.Body).Decode(&rule); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid payload")
		return
	}
	rule.ID = id
	if err := h.alertRepo.SaveRule(&rule); err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	RespondJSON(w, http.StatusOK, rule)
}

func (h *AdminHandler) ListMatches(w http.ResponseWriter, r *http.Request) {
	matches, err := h.alertRepo.ListMatches(r.URL.Query().Get("status"), 100)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{"items": matches})
}

func (h *AdminHandler) AcknowledgeMatch(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	_ = h.alertRepo.UpdateMatchStatus(id, "acknowledged")
	RespondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *AdminHandler) ResolveMatch(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	_ = h.alertRepo.UpdateMatchStatus(id, "resolved")
	RespondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
