package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"telegram-radar/internal/api/middleware"
	"telegram-radar/internal/config"
	"telegram-radar/internal/model"
	"telegram-radar/internal/repository"
	"telegram-radar/internal/safe"
	"telegram-radar/internal/scheduler"
)

// CrawlService is the part of the collector the admin API needs
// (*scheduler.Collector satisfies it).
type CrawlService interface {
	CrawlSource(ctx context.Context, src model.Source) scheduler.CrawlResult
	CrawlSourceAsync(src model.Source)
}

// crawlNowTimeout bounds a manually triggered crawl (two page fetches plus
// storing the posts).
const crawlNowTimeout = 90 * time.Second

type AdminHandler struct {
	cfg          *config.Config
	sessions     *middleware.SessionManager
	sources      *repository.SourceRepository
	messages     *repository.MessageRepository
	visits       *repository.VisitRepository
	alerts       *repository.AlertRepository
	feedback     *repository.FeedbackRepository
	crawls       CrawlService
	media        *mediaServer
	loginLimiter *middleware.RateLimiter
	now          func() time.Time
}

func NewAdminHandler(
	cfg *config.Config,
	sessions *middleware.SessionManager,
	sources *repository.SourceRepository,
	messages *repository.MessageRepository,
	visits *repository.VisitRepository,
	alerts *repository.AlertRepository,
	feedback *repository.FeedbackRepository,
	crawls CrawlService,
	media *mediaServer,
) *AdminHandler {
	return &AdminHandler{
		cfg:          cfg,
		sessions:     sessions,
		sources:      sources,
		messages:     messages,
		visits:       visits,
		alerts:       alerts,
		feedback:     feedback,
		crawls:       crawls,
		media:        media,
		loginLimiter: middleware.NewRateLimiter(cfg.LoginMaxAttempts, cfg.LoginWindow),
		now:          time.Now,
	}
}

func (h *AdminHandler) RegisterRoutes(r chi.Router) {
	// 公开认证接口
	r.Post("/api/auth/login", h.Login)
	r.Post("/api/auth/logout", h.Logout)
	r.Get("/api/session", h.GetSession)

	// 受保护的管理端接口
	r.Group(func(p chi.Router) {
		p.Use(middleware.RequireAuth(h.sessions))

		p.Get("/api/admin/sources", h.ListSources)
		p.Post("/api/admin/sources", h.CreateSource)
		p.Patch("/api/admin/sources/{chatId}", h.PatchSource)
		p.Post("/api/admin/sources/{chatId}/crawl-now", h.CrawlSourceNow)

		p.Get("/api/admin/messages", h.ListMessages)
		p.Get("/api/admin/media/{id}/{index}", h.ServeMedia)
		p.Get("/api/admin/operations/summary", h.OperationsSummary)
		p.Get("/api/admin/overview", h.Overview)
		p.Get("/api/admin/visits", h.ListVisits)

		p.Get("/api/admin/rules", h.ListRules)
		p.Post("/api/admin/rules", h.CreateRule)
		p.Patch("/api/admin/rules/{id}", h.PatchRule)
		p.Get("/api/admin/matches", h.ListMatches)
		p.Post("/api/admin/matches/{id}/acknowledge", h.AcknowledgeMatch)
		p.Post("/api/admin/matches/{id}/resolve", h.ResolveMatch)

		p.Get("/api/admin/feedback", h.ListFeedback)
		p.Patch("/api/admin/feedback/{id}", h.UpdateFeedback)
	})
}

// ---- authentication -----------------------------------------------------------

type loginRequest struct {
	APIKey string `json:"api_key"`
}

// keyMatches compares SHA-256 digests in constant time, so neither the content
// nor the length of the real key leaks through timing. An unset key never matches.
func (h *AdminHandler) keyMatches(candidate string) bool {
	if h.cfg.AdminAPIKey == "" {
		return false
	}
	a := sha256.Sum256([]byte(candidate))
	b := sha256.Sum256([]byte(h.cfg.AdminAPIKey))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

func (h *AdminHandler) sessionCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     middleware.SessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   h.cfg.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode,
	}
}

func (h *AdminHandler) Login(w http.ResponseWriter, r *http.Request) {
	// One slot is taken before the key is even looked at, so a burst of
	// parallel guesses cannot all slip past the limit. A successful login
	// gives the slots back.
	ip := middleware.ClientIP(r)
	if allowed, retry := h.loginLimiter.Hit(ip); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry/time.Second)+1))
		RespondError(w, http.StatusTooManyRequests, "Too many login attempts")
		return
	}

	var req loginRequest
	if apiErr := decodeJSON(w, r, &req, maxLoginBody); apiErr != nil {
		apiErr.write(w)
		return
	}
	if req.APIKey == "" || runeLen(req.APIKey) > maxAPIKeyLen {
		RespondError(w, http.StatusBadRequest, "api_key must be between 1 and 256 characters")
		return
	}
	if !h.keyMatches(req.APIKey) {
		RespondError(w, http.StatusUnauthorized, "Invalid credentials")
		return
	}
	h.loginLimiter.Reset(ip)

	token, expiresAt, err := h.sessions.Issue()
	if err != nil {
		internalError(w, r, err)
		return
	}
	http.SetCookie(w, h.sessionCookie(token, int(h.cfg.SessionTTL.Seconds())))
	RespondJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"expires_at":    time.Unix(expiresAt, 0).UTC().Format(time.RFC3339),
	})
}

func (h *AdminHandler) Logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(middleware.SessionCookieName); err == nil && cookie.Value != "" {
		h.sessions.Revoke(cookie.Value)
	}
	http.SetCookie(w, h.sessionCookie("", -1))
	w.WriteHeader(http.StatusNoContent)
}

func (h *AdminHandler) GetSession(w http.ResponseWriter, r *http.Request) {
	var expiresAt int64
	if cookie, err := r.Cookie(middleware.SessionCookieName); err == nil && cookie.Value != "" {
		expiresAt = h.sessions.Verify(cookie.Value)
	}
	if expiresAt == 0 {
		RespondJSON(w, http.StatusOK, map[string]any{"authenticated": false, "expires_at": nil})
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"expires_at":    time.Unix(expiresAt, 0).UTC().Format(time.RFC3339),
	})
}

// ---- sources ------------------------------------------------------------------

func (h *AdminHandler) sourceView(s model.Source, stats map[int64]repository.ChatStats) model.SourceWithHealth {
	health := h.sources.GetSourceHealth(s.ChatID, h.cfg.SourceStaleAfterSeconds)
	adapter := firstNonEmpty(s.Adapter, s.SourceType)
	v := model.SourceWithHealth{
		ChatID:        s.ChatID,
		Name:          s.Name,
		SourceURL:     s.SourceURL,
		SourceType:    adapter,
		Adapter:       adapter,
		Enabled:       s.Enabled,
		PublicVisible: s.PublicVisible,
		CreatedAt:     s.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:     s.UpdatedAt.UTC().Format(time.RFC3339),
		HealthStatus:  health.HealthStatus,
		LastRunAt:     health.LastRunAt,
		LastSuccessAt: health.LastSuccessAt,
		FetchedCount:  health.FetchedCount,
		SavedCount:    health.SavedCount,
	}
	if health.LastError != nil {
		clean := safe.ErrorText(*health.LastError)
		v.LastError = &clean
	}
	if st, ok := stats[s.ChatID]; ok {
		v.MessageCount = st.MessageCount
		v.LastMessageTime = st.LastMessageTime
	}
	return v
}

func (h *AdminHandler) sourceViews() ([]model.SourceWithHealth, error) {
	sources, err := h.sources.ListSources()
	if err != nil {
		return nil, err
	}
	stats, err := h.messages.StatsByChat()
	if err != nil {
		return nil, err
	}
	views := make([]model.SourceWithHealth, 0, len(sources))
	for _, s := range sources {
		views = append(views, h.sourceView(s, stats))
	}
	return views, nil
}

func (h *AdminHandler) ListSources(w http.ResponseWriter, r *http.Request) {
	views, err := h.sourceViews()
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{"items": views})
}

type createSourceRequest struct {
	Name      string `json:"name"`
	SourceURL string `json:"source_url"`
	Adapter   string `json:"adapter"`
}

func (h *AdminHandler) CreateSource(w http.ResponseWriter, r *http.Request) {
	var req createSourceRequest
	if apiErr := decodeJSON(w, r, &req, maxAdminBody); apiErr != nil {
		apiErr.write(w)
		return
	}
	sourceURL := strings.TrimSpace(req.SourceURL)
	if sourceURL == "" || runeLen(sourceURL) > maxSourceURLLen {
		invalid("source_url must be between 1 and 300 characters").write(w)
		return
	}
	if adapter := strings.TrimSpace(req.Adapter); adapter != "" && adapter != "telegram_public" {
		invalid("unknown source adapter").write(w)
		return
	}
	canonical, err := config.CanonicalTelegramPublicURL(sourceURL)
	if err != nil {
		invalid("Invalid Telegram public channel URL").write(w)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = config.NormalizeTelegramPublicSource(sourceURL)
	}
	if runeLen(name) > maxNameLen {
		invalid("name must be at most 80 characters").write(w)
		return
	}

	src := &model.Source{
		ChatID:        config.PublicSourceChatID(canonical),
		Name:          name,
		SourceURL:     canonical,
		SourceType:    "telegram_public",
		Adapter:       "telegram_public",
		Locator:       canonical,
		Enabled:       true,
		PublicVisible: false, // new sources start hidden; publishing is a separate decision
	}
	if err := h.sources.CreateSource(src); err != nil {
		if errors.Is(err, repository.ErrConflict) {
			RespondError(w, http.StatusConflict, "Source already exists")
			return
		}
		internalError(w, r, err)
		return
	}

	h.crawls.CrawlSourceAsync(*src) // first collection without waiting for the next tick
	RespondJSON(w, http.StatusCreated, h.sourceView(*src, nil))
}

type patchSourceRequest struct {
	Name          *string `json:"name"`
	Enabled       *bool   `json:"enabled"`
	PublicVisible *bool   `json:"public_visible"`
}

func parseChatID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "chatId"), 10, 64)
	return id, err == nil
}

func (h *AdminHandler) PatchSource(w http.ResponseWriter, r *http.Request) {
	chatID, ok := parseChatID(r)
	if !ok {
		RespondError(w, http.StatusBadRequest, "Invalid chatId")
		return
	}
	var req patchSourceRequest
	if apiErr := decodeJSON(w, r, &req, maxAdminBody); apiErr != nil {
		apiErr.write(w)
		return
	}
	patch := repository.SourcePatch{Enabled: req.Enabled, PublicVisible: req.PublicVisible}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || runeLen(name) > maxNameLen {
			invalid("name must be between 1 and 80 characters").write(w)
			return
		}
		patch.Name = &name
	}

	src, err := h.sources.UpdateSource(chatID, patch)
	if errors.Is(err, repository.ErrNotFound) {
		RespondError(w, http.StatusNotFound, "Source not found")
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}
	stats, _ := h.messages.StatsByChat()
	RespondJSON(w, http.StatusOK, h.sourceView(*src, stats))
}

// CrawlSourceNow collects one source and waits for the result, which is what
// the UI's "采集完成" message and the following reload rely on.
func (h *AdminHandler) CrawlSourceNow(w http.ResponseWriter, r *http.Request) {
	chatID, ok := parseChatID(r)
	if !ok {
		RespondError(w, http.StatusBadRequest, "Invalid chatId")
		return
	}
	src, err := h.sources.GetSource(chatID)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if src == nil || !src.Enabled || firstNonEmpty(src.Adapter, src.SourceType) != "telegram_public" {
		RespondError(w, http.StatusNotFound, "enabled source not found")
		return
	}

	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(crawlNowTimeout + 15*time.Second))
	// Finish the crawl even if the browser gives up waiting.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), crawlNowTimeout)
	defer cancel()
	RespondJSON(w, http.StatusOK, h.crawls.CrawlSource(ctx, *src))
}

// ---- messages and media -------------------------------------------------------

func (h *AdminHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, apiErr := queryInt(q, "limit", 30, 1, 200)
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	f, apiErr := parseFeedFilter(q)
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	list, hasMore, nextCursor, err := h.messages.ListMessagesPage(repository.QueryFilter{
		ChatID:    f.ChatID,
		Query:     f.Query,
		MediaType: f.Media,
		Cursor:    f.Cursor,
		Limit:     limit,
		MaxLimit:  200,
	})
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{
		"items":       formatMessages(list, "/api/admin/media"),
		"has_more":    hasMore,
		"next_cursor": nextCursor,
		"total":       nil,
	})
}

// ServeMedia serves media of any source, hidden ones included. It sits behind
// the session check and is never cached by shared caches.
func (h *AdminHandler) ServeMedia(w http.ResponseWriter, r *http.Request) {
	req, apiErr, err := h.media.lookup(r)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	h.media.serve(w, r, req, "private, no-store")
}

// ---- operations, overview, visits ---------------------------------------------

func isUnhealthy(status string) bool {
	return status == "unknown" || status == "stale" || status == "error"
}

type operationsSource struct {
	model.SourceWithHealth
	ConsecutiveFailures int `json:"consecutive_failures"`
	NewMessageVolume    int `json:"new_message_volume"`
}

func (h *AdminHandler) OperationsSummary(w http.ResponseWriter, r *http.Request) {
	anomaly := r.URL.Query().Get("anomaly")
	if anomaly != "" && anomaly != "failures" && anomaly != "volume" {
		RespondError(w, http.StatusBadRequest, "anomaly must be failures or volume")
		return
	}
	views, err := h.sourceViews()
	if err != nil {
		internalError(w, r, err)
		return
	}

	sources := make([]operationsSource, 0, len(views))
	for _, v := range views {
		failures, volume, err := h.sources.AnomalyStats(v.ChatID)
		if err != nil {
			internalError(w, r, err)
			return
		}
		switch {
		case anomaly == "failures" && failures == 0:
			continue
		case anomaly == "volume" && volume != 0:
			continue
		}
		sources = append(sources, operationsSource{SourceWithHealth: v, ConsecutiveFailures: failures, NewMessageVolume: volume})
	}

	unhealthy := make([]operationsSource, 0)
	publicCount := 0
	for _, s := range sources {
		if isUnhealthy(s.HealthStatus) {
			unhealthy = append(unhealthy, s)
		}
		if s.PublicVisible && s.Enabled {
			publicCount++
		}
	}
	RespondJSON(w, http.StatusOK, map[string]any{
		"generated_at":        h.now().UTC().Format(time.RFC3339),
		"sources":             sources,
		"unhealthy_sources":   unhealthy,
		"public_source_count": publicCount,
		"source_count":        len(sources),
	})
}

type overviewSources struct {
	Total     int                      `json:"total"`
	Enabled   int                      `json:"enabled"`
	Public    int                      `json:"public"`
	Unhealthy int                      `json:"unhealthy"`
	Items     []model.SourceWithHealth `json:"items"`
}

type overviewAlerts struct {
	NewCount          int `json:"new_count"`
	PendingCount      int `json:"pending_count"`
	AcknowledgedCount int `json:"acknowledged_count"`
	ResolvedCount     int `json:"resolved_count"`
	RuleCount         int `json:"rule_count"`
	EnabledRuleCount  int `json:"enabled_rule_count"`
}

// overviewVisits 在访问统计之上附带按天趋势序列，供后台「访问趋势」图使用。
// 内嵌 SiteVisitStats 以提升其 JSON 字段，同时让该结构体保持可比较（无切片）。
type overviewVisits struct {
	model.SiteVisitStats
	Trend []model.VisitTrendPoint `json:"trend"`
}

const overviewTrendDays = 7

// Overview feeds the admin landing page. The shape is the contract of the
// frontend's AdminOverview type.
func (h *AdminHandler) Overview(w http.ResponseWriter, r *http.Request) {
	views, err := h.sourceViews()
	if err != nil {
		internalError(w, r, err)
		return
	}
	visits, err := h.visits.GetStats(h.now(), h.cfg.Location)
	if err != nil {
		internalError(w, r, err)
		return
	}
	trend, err := h.visits.DailyTrend(h.now(), h.cfg.Location, overviewTrendDays)
	if err != nil {
		internalError(w, r, err)
		return
	}
	alerts, err := h.alerts.Stats()
	if err != nil {
		internalError(w, r, err)
		return
	}

	summary := overviewSources{Total: len(views), Items: views}
	for _, v := range views {
		if v.Enabled {
			summary.Enabled++
			if v.PublicVisible {
				summary.Public++
			}
		}
		if isUnhealthy(v.HealthStatus) {
			summary.Unhealthy++
		}
	}
	RespondJSON(w, http.StatusOK, map[string]any{
		"visits":  overviewVisits{SiteVisitStats: visits, Trend: trend},
		"sources": summary,
		"alerts": overviewAlerts{
			NewCount:          alerts.New,
			PendingCount:      alerts.New + alerts.Acknowledged,
			AcknowledgedCount: alerts.Acknowledged,
			ResolvedCount:     alerts.Resolved,
			RuleCount:         alerts.RuleCount,
			EnabledRuleCount:  alerts.EnabledRuleCount,
		},
	})
}

func (h *AdminHandler) ListVisits(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, apiErr := queryInt(q, "limit", 100, 1, 500)
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	offset, apiErr := queryInt(q, "offset", 0, 0, 10000)
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	items, err := h.visits.ListRecentVisits(limit, offset)
	if err != nil {
		internalError(w, r, err)
		return
	}
	stats, err := h.visits.GetStats(h.now(), h.cfg.Location)
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{"items": items, "stats": stats})
}

// ---- alert rules and matches --------------------------------------------------

// optional distinguishes a JSON field that is absent (leave unchanged) from one
// that is present, including an explicit null (clear it).
type optional[T any] struct {
	set   bool
	value *T
}

func (o *optional[T]) UnmarshalJSON(b []byte) error {
	o.set = true
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		o.value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.value = &v
	return nil
}

func emptyToNil(s *string) *string {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	v := strings.TrimSpace(*s)
	return &v
}

// normalizeRule trims and checks a rule. It is used for creates and, on the
// merged result, for patches, so both paths enforce the same limits.
func normalizeRule(rule *model.AlertRule) *apiError {
	rule.Name = strings.TrimSpace(rule.Name)
	rule.Keyword = strings.TrimSpace(rule.Keyword)
	if rule.Name == "" || runeLen(rule.Name) > maxNameLen {
		return invalid("name must be between 1 and 80 characters")
	}
	if rule.Keyword == "" || runeLen(rule.Keyword) > maxKeywordLen {
		return invalid("keyword must be between 1 and 200 characters")
	}
	rule.MediaType = emptyToNil(rule.MediaType)
	if rule.MediaType != nil && (*rule.MediaType == "all" || !mediaFilters[*rule.MediaType]) {
		return invalid("media_type is not supported")
	}
	rule.QuietStart = emptyToNil(rule.QuietStart)
	rule.QuietEnd = emptyToNil(rule.QuietEnd)
	if (rule.QuietStart == nil) != (rule.QuietEnd == nil) {
		return invalid("quiet_start and quiet_end must be provided together")
	}
	for _, clock := range []*string{rule.QuietStart, rule.QuietEnd} {
		if clock != nil && !clockPattern.MatchString(*clock) {
			return invalid("quiet hours must look like HH:MM")
		}
	}
	if rule.CooldownMinutes < 0 || rule.CooldownMinutes > maxCooldownMins {
		return invalid("cooldown_minutes must be between 0 and 1440")
	}
	if len(rule.SourceIDs) > maxRuleSources {
		return invalid("a rule can cover at most 100 sources")
	}
	return nil
}

func (h *AdminHandler) ListRules(w http.ResponseWriter, r *http.Request) {
	rules, err := h.alerts.ListRules()
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{"items": rules})
}

type createRuleRequest struct {
	Name            string  `json:"name"`
	Keyword         string  `json:"keyword"`
	MediaType       *string `json:"media_type"`
	QuietStart      *string `json:"quiet_start"`
	QuietEnd        *string `json:"quiet_end"`
	CooldownMinutes int     `json:"cooldown_minutes"`
	Enabled         bool    `json:"enabled"`
	SourceIDs       []int64 `json:"source_ids"`
}

func (h *AdminHandler) CreateRule(w http.ResponseWriter, r *http.Request) {
	var req createRuleRequest
	if apiErr := decodeJSON(w, r, &req, maxAdminBody); apiErr != nil {
		apiErr.write(w)
		return
	}
	// Only the fields above are taken from the client: ids and timestamps are
	// ours to assign.
	rule := &model.AlertRule{
		Name:            req.Name,
		Keyword:         req.Keyword,
		MediaType:       req.MediaType,
		QuietStart:      req.QuietStart,
		QuietEnd:        req.QuietEnd,
		CooldownMinutes: req.CooldownMinutes,
		Enabled:         req.Enabled,
		SourceIDs:       req.SourceIDs,
	}
	if apiErr := normalizeRule(rule); apiErr != nil {
		apiErr.write(w)
		return
	}
	if err := h.alerts.CreateRule(rule); err != nil {
		internalError(w, r, err)
		return
	}
	RespondJSON(w, http.StatusCreated, rule)
}

type patchRuleRequest struct {
	Name            optional[string]  `json:"name"`
	Keyword         optional[string]  `json:"keyword"`
	MediaType       optional[string]  `json:"media_type"`
	QuietStart      optional[string]  `json:"quiet_start"`
	QuietEnd        optional[string]  `json:"quiet_end"`
	CooldownMinutes optional[int]     `json:"cooldown_minutes"`
	Enabled         optional[bool]    `json:"enabled"`
	SourceIDs       optional[[]int64] `json:"source_ids"`
}

// PatchRule changes only the fields present in the request. The admin UI's
// enable/disable switch sends just {"enabled": ...}; everything else must stay
// as it was.
func (h *AdminHandler) PatchRule(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid id")
		return
	}
	var req patchRuleRequest
	if apiErr := decodeJSON(w, r, &req, maxAdminBody); apiErr != nil {
		apiErr.write(w)
		return
	}

	rule, err := h.alerts.UpdateRule(id, func(rule *model.AlertRule) error {
		if req.Name.set {
			if req.Name.value == nil {
				return invalid("name cannot be null")
			}
			rule.Name = *req.Name.value
		}
		if req.Keyword.set {
			if req.Keyword.value == nil {
				return invalid("keyword cannot be null")
			}
			rule.Keyword = *req.Keyword.value
		}
		if req.MediaType.set {
			rule.MediaType = req.MediaType.value
		}
		if req.QuietStart.set {
			rule.QuietStart = req.QuietStart.value
		}
		if req.QuietEnd.set {
			rule.QuietEnd = req.QuietEnd.value
		}
		if req.CooldownMinutes.set {
			if req.CooldownMinutes.value == nil {
				return invalid("cooldown_minutes cannot be null")
			}
			rule.CooldownMinutes = *req.CooldownMinutes.value
		}
		if req.Enabled.set {
			if req.Enabled.value == nil {
				return invalid("enabled cannot be null")
			}
			rule.Enabled = *req.Enabled.value
		}
		if req.SourceIDs.set {
			rule.SourceIDs = []int64{}
			if req.SourceIDs.value != nil {
				rule.SourceIDs = *req.SourceIDs.value
			}
		}
		if apiErr := normalizeRule(rule); apiErr != nil {
			return apiErr
		}
		return nil
	})
	var apiErr *apiError
	switch {
	case errors.Is(err, repository.ErrNotFound):
		RespondError(w, http.StatusNotFound, "Rule not found")
	case errors.As(err, &apiErr):
		apiErr.write(w)
	case err != nil:
		internalError(w, r, err)
	default:
		RespondJSON(w, http.StatusOK, rule)
	}
}

func (h *AdminHandler) ListMatches(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	switch status {
	case "", "all", "new", "acknowledged", "resolved":
	default:
		RespondError(w, http.StatusBadRequest, "Invalid status")
		return
	}
	matches, err := h.alerts.ListMatches(status, 200)
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{"items": matches})
}

func (h *AdminHandler) setMatchStatus(w http.ResponseWriter, r *http.Request, status string) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid id")
		return
	}
	match, err := h.alerts.SetMatchStatus(id, status)
	switch {
	case errors.Is(err, repository.ErrNotFound):
		RespondError(w, http.StatusNotFound, "Match not found")
	case err != nil:
		internalError(w, r, err)
	default:
		RespondJSON(w, http.StatusOK, match)
	}
}

func (h *AdminHandler) AcknowledgeMatch(w http.ResponseWriter, r *http.Request) {
	h.setMatchStatus(w, r, "acknowledged")
}

func (h *AdminHandler) ResolveMatch(w http.ResponseWriter, r *http.Request) {
	h.setMatchStatus(w, r, "resolved")
}

// ---- feedback -----------------------------------------------------------------

func (h *AdminHandler) ListFeedback(w http.ResponseWriter, r *http.Request) {
	items, err := h.feedback.ListFeedback(200)
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondJSON(w, http.StatusOK, map[string]any{"items": items})
}

type feedbackStatusRequest struct {
	Status string `json:"status"`
}

func (h *AdminHandler) UpdateFeedback(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid id")
		return
	}
	var req feedbackStatusRequest
	if apiErr := decodeJSON(w, r, &req, maxAdminBody); apiErr != nil {
		apiErr.write(w)
		return
	}
	if !repository.ValidFeedbackStatus(req.Status) {
		invalid("status must be new, reviewed, resolved or dismissed").write(w)
		return
	}
	fb, err := h.feedback.UpdateFeedbackStatus(id, req.Status)
	switch {
	case errors.Is(err, repository.ErrNotFound):
		RespondError(w, http.StatusNotFound, "Feedback not found")
	case err != nil:
		internalError(w, r, err)
	default:
		RespondJSON(w, http.StatusOK, fb)
	}
}
