package middleware

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

type ctxKey int

const clientIPKey ctxKey = iota

const maxIPLen = 64

// ClientIPResolver decides who a request really came from. Proxy headers are
// only believed when the TCP peer is a configured trusted proxy; otherwise
// anybody could write "X-Forwarded-For: 1.2.3.4" and pick their own identity
// (and thereby escape any per-IP limit).
type ClientIPResolver struct {
	trusted []netip.Prefix
}

func NewClientIPResolver(trusted []netip.Prefix) *ClientIPResolver {
	return &ClientIPResolver{trusted: trusted}
}

func (c *ClientIPResolver) isTrusted(ip netip.Addr) bool {
	ip = ip.Unmap()
	for _, p := range c.trusted {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// peerAddr extracts the address of the TCP peer.
func peerAddr(r *http.Request) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	host = strings.Trim(host, "[]")
	if i := strings.IndexByte(host, '%'); i >= 0 { // IPv6 zone
		host = host[:i]
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

// Resolve returns the client address for r.
func (c *ClientIPResolver) Resolve(r *http.Request) string {
	peer, ok := peerAddr(r)
	if !ok {
		return truncateIP(r.RemoteAddr)
	}
	if !c.isTrusted(peer) {
		return peer.String()
	}

	// The peer is our own proxy. X-Forwarded-For is a chain: every proxy appends
	// the address it received the request from. Walk it from the right and take
	// the first hop that is not one of our proxies; everything left of that was
	// supplied by the client and is worthless.
	if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
		hops := strings.Split(strings.Join(xff, ","), ",")
		var leftmost netip.Addr
		for i := len(hops) - 1; i >= 0; i-- {
			hop, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
			if err != nil {
				break // garbage in the chain: do not trust any of it
			}
			hop = hop.Unmap()
			leftmost = hop
			if !c.isTrusted(hop) {
				return hop.String()
			}
		}
		if leftmost.IsValid() {
			return leftmost.String()
		}
	}
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
		if a, err := netip.ParseAddr(real); err == nil {
			return a.Unmap().String()
		}
	}
	return peer.String()
}

func truncateIP(s string) string {
	if len(s) > maxIPLen {
		return s[:maxIPLen]
	}
	return s
}

// Middleware stores the resolved address in the request context. Handlers read
// it with ClientIP.
func (c *ClientIPResolver) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := c.Resolve(r)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), clientIPKey, ip)))
	})
}

// ClientIP returns the address resolved by the middleware. Without the
// middleware it falls back to the TCP peer and never reads proxy headers.
func ClientIP(r *http.Request) string {
	if ip, ok := r.Context().Value(clientIPKey).(string); ok && ip != "" {
		return ip
	}
	if peer, ok := peerAddr(r); ok {
		return peer.String()
	}
	return truncateIP(r.RemoteAddr)
}
