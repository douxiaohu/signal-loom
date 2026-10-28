package middleware

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

const SessionCookieName = "tg_session"

// maxActiveSessions bounds the in-memory session table. Logging in is only
// possible with the admin key, so this is a safety net, not an attack surface.
const maxActiveSessions = 200

// SessionPayload 储存在 token 中的数据
type SessionPayload struct {
	Exp int64  `json:"exp"`
	SID string `json:"sid"`
}

// SessionManager 负责会话的签发、签名验证与内存撤销。
// A token is "payload.signature" (HMAC-SHA256) and is only honoured while its
// session id is also registered here, so logout revokes it immediately and a
// restart invalidates all sessions.
type SessionManager struct {
	secret         []byte
	ttl            time.Duration
	now            func() time.Time
	mu             sync.RWMutex
	activeSessions map[string]int64
}

func NewSessionManager(secret string, ttl time.Duration) *SessionManager {
	if ttl <= 0 {
		ttl = 12 * time.Hour
	}
	return &SessionManager{
		secret:         []byte(secret),
		ttl:            ttl,
		now:            time.Now,
		activeSessions: make(map[string]int64),
	}
}

func (s *SessionManager) sign(payloadB64 string) []byte {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payloadB64))
	return mac.Sum(nil)
}

// Issue 签发新会话
func (s *SessionManager) Issue() (token string, expiresAt int64, err error) {
	now := s.now().Unix()
	expiresAt = now + int64(s.ttl.Seconds())

	randomBytes := make([]byte, 16)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", 0, err
	}
	sid := base64.RawURLEncoding.EncodeToString(randomBytes)

	s.mu.Lock()
	s.pruneLocked(now)
	for len(s.activeSessions) >= maxActiveSessions {
		var oldest string
		var oldestExp int64
		for id, exp := range s.activeSessions {
			if oldest == "" || exp < oldestExp {
				oldest, oldestExp = id, exp
			}
		}
		delete(s.activeSessions, oldest)
	}
	s.activeSessions[sid] = expiresAt
	s.mu.Unlock()

	payloadBytes, err := json.Marshal(SessionPayload{Exp: expiresAt, SID: sid})
	if err != nil {
		return "", 0, err
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(payloadBytes)
	sigB64 := base64.RawURLEncoding.EncodeToString(s.sign(payloadB64))
	return payloadB64 + "." + sigB64, expiresAt, nil
}

// parse checks the signature and returns the payload of a well-formed token.
func (s *SessionManager) parse(token string) (SessionPayload, bool) {
	var payload SessionPayload
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return payload, false
	}
	actualSig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(s.sign(parts[0]), actualSig) {
		return payload, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(raw, &payload) != nil || payload.SID == "" {
		return payload, false
	}
	return payload, true
}

// Verify 校验 Token 合法性，如果有效返回过期时间戳，否则返回 0
func (s *SessionManager) Verify(token string) int64 {
	payload, ok := s.parse(token)
	if !ok || payload.Exp <= s.now().Unix() {
		return 0
	}
	s.mu.RLock()
	activeExp, exists := s.activeSessions[payload.SID]
	s.mu.RUnlock()
	if !exists || activeExp != payload.Exp {
		return 0
	}
	return payload.Exp
}

// Revoke 撤销会话（登出）。Only validly signed tokens can revoke anything.
func (s *SessionManager) Revoke(token string) {
	if payload, ok := s.parse(token); ok {
		s.mu.Lock()
		delete(s.activeSessions, payload.SID)
		s.mu.Unlock()
	}
}

// Active reports the number of live sessions (for tests).
func (s *SessionManager) Active() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.activeSessions)
}

func (s *SessionManager) pruneLocked(now int64) {
	for sid, exp := range s.activeSessions {
		if exp <= now {
			delete(s.activeSessions, sid)
		}
	}
}

// RequireAuth 中间件：拦截未授权的 Admin 请求
func RequireAuth(sessionMgr *SessionManager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(SessionCookieName)
			if err != nil || cookie.Value == "" {
				writeJSONError(w, http.StatusUnauthorized, "Authentication required")
				return
			}
			if sessionMgr.Verify(cookie.Value) == 0 {
				writeJSONError(w, http.StatusUnauthorized, "Authentication required")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
