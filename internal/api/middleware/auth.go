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

// SessionPayload 储存在 token 中的数据
type SessionPayload struct {
	Exp int64  `json:"exp"`
	SID string `json:"sid"`
}

// SessionManager 负责会话的签发、签名验证与内存撤销
type SessionManager struct {
	secret         []byte
	ttl            time.Duration
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
		activeSessions: make(map[string]int64),
	}
}

// Issue 签发新会话：payload.signature
func (s *SessionManager) Issue() (string, int64, error) {
	now := time.Now().Unix()
	expiresAt := now + int64(s.ttl.Seconds())

	randomBytes := make([]byte, 16)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", 0, err
	}
	sid := base64.RawURLEncoding.EncodeToString(randomBytes)

	s.mu.Lock()
	s.activeSessions[sid] = expiresAt
	s.pruneLocked(now)
	s.mu.Unlock()

	payloadBytes, _ := json.Marshal(SessionPayload{
		Exp: expiresAt,
		SID: sid,
	})
	payloadB64 := base64.RawURLEncoding.EncodeToString(payloadBytes)

	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payloadB64))
	sigB64 := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return payloadB64 + "." + sigB64, expiresAt, nil
}

// Verify 校验 Token 合法性，如果有效返回过期时间戳，否则返回 0
func (s *SessionManager) Verify(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return 0
	}
	payloadB64, sigB64 := parts[0], parts[1]

	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payloadB64))
	expectedSig := mac.Sum(nil)
	actualSig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || !hmac.Equal(expectedSig, actualSig) {
		return 0
	}

	rawPayload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return 0
	}
	var payload SessionPayload
	if err := json.Unmarshal(rawPayload, &payload); err != nil {
		return 0
	}

	now := time.Now().Unix()
	if payload.Exp <= now {
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

// Revoke 撤销会话（登出）
func (s *SessionManager) Revoke(token string) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return
	}
	rawPayload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return
	}
	var payload SessionPayload
	if err := json.Unmarshal(rawPayload, &payload); err == nil {
		s.mu.Lock()
		delete(s.activeSessions, payload.SID)
		s.mu.Unlock()
	}
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
				http.Error(w, `{"detail":"Unauthorized"}`, http.StatusUnauthorized)
				return
			}
			exp := sessionMgr.Verify(cookie.Value)
			if exp == 0 {
				http.Error(w, `{"detail":"Invalid session"}`, http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
