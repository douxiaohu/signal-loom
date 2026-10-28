package middleware

import (
	"sync"
	"time"
)

// RateLimiter is a sliding-window counter keyed by an arbitrary string
// (normally a client IP). It is safe for concurrent use.
//
// Hit checks and records in one atomic step. That matters for the login
// endpoint: with a separate "check" and "record after the password was
// verified", a client could fire hundreds of parallel guesses that all pass the
// check before the first failure is recorded.
type RateLimiter struct {
	max    int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	hits    map[string][]time.Time
	maxKeys int
}

func NewRateLimiter(max int, window time.Duration) *RateLimiter {
	if max < 1 {
		max = 1
	}
	if window <= 0 {
		window = time.Minute
	}
	return &RateLimiter{max: max, window: window, now: time.Now, hits: make(map[string][]time.Time), maxKeys: 50_000}
}

// prune drops expired entries of one key and returns the live ones.
func (l *RateLimiter) prune(key string, now time.Time) []time.Time {
	live := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.window {
			live = append(live, t)
		}
	}
	if len(live) == 0 {
		delete(l.hits, key)
		return nil
	}
	l.hits[key] = live
	return live
}

// Hit records an event for key unless the limit is already reached. It returns
// whether the event was allowed and, if not, how long until a slot frees up.
func (l *RateLimiter) Hit(key string) (allowed bool, retryAfter time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	live := l.prune(key, now)
	if len(live) >= l.max {
		return false, live[0].Add(l.window).Sub(now)
	}
	if len(l.hits) >= l.maxKeys {
		l.evictLocked(now)
	}
	l.hits[key] = append(live, now)
	return true, 0
}

// Reset forgets key (called after a successful login).
func (l *RateLimiter) Reset(key string) {
	l.mu.Lock()
	delete(l.hits, key)
	l.mu.Unlock()
}

// evictLocked bounds memory: first drop everything expired, then, if the table
// is still full, arbitrary keys.
func (l *RateLimiter) evictLocked(now time.Time) {
	for k := range l.hits {
		l.prune(k, now)
	}
	for k := range l.hits {
		if len(l.hits) < l.maxKeys {
			return
		}
		delete(l.hits, k)
	}
}

// Len reports the number of tracked keys (for tests).
func (l *RateLimiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.hits)
}
