package api

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"telegram-radar/internal/api/middleware"
	"telegram-radar/internal/config"
	"telegram-radar/internal/repository"
)

// PublicHandler serves everything an anonymous visitor may reach.
type PublicHandler struct {
	cfg             *config.Config
	sources         *repository.SourceRepository
	messages        *repository.MessageRepository
	feedback        *repository.FeedbackRepository
	media           *mediaServer
	feedbackLimiter *middleware.RateLimiter
}

func NewPublicHandler(
	cfg *config.Config,
	sources *repository.SourceRepository,
	messages *repository.MessageRepository,
	feedback *repository.FeedbackRepository,
	media *mediaServer,
) *PublicHandler {
	return &PublicHandler{
		cfg:             cfg,
		sources:         sources,
		messages:        messages,
		feedback:        feedback,
		media:           media,
		feedbackLimiter: middleware.NewRateLimiter(cfg.FeedbackRateLimit, cfg.FeedbackRateWindow),
	}
}

// RegisterRoutes 注册公开路由
func (h *PublicHandler) RegisterRoutes(r chi.Router) {
	r.Get("/health", h.Health)

	r.Route("/api/public", func(r chi.Router) {
		r.Get("/config", h.SiteConfig)
		r.Get("/messages/{id}", h.GetMessage)
		r.Get("/sources", h.ListSources)
		r.Get("/messages", h.ListMessages)
		r.Get("/media/{id}/{index}", h.ServeMedia)
		r.Post("/feedback", h.SubmitFeedback)
	})
}

func (h *PublicHandler) Health(w http.ResponseWriter, r *http.Request) {
	RespondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *PublicHandler) ListSources(w http.ResponseWriter, r *http.Request) {
	sources, err := h.sources.ListPublicSources(h.cfg.SourceStaleAfterSeconds)
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondETagJSON(w, r, map[string]any{"items": sources})
}

func (h *PublicHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, apiErr := queryInt(q, "limit", 20, 1, 100)
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	f, apiErr := parseFeedFilter(q)
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	// README "可见性合同": asking for a source that is not public answers 404,
	// not an empty page. Hidden, disabled and unknown sources look the same.
	if f.ChatID != nil {
		visible, err := h.sources.IsPubliclyVisible(*f.ChatID)
		if err != nil {
			internalError(w, r, err)
			return
		}
		if !visible {
			RespondError(w, http.StatusNotFound, "Source not found")
			return
		}
	}

	list, hasMore, nextCursor, err := h.messages.ListMessagesPage(repository.QueryFilter{
		ChatID:     f.ChatID,
		Query:      f.Query,
		MediaType:  f.Media,
		Cursor:     f.Cursor,
		Limit:      limit,
		MaxLimit:   100,
		OnlyPublic: true, // hidden and disabled sources never show up here
	})
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondETagJSON(w, r, map[string]any{
		"items":       formatMessages(list, "/api/public/media"),
		"has_more":    hasMore,
		"next_cursor": nextCursor,
		"total":       nil,
	})
}

// ServeMedia streams the image or video of a message, but only when the
// message belongs to a source that is enabled and published. A message of a
// hidden source answers 404, exactly like a message that does not exist, so
// ids cannot be used to probe for it. The admin console uses
// /api/admin/media instead.
func (h *PublicHandler) ServeMedia(w http.ResponseWriter, r *http.Request) {
	req, apiErr, err := h.media.lookup(r)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if apiErr != nil {
		apiErr.write(w)
		return
	}
	visible, err := h.sources.IsPubliclyVisible(req.msg.ChatID)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !visible {
		RespondError(w, http.StatusNotFound, "Media not found")
		return
	}
	// "no-cache" = always revalidate: access can be revoked by hiding the source.
	h.media.serve(w, r, req, "no-cache")
}

type feedbackRequest struct {
	Message string `json:"message"`
}

// SubmitFeedback accepts a short note from a visitor. The endpoint is open to
// the world, so it is rate limited per client, size limited, and (via the
// global middleware) same-origin only.
func (h *PublicHandler) SubmitFeedback(w http.ResponseWriter, r *http.Request) {
	ip := middleware.ClientIP(r)
	if allowed, retry := h.feedbackLimiter.Hit(ip); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry/time.Second)+1))
		RespondError(w, http.StatusTooManyRequests, "Too many feedback submissions")
		return
	}

	var req feedbackRequest
	if apiErr := decodeJSON(w, r, &req, maxFeedbackBody); apiErr != nil {
		apiErr.write(w)
		return
	}
	message := strings.TrimSpace(req.Message)
	if message == "" || runeLen(message) > maxFeedbackLen {
		invalid("message must be between 1 and 2000 characters").write(w)
		return
	}

	fb, err := h.feedback.CreateFeedback(message, ip)
	if err != nil {
		internalError(w, r, err)
		return
	}
	RespondJSON(w, http.StatusCreated, map[string]any{
		"id":         fb.ID,
		"status":     fb.Status,
		"created_at": fb.CreatedAt,
	})
}

// SiteConfig is an explicit whitelist; never serialize the runtime Config.
func (h *PublicHandler) SiteConfig(w http.ResponseWriter, r *http.Request) {
	name := h.cfg.SiteName
	if name == "" {
		name = "拾讯"
	}
	RespondJSON(w, http.StatusOK, map[string]string{"name": name, "description": h.cfg.SiteDescription, "base_url": h.cfg.PublicBaseURL})
}

func (h *PublicHandler) GetMessage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		RespondError(w, 404, "Message not found")
		return
	}
	msg, err := h.messages.GetMessageByID(id)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if msg == nil || (strings.TrimSpace(msg.Content) == "" && msg.MediaType == nil) || (msg.MediaType != nil && *msg.MediaType == "poll") {
		RespondError(w, 404, "Message not found")
		return
	}
	visible, err := h.sources.IsPubliclyVisible(msg.ChatID)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !visible {
		RespondError(w, 404, "Message not found")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	RespondJSON(w, 200, FormatAPIMessage(msg, "/api/public/media"))
}
