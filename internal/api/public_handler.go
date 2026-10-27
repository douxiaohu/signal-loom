package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"telegram-radar/internal/api/middleware"
	"telegram-radar/internal/config"
	"telegram-radar/internal/media"
	"telegram-radar/internal/model"
	"telegram-radar/internal/repository"
)

type PublicHandler struct {
	cfg          *config.Config
	sourceRepo   *repository.SourceRepository
	msgRepo      *repository.MessageRepository
	visitRepo    *repository.VisitRepository
	feedbackRepo *repository.FeedbackRepository
	mediaCache   *media.MediaCache
}

func NewPublicHandler(
	cfg *config.Config,
	sourceRepo *repository.SourceRepository,
	msgRepo *repository.MessageRepository,
	visitRepo *repository.VisitRepository,
	feedbackRepo *repository.FeedbackRepository,
	mediaCache *media.MediaCache,
) *PublicHandler {
	return &PublicHandler{
		cfg:          cfg,
		sourceRepo:   sourceRepo,
		msgRepo:      msgRepo,
		visitRepo:    visitRepo,
		feedbackRepo: feedbackRepo,
		mediaCache:   mediaCache,
	}
}

// RegisterRoutes 注册公开路由
func (h *PublicHandler) RegisterRoutes(r chi.Router) {
	r.Get("/health", h.Health)

	r.Route("/api/public", func(r chi.Router) {
		r.Get("/sources", h.ListSources)
		r.Get("/messages", h.ListMessages)
		r.Get("/media/{id}/{index}", h.ServeMedia)
	})

	r.Post("/api/feedback", h.SubmitFeedback)
}

func (h *PublicHandler) Health(w http.ResponseWriter, r *http.Request) {
	RespondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *PublicHandler) ListSources(w http.ResponseWriter, r *http.Request) {
	sources, err := h.sourceRepo.ListPublicSources(h.cfg.SourceStaleAfterSeconds)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	RespondETagJSON(w, r, map[string]any{"items": sources})
}

func (h *PublicHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 20
	}

	var chatID *int64
	if cidStr := q.Get("chat_id"); cidStr != "" {
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
		OnlyPublic: true,
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

	RespondETagJSON(w, r, map[string]any{
		"items":       items,
		"has_more":    hasMore,
		"next_cursor": nextCursor,
		"total":       nil,
	})
}

func (h *PublicHandler) ServeMedia(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	indexStr := chi.URLParam(r, "index")

	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid id")
		return
	}
	index, err := strconv.Atoi(indexStr)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid index")
		return
	}

	msg, err := h.msgRepo.GetMessageByID(id)
	if err != nil || msg == nil {
		RespondError(w, http.StatusNotFound, "Message not found")
		return
	}

	var raw model.RawMessageData
	if err := json.Unmarshal([]byte(msg.RawJSON), &raw); err != nil {
		RespondError(w, http.StatusInternalServerError, "Malformed media data")
		return
	}

	if index < 0 || index >= len(raw.MediaItems) {
		RespondError(w, http.StatusNotFound, "Media index out of range")
		return
	}

	variant := r.URL.Query().Get("variant")
	thumbnail := variant == "thumbnail"

	localPath, err := h.mediaCache.GetPath(msg.ChatID, msg.MessageID, index, raw.MediaItems[index].URL, thumbnail)
	if err != nil {
		RespondError(w, http.StatusBadGateway, "Failed to retrieve media")
		return
	}

	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, localPath)
}

type FeedbackRequest struct {
	Message string `json:"message"`
}

func (h *PublicHandler) SubmitFeedback(w http.ResponseWriter, r *http.Request) {
	var req FeedbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Message == "" {
		RespondError(w, http.StatusBadRequest, "Feedback message is required")
		return
	}

	ip := middleware.ClientIP(r)
	if err := h.feedbackRepo.CreateFeedback(req.Message, ip); err != nil {
		RespondError(w, http.StatusInternalServerError, "Failed to save feedback")
		return
	}

	RespondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
