package middleware

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func ok(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }

// ---- sessions ---------------------------------------------------------------

func TestSessionLifecycle(t *testing.T) {
	m := NewSessionManager("a-secret-that-is-long-enough-0123456789", time.Hour)
	now := time.Unix(1_800_000_000, 0)
	m.now = func() time.Time { return now }

	token, exp, err := m.Issue()
	if err != nil || exp != now.Unix()+3600 {
		t.Fatalf("Issue: %v exp=%d", err, exp)
	}
	if got := m.Verify(token); got != exp {
		t.Fatalf("Verify = %d, want %d", got, exp)
	}

	now = now.Add(59 * time.Minute)
	if m.Verify(token) != exp {
		t.Fatal("token should still be valid just before expiry")
	}
	now = now.Add(2 * time.Minute)
	if m.Verify(token) != 0 {
		t.Fatal("expired token accepted")
	}
}

func TestSessionRejectsForgeries(t *testing.T) {
	m := NewSessionManager("a-secret-that-is-long-enough-0123456789", time.Hour)
	token, exp, _ := m.Issue()
	parts := strings.Split(token, ".")

	// A payload edited to live longer, with the old signature.
	raw, _ := base64.RawURLEncoding.DecodeString(parts[0])
	var p SessionPayload
	_ = json.Unmarshal(raw, &p)
	p.Exp = exp + 10_000
	edited, _ := json.Marshal(p)
	forged := base64.RawURLEncoding.EncodeToString(edited) + "." + parts[1]

	// Correctly signed with the wrong key, and with the right key but an
	// unregistered session id (what a leaked/default secret would allow).
	other := NewSessionManager("a-completely-different-secret-0123456789", time.Hour)
	foreign, _, _ := other.Issue()
	unregistered := func() string {
		payload, _ := json.Marshal(SessionPayload{Exp: time.Now().Add(time.Hour).Unix(), SID: "never-issued"})
		b64 := base64.RawURLEncoding.EncodeToString(payload)
		return b64 + "." + base64.RawURLEncoding.EncodeToString(m.sign(b64))
	}()

	for name, bad := range map[string]string{
		"empty":               "",
		"no dot":              "abc",
		"three parts":         token + ".x",
		"edited payload":      forged,
		"truncated signature": token[:len(token)-3],
		"foreign key":         foreign,
		"unregistered sid":    unregistered,
		"garbage":             "!!!.???",
		"only dots":           "..",
		"huge":                strings.Repeat("A", 100_000) + "." + strings.Repeat("B", 100_000),
	} {
		if m.Verify(bad) != 0 {
			t.Errorf("%s: forged token accepted", name)
		}
	}
	if m.Verify(token) != exp {
		t.Fatal("the genuine token must still work")
	}
}

func TestSessionRevocationAndLimits(t *testing.T) {
	m := NewSessionManager("a-secret-that-is-long-enough-0123456789", time.Hour)
	a, _, _ := m.Issue()
	b, expB, _ := m.Issue()
	m.Revoke(a)
	if m.Verify(a) != 0 || m.Verify(b) != expB {
		t.Fatal("logout must revoke exactly one session")
	}
	m.Revoke("garbage") // must not panic or revoke anything
	m.Revoke(a[:len(a)-2] + "xx")
	if m.Verify(b) != expB {
		t.Fatal("an invalid token revoked a session")
	}

	for i := 0; i < maxActiveSessions+50; i++ {
		if _, _, err := m.Issue(); err != nil {
			t.Fatal(err)
		}
	}
	if m.Active() > maxActiveSessions {
		t.Fatalf("session table grew to %d", m.Active())
	}
}

func TestRequireAuth(t *testing.T) {
	m := NewSessionManager("a-secret-that-is-long-enough-0123456789", time.Hour)
	h := RequireAuth(m)(http.HandlerFunc(ok))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/admin/x", nil))
	if rec.Code != 401 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") ||
		!strings.Contains(rec.Body.String(), `"detail"`) {
		t.Fatalf("unauthenticated: %d %q %q", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}

	token, _, _ := m.Issue()
	req := httptest.NewRequest("GET", "/api/admin/x", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Fatalf("valid session rejected: %d", rec.Code)
	}

	req = httptest.NewRequest("GET", "/api/admin/x", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token + "tamper"})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("tampered cookie: %d", rec.Code)
	}
}

// ---- client IP ---------------------------------------------------------------

func prefixes(t *testing.T, specs ...string) []netip.Prefix {
	t.Helper()
	var out []netip.Prefix
	for _, s := range specs {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func TestClientIPResolution(t *testing.T) {
	proxies := NewClientIPResolver(prefixes(t, "10.0.0.0/8", "172.16.0.0/12", "127.0.0.0/8", "::1/128"))
	cases := []struct {
		name   string
		peer   string
		xff    []string
		realIP string
		want   string
	}{
		{"direct client", "203.0.113.9:5555", nil, "", "203.0.113.9"},
		{"direct client forging XFF", "203.0.113.9:5555", []string{"1.2.3.4"}, "5.6.7.8", "203.0.113.9"},
		{"proxy adds the real client", "172.18.0.1:4000", []string{"198.51.100.5"}, "", "198.51.100.5"},
		{"client forged the left side", "172.18.0.1:4000", []string{"6.6.6.6, 198.51.100.5"}, "", "198.51.100.5"},
		{"two proxies in the chain", "10.0.0.1:1", []string{"198.51.100.5, 10.0.0.2"}, "", "198.51.100.5"},
		{"header sent twice", "10.0.0.1:1", []string{"6.6.6.6", "198.51.100.5"}, "", "198.51.100.5"},
		{"only trusted hops", "10.0.0.1:1", []string{"10.0.0.7, 10.0.0.2"}, "", "10.0.0.7"},
		{"garbage chain falls back", "10.0.0.1:1", []string{"unknown"}, "", "10.0.0.1"},
		{"garbage then X-Real-IP", "10.0.0.1:1", []string{"unknown"}, "198.51.100.77", "198.51.100.77"},
		{"X-Real-IP only", "127.0.0.1:1", nil, "198.51.100.77", "198.51.100.77"},
		{"bad X-Real-IP", "127.0.0.1:1", nil, "<script>", "127.0.0.1"},
		{"IPv6 client behind proxy", "[::1]:9", []string{"2001:db8::7"}, "", "2001:db8::7"},
		{"IPv4-mapped peer", "[::ffff:172.18.0.1]:9", []string{"198.51.100.5"}, "", "198.51.100.5"},
		{"peer without port", "203.0.113.9", []string{"1.2.3.4"}, "", "203.0.113.9"},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = c.peer
		for _, v := range c.xff {
			req.Header.Add("X-Forwarded-For", v)
		}
		if c.realIP != "" {
			req.Header.Set("X-Real-IP", c.realIP)
		}
		if got := proxies.Resolve(req); got != c.want {
			t.Errorf("%s: Resolve = %q, want %q", c.name, got, c.want)
		}
	}

	// Nobody is trusted: headers are ignored whoever sends them.
	strict := NewClientIPResolver(nil)
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:1"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := strict.Resolve(req); got != "10.0.0.1" {
		t.Errorf("TRUSTED_PROXIES=none still believed X-Forwarded-For: %q", got)
	}
}

func TestClientIPWithoutMiddlewareIgnoresHeaders(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "203.0.113.9:80"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	req.Header.Set("X-Real-IP", "5.6.7.8")
	if got := ClientIP(req); got != "203.0.113.9" {
		t.Fatalf("ClientIP = %q", got)
	}

	var seen string
	h := NewClientIPResolver(nil).Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen = ClientIP(r) }))
	h.ServeHTTP(httptest.NewRecorder(), req)
	if seen != "203.0.113.9" {
		t.Fatalf("via middleware = %q", seen)
	}
}

// ---- rate limiter ------------------------------------------------------------

func TestRateLimiterWindow(t *testing.T) {
	l := NewRateLimiter(3, time.Minute)
	now := time.Unix(1_000_000, 0)
	l.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if allowed, _ := l.Hit("a"); !allowed {
			t.Fatalf("attempt %d refused", i+1)
		}
		now = now.Add(5 * time.Second)
	}
	allowed, retry := l.Hit("a")
	if allowed || retry <= 0 || retry > time.Minute {
		t.Fatalf("4th attempt: allowed=%v retry=%v", allowed, retry)
	}
	if allowed, _ := l.Hit("b"); !allowed {
		t.Fatal("keys must be independent")
	}

	now = now.Add(retry + time.Second)
	if allowed, _ := l.Hit("a"); !allowed {
		t.Fatal("the window should have freed a slot")
	}

	for i := 0; i < 3; i++ {
		l.Hit("c")
	}
	l.Reset("c")
	if allowed, _ := l.Hit("c"); !allowed {
		t.Fatal("Reset must clear the counter")
	}
}

func TestRateLimiterIsAtomicUnderConcurrency(t *testing.T) {
	// 300 parallel guesses must let exactly `max` through, not "max plus however
	// many raced past the check".
	l := NewRateLimiter(5, time.Hour)
	var allowedCount atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 300; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if allowed, _ := l.Hit("attacker"); allowed {
				allowedCount.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if allowedCount.Load() != 5 {
		t.Fatalf("%d attempts passed, want exactly 5", allowedCount.Load())
	}
}

func TestRateLimiterBoundsMemory(t *testing.T) {
	l := NewRateLimiter(1, time.Hour)
	l.maxKeys = 100
	for i := 0; i < 1000; i++ {
		l.Hit(strings.Repeat("k", 1) + string(rune('a'+i%26)) + string(rune(0x4e00+i)))
	}
	if l.Len() > 100 {
		t.Fatalf("limiter tracks %d keys, cap is 100", l.Len())
	}
}

// ---- same origin -------------------------------------------------------------

func TestSameOrigin(t *testing.T) {
	cases := []struct {
		origin, host string
		want         bool
	}{
		{"https://example.com", "example.com", true},
		{"https://example.com", "example.com:443", true},
		{"http://example.com", "example.com", true},
		{"https://EXAMPLE.com.", "example.com", true},
		{"http://localhost:8000", "localhost:8000", true},
		{"http://127.0.0.1:18099", "127.0.0.1:18099", true},
		{"http://[::1]:8000", "[::1]:8000", true},
		{"https://example.com:8443", "example.com:8443", true},

		{"https://evil.example", "example.com", false},
		{"https://example.com.evil.example", "example.com", false},
		{"https://example.com", "example.com:8443", false},
		{"https://example.com:8443", "example.com", false},
		{"http://example.com:8000", "example.com:9000", false},
		{"null", "example.com", false},
		{"", "example.com", false},
		{"file://", "example.com", false},
		{"ftp://example.com", "example.com", false},
		{"https://example.com/path", "example.com", false},
		{"https://example.com", "", false},
		{"https://example.com", "exa mple.com", false},
	}
	for _, c := range cases {
		if got := sameOrigin(c.origin, c.host); got != c.want {
			t.Errorf("sameOrigin(%q, %q) = %v, want %v", c.origin, c.host, got, c.want)
		}
	}
}

func TestRequireSameOriginMiddleware(t *testing.T) {
	strict := RequireSameOrigin(false)(http.HandlerFunc(ok))
	lenient := RequireSameOrigin(true)(http.HandlerFunc(ok))

	do := func(h http.Handler, method, path, origin string) int {
		req := httptest.NewRequest(method, "http://example.com"+path, nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	for _, method := range []string{"POST", "PATCH", "PUT", "DELETE"} {
		if c := do(strict, method, "/api/auth/login", ""); c != 403 {
			t.Errorf("%s without Origin = %d, want 403", method, c)
		}
		if c := do(strict, method, "/api/auth/login", "https://evil.example"); c != 403 {
			t.Errorf("%s cross-origin = %d, want 403", method, c)
		}
		if c := do(strict, method, "/api/auth/login", "http://example.com"); c != 204 {
			t.Errorf("%s same-origin = %d, want 204", method, c)
		}
	}
	for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
		if c := do(strict, method, "/api/admin/sources", ""); c != 204 {
			t.Errorf("%s must not need an Origin, got %d", method, c)
		}
	}
	if c := do(strict, "POST", "/not-api", ""); c != 204 {
		t.Errorf("non-API path was blocked: %d", c)
	}
	if c := do(lenient, "POST", "/api/auth/login", ""); c != 204 {
		t.Errorf("development mode should allow a missing Origin, got %d", c)
	}
	if c := do(lenient, "POST", "/api/auth/login", "https://evil.example"); c != 403 {
		t.Errorf("a wrong Origin is refused even in development, got %d", c)
	}
}

// ---- security headers --------------------------------------------------------

func TestSecurityHeaders(t *testing.T) {
	h := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/public/override" {
			w.Header().Set("Cache-Control", "public, max-age=60")
		}
	}))
	get := func(path string) http.Header {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec.Header()
	}

	hdr := get("/health")
	csp := hdr.Get("Content-Security-Policy")
	for _, must := range []string{"default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"} {
		if !strings.Contains(csp, must) {
			t.Errorf("CSP lacks %q: %s", must, csp)
		}
	}
	for _, mustNot := range []string{"https:", "'unsafe-eval'", "*", "script-src 'self' 'unsafe-inline'"} {
		if strings.Contains(csp, mustNot) {
			t.Errorf("CSP must not contain %q: %s", mustNot, csp)
		}
	}
	if hdr.Get("X-Content-Type-Options") != "nosniff" || hdr.Get("X-Frame-Options") != "DENY" || hdr.Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("headers: %v", hdr)
	}
	if hdr.Get("Cache-Control") != "" {
		t.Errorf("non-API paths must be left to their handler, got %q", hdr.Get("Cache-Control"))
	}

	if got := get("/assets/app-abc.js").Get("Cache-Control"); got != "" {
		t.Errorf("immutable caching must only be set by the file server for files that exist, got %q", got)
	}
	if got := get("/api/public/sources").Get("Cache-Control"); got != "no-cache" {
		t.Errorf("public API cache = %q", got)
	}
	if got := get("/api/public/override").Get("Cache-Control"); got != "public, max-age=60" {
		t.Errorf("a handler could not override the default: %q", got)
	}
	admin := get("/api/admin/sources")
	if admin.Get("Cache-Control") != "private, no-store" || !strings.Contains(admin.Get("Vary"), "Cookie") {
		t.Errorf("admin API headers: %v", admin)
	}
}

// ---- visit recorder ----------------------------------------------------------

type fakeVisits struct {
	mu       sync.Mutex
	events   []string
	pruned   []time.Time
	gate     chan struct{} // when set, RecordVisit blocks until closed
	failing  atomic.Bool
	panicky  atomic.Bool
	attempts atomic.Int32
}

func (f *fakeVisits) RecordVisit(ip, path, method, ua, ref string) error {
	f.attempts.Add(1)
	if f.gate != nil {
		<-f.gate
	}
	if f.panicky.Load() {
		panic("db exploded")
	}
	if f.failing.Load() {
		return errors.New("database is locked")
	}
	f.mu.Lock()
	f.events = append(f.events, ip+" "+method+" "+path)
	f.mu.Unlock()
	return nil
}

func (f *fakeVisits) PruneVisits(before time.Time) (int64, error) {
	f.mu.Lock()
	f.pruned = append(f.pruned, before)
	f.mu.Unlock()
	return 0, nil
}

func (f *fakeVisits) snapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.events...)
}

func TestVisitRecorderRecordsTheRightRequests(t *testing.T) {
	store := &fakeVisits{}
	rec := NewVisitRecorder(store, 16, 90*24*time.Hour)
	h := NewClientIPResolver(nil).Middleware(rec.Middleware(http.HandlerFunc(ok)))

	for _, c := range []struct{ method, path string }{
		{"GET", "/"}, {"GET", "/api/public/messages"}, {"GET", "/api/public/sources"},
		{"GET", "/api/public/media/1/0"}, {"GET", "/api/admin/sources"}, {"GET", "/assets/x.js"},
		{"POST", "/api/public/feedback"}, {"HEAD", "/"}, {"GET", "/admin"},
	} {
		req := httptest.NewRequest(c.method, c.path, nil)
		req.RemoteAddr = "203.0.113.9:1"
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	rec.Close(2 * time.Second)

	want := []string{"203.0.113.9 GET /", "203.0.113.9 GET /api/public/messages", "203.0.113.9 GET /api/public/sources"}
	got := store.snapshot()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("recorded %v\nwant     %v", got, want)
	}
	if len(store.pruned) == 0 {
		t.Fatal("retention pruning never ran")
	}
	if age := time.Since(store.pruned[0]); age < 89*24*time.Hour || age > 91*24*time.Hour {
		t.Fatalf("prune cutoff is %v old, want ~90 days", age)
	}
}

func TestVisitRecorderNeverBlocksRequests(t *testing.T) {
	store := &fakeVisits{gate: make(chan struct{})}
	rec := NewVisitRecorder(store, 4, 0)
	h := rec.Middleware(http.HandlerFunc(ok))

	done := make(chan struct{})
	go func() {
		for i := 0; i < 500; i++ {
			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = "203.0.113.9:1"
			h.ServeHTTP(httptest.NewRecorder(), req)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("requests blocked behind a stuck database")
	}
	if rec.Dropped() < 400 {
		t.Fatalf("dropped = %d; a full queue should shed load", rec.Dropped())
	}
	close(store.gate)
	rec.Close(2 * time.Second)
	if n := len(store.snapshot()); n == 0 || n > 10 {
		t.Fatalf("recorded %d events, the bounded queue should have kept only a handful", n)
	}
}

func TestVisitRecorderSurvivesStoreFailuresAndClose(t *testing.T) {
	store := &fakeVisits{}
	rec := NewVisitRecorder(store, 16, 0)
	h := rec.Middleware(http.HandlerFunc(ok))
	hit := func() {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = "203.0.113.9:1"
		h.ServeHTTP(httptest.NewRecorder(), req)
	}

	waitAttempts := func(n int32) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for store.attempts.Load() < n {
			if time.Now().After(deadline) {
				t.Fatalf("worker never reached attempt %d", n)
			}
			time.Sleep(2 * time.Millisecond)
		}
	}
	store.failing.Store(true)
	hit()
	waitAttempts(1)
	store.failing.Store(false)
	store.panicky.Store(true)
	hit()
	waitAttempts(2)
	store.panicky.Store(false)
	hit()
	waitAttempts(3)
	rec.Close(2 * time.Second)
	if n := len(store.snapshot()); n != 1 {
		t.Fatalf("worker did not recover from errors and panics (recorded %d)", n)
	}

	// Late requests after shutdown are ignored, not a panic on a closed channel.
	hit()
	rec.Close(time.Second) // idempotent
}
