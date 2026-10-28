package middleware

import (
	"net/http"
	"net/url"
	"strings"
)

// RequireSameOrigin rejects state-changing API requests that do not come from
// the site itself. Browsers attach an Origin header to every cross-origin and
// every non-GET request, so a page on another site cannot forge one; this is
// the same check the Python service applied on its mutating routes, and it
// complements the SameSite=Strict session cookie (which does not help against
// the unauthenticated endpoints, nor against sibling subdomains).
//
// A missing Origin is refused unless allowMissing is set (development / tests,
// where curl-style clients are convenient).
func RequireSameOrigin(allowMissing bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isUnsafeMethod(r.Method) || !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			switch {
			case origin == "" && allowMissing:
			case origin == "":
				writeJSONError(w, http.StatusForbidden, "Origin header required")
				return
			case !sameOrigin(origin, r.Host):
				writeJSONError(w, http.StatusForbidden, "Cross-origin request rejected")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isUnsafeMethod(m string) bool {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return false
	}
	return true
}

// sameOrigin compares the Origin header with the Host the request was sent to:
// scheme must be http(s), hostnames equal (case-insensitive, trailing dot
// ignored) and ports equal after applying the scheme's default.
func sameOrigin(origin, host string) bool {
	o, err := url.Parse(origin)
	if err != nil || (o.Scheme != "http" && o.Scheme != "https") || o.Hostname() == "" || o.Path != "" && o.Path != "/" {
		return false
	}
	h, err := url.Parse("//" + strings.TrimSpace(host))
	if err != nil || h.Hostname() == "" {
		return false
	}
	if normHost(o.Hostname()) != normHost(h.Hostname()) {
		return false
	}
	oPort := o.Port()
	if oPort == "" {
		oPort = defaultPort(o.Scheme)
	}
	hPort := h.Port()
	switch {
	case hPort != "":
		return oPort == hPort
	default:
		// The Host header carries no port, so it is the scheme's default.
		return oPort == defaultPort(o.Scheme)
	}
}

func normHost(h string) string { return strings.ToLower(strings.TrimSuffix(h, ".")) }

func defaultPort(scheme string) string {
	if scheme == "https" {
		return "443"
	}
	return "80"
}
