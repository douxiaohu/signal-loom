package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"

	"telegram-radar/internal/model"
)

// RespondJSON 向客户端输出 JSON 格式
func RespondJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// RespondETagJSON 带有 ETag 协商缓存的 JSON 输出（如果客户端已缓存返回 304）
func RespondETagJSON(w http.ResponseWriter, r *http.Request, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		RespondError(w, http.StatusInternalServerError, "JSON encoding error")
		return
	}

	hash := sha256.Sum256(data)
	etag := fmt.Sprintf(`"%s"`, hex.EncodeToString(hash[:]))

	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")

	if match := r.Header.Get("If-None-Match"); match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// RespondError 输出错误 JSON
func RespondError(w http.ResponseWriter, status int, detail string) {
	RespondJSON(w, status, map[string]string{"detail": detail})
}

// FormatAPIMessage 将数据库存储的 StoredMessage 转化为前端渲染的 APIMessage
func FormatAPIMessage(m *model.StoredMessage, mediaBasePath string) model.APIMessage {
	var raw model.RawMessageData
	if m.RawJSON != "" {
		_ = json.Unmarshal([]byte(m.RawJSON), &raw)
	}

	var serializedItems []model.MediaItem
	var mediaURLs []string

	for idx, item := range raw.MediaItems {
		thumbURL := fmt.Sprintf("%s/%d/%d?variant=thumbnail", mediaBasePath, m.ID, idx)
		origURL := fmt.Sprintf("%s/%d/%d?variant=original", mediaBasePath, m.ID, idx)

		serializedItems = append(serializedItems, model.MediaItem{
			URL:         thumbURL,
			OriginalURL: origURL,
			Kind:        item.Kind,
			Role:        item.Role,
		})
		mediaURLs = append(mediaURLs, thumbURL)
	}

	sourceURL := raw.SourceURL
	if sourceURL == "" {
		sourceURL = fmt.Sprintf("https://t.me/c/%d/%d", m.ChatID, m.MessageID)
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
		MediaURLs:   mediaURLs,
		MediaItems:  serializedItems,
		SourceURL:   sourceURL,
		ForwardedAt: m.ForwardedAt,
	}
}
