package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"

	"telegram-radar/internal/model"
)

// Body size limits for JSON endpoints. They are far above anything the UI
// sends and far below anything that could hurt the server.
const (
	maxLoginBody    = 4 << 10
	maxFeedbackBody = 32 << 10
	maxAdminBody    = 64 << 10
)

// RespondJSON 向客户端输出 JSON 格式
func RespondJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// RespondError 输出错误 JSON
func RespondError(w http.ResponseWriter, status int, detail string) {
	RespondJSON(w, status, map[string]string{"detail": detail})
}

// internalError logs the real cause and gives the client a generic message.
// Database and filesystem errors can contain paths and SQL, which have no
// business in a response.
func internalError(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("[api] %s %s (request %s): %v", r.Method, r.URL.Path, middleware.GetReqID(r.Context()), err)
	RespondError(w, http.StatusInternalServerError, "Internal server error")
}

// RespondETagJSON 带有 ETag 协商缓存的 JSON 输出（如果客户端已缓存返回 304）
func RespondETagJSON(w http.ResponseWriter, r *http.Request, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		internalError(w, r, err)
		return
	}
	sum := sha256.Sum256(data)
	etag := fmt.Sprintf(`"%s"`, hex.EncodeToString(sum[:]))

	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// etagMatches implements the weak comparison of If-None-Match, including lists
// and "*", so proxies that turn strong validators into weak ones still get 304s.
func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}

// apiError is a client-visible failure with an HTTP status.
type apiError struct {
	status int
	detail string
}

func (e *apiError) Error() string { return e.detail }

func (e *apiError) write(w http.ResponseWriter) { RespondError(w, e.status, e.detail) }

func invalid(detail string) *apiError { return &apiError{http.StatusUnprocessableEntity, detail} }

func isJSONContentType(header string) bool {
	mt, _, err := mime.ParseMediaType(header)
	return err == nil && (mt == "application/json" || strings.HasSuffix(mt, "+json"))
}

// decodeJSON reads exactly one JSON value from the request body. It insists on
// a JSON Content-Type (a cross-site HTML form cannot send one without a CORS
// preflight), caps the body size and rejects trailing data.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) *apiError {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return &apiError{http.StatusUnsupportedMediaType, "Content-Type must be application/json"}
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		var tooBig *http.MaxBytesError
		var syntax *json.SyntaxError
		var typeErr *json.UnmarshalTypeError
		switch {
		case errors.As(err, &tooBig):
			return &apiError{http.StatusRequestEntityTooLarge, "Request body too large"}
		case errors.Is(err, io.EOF):
			return &apiError{http.StatusBadRequest, "Request body is empty"}
		case errors.As(err, &syntax), errors.Is(err, io.ErrUnexpectedEOF):
			return &apiError{http.StatusBadRequest, "Malformed JSON"}
		case errors.As(err, &typeErr):
			if typeErr.Field != "" {
				return invalid("Invalid value for " + typeErr.Field)
			}
			return invalid("Invalid JSON value")
		default:
			return &apiError{http.StatusBadRequest, "Invalid JSON payload"}
		}
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return &apiError{http.StatusRequestEntityTooLarge, "Request body too large"}
		}
		return &apiError{http.StatusBadRequest, "Unexpected data after JSON body"}
	}
	return nil
}

// FormatAPIMessage 将数据库存储的 StoredMessage 转化为前端渲染的 APIMessage。
// mediaBasePath selects the endpoint family the media URLs point at: the public
// one for the public site, the authenticated one for the admin console.
func FormatAPIMessage(m *model.StoredMessage, mediaBasePath string) model.APIMessage {
	raw := model.ParseRawMessage(m.RawJSON)
	items := raw.Items(m.MediaType)

	serialized := make([]model.MediaItem, 0, len(items))
	urls := make([]string, 0, len(items))
	for idx, item := range items {
		thumb := fmt.Sprintf("%s/%d/%d?variant=thumbnail", mediaBasePath, m.ID, idx)
		orig := fmt.Sprintf("%s/%d/%d?variant=original", mediaBasePath, m.ID, idx)
		serialized = append(serialized, model.MediaItem{URL: thumb, OriginalURL: orig, Kind: item.Kind, Role: item.Role})
		urls = append(urls, thumb)
	}

	return model.APIMessage{
		ID:          m.ID,
		ChatID:      m.ChatID,
		ChatTitle:   m.ChatTitle,
		MessageID:   m.MessageID,
		SenderName:  m.SenderName,
		MessageTime: m.MessageTime,
		Content:     m.Content,
		MediaType:   m.MediaType,
		MediaURLs:   urls,
		MediaItems:  serialized,
		SourceURL:   raw.SourceURL,
		ForwardedAt: m.ForwardedAt,
	}
}

func formatMessages(list []model.StoredMessage, mediaBasePath string) []model.APIMessage {
	items := make([]model.APIMessage, 0, len(list))
	for i := range list {
		items = append(items, FormatAPIMessage(&list[i], mediaBasePath))
	}
	return items
}
