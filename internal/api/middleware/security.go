package middleware

import (
	"net/http"
	"strings"
)

// contentSecurityPolicy is deliberately tight: everything is served from our
// own origin, images and media included (remote media is proxied through the
// cache), so nothing needs to be loaded from third parties.
const contentSecurityPolicy = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
	"style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
	"frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

// SecurityHeaders adds the security headers and the default cache policy of
// API responses. Static files choose their own Cache-Control (an "immutable"
// header must only ever accompany a file that really exists, so it is not set
// here); handlers may override the API defaults.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")

		path := r.URL.Path
		switch {
		case strings.HasPrefix(path, "/api/public/"):
			h.Set("Cache-Control", "no-cache")
		case strings.HasPrefix(path, "/api/"):
			h.Set("Cache-Control", "private, no-store")
			h.Set("Vary", "Cookie")
		}
		next.ServeHTTP(w, r)
	})
}
