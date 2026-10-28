package middleware

import (
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"telegram-radar/internal/safe"
)

// VisitStore is where page views end up (*repository.VisitRepository).
type VisitStore interface {
	RecordVisit(ip, path, method, userAgent, referer string) error
	PruneVisits(before time.Time) (int64, error)
}

type visit struct{ ip, path, method, userAgent, referer string }

// VisitRecorder writes page views from a single background worker fed by a
// bounded queue. A request never waits for the database and a traffic flood
// cannot pile up goroutines: when the queue is full the view is dropped (and
// counted). It also deletes visits older than the retention period.
type VisitRecorder struct {
	store     VisitStore
	retention time.Duration

	queue   chan visit
	mu      sync.RWMutex // guards closed and sends on queue
	closed  bool
	done    chan struct{}
	dropped atomic.Int64
}

func NewVisitRecorder(store VisitStore, buffer int, retention time.Duration) *VisitRecorder {
	if buffer < 1 {
		buffer = 1024
	}
	v := &VisitRecorder{
		store:     store,
		retention: retention,
		queue:     make(chan visit, buffer),
		done:      make(chan struct{}),
	}
	go v.run()
	return v
}

func (v *VisitRecorder) run() {
	defer close(v.done)
	prune := func() {
		if v.retention <= 0 {
			return
		}
		safe.Run("prune visits", func() {
			if n, err := v.store.PruneVisits(time.Now().Add(-v.retention)); err != nil {
				log.Printf("[visits] prune failed: %v", err)
			} else if n > 0 {
				log.Printf("[visits] pruned %d visits older than %v", n, v.retention)
			}
		})
	}
	prune()
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()

	var lastLogged time.Time
	for {
		select {
		case ev, ok := <-v.queue:
			if !ok {
				return
			}
			safe.Run("record visit", func() {
				if err := v.store.RecordVisit(ev.ip, ev.path, ev.method, ev.userAgent, ev.referer); err != nil &&
					time.Since(lastLogged) > time.Minute {
					lastLogged = time.Now()
					log.Printf("[visits] recording failed: %v", err)
				}
			})
		case <-ticker.C:
			prune()
		}
	}
}

// shouldRecord matches the Python service: GETs of the home page and of the
// public API, except media downloads.
func shouldRecord(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	p := r.URL.Path
	return p == "/" || (strings.HasPrefix(p, "/api/public/") && !strings.HasPrefix(p, "/api/public/media"))
}

// Middleware counts page views.
func (v *VisitRecorder) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if shouldRecord(r) {
			v.enqueue(visit{
				ip:        ClientIP(r),
				path:      r.URL.Path,
				method:    r.Method,
				userAgent: r.UserAgent(),
				referer:   r.Referer(),
			})
		}
		next.ServeHTTP(w, r)
	})
}

func (v *VisitRecorder) enqueue(ev visit) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	if v.closed {
		return
	}
	select {
	case v.queue <- ev:
	default:
		v.dropped.Add(1)
	}
}

// Dropped reports how many views were discarded because the queue was full.
func (v *VisitRecorder) Dropped() int64 { return v.dropped.Load() }

// Close stops accepting views, writes what is queued and stops the worker.
func (v *VisitRecorder) Close(timeout time.Duration) {
	v.mu.Lock()
	if !v.closed {
		v.closed = true
		close(v.queue)
	}
	v.mu.Unlock()
	select {
	case <-v.done:
	case <-time.After(timeout):
		log.Printf("[visits] worker did not drain within %v", timeout)
	}
}
