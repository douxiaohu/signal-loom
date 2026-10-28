package api

import (
	"io/fs"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"telegram-radar/internal/api/middleware"
	"telegram-radar/internal/config"
	"telegram-radar/internal/media"
	"telegram-radar/internal/repository"
)

const (
	// visitRetention is how long page views are kept (same as the Python service).
	visitRetention = 90 * 24 * time.Hour
	visitQueueSize = 2048
)

// Deps is everything the HTTP layer needs. main wires the real implementations
// in; tests plug in fakes where that is useful.
type Deps struct {
	Config   *config.Config
	Sources  *repository.SourceRepository
	Messages *repository.MessageRepository
	Visits   *repository.VisitRepository
	Feedback *repository.FeedbackRepository
	Alerts   *repository.AlertRepository
	Media    *media.Cache
	Crawls   CrawlService
	Sessions *middleware.SessionManager
	Static   fs.FS // built frontend; nil = API only
}

// NewRouter assembles the whole HTTP stack. The returned function stops the
// background worker that records page views; call it after the server has
// stopped accepting requests.
func NewRouter(d Deps) (http.Handler, func()) {
	cfg := d.Config
	visits := middleware.NewVisitRecorder(d.Visits, visitQueueSize, visitRetention)

	r := chi.NewRouter()
	r.Use(chimw.RequestID)
	r.Use(middleware.NewClientIPResolver(cfg.TrustedProxies).Middleware)
	r.Use(middleware.SecurityHeaders)
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(chimw.GetHead)
	// A missing Origin is tolerated only where curl-style testing is expected.
	r.Use(middleware.RequireSameOrigin(cfg.IsDevLike()))
	r.Use(visits.Middleware)

	mediaSrv := &mediaServer{messages: d.Messages, cache: d.Media}
	NewPublicHandler(cfg, d.Sources, d.Messages, d.Feedback, mediaSrv).RegisterRoutes(r)
	NewAdminHandler(cfg, d.Sessions, d.Sources, d.Messages, d.Visits, d.Alerts, d.Feedback, d.Crawls, mediaSrv).RegisterRoutes(r)

	if d.Static != nil {
		MountSPA(r, d.Static)
	}

	// Unknown API paths answer in JSON like every other API error.
	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		RespondError(w, http.StatusNotFound, "Not Found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, req *http.Request) {
		RespondError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	})

	return r, func() { visits.Close(5 * time.Second) }
}
