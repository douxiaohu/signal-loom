package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestLoginSetsHardenedCookie(t *testing.T) {
	h := newHarness(t)
	rec := h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey})
	expectStatus(t, rec, 200)

	body := decodeMap(t, rec)
	if body["authenticated"] != true || body["expires_at"] == nil {
		t.Fatalf("body = %v", body)
	}
	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "tg_session" {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no session cookie")
	}
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/" || cookie.MaxAge != 12*3600 {
		t.Fatalf("cookie attributes: %+v", cookie)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("login response must not be cached, got %q", got)
	}

	expectStatus(t, h.do("GET", "/api/admin/sources", nil, withCookie(cookie)), 200)
	session := decodeMap(t, h.do("GET", "/api/session", nil, withCookie(cookie)))
	if session["authenticated"] != true {
		t.Fatalf("session = %v", session)
	}
	anon := decodeMap(t, h.do("GET", "/api/session", nil))
	if anon["authenticated"] != false || anon["expires_at"] != nil {
		t.Fatalf("anonymous session = %v", anon)
	}
}

func TestLoginRejectsBadRequests(t *testing.T) {
	// Throttling has its own tests; here every case must reach the validation.
	h := newHarness(t, func(c *configT) { c.LoginMaxAttempts = 10_000 })
	big := strings.Repeat("x", 1<<20)
	cases := []struct {
		name string
		do   func() *httptest.ResponseRecorder
		want int
	}{
		{"wrong key", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", map[string]string{"api_key": "nope"})
		}, 401},
		{"empty key", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", map[string]string{"api_key": ""})
		}, 400},
		{"key longer than 256", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", map[string]string{"api_key": strings.Repeat("k", 257)})
		}, 400},
		{"missing field", func() *httptest.ResponseRecorder { return h.do("POST", "/api/auth/login", `{}`) }, 400},
		{"wrong type", func() *httptest.ResponseRecorder { return h.do("POST", "/api/auth/login", `{"api_key": 12345}`) }, 422},
		{"malformed JSON", func() *httptest.ResponseRecorder { return h.do("POST", "/api/auth/login", `{"api_key":`) }, 400},
		{"empty body", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", nil, withHeader("Content-Type", "application/json"))
		}, 400},
		{"trailing data", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", `{"api_key":"`+testAdminKey+`"} {"x":1}`)
		}, 400},
		{"body of 1 MiB", func() *httptest.ResponseRecorder { return h.do("POST", "/api/auth/login", `{"api_key":"`+big+`"}`) }, 413},
		{"form content type", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", `{"api_key":"`+testAdminKey+`"}`, withHeader("Content-Type", "text/plain"))
		}, 415},
		{"urlencoded content type", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", "api_key="+testAdminKey, withHeader("Content-Type", "application/x-www-form-urlencoded"))
		}, 415},
		{"missing Origin", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey}, withoutHeader("Origin"))
		}, 403},
		{"cross-site Origin", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey}, withHeader("Origin", "https://evil.example"))
		}, 403},
		{"Origin null", func() *httptest.ResponseRecorder {
			return h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey}, withHeader("Origin", "null"))
		}, 403},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := tc.do()
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d; body %s", rec.Code, tc.want, truncateForLog(rec.Body.String()))
			}
			if !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") || detailOf(t, rec) == "" {
				t.Fatalf("errors must be JSON with a detail: %q", rec.Body.String())
			}
			for _, c := range rec.Result().Cookies() {
				if c.Name == "tg_session" && c.MaxAge >= 0 {
					t.Fatal("a failed login must not issue a session")
				}
			}
		})
	}
}

func TestLoginIsThrottledLikeThePythonService(t *testing.T) {
	h := newHarness(t)
	wrong := map[string]string{"api_key": "wrong"}
	right := map[string]string{"api_key": testAdminKey}

	for i := 1; i <= 5; i++ {
		expectStatus(t, h.do("POST", "/api/auth/login", wrong), 401)
	}
	locked := h.do("POST", "/api/auth/login", wrong)
	expectStatus(t, locked, 429)
	if retry, err := strconv.Atoi(locked.Header().Get("Retry-After")); err != nil || retry < 1 || retry > 901 {
		t.Fatalf("Retry-After = %q", locked.Header().Get("Retry-After"))
	}
	// While locked out even the correct key is refused (no oracle for guessers).
	expectStatus(t, h.do("POST", "/api/auth/login", right), 429)

	// Other clients are unaffected.
	expectStatus(t, h.do("POST", "/api/auth/login", right, withPeer("198.51.100.20:4000")), 200)
}

func TestSuccessfulLoginResetsTheCounter(t *testing.T) {
	h := newHarness(t)
	for round := 0; round < 3; round++ {
		for i := 0; i < 4; i++ {
			expectStatus(t, h.do("POST", "/api/auth/login", map[string]string{"api_key": "wrong"}), 401)
		}
		expectStatus(t, h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey}), 200)
	}
}

func TestSpoofedForwardingHeadersDoNotEscapeTheLimit(t *testing.T) {
	h := newHarness(t)
	// A direct (untrusted) client rotating X-Forwarded-For / X-Real-IP.
	statuses := map[int]int{}
	for i := 0; i < 30; i++ {
		rec := h.do("POST", "/api/auth/login", map[string]string{"api_key": "wrong"},
			withHeader("X-Forwarded-For", "10.9.8."+strconv.Itoa(i)),
			withHeader("X-Real-IP", "172.16.0."+strconv.Itoa(i)),
			withPeer("203.0.113.50:5000"))
		statuses[rec.Code]++
	}
	if statuses[401] != 5 || statuses[429] != 25 {
		t.Fatalf("spoofing headers bypassed the throttle: %v", statuses)
	}
}

func TestThrottleIsPerClientBehindATrustedProxy(t *testing.T) {
	h := newHarness(t)
	proxy := withPeer("172.18.0.1:3000") // the reverse proxy in front of us
	attacker := withHeader("X-Forwarded-For", "6.6.6.6, 198.51.100.1")
	victim := withHeader("X-Forwarded-For", "198.51.100.2")

	for i := 0; i < 5; i++ {
		expectStatus(t, h.do("POST", "/api/auth/login", map[string]string{"api_key": "wrong"}, proxy, attacker), 401)
	}
	expectStatus(t, h.do("POST", "/api/auth/login", map[string]string{"api_key": "wrong"}, proxy, attacker), 429)
	// The real administrator, coming from another address, can still log in;
	// one client's failures do not lock everybody out.
	expectStatus(t, h.do("POST", "/api/auth/login", map[string]string{"api_key": testAdminKey}, proxy, victim), 200)
	// ...and the attacker cannot reset the counter by rewriting the left side of the chain.
	forged := withHeader("X-Forwarded-For", "9.9.9.9, 198.51.100.1")
	expectStatus(t, h.do("POST", "/api/auth/login", map[string]string{"api_key": "wrong"}, proxy, forged), 429)
}

func TestParallelGuessesAreCounted(t *testing.T) {
	h := newHarness(t)
	var unauthorized, throttled, other atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			rec := h.do("POST", "/api/auth/login", map[string]string{"api_key": "guess-" + strconv.Itoa(i)})
			switch rec.Code {
			case 401:
				unauthorized.Add(1)
			case 429:
				throttled.Add(1)
			default:
				other.Add(1)
			}
		}(i)
	}
	close(start)
	wg.Wait()
	if unauthorized.Load() != 5 || throttled.Load() != 195 || other.Load() != 0 {
		t.Fatalf("200 parallel guesses: %d reached the key check, %d throttled, %d other (want 5 / 195 / 0)",
			unauthorized.Load(), throttled.Load(), other.Load())
	}
}

func TestLogoutRevokesTheSession(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	expectStatus(t, h.do("GET", "/api/admin/sources", nil, withCookie(cookie)), 200)

	rec := h.do("POST", "/api/auth/logout", nil, withCookie(cookie))
	expectStatus(t, rec, 204)
	cleared := false
	for _, c := range rec.Result().Cookies() {
		if c.Name == "tg_session" && c.MaxAge < 0 && c.Value == "" {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("logout did not clear the cookie")
	}

	// A copy of the cookie taken before logout is dead.
	expectStatus(t, h.do("GET", "/api/admin/sources", nil, withCookie(cookie)), 401)
	if decodeMap(t, h.do("GET", "/api/session", nil, withCookie(cookie)))["authenticated"] != false {
		t.Fatal("session still authenticated after logout")
	}
	// Logout needs the same-origin check as every other mutation.
	expectStatus(t, h.do("POST", "/api/auth/logout", nil, withHeader("Origin", "https://evil.example")), 403)
}

func TestEveryAdminRouteRequiresASession(t *testing.T) {
	h := newHarness(t)
	routes := []struct{ method, path string }{
		{"GET", "/api/admin/sources"},
		{"POST", "/api/admin/sources"},
		{"PATCH", "/api/admin/sources/1"},
		{"POST", "/api/admin/sources/1/crawl-now"},
		{"GET", "/api/admin/messages"},
		{"GET", "/api/admin/media/1/0"},
		{"GET", "/api/admin/operations/summary"},
		{"GET", "/api/admin/overview"},
		{"GET", "/api/admin/visits"},
		{"GET", "/api/admin/rules"},
		{"POST", "/api/admin/rules"},
		{"PATCH", "/api/admin/rules/1"},
		{"GET", "/api/admin/matches"},
		{"POST", "/api/admin/matches/1/acknowledge"},
		{"POST", "/api/admin/matches/1/resolve"},
		{"GET", "/api/admin/feedback"},
		{"PATCH", "/api/admin/feedback/1"},
	}
	for _, rt := range routes {
		var body any
		if rt.method != "GET" {
			body = map[string]any{}
		}
		rec := h.do(rt.method, rt.path, body)
		if rec.Code != 401 {
			t.Errorf("%s %s without a session = %d, want 401", rt.method, rt.path, rec.Code)
			continue
		}
		if detailOf(t, rec) == "" {
			t.Errorf("%s %s: 401 without a JSON detail", rt.method, rt.path)
		}
		forged := h.do(rt.method, rt.path, body, withCookie(&http.Cookie{Name: "tg_session", Value: "e30.AAAA"}))
		if forged.Code != 401 {
			t.Errorf("%s %s with a forged cookie = %d, want 401", rt.method, rt.path, forged.Code)
		}
	}
}
