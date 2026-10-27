package middleware

import (
	"net"
	"net/http"
	"strings"

	"telegram-radar/internal/repository"
)

// SecurityHeaders 添加生产安全头（CSP、X-Frame-Options 等）
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; "+
				"style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "+
				"frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")

		path := r.URL.Path
		if strings.HasPrefix(path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else if strings.HasPrefix(path, "/api/public/") {
			if w.Header().Get("Cache-Control") == "" {
				w.Header().Set("Cache-Control", "no-cache")
			}
		} else if strings.HasPrefix(path, "/api/") {
			w.Header().Set("Cache-Control", "private, no-store")
			w.Header().Set("Vary", "Cookie")
		}

		next.ServeHTTP(w, r)
	})
}

// ClientIP 解析客户端真实 IP
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

// SiteVisitAuditor 记录公开页面的访问统计流水
func SiteVisitAuditor(visitRepo *repository.VisitRepository) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := r.URL.Path
			if r.Method == http.MethodGet && (path == "/" || (strings.HasPrefix(path, "/api/public/") && !strings.HasPrefix(path, "/api/public/media"))) {
				ip := ClientIP(r)
				ua := r.UserAgent()
				ref := r.Referer()
				go func() {
					_ = visitRepo.RecordVisit(ip, path, r.Method, ua, ref)
				}()
			}
			next.ServeHTTP(w, r)
		})
	}
}
